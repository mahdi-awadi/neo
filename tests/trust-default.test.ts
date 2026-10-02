// Trust default for new projects (ADR-0007): the default is recorded at first sight, an explicit
// record is never overwritten, existing projects are frozen by the migration, and the hard
// firewall does not move when the default is on.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "neo-trust-default-")), "trust.db");
const ON = { defaultForNewProjects: true };

// ── The store: first sight records the default; explicit records win ──

test("default on: a never-seen folder is trusted, and that is recorded at first sight", () => {
  const path = tmpDb();
  expect(openTrustStore(path, ON).isTrusted("/p/new")).toBe(true);
  // recorded, not resolved: turning the default off later does not change it
  expect(openTrustStore(path, { defaultForNewProjects: false }).isTrusted("/p/new")).toBe(true);
});

test("default off: a never-seen folder is untrusted, and stays so when the default turns on", () => {
  const path = tmpDb();
  expect(openTrustStore(path).isTrusted("/p/seen-while-off")).toBe(false);
  expect(openTrustStore(path, ON).isTrusted("/p/seen-while-off")).toBe(false);
});

test("an explicit /trust off is never overwritten by the default", () => {
  const path = tmpDb();
  openTrustStore(path, ON).setTrust("/p/off", false);
  const t = openTrustStore(path, ON);
  expect(t.isTrusted("/p/off")).toBe(false);
  expect(t.list()).toEqual([]);
});

test("list() shows only trusted folders", () => {
  const t = openTrustStore(":memory:", ON);
  t.isTrusted("/p/a"); // first sight → trusted by default
  t.setTrust("/p/b", false);
  t.setTrust("/p/c", true);
  expect(t.list()).toEqual(["/p/a", "/p/c"]);
});

// ── Migration: existing projects keep their current setting ──

function legacyTrustDb(path: string, trusted: string[]): void {
  const db = new Database(path);
  db.run(`CREATE TABLE trust (folder TEXT PRIMARY KEY)`); // the old presence-only schema
  for (const f of trusted) db.query(`INSERT INTO trust (folder) VALUES (?)`).run(f);
  db.close();
}

test("migration: old trusted rows stay trusted; known-but-untrusted projects stay untrusted", () => {
  const path = tmpDb();
  legacyTrustDb(path, ["/home/waselni"]);
  const t = openTrustStore(path, { ...ON, knownFolders: () => ["/home/waselni", "/home/awafi"] });
  expect(t.isTrusted("/home/waselni")).toBe(true);
  expect(t.isTrusted("/home/awafi")).toBe(false); // existed before, was untrusted → frozen untrusted
  expect(t.isTrusted("/home/brand-new")).toBe(true); // genuinely new → the default
});

test("migration on a fresh trust db still freezes the projects the ledger already knows", () => {
  const t = openTrustStore(tmpDb(), { ...ON, knownFolders: () => ["/home/old"] });
  expect(t.isTrusted("/home/old")).toBe(false);
});

test("migration runs once: a folder first seen after it gets the default", () => {
  const path = tmpDb();
  openTrustStore(path, { ...ON, knownFolders: () => [] });
  const t = openTrustStore(path, { ...ON, knownFolders: () => ["/home/later"] });
  expect(t.isTrusted("/home/later")).toBe(true);
});

test("rollback-safe: the old engine's read still sees frozen and explicit-off folders as untrusted", () => {
  const path = tmpDb();
  legacyTrustDb(path, ["/home/waselni"]);
  const t = openTrustStore(path, { ...ON, knownFolders: () => ["/home/awafi"] });
  t.setTrust("/home/waselni", false);
  t.isTrusted("/home/brand-new"); // default on → trusted
  const db = new Database(path, { readonly: true });
  const oldIsTrusted = (f: string) => db.query(`SELECT 1 FROM trust WHERE folder = ?`).get(f) !== null; // pre-ADR-0007 read
  expect(oldIsTrusted("/home/awafi")).toBe(false);
  expect(oldIsTrusted("/home/waselni")).toBe(false);
  expect(oldIsTrusted("/home/brand-new")).toBe(true);
  db.close();
});

test("a trailing slash is the same folder: /trust off on '/p/x/' keeps '/p/x' untrusted", () => {
  const t = openTrustStore(":memory:", ON);
  t.setTrust("/p/x/", false);
  expect(t.isTrusted("/p/x")).toBe(false);
  expect(t.list()).toEqual([]);
});

test("ledger.knownFolders lists every folder with an order or an open session", () => {
  const ledger = openLedger(":memory:");
  ledger.recordOrder({ id: "o1", source: "neo", folder: "/home/a", task: "t", chatId: 1, createdAt: 1 });
  ledger.recordOrder({ id: "o2", source: "neo", folder: "/home/a", task: "t", chatId: 1, createdAt: 2 });
  ledger.recordOrder({ id: "o3", source: "neo", folder: "/home/b", task: "t", chatId: 1, createdAt: 3 });
  expect(ledger.knownFolders()).toEqual(["/home/a", "/home/b"]);
});

// ── Config: safe default in code, a flip in config.json ──

test("trust.defaultForNewProjects is off by default and config.json turns it on", () => {
  const d = mkdtempSync(join(tmpdir(), "neo-cfg-"));
  expect(loadConfig(d).trust.defaultForNewProjects).toBe(false);
  writeFileSync(join(d, "config.json"), JSON.stringify({ trust: { defaultForNewProjects: true } }));
  expect(loadConfig(d).trust.defaultForNewProjects).toBe(true);
});

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

test("default on: a new project auto-approves a risky command (what trust is for)", async () => {
  const r = await governed("Bash", { command: "git push --dry-run" });
  expect(r.decision).toBe("allow");
  expect(r.auto.length).toBe(1);
});

test("default on: an out-of-folder write is still fenced — it asks the operator, never trust", async () => {
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

test("default on: trust never applies to a customer-sourced order", async () => {
  const r = await governed("Bash", { command: "git push" }, "customer");
  expect(r.escalated).toBe(true);
  expect(r.auto).toEqual([]);
});

test("default on: customer routing is still refused", () => {
  const order: Order = { id: "c1", source: "customer", folder: "/home/x", task: "t", chatId: 1, createdAt: 1 };
  expect(route(order, loadConfig(mkdtempSync(join(tmpdir(), "neo-cfg-"))))).toHaveProperty("refuse");
});

test("default on: an inbox (tainted) brief still runs with zero tools, no MCP, and denies escalations", async () => {
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
