// One-time cleanup (ADR-0053): close the open decisions whose question is gone, with the reason kept,
// and re-derive the threads. It applies the engine's own settle rules (decision-settle.ts) to every
// open decision — threadless ones too — plus one cleanup-only rule for plan cards: a todo in the
// plan's folder, created after the card, that names the plan and ended `done`, built it (the signal
// Execute already uses, ADR-0034). A person checks that list before --apply; its close marks the plan
// done too (ADR-0054). The engine itself never closes on it: a merge or review order cites plans too. It NEVER closes an unanswered decision that matches the keep
// patterns (irreversible, prod, money, auth): those are listed to keep open.
//
//   bun tools/threads/settle-decisions.ts <ledger.db>           dry run (default): works on a copy
//   bun tools/threads/settle-decisions.ts <ledger.db> --apply   back up, then write
//
// The dry run copies the ledger (`VACUUM INTO`, safe while the daemon holds it open), runs the very
// same apply on the copy and reports it, so the report is what --apply would do. --apply runs only on
// a ledger already at this code's schema (after the daemon restarted onto it): it never migrates a
// ledger under a live daemon. Idempotent: only `open` decisions change, so a second run closes nothing.
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, PAGE_MAX, type Ledger } from "../../src/engine/ledger";
import { MIGRATIONS } from "../../src/engine/ledger-migrations";
import { createRegistry } from "../../src/engine/registry";
import { createTrace, msgRef, type Trace } from "../../src/engine/trace";
import { applyStale, decisionText, keepsOpen, staleDecisions, DEFAULT_DECISION_SETTLE, type DecisionSettleCfg, type StaleDecision } from "../../src/engine/decision-settle";
import { loadConfig } from "../../src/config";
import { reviewedPath } from "../../src/engine/plan-review";

export interface Closable extends StaleDecision {
  project?: string;
  thread?: number;
}
export interface KeepOpen {
  id: string;
  project?: string;
  thread?: number;
  why: string;
}

const ACTIVE_PLAN = new Set(["draft", "sent", "approved"]);

/** What the cleanup would close, and what stays open with why. Reads only. */
export function planCleanup(ledger: Ledger, opts: { now: number; cfg: DecisionSettleCfg }): { close: Closable[]; keep: KeepOpen[] } {
  const open = ledger.listOpenDecisions();
  const settleOpts = { now: opts.now, expireAfterDays: opts.cfg.expireAfterDays, keepPatterns: opts.cfg.keepPatterns };
  const found = new Map<string, StaleDecision>();
  // Threads: every rule, with the thread's own facts.
  const threads = [...new Set(open.flatMap((d) => (d.cause ? [d.cause.threadId] : [])))];
  for (const t of threads) {
    const f = ledger.decisionSettleFacts(t);
    for (const s of staleDecisions(f, settleOpts)) found.set(s.id, s);
  }
  // No thread (before the trace existed): the plan, parked and expiry rules.
  const loose = open.filter((d) => !d.cause).map((d) => d.id);
  const f = ledger.decisionSettleFactsByIds(loose);
  for (const s of staleDecisions(f, settleOpts)) found.set(s.id, s);

  const close: Closable[] = [];
  const keep: KeepOpen[] = [];
  const todos = ledger.listTodos({ statuses: ["done", "waiting"], limit: PAGE_MAX * 10 });
  for (const d of open) {
    const where = { ...(d.project ? { project: d.project } : {}), ...(d.cause ? { thread: d.cause.threadId } : {}) };
    const text = decisionText(d.question, d.options, d.spec);
    const s = found.get(d.id);
    if (s) {
      close.push({ ...s, ...where });
      continue;
    }
    const path = d.folder ? reviewedPath(d.question) : undefined;
    const row = path ? ledger.planByPath(d.folder!, path) : undefined;
    const plan = row?.decisionId === d.id ? row : undefined;
    if (plan && ACTIVE_PLAN.has(plan.status)) {
      // Cleanup-only (a person checks this dry-run list before --apply; the engine never auto-closes on
      // it, ADR-0054): a later todo that names the plan and ended done built it. The first such todo
      // that really ran (a delivery marked done at once, ADR-0052, did not).
      const built = todos
        .filter((t) => t.status === "done" && t.folder === plan.folder && t.createdAt > d.createdAt && t.brief.includes(plan.path))
        .filter((t) => t.startedAt !== undefined && t.endedAt !== undefined && t.endedAt > t.startedAt)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      // A plan card's buttons are the engine's own (Approve & build / Changes / Drop): only its question counts.
      if (built && !keepsOpen(d.question, opts.cfg.keepPatterns)) {
        // planDone: the plan is marked done too, so its card cannot come back (ADR-0054).
        close.push({ id: d.id, reason: `plan built by todo #${built.id} (it names the plan and ended done)`, planDone: true, ...where });
        continue;
      }
      keep.push({ id: d.id, ...where, why: built ? `plan built by todo #${built.id}? it touches irreversible or prod work — tap Done or Drop on its card` : "plan awaits Approve & build" });
      continue;
    }
    if (!d.orderId) keep.push({ id: d.id, ...where, why: "governor escalation (no order) — the operator answers it" });
    else if (keepsOpen(text, opts.cfg.keepPatterns)) keep.push({ id: d.id, ...where, why: "irreversible or prod question, unanswered" });
    else if (todos.some((t) => t.status === "waiting" && t.waitingOn === d.id)) keep.push({ id: d.id, ...where, why: "a todo is parked on it" });
    else keep.push({ id: d.id, ...where, why: notMovedOn(ledger, d, opts) });
  }
  return { close, keep };
}

/** Why a plain question did not expire: too young, its order still open, or nothing finished since. */
function notMovedOn(ledger: Ledger, d: { orderId?: string; createdAt: number; folder?: string }, opts: { now: number; cfg: DecisionSettleCfg }): string {
  if (opts.cfg.expireAfterDays <= 0) return "expiry is off (decisionSettle.expireAfterDays = 0)";
  if (opts.now - d.createdAt < opts.cfg.expireAfterDays * 86_400_000) return `younger than ${opts.cfg.expireAfterDays} days`;
  if (!d.orderId || !ledger.getOutcome(d.orderId)) return "the work that asked it has not ended";
  return "no later work in its project has finished since it ended";
}

/** Close what `planCleanup` found and re-derive every thread it touched plus every WAITING thread. */
export function applyCleanup(ledger: Ledger, trace: Trace, plan: { close: Closable[] }, now: number): { closed: number; todosCancelled: number[]; threads: Array<{ id: number; from: string; to: string }> } {
  const waiting: number[] = [];
  for (let before: string | undefined, page; (page = ledger.listThreads({ state: "waiting" }, { limit: PAGE_MAX, ...(before ? { before } : {}) })); before = page.next) {
    waiting.push(...page.rows.map((t) => t.id));
    if (!page.next) break;
  }
  const touched = new Set<number>([...waiting, ...plan.close.flatMap((c) => (c.thread !== undefined ? [c.thread] : []))]);
  const before = new Map([...touched].map((id) => [id, ledger.threadById(id)?.state ?? "?"]));
  let todosCancelled: number[] = [];
  ledger.transaction(() => {
    todosCancelled = applyStale(ledger, plan.close, now);
  });
  for (const id of touched) trace.refreshThread(id);
  const threads = [...touched].flatMap((id) => {
    const to = ledger.threadById(id)?.state ?? "?";
    const from = before.get(id)!;
    return from !== to ? [{ id, from, to }] : [];
  });
  return { closed: plan.close.length, todosCancelled, threads };
}

/** A trace over `ledger` for the cleanup: no live sessions, and no settle of its own (the plan is the settle). */
function cleanupTrace(ledger: Ledger, now: number): Trace {
  return createTrace({ ledger, registry: createRegistry(), now: () => now, settleDecisions: false });
}

function report(plan: { close: Closable[]; keep: KeepOpen[] }, out: ReturnType<typeof applyCleanup>, mode: string): string {
  const ref = (t?: number) => (t !== undefined ? msgRef(t) : "no thread");
  const lines = [`${mode}`, `CLOSABLE (${plan.close.length})`];
  for (const c of plan.close) lines.push(`  #${c.id.slice(0, 8)} · ${c.project ?? "?"} · ${ref(c.thread)} · ${c.expired ? c.reason : `superseded: ${c.reason}`}`);
  lines.push(`KEEP OPEN (${plan.keep.length})`);
  for (const k of plan.keep) lines.push(`  #${k.id.slice(0, 8)} · ${k.project ?? "?"} · ${ref(k.thread)} · ${k.why}`);
  const leaving = out.threads.filter((t) => t.from === "waiting");
  lines.push(`threads leaving waiting (${leaving.length}): ${leaving.map((t) => `${ref(t.id)}→${t.to}`).join(", ") || "none"}`);
  lines.push(`todos cancelled: ${out.todosCancelled.map((id) => `#${id}`).join(", ") || "none"}`);
  return lines.join("\n");
}

/** The dry run: copy the ledger, apply on the copy, report. The ledger file is never written. */
export function dryRun(path: string, opts: { now: number; cfg: DecisionSettleCfg }): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-settle-dry-"));
  const copy = join(dir, "ledger.db");
  try {
    const src = new Database(path, { readonly: true });
    src.query("VACUUM INTO ?").run(copy);
    src.close();
    const ledger = openLedger(copy); // migrates the COPY only
    const plan = planCleanup(ledger, opts);
    const out = applyCleanup(ledger, cleanupTrace(ledger, opts.now), plan, opts.now);
    return report(plan, out, `DRY RUN on a copy of ${path} — nothing was written`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** --apply: only on a ledger at this code's schema; a `VACUUM INTO` backup first. */
export function applyTo(path: string, opts: { now: number; cfg: DecisionSettleCfg }): string {
  const newest = Math.max(...MIGRATIONS.map((m) => m.version));
  const probe = new Database(path, { readonly: true });
  const at = (probe.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (at !== newest) {
    probe.close();
    return `REFUSED: ${path} is at ledger v${at}, this code is v${newest}. Run --apply after the daemon restarted onto this code (never migrate a live ledger from a tool).`;
  }
  const backup = `${path}.bak-settle-${new Date(opts.now).toISOString().replace(/[:.]/g, "-")}`;
  probe.query("VACUUM INTO ?").run(backup);
  probe.close();
  const ledger = openLedger(path);
  const plan = planCleanup(ledger, opts);
  const out = applyCleanup(ledger, cleanupTrace(ledger, opts.now), plan, opts.now);
  ledger.recordEvent("decisions_cleanup", { data: { closed: out.closed, todosCancelled: out.todosCancelled, backup } });
  return report(plan, out, `APPLIED to ${path} (backup ${backup})`);
}

if (import.meta.main) {
  const [path, flag] = process.argv.slice(2);
  if (!path || !existsSync(path) || (flag !== undefined && flag !== "--apply")) {
    console.error("usage: bun tools/threads/settle-decisions.ts <ledger.db> [--apply]");
    process.exit(2);
  }
  let cfg = DEFAULT_DECISION_SETTLE;
  try {
    cfg = loadConfig(process.cwd()).decisionSettle ?? DEFAULT_DECISION_SETTLE;
  } catch {
    // no readable config here: the defaults
  }
  const opts = { now: Date.now(), cfg };
  console.log(flag === "--apply" ? applyTo(path, opts) : dryRun(path, opts));
}
