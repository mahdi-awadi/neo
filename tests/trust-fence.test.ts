// Trust never moves the firewall (ported from 4b7848c onto the live trust store): a trusted project
// auto-approves its escalations, but an out-of-folder write is a FENCE escalation only the operator
// approves, trust never applies to a customer-sourced order, and a tainted inbox brief stays toolless.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTrustStore } from "../src/engine/trust";
import { openLedger } from "../src/engine/ledger";
import { loadConfig } from "../src/config";
import { decide } from "../src/engine/governor";
import { route } from "../src/engine/provider-router";
import { runOrder, type RunHandlers, type RunResult } from "../src/engine/session-runner";
import { runCompanyBrief } from "../src/engine/ingress";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { registerDefaultProject } from "../src/engine/default-project";
import type { Order, OrderSource } from "../src/types";

const ON = { trustNewProjects: true };


// ── The firewall does not move with the default on ──

function fakeQuery(tool: string, input: Record<string, unknown>) {
  const decisions: Array<{ behavior: string }> = [];
  const q = (args: { prompt: unknown; options: any }) =>
    (async function* () {
      decisions.push(await args.options.canUseTool(tool, input));
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  return { q, decisions };
}

/** Run one tool call through the real canUseTool with trust read from a default-on store. */
async function governed(tool: string, input: Record<string, unknown>, source: OrderSource = "neo") {
  const trust = openTrustStore(":memory:", ON);
  const folder = "/home/new-project";
  trust.setTrust(folder, true);
  const { q, decisions } = fakeQuery(tool, input);
  let escalated = false;
  const auto: string[] = [];
  await runOrder(
    { id: "o1", source, folder, task: "t", chatId: 1, createdAt: 1 },
    {
      onMessage: () => {},
      onEscalation: async () => ((escalated = true), "deny"),
      autoApprove: () => trust.isTrusted(folder),
      onAutoApprove: (r) => auto.push(r),
    },
    { query: q as never },
  );
  return { decision: decisions[0].behavior, escalated, auto };
}

test("trusted: a new project auto-approves a risky command (what trust is for)", async () => {
  const r = await governed("Bash", { command: "git push --dry-run" });
  expect(r.decision).toBe("allow");
  expect(r.auto.length).toBe(1);
});

test("trusted: an out-of-folder write is still fenced — it asks the operator, never trust", async () => {
  for (const [tool, input] of [
    ["Write", { file_path: "/etc/passwd" }],
    ["Edit", { file_path: "/home/other-project/x.ts" }],
    ["NotebookEdit", { notebook_path: "/tmp/n.ipynb" }],
  ] as const) {
    const r = await governed(tool, input);
    expect(r.escalated).toBe(true);
    expect(r.auto).toEqual([]);
    expect(r.decision).toBe("deny");
  }
});

test("the governor marks an out-of-folder write as a fence escalation, and nothing else", () => {
  const ctx = { folder: "/home/p" };
  expect(decide("Write", { file_path: "/etc/x" }, ctx)).toMatchObject({ fenced: true });
  expect(decide("Bash", { command: "git push" }, ctx)).not.toHaveProperty("fenced");
  expect(decide("WebFetch", {}, ctx)).not.toHaveProperty("fenced");
});

test("trusted: trust never applies to a customer-sourced order", async () => {
  const r = await governed("Bash", { command: "git push" }, "customer");
  expect(r.escalated).toBe(true);
  expect(r.auto).toEqual([]);
});

test("trusted: customer routing is still refused", () => {
  const order: Order = { id: "c1", source: "customer", folder: "/home/x", task: "t", chatId: 1, createdAt: 1 };
  expect(route(order, loadConfig(mkdtempSync(join(tmpdir(), "neo-cfg-"))))).toHaveProperty("refuse");
});

test("trusted: an inbox (tainted) brief still runs with zero tools, no MCP, and denies escalations", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, undefined, () => 1);
  let seen: { disallowedTools?: string[]; mcpServers?: unknown } | undefined;
  let handlers: RunHandlers | undefined;
  const fakeRun = async (_o: Order, h: RunHandlers, d?: typeof seen): Promise<RunResult> => {
    seen = d;
    handlers = h;
    return { ok: true, sessionId: "s", summary: "draft", costUsd: 0 };
  };
  await runCompanyBrief(
    "draft a reply",
    {
      cfg: { workers: {}, workerEnv: {} } as never, ledger, registry,
      meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
      trust: openTrustStore(":memory:", ON), // the operator's default-on store must not leak in
      reply: () => {},
      askApproval: async () => "allow",
      run: fakeRun as never, now: () => 2,
    },
    { tainted: true },
  );
  expect(seen?.mcpServers).toBeUndefined();
  for (const t of ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch"]) expect(seen?.disallowedTools).toContain(t);
  expect(handlers?.autoApprove).toBeUndefined();
  expect(await handlers!.onEscalation("anything")).toBe("deny");
});
