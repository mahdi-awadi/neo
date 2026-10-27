// ADR-0053 one-time cleanup: tools/threads/settle-decisions.ts.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { DEFAULT_DECISION_SETTLE } from "../src/engine/decision-settle";
import { planCleanup, applyCleanup, dryRun } from "../tools/threads/settle-decisions";

const DAY = 86_400_000;
const T0 = 1_000_000;
const NOW = T0 + 30 * DAY;

function rig(path = ":memory:") {
  const ledger = openLedger(path);
  const trace = createTrace({ ledger, registry: createRegistry(), now: () => NOW, settleDecisions: false });
  const root = trace.inbound({ chatId: 7, text: "fix all old code", surface: "telegram" });
  const order = (id: string, folder: string, at: number, done?: number) => {
    ledger.recordOrder({ id, source: "neo", folder, task: "t", chatId: 7, createdAt: at }, { cause: root });
    if (done !== undefined) ledger.recordOutcome(id, "done", "ok", done);
  };
  return { ledger, trace, root, order };
}

/** A small ledger with one decision of each kind the cleanup meets. */
function seed(r: ReturnType<typeof rig>) {
  const { ledger, root, order } = r;
  const gold = "/home/gold";
  order("o1", gold, T0, T0 + 10);
  order("o2", gold, T0 + 20, T0 + 30);
  // An ordinary question whose work moved on: expires.
  const colour = ledger.openDecision({ kind: "decision", question: "Which colour for the header?", folder: gold, orderId: "o1", cause: root }, T0);
  // The same, but about prod: kept open and listed.
  const prod = ledger.openDecision({ kind: "decision", question: "Release the hotfix to prod now?", folder: gold, orderId: "o1", cause: root }, T0);
  // A pre-trace question (no thread) whose work moved on: expires too.
  const old = ledger.openDecision({ kind: "decision", question: "Which font?", folder: gold, orderId: "o1" }, T0);
  // A governor escalation (no order): kept.
  const esc = ledger.openDecision({ kind: "decision", question: "risky shell command: rm -rf build" }, T0);
  // A plan card built by a later todo that names it, with the writer's continuation parked on it.
  const plan = ledger.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/plans/fix.md — Fix the labels", folder: gold, orderId: "o1", cause: root }, T0 + 5);
  ledger.upsertPlan({ project: "gold", folder: gold, path: "docs/plans/fix.md", title: "Fix the labels", sha256: "x", stepsTotal: 0, stepsDone: 0, status: "sent", gate: "approval", decisionId: plan, threadId: root.threadId } as never);
  const built = ledger.addTodo({ project: "gold", folder: gold, brief: "Execute docs/plans/fix.md", workClass: "interactive", createdBy: "operator" }, T0 + 6);
  // A dead delivery (ADR-0052: marked done the moment it was handed over) is no evidence; the real run is.
  const dead = ledger.addTodo({ project: "gold", folder: gold, brief: "Execute docs/plans/fix.md (again)", workClass: "interactive", createdBy: "operator" }, T0 + 5.5);
  ledger.updateTodo(dead.id, { status: "done", startedAt: T0 + 6, endedAt: T0 + 6 });
  ledger.updateTodo(built.id, { status: "done", startedAt: T0 + 7, endedAt: T0 + 9 });
  const parked = ledger.addTodo({ project: "gold", folder: gold, brief: "continue; waits on docs/plans/fix.md", workClass: "interactive", createdBy: "operator", cause: root }, T0 + 7);
  ledger.updateTodo(parked.id, { status: "waiting", waitingOn: plan });
  // A plan card still awaiting, nothing built: kept.
  const waiting = ledger.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/plans/new.md — New page", folder: gold, orderId: "o2", cause: root }, T0 + 25);
  ledger.upsertPlan({ project: "gold", folder: gold, path: "docs/plans/new.md", title: "New page", sha256: "y", stepsTotal: 0, stepsDone: 0, status: "sent", gate: "approval", decisionId: waiting, threadId: root.threadId } as never);
  r.trace.refreshThread(root.threadId);
  return { colour, prod, old, esc, plan, waiting, built: built.id, parked: parked.id };
}

test("plan: closable vs keep-open — never an unanswered irreversible/prod question", () => {
  const r = rig();
  const s = seed(r);
  const p = planCleanup(r.ledger, { now: NOW, cfg: DEFAULT_DECISION_SETTLE });
  const closeIds = p.close.map((c) => c.id).sort();
  expect(closeIds).toEqual([s.colour, s.old, s.plan].sort());
  expect(p.close.find((c) => c.id === s.plan)).toMatchObject({ reason: `plan built by todo #${s.built} (it names the plan and ended done)` });
  expect(p.close.find((c) => c.id === s.colour)).toMatchObject({ expired: true });
  const keep = Object.fromEntries(p.keep.map((k) => [k.id, k.why]));
  expect(keep[s.prod]).toContain("irreversible or prod");
  expect(keep[s.esc]).toContain("escalation");
  expect(keep[s.waiting]).toContain("plan awaits");
});

test("apply: closes with reasons, releases the parked todo, re-derives the threads; a second run closes nothing", () => {
  const r = rig();
  const s = seed(r);
  expect(r.ledger.threadById(r.root.threadId)?.state).toBe("waiting");
  const out = applyCleanup(r.ledger, r.trace, planCleanup(r.ledger, { now: NOW, cfg: DEFAULT_DECISION_SETTLE }), NOW);
  expect(r.ledger.decisionById(s.colour)).toMatchObject({ status: "expired" });
  expect(r.ledger.decisionById(s.plan)).toMatchObject({ status: "superseded", answer: expect.stringContaining("plan built by todo #") });
  // ADR-0054: the plan itself is marked done too, so its card cannot come back as "awaits approval".
  expect(r.ledger.listPlans("gold").find((p) => p.decisionId === s.plan)?.status).toBe("done");
  expect(r.ledger.todoById(s.parked)).toMatchObject({ status: "cancelled" });
  expect(r.ledger.decisionById(s.prod)?.status).toBe("open");
  expect(out.closed).toBe(3);
  // Still waiting: the prod question and the awaiting plan remain.
  expect(r.ledger.threadById(r.root.threadId)?.state).toBe("waiting");
  const again = planCleanup(r.ledger, { now: NOW, cfg: DEFAULT_DECISION_SETTLE });
  expect(again.close).toEqual([]);
});

test("dry run: works on a copy — the ledger file is not changed, and the report lists both sides", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-settle-"));
  const path = join(dir, "ledger.db");
  const r = rig(path);
  seed(r);
  const before = new Database(path, { readonly: true }).query(`SELECT count(*) AS n FROM decisions WHERE status = 'open'`).get() as { n: number };
  const report = dryRun(path, { now: NOW, cfg: DEFAULT_DECISION_SETTLE });
  const after = new Database(path, { readonly: true }).query(`SELECT count(*) AS n FROM decisions WHERE status = 'open'`).get() as { n: number };
  expect(after.n).toBe(before.n);
  expect(report).toContain("CLOSABLE (3)");
  expect(report).toContain("KEEP OPEN (3)");
  expect(report).toContain("threads leaving waiting");
});

test("--apply: refuses a ledger older than this code (never migrates a live ledger); on a current one it backs up, then applies", async () => {
  const { applyTo } = await import("../tools/threads/settle-decisions");
  const { existsSync, readdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "neo-settle-apply-"));
  const path = join(dir, "ledger.db");
  const r = rig(path);
  const s = seed(r);
  const raw = new Database(path);
  const v = (raw.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  raw.run(`PRAGMA user_version = ${v - 1}`);
  expect(applyTo(path, { now: NOW, cfg: DEFAULT_DECISION_SETTLE })).toStartWith("REFUSED");
  expect(r.ledger.decisionById(s.colour)?.status).toBe("open");
  raw.run(`PRAGMA user_version = ${v}`);
  raw.close();
  expect(applyTo(path, { now: NOW, cfg: DEFAULT_DECISION_SETTLE })).toContain("CLOSABLE (3)");
  expect(readdirSync(dir).some((f) => f.startsWith("ledger.db.bak-settle-"))).toBe(true);
  expect(new Database(path, { readonly: true }).query(`SELECT status FROM decisions WHERE id = ?`).get(s.colour)).toEqual({ status: "expired" });
  expect(existsSync(path)).toBe(true);
});

test("--keep: an id the operator keeps stays open (listed with why), matched by its short #id", () => {
  const r = rig();
  const s = seed(r);
  const p = planCleanup(r.ledger, { now: NOW, cfg: DEFAULT_DECISION_SETTLE, keep: [s.plan.slice(0, 8)] });
  expect(p.close.map((c) => c.id).sort()).toEqual([s.colour, s.old].sort());
  expect(p.keep.find((k) => k.id === s.plan)?.why).toBe("kept by the operator (--keep)");
  applyCleanup(r.ledger, r.trace, p, NOW);
  expect(r.ledger.decisionById(s.plan)?.status).toBe("open");
  expect(r.ledger.listPlans("gold").find((x) => x.decisionId === s.plan)?.status).toBe("sent");
});

test("parseArgs: <ledger> [--apply] [--keep a,b]; anything else is a usage error", async () => {
  const { parseArgs } = await import("../tools/threads/settle-decisions");
  expect(parseArgs(["l.db"])).toEqual({ path: "l.db", apply: false, keep: [] });
  expect(parseArgs(["l.db", "--apply", "--keep", "4bb30cac,#666f1438"])).toEqual({ path: "l.db", apply: true, keep: ["4bb30cac", "666f1438"] });
  expect(parseArgs(["l.db", "--keep"])).toBeUndefined();
  expect(parseArgs(["l.db", "--force"])).toBeUndefined();
  // A short prefix could keep many cards by accident: the 8-character #id the report prints, at least.
  expect(parseArgs(["l.db", "--keep", "4bb3"])).toBeUndefined();
  expect(parseArgs([])).toBeUndefined();
});
