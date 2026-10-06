// Numbered ledger migrations (spec §3.1). The schema lives here and nowhere else: a change is a new
// entry in MIGRATIONS, never an edit to an old one. `user_version` records how far a db has got.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

/** v1 = every table, index and column the ledger had before migrations existed, moved verbatim.
 *  All statements are idempotent, so a pre-migration db (user_version 0, tables + data) and a fresh
 *  one both end at v1 with the same schema. */
function baseline(db: Database): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS orders (
       id TEXT PRIMARY KEY, source TEXT NOT NULL, folder TEXT NOT NULL,
       task TEXT NOT NULL, chat_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
       sdk_session_id TEXT
     )`,
  );
  // Migrate dbs created before sdk_session_id / sdk_provider existed. Rows written before
  // sdk_provider have a NULL provider: unprovable ownership, so a provider-filtered read skips
  // them (one fresh start) rather than risking a cross-SDK resume that kills the session.
  const cols = db.query(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "sdk_session_id")) {
    db.run(`ALTER TABLE orders ADD COLUMN sdk_session_id TEXT`);
  }
  if (!cols.some((c) => c.name === "sdk_provider")) {
    db.run(`ALTER TABLE orders ADD COLUMN sdk_provider TEXT`);
  }
  db.run(
    `CREATE TABLE IF NOT EXISTS outcomes (
       order_id TEXT PRIMARY KEY, status TEXT NOT NULL, summary TEXT, at INTEGER NOT NULL
     )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS auto_approvals (
       order_id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL
     )`,
  );
  // The full conversation transcript — every line in/out of a chat, durable across restarts.
  db.run(
    `CREATE TABLE IF NOT EXISTS messages (
       chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, at)`);
  // Loop scheduler state — last fire time + explicit enable override, so cron loops survive restart.
  db.run(
    `CREATE TABLE IF NOT EXISTS loop_state (
       name TEXT PRIMARY KEY, last_run INTEGER, enabled INTEGER
     )`,
  );
  // Custom (operator-authored) loop definitions — opaque JSON, merged with the built-in library.
  db.run(`CREATE TABLE IF NOT EXISTS loop_defs (name TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  // Sessions that were open at the last graceful shutdown — restored (and cleared) at boot.
  db.run(
    `CREATE TABLE IF NOT EXISTS open_sessions (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, chat_id INTEGER NOT NULL,
       sdk_session_id TEXT NOT NULL, task TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL
     )`,
  );
  const openCols = db.query(`PRAGMA table_info(open_sessions)`).all() as Array<{ name: string }>;
  if (!openCols.some((c) => c.name === "sdk_provider")) {
    db.run(`ALTER TABLE open_sessions ADD COLUMN sdk_provider TEXT`);
  }
  // Audit trail of context-policy verdicts (handoff/clear/…) fired per folder (ADR-0021).
  db.run(
    `CREATE TABLE IF NOT EXISTS context_events (
       folder TEXT NOT NULL, verdict TEXT NOT NULL, occupancy REAL NOT NULL, at INTEGER NOT NULL
     )`,
  );
  const ctxCols = db.query(`PRAGMA table_info(context_events)`).all() as Array<{ name: string }>;
  for (const col of ["reason", "boundary", "session_id", "detail"]) {
    if (!ctxCols.some((c) => c.name === col)) db.run(`ALTER TABLE context_events ADD COLUMN ${col} TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS context_events_folder_at ON context_events(folder, at)`);
  // LEARNED cache-TTL inputs: one row per resume, recording the idle gap beforehand and whether
  // the prompt cache was still warm (see context-policy.ts effectiveCacheTtlMs).
  db.run(
    `CREATE TABLE IF NOT EXISTS cache_observations (
       gap_ms INTEGER NOT NULL, hit INTEGER NOT NULL, at INTEGER NOT NULL
     )`,
  );
  // The context window the SDK reports per model, newest only (ADR-0013). The transcript names the
  // canonical model id but not its window, so the context policy reads the window from here.
  db.run(
    `CREATE TABLE IF NOT EXISTS model_windows (
       model TEXT PRIMARY KEY, tokens INTEGER NOT NULL, at INTEGER NOT NULL
     )`,
  );
  // Reply-routing map: which project each sent channel message belongs to, so a REPLY to a specific
  // worker message routes into that project even after a /reload (in-memory cache was lost before).
  db.run(
    `CREATE TABLE IF NOT EXISTS message_routes (
       chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
       session_id TEXT NOT NULL, folder TEXT NOT NULL, project TEXT NOT NULL, at INTEGER NOT NULL,
       PRIMARY KEY (chat_id, message_id)
     )`,
  );
  // Structured diagnostic event log — API errors/retries + session and dispatch lifecycle
  // transitions. The persistent trail to diagnose instability from (throttle loops, wedged
  // dispatches, stalls); kinds + small metadata only, never message bodies (those live in messages).
  db.run(
    `CREATE TABLE IF NOT EXISTS events (
       kind TEXT NOT NULL, at INTEGER NOT NULL,
       order_id TEXT, session_id TEXT, folder TEXT, data TEXT
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events (kind, at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_order_at ON events (order_id, at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_at ON events (at)`);

  // Pending-decisions queue: blocking worker questions + governor escalations (kind 'decision') and
  // failure alerts (kind 'alert'). Each stays OPEN until the operator answers/dismisses it, so a
  // blocking question is never lost across a daemon restart (unlike the in-memory approval resolver).
  db.run(
    `CREATE TABLE IF NOT EXISTS decisions (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       project TEXT,
       folder TEXT,
       order_id TEXT,
       session_id TEXT,
       chat_id INTEGER,
       question TEXT NOT NULL,
       options TEXT,
       spec TEXT,
       status TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       answered_at INTEGER,
       answer TEXT,
       decision_chat_id INTEGER,
       decision_message_id INTEGER,
       last_reminded_at INTEGER,
       reminder_count INTEGER NOT NULL DEFAULT 0
     )`,
  );
  // Migrate dbs created before the structured-ask `spec` column existed (Feature 1). A NULL spec is
  // a plain/flat decision — read back as undefined, so legacy rows are unaffected.
  const decisionCols = db.query(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>;
  if (!decisionCols.some((c) => c.name === "spec")) {
    db.run(`ALTER TABLE decisions ADD COLUMN spec TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_msg ON decisions (decision_chat_id, decision_message_id)`);

  // Dispatcher inbox (ADR-0007): final dispatch results waiting for the company. A row leaves the
  // pending set only once delivered; delivered rows are kept short (pruned on each queue).
  db.run(
    `CREATE TABLE IF NOT EXISTS dispatcher_inbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       project TEXT NOT NULL,
       text TEXT NOT NULL,
       at INTEGER NOT NULL,
       delivered_at INTEGER
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_dispatcher_inbox_pending ON dispatcher_inbox (delivered_at, id)`);

  // Todo queue (ADR-0008): one row per dispatched brief, per project (keyed by folder). `position`
  // orders the queued rows of one folder; it is renumbered on every move.
  db.run(
    `CREATE TABLE IF NOT EXISTS project_todos (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       project TEXT NOT NULL,
       folder TEXT NOT NULL,
       brief TEXT NOT NULL,
       team TEXT,
       work_class TEXT NOT NULL,
       created_by TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       status TEXT NOT NULL,
       position INTEGER NOT NULL,
       order_id TEXT,
       result TEXT,
       started_at INTEGER,
       ended_at INTEGER
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_todos_folder ON project_todos (folder, status, position)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_todos_order ON project_todos (order_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS todo_paused (folder TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL)`);
}

export const MIGRATIONS: Migration[] = [{ version: 1, name: "baseline", up: baseline }];

/** Bring `db` up to the newest version. Each migration runs in its own transaction, so earlier good
 *  ones stay applied when a later one throws. Before the first pending migration a file db that
 *  already has tables is copied to `<path>.bak-v<from>` (once). A failure throws out: the daemon
 *  treats an unmigratable ledger as unrecoverable, and the message names the backup. */
export function migrate(
  db: Database,
  opts: { path: string; migrations?: Migration[] },
): { from: number; to: number; backup?: string } {
  const list = opts.migrations ?? MIGRATIONS;
  const from = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const pending = list.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const hasTables = (db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n > 0;
  let backup: string | undefined;
  if (pending.length && opts.path !== ":memory:" && opts.path !== "" && hasTables) {
    backup = `${opts.path}.bak-v${from}`;
    if (!existsSync(backup)) db.run(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  }
  for (const m of pending) {
    try {
      db.transaction(() => {
        m.up(db);
        db.run(`PRAGMA user_version = ${m.version}`);
      })();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ledger migration ${m.version} (${m.name}) failed: ${why}${backup ? ` — backup at ${backup}` : ""}`,
        { cause: err },
      );
    }
  }
  return { from, to: pending.at(-1)?.version ?? from, backup };
}
