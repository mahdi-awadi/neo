import { test, expect } from "bun:test";
import { runCompanyBrief, denyAllTrust } from "../src/engine/ingress";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { registerDefaultProject } from "../src/engine/default-project";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

test("denyAllTrust never trusts any folder (customer-path dispatch cannot auto-approve)", () => {
  const t = denyAllTrust();
  expect(t.isTrusted("/home/neo/agent")).toBe(false);
  expect(t.isTrusted("/anything")).toBe(false);
  expect(t.list()).toEqual([]);
});

test("runCompanyBrief runs the brief on the company and returns its result", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, () => 1); // pins an idle company at /home/neo/agent
  const replies: string[] = [];
  let seenResume: string | undefined;
  const fakeRun = async (_o: Order, h: RunHandlers, d?: { resume?: string }): Promise<RunResult> => {
    seenResume = d?.resume;
    h.onMessage("looked it up");
    return { ok: true, sessionId: "co-1", summary: "order #7 ships tomorrow", costUsd: 0.01 };
  };

  const out = await runCompanyBrief("A customer asks: where is order #7? Answer them.", {
    cfg: {} as never, ledger, registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, t) => void replies.push(t),
    askApproval: async () => "deny",
    run: fakeRun as never, now: () => 2,
  });

  expect(out).toBe("order #7 ships tomorrow");
  expect(replies).toContain("looked it up");                 // streamed for observability
  expect(registry.getDefault()?.status).toBe("idle");        // company left idle
});

test("tainted brief runs with zero mutating tools and no MCP servers", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, () => 1);
  let seenDeps: { disallowedTools?: string[]; mcpServers?: unknown } | undefined;
  const fakeRun = async (_o: Order, _h: RunHandlers, d?: { disallowedTools?: string[]; mcpServers?: unknown }): Promise<RunResult> => {
    seenDeps = d;
    return { ok: true, sessionId: "co-2", summary: "draft text", costUsd: 0 };
  };

  const out = await runCompanyBrief("draft a reply", {
    cfg: {} as never, ledger, registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "deny",
    run: fakeRun as never, now: () => 2,
  }, { tainted: true });

  expect(out).toBe("draft text");
  expect(seenDeps?.mcpServers).toBeUndefined();
  for (const t of ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "SlashCommand", "KillShell"]) {
    expect(seenDeps?.disallowedTools).toContain(t);
  }
});

test("tainted brief is a fully isolated one-shot: no resume, and it never persists a session id", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, () => 1);
  registry.setSdkSessionId(registry.getDefault()!.id, "prior-company-session");
  let seenDeps: { resume?: string } | undefined;
  const fakeRun = async (_o: Order, _h: RunHandlers, d?: { resume?: string }): Promise<RunResult> => {
    seenDeps = d;
    return { ok: true, sessionId: "co-2", summary: "draft text", costUsd: 0 };
  };

  await runCompanyBrief("draft a reply", {
    cfg: {} as never, ledger, registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "deny",
    run: fakeRun as never, now: () => 2,
  }, { tainted: true });

  expect(seenDeps?.resume).toBeUndefined();
  expect(registry.getDefault()?.sdkSessionId).toBe("prior-company-session");
});

test("untainted brief keeps MCP servers and no disallowedTools (unchanged path)", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, () => 1);
  let seenDeps: { disallowedTools?: string[]; mcpServers?: unknown } | undefined;
  const fakeRun = async (_o: Order, _h: RunHandlers, d?: { disallowedTools?: string[]; mcpServers?: unknown }): Promise<RunResult> => {
    seenDeps = d;
    return { ok: true, sessionId: "co-3", summary: "ok", costUsd: 0 };
  };

  await runCompanyBrief("normal brief", {
    cfg: {} as never, ledger, registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "deny",
    run: fakeRun as never, now: () => 2,
  });

  expect(seenDeps?.mcpServers).toBeDefined();
  expect(seenDeps?.disallowedTools).toBeUndefined();
});
