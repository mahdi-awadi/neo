// One-off data fix (2026-10-08, ADR-0027): todo rows that ended `failed` but whose work later runs
// finished. Each row was checked by hand against git and the ledger before it was listed here. A row
// is changed only while it is still `failed`, so a second run changes nothing.
//
//   bun tools/oneoff/2026-10-08-fix-failed-todos.ts <ledger.db>            dry run: print the plan
//   bun tools/oneoff/2026-10-08-fix-failed-todos.ts <ledger.db> --apply    back up, then write
//
// Uses only columns that exist before migration 9 (status, result, ended_at), so it runs against the
// live ledger without migrating it. The backup is a `VACUUM INTO` copy, which is safe while the
// daemon holds the database open. Thread state is re-derived with the engine's own pure rule.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { deriveThreadState } from "../../src/engine/thread-state";

const at = (iso: string) => Date.parse(iso);
/** Ended-at is when the later work finished, so the thread's newest end is that finish. */
const FIXES: Array<{ id: number; endedAt: number | { todo: number }; note: string }> = [
  { id: 10, endedAt: at("2026-10-06T11:52:15Z"), note: "done by later work: out-of-folder writes are pre-approved by config (neo f1d4112, ADR-0012)" },
  { id: 16, endedAt: at("2026-10-05T03:34:27Z"), note: "done by later work: the pages_messaging use case was written (adminli e352229)" },
  { id: 42, endedAt: at("2026-10-06T21:41:29Z"), note: "done by later work: traceability plan P2–P6 finished and merged (neo 56c55ce, P6 6aadb43)" },
  { id: 46, endedAt: at("2026-10-06T18:45:21Z"), note: "done by later work: the agency brand restyle was finished (eticket-v3 ADR-0112/0113, completion audit b10aaa8c)" },
  { id: 59, endedAt: { todo: 86 }, note: "done by later work: todo #86 finished the security kit (neo 757a7a2)" },
  { id: 60, endedAt: at("2026-10-06T23:33:43Z"), note: "done by later work: memory limits deployed on all 51 prod containers (prod-ops 0ceac3b, order 115469fe)" },
  { id: 76, endedAt: { todo: 81 }, note: "done by later work: todo #81 made console attachments travel with their message (neo 7e0b105)" },
  { id: 77, endedAt: { todo: 82 }, note: "done by later work: todo #82 fixed the four hotel bugs (eticket-v3 69191da2 and the ADR-0122 commits)" },
  { id: 78, endedAt: { todo: 82 }, note: "done by later work: todo #82 built the wallet selector (eticket-v3 6bf0f62f, ADR-0123)" },
  { id: 79, endedAt: { todo: 82 }, note: "done by later work: todo #82 built the fare calendar (eticket-v3 e75f9f24, ADR-0124)" },
  { id: 80, endedAt: { todo: 82 }, note: "done by later work: todo #82 removed the two chrome labels (eticket-v3 59d023a2)" },
];
// Not changed: #61 (Cloudflare Browser Cache TTL → "Respect existing headers"). Checked live on
// 2026-10-08: the edge still rewrites origin `no-cache` to `max-age=14400`, so the work is NOT done.

const [path, flag] = process.argv.slice(2);
if (!path || !existsSync(path)) {
  console.error("usage: bun tools/oneoff/2026-10-08-fix-failed-todos.ts <ledger.db> [--apply]");
  process.exit(2);
}
const apply = flag === "--apply";
const db = new Database(path);
db.run("PRAGMA busy_timeout = 5000");

type Row = { id: number; status: string; result: string | null; thread_id: number | null };
const plan = FIXES.map((f) => {
  const row = db.query(`SELECT id, status, result, thread_id FROM project_todos WHERE id = ?`).get(f.id) as Row | null;
  const endedAt =
    typeof f.endedAt === "number"
      ? f.endedAt
      : (db.query(`SELECT ended_at FROM project_todos WHERE id = ? AND status = 'done'`).get(f.endedAt.todo) as { ended_at: number } | null)?.ended_at;
  return { ...f, row, endedAt };
});
for (const p of plan) {
  const what = !p.row ? "MISSING — skipped" : p.row.status !== "failed" ? `already ${p.row.status} — skipped` : p.endedAt === undefined ? "no finish time — skipped" : "→ done";
  console.log(`#${p.id} ${what}${p.row?.status === "failed" ? ` · ${p.note}` : ""}`);
}
if (!apply) {
  console.log("dry run — pass --apply to back up and write");
  process.exit(0);
}

const backup = `${path}.bak-2026-10-08-todofix-${Date.now()}`;
db.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`backup: ${backup}`);

const update = db.query(
  `UPDATE project_todos SET status = 'done', ended_at = ?1,
     result = ?2 || CASE WHEN result IS NULL OR result = '' THEN '' ELSE ' — earlier: ' || result END
   WHERE id = ?3 AND status = 'failed'`,
);
const threads = new Set<number>();
db.transaction(() => {
  for (const p of plan) {
    if (p.row?.status !== "failed" || p.endedAt === undefined) continue;
    update.run(p.endedAt, p.note, p.id);
    if (p.row.thread_id !== null) threads.add(p.row.thread_id);
  }
  // Re-derive each touched thread with the engine's rule (ADR-0016). Live approvals are not in the
  // ledger; these are finished threads, so none is pending.
  for (const id of threads) {
    const f = db
      .query(
        `SELECT (SELECT count(*) FROM decisions WHERE thread_id = ?1 AND status = 'open') AS open_decisions,
                (SELECT count(*) FROM project_todos WHERE thread_id = ?1 AND status IN ('queued', 'running', 'retry')) AS active_todos,
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
    console.log(`thread ${id}: ${before ?? "missing"} → ${state}`);
  }
})();
console.log("applied");
