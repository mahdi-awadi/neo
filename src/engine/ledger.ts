// Durable record of orders and their outcomes. The deterministic bookkeeping layer —
// the part of operant that already was an "engine" (ported to bun:sqlite, trimmed).
import { Database } from "bun:sqlite";
import type { Order, OrderSource, RouteTarget } from "../types";
import { CACHE_OBS_WINDOW } from "./context-policy";

/** Generous cap on persisted reply-routes — the ledger is the source of truth, so this only bounds
 *  ancient rows the operator will never reply to. One tiny row per sent worker message. */
export const ROUTE_KEEP = 20_000;

/** Diagnostic event-log retention: prune in coarse batches so the hot path stays a single insert. */
export const EVENTS_KEEP = 50_000;
export const EVENTS_PRUNE_INTERVAL = 1000;

export interface Ledger {
  recordOrder(order: Order): void;
  recordOutcome(orderId: string, status: string, summary: string): void;
  getOutcome(orderId: string): { status: string; summary: string } | undefined;
  /** Persist the worker's SDK session id against an order, so it can later be resumed. */
  recordSession(orderId: string, sdkSessionId: string): void;
  /** The most recently recorded SDK session id for a folder/chat (for resume), if any. */
  lastSessionFor(folder: string, chatId: number): string | undefined;
  listRecent(limit?: number): Order[];
  /** Audit: a risky action that trust auto-approved (the compensating control for the bypassed gate). */
  recordAutoApproval(orderId: string, reason: string): void;
  autoApprovalsFor(orderId: string): string[];
  /** Append one line of a conversation (keyed by chat = the thread), e.g. "user"/"assistant". */
  recordMessage(chatId: number, role: string, content: string): void;
  /** The full transcript for a chat, oldest-first; `limit` keeps only the most recent N. */
  conversation(chatId: number, limit?: number): ConversationMessage[];
  /** Loop scheduler state — last fire time + explicit enable override (implements LoopStateStore). */
  getLastRun(name: string): number | undefined;
  setLastRun(name: string, at: number): void;
  isEnabled(name: string): boolean | undefined;
  setEnabled(name: string, on: boolean): void;
  /** Custom loop definitions (data-driven loop CRUD) — opaque JSON keyed by name. */
  saveLoopDef(name: string, json: string): void;
  listLoopDefs(): Array<{ name: string; json: string }>;
  deleteLoopDef(name: string): void;
  /** Audit: a context-policy verdict (e.g. a handoff) fired for a folder. */
  recordContextEvent(folder: string, verdict: string, occupancy: number, at?: number): void;
  listContextEvents(limit?: number): Array<{ folder: string; verdict: string; occupancy: number; at: number }>;
  /** LEARNED cache-TTL input: one (idle gap before a resume, was the prompt cache still warm?)
   *  observation, so the effective staleness TTL can be derived from real behavior instead of a
   *  fixed provider-documented number (see context-policy.ts effectiveCacheTtlMs). */
  recordCacheObservation(gapMs: number, hit: boolean, at?: number): void;
  /** Most recent observations, newest-first, capped by `limit`. */
  listCacheObservations(limit?: number): Array<{ gapMs: number; hit: boolean; at: number }>;
  /** Wipe the resume-target session id for every order in this folder (fresh start after a handoff/clear). */
  clearSessionsFor(folder: string): void;
  /** Persist the map from a sent channel message → the project it belongs to, so a reply to that
   *  message routes back to the right project even after a /reload (source of truth for MessageRoutes). */
  rememberRoute(chatId: number, messageId: number, target: RouteTarget): void;
  /** The project a replied-to message belongs to, or undefined if it isn't tracked (any more). */
  routeFor(chatId: number, messageId: number): RouteTarget | undefined;
  /** Graceful reload: replace the open-session snapshot (what was live at shutdown). */
  saveOpenSessions(rows: OpenSessionRow[]): void;
  /** Read AND clear the snapshot — consumed once at boot so a later boot restores nothing stale. */
  takeOpenSessions(): OpenSessionRow[];
  /** Every recorded outcome for orders in this folder, oldest-first (memory bootstrap: seed a
   *  project's memory log from what the ledger already knows, instead of starting from zero). */
  outcomesForFolder(folder: string): Array<{ orderId: string; status: string; summary: string; at: number }>;
  /** Append one diagnostic event (single cheap INSERT; retention amortised — see EVENTS_KEEP). The
   *  durable trail to diagnose instability from (API retry loops, wedged dispatches, stalls). */
  recordEvent(
    kind: string,
    input?: { orderId?: string; sessionId?: string; folder?: string; data?: Record<string, unknown>; at?: number },
  ): void;
  /** Recent events, newest-first. Filter by kind and/or orderId; capped by `limit` (default 50). */
  listEvents(opts?: { kind?: string; orderId?: string; limit?: number }): EngineEvent[];
  /** Commitments (Phase 5 heartbeat): a follow-up someone promised ("I'll check the deploy
   *  tomorrow"), with a due time the heartbeat checks in on deterministically (commitments.ts). */
  addCommitment(input: { text: string; project: string; dueAt: number; source: CommitmentSource; at?: number }): Commitment;
  /** Commitments in `status` (default "open"), soonest-due first. */
  listCommitments(status?: CommitmentStatus): Commitment[];
  getCommitment(id: number): Commitment | undefined;
  /** Close (done) or drop a commitment. Returns false when the id is unknown. */
  setCommitmentStatus(id: number, status: CommitmentStatus): boolean;
  /** Record that a check-in for this commitment reached the operator (re-ping spacing). */
  markCommitmentCheckin(id: number, at: number): void;
}

export type CommitmentStatus = "open" | "done" | "dropped";
/** Who recorded it: the operator (/remind) or a worker (the `commitment_add` tool). */
export type CommitmentSource = "operator" | "worker";

export interface Commitment {
  id: number;
  text: string;
  /** Project tag it belongs to (folder basename, e.g. "agent" for the company). */
  project: string;
  dueAt: number;
  createdAt: number;
  status: CommitmentStatus;
  source: CommitmentSource;
  /** When the last check-in was delivered; undefined until the first one. */
  lastCheckinAt?: number;
}

/** One structured engine event (diagnostic trail). `data` is small structured metadata —
 *  ids/counts/timings/error codes/short messages — NEVER a full message body. */
export interface EngineEvent {
  kind: string;
  at: number;
  orderId?: string;
  sessionId?: string;
  folder?: string;
  data?: Record<string, unknown>;
}

/** One open session as persisted across a graceful daemon reload. */
export interface OpenSessionRow {
  id: string;
  name: string;
  folder: string;
  chatId: number;
  sdkSessionId: string;
  task: string;
  source: OrderSource;
  createdAt: number;
}

export interface ConversationMessage {
  role: string;
  content: string;
  at: number;
}

export function openLedger(path: string): Ledger {
  const db = new Database(path);
  db.run(
    `CREATE TABLE IF NOT EXISTS orders (
       id TEXT PRIMARY KEY, source TEXT NOT NULL, folder TEXT NOT NULL,
       task TEXT NOT NULL, chat_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
       sdk_session_id TEXT
     )`,
  );
  // Migrate dbs created before sdk_session_id existed.
  const cols = db.query(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "sdk_session_id")) {
    db.run(`ALTER TABLE orders ADD COLUMN sdk_session_id TEXT`);
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
  // Audit trail of context-policy verdicts (handoff/clear) fired per folder.
  db.run(
    `CREATE TABLE IF NOT EXISTS context_events (
       folder TEXT NOT NULL, verdict TEXT NOT NULL, occupancy REAL NOT NULL, at INTEGER NOT NULL
     )`,
  );
  // LEARNED cache-TTL inputs: one row per resume, recording the idle gap beforehand and whether
  // the prompt cache was still warm (see context-policy.ts effectiveCacheTtlMs).
  db.run(
    `CREATE TABLE IF NOT EXISTS cache_observations (
       gap_ms INTEGER NOT NULL, hit INTEGER NOT NULL, at INTEGER NOT NULL
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
  let eventInserts = 0;
  // Commitments: follow-ups with a due time; the heartbeat delivers due check-ins (commitments.ts).
  db.run(
    `CREATE TABLE IF NOT EXISTS commitments (
       id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, project TEXT NOT NULL,
       due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
       source TEXT NOT NULL, last_checkin_at INTEGER
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_commitments_status_due ON commitments (status, due_at)`);
  type CommitmentRow = {
    id: number;
    text: string;
    project: string;
    due_at: number;
    created_at: number;
    status: string;
    source: string;
    last_checkin_at: number | null;
  };
  const toCommitment = (r: CommitmentRow): Commitment => ({
    id: r.id,
    text: r.text,
    project: r.project,
    dueAt: r.due_at,
    createdAt: r.created_at,
    status: r.status as CommitmentStatus,
    source: r.source as CommitmentSource,
    ...(r.last_checkin_at !== null ? { lastCheckinAt: r.last_checkin_at } : {}),
  });

  return {
    recordOrder(o) {
      db.query(
        `INSERT OR REPLACE INTO orders (id, source, folder, task, chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(o.id, o.source, o.folder, o.task, o.chatId, o.createdAt);
    },
    recordOutcome(orderId, status, summary) {
      db.query(
        `INSERT OR REPLACE INTO outcomes (order_id, status, summary, at) VALUES (?, ?, ?, ?)`,
      ).run(orderId, status, summary, Date.now());
    },
    getOutcome(orderId) {
      const row = db
        .query(`SELECT status, summary FROM outcomes WHERE order_id = ?`)
        .get(orderId) as { status: string; summary: string } | null;
      return row ?? undefined;
    },
    recordSession(orderId, sdkSessionId) {
      db.query(`UPDATE orders SET sdk_session_id = ? WHERE id = ?`).run(sdkSessionId, orderId);
    },
    lastSessionFor(folder, chatId) {
      const row = db
        .query(
          `SELECT sdk_session_id FROM orders
           WHERE folder = ? AND chat_id = ? AND sdk_session_id IS NOT NULL AND sdk_session_id != ''
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(folder, chatId) as { sdk_session_id: string } | null;
      return row?.sdk_session_id ?? undefined;
    },
    listRecent(limit = 20) {
      const rows = db
        .query(
          `SELECT id, source, folder, task, chat_id, created_at
           FROM orders ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        id: string;
        source: string;
        folder: string;
        task: string;
        chat_id: number;
        created_at: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        source: r.source as OrderSource,
        folder: r.folder,
        task: r.task,
        chatId: r.chat_id,
        createdAt: r.created_at,
      }));
    },
    recordAutoApproval(orderId, reason) {
      db.query(`INSERT INTO auto_approvals (order_id, reason, at) VALUES (?, ?, ?)`).run(orderId, reason, Date.now());
    },
    autoApprovalsFor(orderId) {
      return (
        db.query(`SELECT reason FROM auto_approvals WHERE order_id = ? ORDER BY at, rowid`).all(orderId) as Array<{ reason: string }>
      ).map((r) => r.reason);
    },
    recordMessage(chatId, role, content) {
      db.query(`INSERT INTO messages (chat_id, role, content, at) VALUES (?, ?, ?, ?)`).run(
        chatId,
        role,
        content,
        Date.now(),
      );
    },
    conversation(chatId, limit = 500) {
      // Pull the most recent `limit` (rowid breaks ties when many share one ms), then re-sort
      // oldest-first so the result reads as a transcript.
      const rows = db
        .query(
          `SELECT role, content, at FROM (
             SELECT rowid, role, content, at FROM messages
             WHERE chat_id = ? ORDER BY at DESC, rowid DESC LIMIT ?
           ) ORDER BY at ASC, rowid ASC`,
        )
        .all(chatId, limit) as Array<{ role: string; content: string; at: number }>;
      return rows;
    },
    getLastRun(name) {
      const row = db.query(`SELECT last_run FROM loop_state WHERE name = ?`).get(name) as
        | { last_run: number | null }
        | null;
      return row && row.last_run != null ? row.last_run : undefined;
    },
    setLastRun(name, at) {
      db.query(
        `INSERT INTO loop_state (name, last_run) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run`,
      ).run(name, at);
    },
    isEnabled(name) {
      const row = db.query(`SELECT enabled FROM loop_state WHERE name = ?`).get(name) as
        | { enabled: number | null }
        | null;
      return row && row.enabled != null ? row.enabled === 1 : undefined;
    },
    setEnabled(name, on) {
      db.query(
        `INSERT INTO loop_state (name, enabled) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled`,
      ).run(name, on ? 1 : 0);
    },
    saveLoopDef(name, json) {
      db.query(
        `INSERT INTO loop_defs (name, json) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET json = excluded.json`,
      ).run(name, json);
    },
    listLoopDefs() {
      return db.query(`SELECT name, json FROM loop_defs ORDER BY name`).all() as Array<{ name: string; json: string }>;
    },
    deleteLoopDef(name) {
      db.query(`DELETE FROM loop_defs WHERE name = ?`).run(name);
      db.query(`DELETE FROM loop_state WHERE name = ?`).run(name);
    },
    recordEvent(kind, input = {}) {
      db.query(`INSERT INTO events (kind, at, order_id, session_id, folder, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
        kind,
        input.at ?? Date.now(),
        input.orderId ?? null,
        input.sessionId ?? null,
        input.folder ?? null,
        input.data ? JSON.stringify(input.data) : null,
      );
      // Amortised retention: prune only every EVENTS_PRUNE_INTERVAL inserts, so the common path
      // stays a single insert (never a DELETE-per-insert).
      if (++eventInserts % EVENTS_PRUNE_INTERVAL === 0) {
        db.query(
          `DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY at DESC, rowid DESC LIMIT ?)`,
        ).run(EVENTS_KEEP);
      }
    },
    listEvents(opts = {}) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (opts.kind) {
        where.push("kind = ?");
        params.push(opts.kind);
      }
      if (opts.orderId) {
        where.push("order_id = ?");
        params.push(opts.orderId);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      params.push(opts.limit ?? 50);
      const rows = db
        .query(
          `SELECT kind, at, order_id, session_id, folder, data FROM events ${clause} ORDER BY at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params) as Array<{
        kind: string;
        at: number;
        order_id: string | null;
        session_id: string | null;
        folder: string | null;
        data: string | null;
      }>;
      return rows.map((r) => {
        let data: Record<string, unknown> | undefined;
        if (r.data) {
          try {
            data = JSON.parse(r.data);
          } catch {
            data = undefined; // tolerate a corrupt blob
          }
        }
        return {
          kind: r.kind,
          at: r.at,
          orderId: r.order_id ?? undefined,
          sessionId: r.session_id ?? undefined,
          folder: r.folder ?? undefined,
          data,
        };
      });
    },
    recordContextEvent(folder, verdict, occupancy, at = Date.now()) {
      db.query(
        `INSERT INTO context_events (folder, verdict, occupancy, at) VALUES (?, ?, ?, ?)`,
      ).run(folder, verdict, occupancy, at);
    },
    listContextEvents(limit = 50) {
      return db
        .query(`SELECT folder, verdict, occupancy, at FROM context_events ORDER BY at DESC LIMIT ?`)
        .all(limit) as Array<{ folder: string; verdict: string; occupancy: number; at: number }>;
    },
    recordCacheObservation(gapMs, hit, at = Date.now()) {
      db.query(`INSERT INTO cache_observations (gap_ms, hit, at) VALUES (?, ?, ?)`).run(gapMs, hit ? 1 : 0, at);
    },
    listCacheObservations(limit = CACHE_OBS_WINDOW) {
      // rowid DESC breaks ties for observations recorded within the same millisecond.
      return (
        db
          .query(`SELECT gap_ms, hit, at FROM cache_observations ORDER BY at DESC, rowid DESC LIMIT ?`)
          .all(limit) as Array<{ gap_ms: number; hit: number; at: number }>
      ).map((r) => ({ gapMs: r.gap_ms, hit: r.hit === 1, at: r.at }));
    },
    saveOpenSessions(rows) {
      db.run(`DELETE FROM open_sessions`);
      const insert = db.query(
        `INSERT INTO open_sessions (id, name, folder, chat_id, sdk_session_id, task, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) insert.run(r.id, r.name, r.folder, r.chatId, r.sdkSessionId, r.task, r.source, r.createdAt);
    },
    takeOpenSessions() {
      const rows = db
        .query(
          `SELECT id, name, folder, chat_id, sdk_session_id, task, source, created_at
           FROM open_sessions ORDER BY created_at`,
        )
        .all() as Array<{
        id: string;
        name: string;
        folder: string;
        chat_id: number;
        sdk_session_id: string;
        task: string;
        source: string;
        created_at: number;
      }>;
      db.run(`DELETE FROM open_sessions`);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        folder: r.folder,
        chatId: r.chat_id,
        sdkSessionId: r.sdk_session_id,
        task: r.task,
        source: r.source as OrderSource,
        createdAt: r.created_at,
      }));
    },
    clearSessionsFor(folder) {
      // Sessions are stored as sdk_session_id on the orders row; wipe the resume target for
      // every order in this folder, so lastSessionFor(folder, *) returns undefined afterward.
      db.query(`UPDATE orders SET sdk_session_id = NULL WHERE folder = ?`).run(folder);
    },
    rememberRoute(chatId, messageId, target) {
      db.query(
        `INSERT INTO message_routes (chat_id, message_id, session_id, folder, project, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           session_id = excluded.session_id, folder = excluded.folder,
           project = excluded.project, at = excluded.at`,
      ).run(chatId, messageId, target.sessionId, target.folder, target.project, Date.now());
      // Bound the table: drop the oldest rows past a generous keep-window (source of truth stays intact).
      db.query(
        `DELETE FROM message_routes WHERE rowid NOT IN (
           SELECT rowid FROM message_routes ORDER BY at DESC, rowid DESC LIMIT ?
         )`,
      ).run(ROUTE_KEEP);
    },
    routeFor(chatId, messageId) {
      const row = db
        .query(`SELECT session_id, folder, project FROM message_routes WHERE chat_id = ? AND message_id = ?`)
        .get(chatId, messageId) as { session_id: string; folder: string; project: string } | null;
      return row ? { sessionId: row.session_id, folder: row.folder, project: row.project } : undefined;
    },
    addCommitment(input) {
      const at = input.at ?? Date.now();
      const row = db
        .query(
          `INSERT INTO commitments (text, project, due_at, created_at, status, source)
           VALUES (?, ?, ?, ?, 'open', ?) RETURNING *`,
        )
        .get(input.text, input.project, input.dueAt, at, input.source) as CommitmentRow;
      return toCommitment(row);
    },
    listCommitments(status = "open") {
      return (
        db.query(`SELECT * FROM commitments WHERE status = ? ORDER BY due_at ASC, id ASC`).all(status) as CommitmentRow[]
      ).map(toCommitment);
    },
    getCommitment(id) {
      const row = db.query(`SELECT * FROM commitments WHERE id = ?`).get(id) as CommitmentRow | null;
      return row ? toCommitment(row) : undefined;
    },
    setCommitmentStatus(id, status) {
      return db.query(`UPDATE commitments SET status = ? WHERE id = ?`).run(status, id).changes > 0;
    },
    markCommitmentCheckin(id, at) {
      db.query(`UPDATE commitments SET last_checkin_at = ? WHERE id = ?`).run(at, id);
    },
    outcomesForFolder(folder) {
      const rows = db
        .query(
          `SELECT o.order_id as order_id, o.status as status, o.summary as summary, o.at as at
           FROM outcomes o JOIN orders ord ON ord.id = o.order_id
           WHERE ord.folder = ?
           ORDER BY o.at ASC`,
        )
        .all(folder) as Array<{ order_id: string; status: string; summary: string; at: number }>;
      return rows.map((r) => ({ orderId: r.order_id, status: r.status, summary: r.summary, at: r.at }));
    },
  };
}
