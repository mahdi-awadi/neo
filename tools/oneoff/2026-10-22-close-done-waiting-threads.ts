// One-off data fix (2026-10-22, ADR-0045): the open decisions of WAITING threads whose work was in fact
// done or made moot later. A person checked each one against its repository (commits, plans, docs);
// the evidence is in each reason and in docs/investigations/2026-10-22-waiting-threads.md. Decisions
// still waiting for the operator are not touched; their one-line ask is seeded as the waiting sweep's
// judgement, so its first reminder is right and it does not re-judge them at once.
//
//   bun tools/oneoff/2026-10-22-close-done-waiting-threads.ts <ledger.db>            dry run
//   bun tools/oneoff/2026-10-22-close-done-waiting-threads.ts <ledger.db> --apply    back up, then write
//
// Uses only what exists at ledger v11 (decisions, project_todos, plans, threads, meta), so it runs
// against the live ledger without migrating it. The backup is a `VACUUM INTO` copy, safe while the
// daemon holds the database open. A row changes only while it is still open/waiting/sent, so a second
// run changes nothing. Thread state is re-derived with the engine's own pure rule.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { deriveThreadState } from "../../src/engine/thread-state";

/** A decision found done: its id prefix and the evidence. */
export interface Fix { id: string; reason: string }
/** A decision still waiting: its id prefix and the operator's one-line ask. */
export interface Keep { id: string; ask: string }

export const FIXES: Fix[] = [
  { id: "d8de5017", reason: "skipped by operator decision, answered as #86b3d086 (contantme docs/VALIDATION.md)" },
  { id: "8c5ad70f", reason: "built: coded requests RQ-01..RQ-12 ride the cross-report request (mirshad f279ee4f, ADR-0033)" },
  { id: "f4cf5967", reason: "built: CA-30 cap breach tells the school's approver (mirshad d3996242, ADR-0034)" },
  { id: "d184a612", reason: "answered by decision #cc6ffca9 'keep everything'; ADR-0041 (neo e6b1baf)" },
  { id: "4c4b5a74", reason: "the sandbox needs no Qi public key; built in eticket-v3 05e67d3e9..6ef58c71c (ADR-0178)" },
  { id: "2f66c3ce", reason: "sandbox login provided; E2E run and passed (prod-ops 98aea90, bda6d40)" },
  { id: "42eba2cd", reason: "deployed: archiver alert rules (prod-ops c25605d)" },
  { id: "b38c679a", reason: "built: the app applies a new build by itself (waselni 4da7c994, ADR-0081; main 8d628cdc)" },
  { id: "ae3b5fa0", reason: "built: one SOS incident per trip (waselni e845c79f, 1187356e, ADR-0083; main 8d628cdc)" },
  { id: "f7387f7e", reason: "shipped: decline clearance + Western digits on main 8f14a9d8 (ADR-0091); deploy + prod OTA green (cea94519)" },
  { id: "d1b477b6", reason: "deployed: travel-service 58d44fa ran on prod (prod-ops wallet-payment-crash-check-2026-10-18), then 17e5d7d" },
  { id: "a6e6778b", reason: "fixed: SEC-1 (eticket-v3 8c6d85446) in main de2901ee3, deployed 2026-10-18" },
  { id: "3a39e3c8", reason: "moot: a partner with no Airalo binding is refused (eticket-v3 ADR-0171, f55a1f3be)" },
  { id: "041de41a", reason: "answered by #88276783; merge 6ce3a1695 is on dev and main (eticket-v3 ADR-0155)" },
];

export const KEEPS: Keep[] = [
  { id: "d3226770", ask: "Unclear: allow one read-only prod check for eSIM customers who may have paid without an eSIM?" },
  { id: "ba954c7c", ask: "Where should support agents see the AI chat from before a hand-off?" },
  { id: "a1b13247", ask: "How is a booking change's price difference paid from the wallet?" },
  { id: "789a27fb", ask: "payment_tokens: build the table or remove the three RPCs?" },
  { id: "73c66293", ask: "Charter-hotel manager RPCs and pricing-rule model: build or remove?" },
  { id: "01441714", ask: "Give an iQtkt prod admin login (or run it yourself) to fail the 23 stuck IA bookings" },
  { id: "b2cd43d9", ask: "Purge passenger PII from prod Loki now? (it expires by itself around 11-01)" },
  { id: "f5559e7d", ask: "Which account do the partner-less background syncs use under 'nothing shared'?" },
  { id: "d3ed03e2", ask: "Approve, change or drop the CityNet Asfoor dev-first plan" },
  { id: "81396fd2", ask: "Enforce allow_api_client for API-key tokens at the gateway?" },
  { id: "1f7d20a3", ask: "Asfoor sandbox admin needs super-admin: SQL grant, create it in the UI, or share a login?" },
  { id: "2598e346", ask: "Approve & build the Bitaqti upgrade design and roadmap, or park them?" },
  { id: "80371ae2", ask: "Approve & build the Bitaqti upgrade design and roadmap, or park them?" },
  { id: "da926828", ask: "Which Telegram bot and channel feed gold prices, and in what post format?" },
];

type Dec = { id: string; status: string; thread_id: number | null };

/** The plan, and (with `apply`) the writes, in one transaction. Returns the printed lines. */
export function run(db: Database, opts: { fixes: Fix[]; keeps: Keep[]; apply: boolean; now: number }): string[] {
  const out: string[] = [];
  const one = (prefix: string): Dec | string => {
    const rows = db.query(`SELECT id, status, thread_id FROM decisions WHERE id LIKE ? || '%'`).all(prefix) as Dec[];
    return rows.length === 1 ? rows[0]! : rows.length === 0 ? "MISSING" : `AMBIGUOUS (${rows.length})`;
  };
  const fixes = opts.fixes.map((f) => ({ ...f, row: one(f.id) }));
  const keeps = opts.keeps.map((k) => ({ ...k, row: one(k.id) }));
  for (const f of fixes) {
    const what = typeof f.row === "string" ? `${f.row} — skipped` : f.row.status !== "open" ? `already ${f.row.status} — skipped` : "→ superseded";
    out.push(`#${f.id} ${what}${typeof f.row !== "string" && f.row.status === "open" ? ` · ${f.reason}` : ""}`);
  }
  for (const k of keeps) out.push(`#${k.id} ${typeof k.row === "string" ? `${k.row} — skipped` : k.row.status !== "open" ? `now ${k.row.status} — not seeded` : "stays waiting"} · ${k.ask}`);
  if (!opts.apply) return out;

  const at = opts.now;
  const threads = new Set<number>();
  db.transaction(() => {
    for (const f of fixes) {
      if (typeof f.row === "string" || f.row.status !== "open") continue;
      const reason = `done by later work: ${f.reason}`;
      db.query(`UPDATE decisions SET status = 'superseded', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'`).run(reason, at, f.row.id);
      const parked = db.query(`SELECT id FROM project_todos WHERE status = 'waiting' AND waiting_on = ?`).all(f.row.id) as Array<{ id: number }>;
      db.query(`UPDATE project_todos SET status = 'cancelled', ended_at = ?, result = ?, waiting_on = NULL WHERE status = 'waiting' AND waiting_on = ?`).run(at, reason, f.row.id);
      for (const p of parked) out.push(`  todo #${p.id} (parked on #${f.id}) → cancelled`);
      // A plan card whose plan was built anyway: the plan is done (ADR-0036 — the card follows it).
      const plan = db.query(`UPDATE plans SET status = 'done', updated_at = ? WHERE decision_id = ? AND status = 'sent'`).run(at, f.row.id);
      if (plan.changes) out.push(`  plan of #${f.id} → done`);
      if (f.row.thread_id !== null) threads.add(f.row.thread_id);
    }
    const prev = db.query(`SELECT value FROM meta WHERE key = 'waitingSweep.judged'`).get() as { value: string } | null;
    const judged = (prev ? JSON.parse(prev.value) : {}) as Record<string, { at: number; commitAt: number; ask: string }>;
    for (const k of keeps) if (typeof k.row !== "string" && k.row.status === "open") judged[k.row.id] = { at, commitAt: at, ask: k.ask };
    db.query(`INSERT INTO meta (key, value, updated_at) VALUES ('waitingSweep.judged', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(judged), at);

    // Re-derive each touched thread with the engine's rule (ADR-0016), as the 2026-10-08 one-off does.
    // Live approvals are not in the ledger; these threads' runs have ended, so none is pending.
    for (const id of threads) {
      const f = db
        .query(
          `SELECT (SELECT count(*) FROM decisions WHERE thread_id = ?1 AND status = 'open') AS open_decisions,
                  (SELECT count(*) FROM project_todos WHERE thread_id = ?1 AND status IN ('queued', 'running', 'retry', 'waiting')) AS active_todos,
                  (SELECT closed_by_operator FROM threads WHERE id = ?1) AS closed`,
        )
        .get(id) as { open_decisions: number; active_todos: number; closed: number | null };
      const end = db
        .query(
          `SELECT ok FROM (
             SELECT o.at AS at, o.status = 'done' AS ok FROM outcomes o JOIN orders ord ON ord.id = o.order_id WHERE ord.thread_id = ?1
             UNION ALL
             SELECT ended_at AS at, status != 'failed' AS ok FROM project_todos
             WHERE thread_id = ?1 AND status IN ('done', 'failed', 'cancelled') AND ended_at IS NOT NULL
           ) ORDER BY at DESC LIMIT 1`,
        )
        .get(id) as { ok: number } | null;
      const state = deriveThreadState({
        openDecisions: f.open_decisions,
        pendingApprovals: 0,
        activeWork: f.active_todos,
        ...(end ? { lastEnd: end.ok ? ("ok" as const) : ("failed" as const) } : {}),
        closedByOperator: f.closed === 1,
      });
      const before = (db.query(`SELECT state FROM threads WHERE id = ?`).get(id) as { state: string } | null)?.state;
      if (before !== undefined && before !== state) db.query(`UPDATE threads SET state = ? WHERE id = ?`).run(state, id);
      out.push(`thread m${id.toString(36)}: ${before ?? "missing"} → ${state}`);
    }
  })();
  return out;
}

if (import.meta.main) {
  const [path, flag] = process.argv.slice(2);
  if (!path || !existsSync(path)) {
    console.error("usage: bun tools/oneoff/2026-10-22-close-done-waiting-threads.ts <ledger.db> [--apply]");
    process.exit(2);
  }
  const apply = flag === "--apply";
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  if (apply) {
    const backup = `${path}.bak-2026-10-22-waiting-sweep-${Date.now()}`;
    db.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`backup: ${backup}`);
  }
  for (const l of run(db, { fixes: FIXES, keeps: KEEPS, apply, now: Date.now() })) console.log(l);
  console.log(apply ? "applied" : "dry run — pass --apply to back up and write");
}
