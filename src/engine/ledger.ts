// Durable record of orders and their outcomes. The deterministic bookkeeping layer —
// the part of operant that already was an "engine" (ported to bun:sqlite, trimmed).
import { Database } from "bun:sqlite";
import type { Order, OrderSource, Provider, RouteTarget } from "../types";
import { CACHE_OBS_WINDOW } from "./context-policy";
import type { StructuredAsk } from "./structured-question";

/** Generous cap on persisted reply-routes — the ledger is the source of truth, so this only bounds
 *  ancient rows the operator will never reply to. One tiny row per sent worker message. */
export const ROUTE_KEEP = 20_000;

/** Diagnostic event-log retention: prune in coarse batches so the hot path stays a single insert. */
export const EVENTS_KEEP = 50_000;
export const EVENTS_PRUNE_INTERVAL = 1000;

/** Pending-decisions retention: decisions are low-volume, so keep a generous window of resolved
 *  (answered/dismissed) rows; OPEN rows are never pruned. Pruned in amortised batches. */
export const DECISIONS_KEEP = 5_000;
export const DECISIONS_PRUNE_INTERVAL = 200;
/** Delivered dispatcher-inbox rows kept as history (pending rows are never pruned). */
export const DISPATCHER_INBOX_KEEP = 500;

/** A blocking question / alert the operator must act on — the durable pending-decisions queue.
 *  `kind:"decision"` needs an answer (a worker question or a governor escalation); `kind:"alert"`
 *  just needs acknowledging (a failure). `options`, when set, are tappable answers the frontend
 *  renders as an inline keyboard. */
export interface NewDecision {
  kind: "decision" | "alert";
  project?: string;
  folder?: string;
  orderId?: string;
  sessionId?: string;
  chatId?: number;
  question: string;
  options?: string[];
  /** A structured multi-question / multi-select ask (Feature 1). When set, the frontend renders the
   *  richer keyboard from this and accumulates a selection; `options` remains the simple flat form. */
  spec?: StructuredAsk;
}

export interface DecisionRow extends NewDecision {
  id: string;
  status: "open" | "answered" | "dismissed";
  createdAt: number;
  answeredAt?: number;
  answer?: string;
  /** The channel the decision message was posted in + its message id — so a REPLY to it resolves
   *  the decision (decisionByMessage) and a later edit can mark it answered. */
  decisionChatId?: number;
  decisionMessageId?: number;
  lastRemindedAt?: number;
  reminderCount: number;
}

export interface Ledger {
  recordOrder(order: Order): void;
  recordOutcome(orderId: string, status: string, summary: string): void;
  getOutcome(orderId: string): { status: string; summary: string } | undefined;
  /** Persist the worker's SDK session id against an order, so it can later be resumed. `provider`
   *  records WHICH SDK minted it — a session id is only meaningful to the SDK that issued it. */
  recordSession(orderId: string, sdkSessionId: string, provider?: Provider): void;
  /** The most recently recorded SDK session id for a folder/chat (for resume), if any. When
   *  `provider` is given, ids minted by a DIFFERENT SDK are skipped: handing a Codex thread id to
   *  the Claude SDK (or vice versa) fails the run outright ("No conversation found with session
   *  ID"). Ids recorded before ownership was tracked have no owner and are still returned — see
   *  canResumeWith for why unknown ownership is tried rather than discarded. */
  lastSessionFor(folder: string, chatId: number, provider?: Provider): string | undefined;
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
  /** Enqueue a pending decision/alert. Returns its id. The queue survives a daemon restart. */
  openDecision(rec: NewDecision, at?: number): string;
  /** Record the channel + message id a decision was posted to (after the frontend sends it), so a
   *  reply to that message can resolve it. */
  setDecisionMessage(id: string, chatId: number, messageId: number): void;
  /** Open (unanswered) decisions/alerts, oldest-first — the secretary digest + /decisions read this. */
  listOpenDecisions(): DecisionRow[];
  /** The decision a replied-to channel message belongs to (the operator answered by replying). */
  decisionByMessage(chatId: number, messageId: number): DecisionRow | undefined;
  /** A decision by its id (the tappable-answer callback carries the id directly). */
  decisionById(id: string): DecisionRow | undefined;
  /** Mark a decision answered + record the answer (the operator answered / a button was tapped). */
  resolveDecision(id: string, answer: string, at?: number): void;
  /** Close an alert (or a decision) without an answer — the operator acknowledged it. */
  dismissDecision(id: string): void;
  /** Stamp the reminder fields (lastRemindedAt + reminderCount++) after a secretary digest. */
  noteDecisionsReminded(ids: string[], at?: number): void;
  /** Dispatcher inbox (ADR-0007): queue one final dispatch result for the company. Returns its id.
   *  It stays pending until delivered, so a reload or a closed company session cannot lose it. */
  queueDispatcherReport(project: string, text: string, at?: number): number;
  /** Pending (undelivered) dispatcher reports, oldest first. */
  pendingDispatcherReports(): DispatcherReport[];
  /** Mark reports delivered (`at`), or back to pending (`null`) when a delivery failed. */
  setDispatcherReportsDelivered(ids: number[], at: number | null): void;
  /** Dispatches that recorded `dispatch_start` at or after `since` but never `dispatch_end` — the
   *  daemon died or was reloaded during them. Oldest first. */
  unfinishedDispatches(since: number): Array<{ orderId: string; folder?: string; project?: string; at: number }>;
}

/** One queued final dispatch result for the dispatcher (the company). */
export interface DispatcherReport {
  id: number;
  project: string;
  text: string;
  at: number;
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
  /** Which SDK minted `sdkSessionId` — carried across the reload so the restored session resumes
   *  under its own SDK and never hands the id to a different one. */
  sdkProvider?: Provider;
  task: string;
  source: OrderSource;
  createdAt: number;
}

export interface ConversationMessage {
  role: string;
  content: string;
  at: number;
}

/** The daemon's ledger DB, relative to its working directory. The ONE place this path is written:
 *  anything that must read or write the SAME ledger the running daemon uses imports this rather
 *  than repeating the literal (the daemon, the memory bootstrap, tools/create-loop). */
export const LEDGER_PATH = "data/ledger.db";

/** Retention caps default to the module constants (behavior-preserving); the daemon passes the
 *  operator-configured `routeKeep`/`eventsKeep` so these bounds are tuning, not baked-in. */
export function openLedger(
  path: string,
  opts: { routeKeep?: number; eventsKeep?: number; decisionsKeep?: number } = {},
): Ledger {
  const db = new Database(path);
  const routeKeep = opts.routeKeep ?? ROUTE_KEEP;
  const eventsKeep = opts.eventsKeep ?? EVENTS_KEEP;
  const decisionsKeep = opts.decisionsKeep ?? DECISIONS_KEEP;
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
  let decisionCloses = 0;

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
    recordSession(orderId, sdkSessionId, provider) {
      db.query(`UPDATE orders SET sdk_session_id = ?, sdk_provider = ? WHERE id = ?`).run(
        sdkSessionId,
        provider ?? null,
        orderId,
      );
    },
    lastSessionFor(folder, chatId, provider) {
      const row = db
        .query(
          `SELECT sdk_session_id FROM orders
           WHERE folder = ? AND chat_id = ? AND sdk_session_id IS NOT NULL AND sdk_session_id != ''
             AND (?3 IS NULL OR sdk_provider IS NULL OR sdk_provider = ?3)
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(folder, chatId, provider ?? null) as { sdk_session_id: string } | null;
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
        ).run(eventsKeep);
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
        `INSERT INTO open_sessions (id, name, folder, chat_id, sdk_session_id, sdk_provider, task, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows)
        insert.run(r.id, r.name, r.folder, r.chatId, r.sdkSessionId, r.sdkProvider ?? null, r.task, r.source, r.createdAt);
    },
    takeOpenSessions() {
      const rows = db
        .query(
          `SELECT id, name, folder, chat_id, sdk_session_id, sdk_provider, task, source, created_at
           FROM open_sessions ORDER BY created_at`,
        )
        .all() as Array<{
        id: string;
        name: string;
        folder: string;
        chat_id: number;
        sdk_session_id: string;
        sdk_provider: string | null;
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
        sdkProvider: (r.sdk_provider as Provider | null) ?? undefined,
        task: r.task,
        source: r.source as OrderSource,
        createdAt: r.created_at,
      }));
    },
    clearSessionsFor(folder) {
      // Sessions are stored as sdk_session_id on the orders row; wipe the resume target for
      // every order in this folder, so lastSessionFor(folder, *) returns undefined afterward.
      db.query(`UPDATE orders SET sdk_session_id = NULL, sdk_provider = NULL WHERE folder = ?`).run(folder);
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
      ).run(routeKeep);
    },
    routeFor(chatId, messageId) {
      const row = db
        .query(`SELECT session_id, folder, project FROM message_routes WHERE chat_id = ? AND message_id = ?`)
        .get(chatId, messageId) as { session_id: string; folder: string; project: string } | null;
      return row ? { sessionId: row.session_id, folder: row.folder, project: row.project } : undefined;
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
    openDecision(rec, at = Date.now()) {
      const id = crypto.randomUUID();
      db.query(
        `INSERT INTO decisions
           (id, kind, project, folder, order_id, session_id, chat_id, question, options, spec, status, created_at, reminder_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 0)`,
      ).run(
        id,
        rec.kind,
        rec.project ?? null,
        rec.folder ?? null,
        rec.orderId ?? null,
        rec.sessionId ?? null,
        rec.chatId ?? null,
        rec.question,
        rec.options && rec.options.length ? JSON.stringify(rec.options) : null,
        rec.spec ? JSON.stringify(rec.spec) : null,
        at,
      );
      return id;
    },
    setDecisionMessage(id, chatId, messageId) {
      db.query(`UPDATE decisions SET decision_chat_id = ?, decision_message_id = ? WHERE id = ?`).run(
        chatId,
        messageId,
        id,
      );
    },
    listOpenDecisions() {
      const rows = db
        .query(`SELECT * FROM decisions WHERE status = 'open' ORDER BY created_at ASC, rowid ASC`)
        .all() as DecisionDbRow[];
      return rows.map(mapDecisionRow);
    },
    decisionByMessage(chatId, messageId) {
      const row = db
        .query(`SELECT * FROM decisions WHERE decision_chat_id = ? AND decision_message_id = ?`)
        .get(chatId, messageId) as DecisionDbRow | null;
      return row ? mapDecisionRow(row) : undefined;
    },
    decisionById(id) {
      const row = db.query(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionDbRow | null;
      return row ? mapDecisionRow(row) : undefined;
    },
    resolveDecision(id, answer, at = Date.now()) {
      db.query(`UPDATE decisions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?`).run(answer, at, id);
      pruneDecisions();
    },
    dismissDecision(id) {
      db.query(`UPDATE decisions SET status = 'dismissed', answered_at = ? WHERE id = ?`).run(Date.now(), id);
      pruneDecisions();
    },
    noteDecisionsReminded(ids, at = Date.now()) {
      if (ids.length === 0) return;
      const stmt = db.query(
        `UPDATE decisions SET last_reminded_at = ?, reminder_count = reminder_count + 1 WHERE id = ?`,
      );
      for (const id of ids) stmt.run(at, id);
    },
    queueDispatcherReport(project, text, at = Date.now()) {
      const r = db
        .query(`INSERT INTO dispatcher_inbox (project, text, at) VALUES (?, ?, ?) RETURNING id`)
        .get(project, text, at) as { id: number };
      // Delivered rows are history only — keep the newest DISPATCHER_INBOX_KEEP of them.
      db.query(
        `DELETE FROM dispatcher_inbox WHERE delivered_at IS NOT NULL AND id NOT IN
           (SELECT id FROM dispatcher_inbox WHERE delivered_at IS NOT NULL ORDER BY id DESC LIMIT ?)`,
      ).run(DISPATCHER_INBOX_KEEP);
      return r.id;
    },
    pendingDispatcherReports() {
      return db
        .query(`SELECT id, project, text, at FROM dispatcher_inbox WHERE delivered_at IS NULL ORDER BY id`)
        .all() as DispatcherReport[];
    },
    setDispatcherReportsDelivered(ids, at) {
      const q = db.query(`UPDATE dispatcher_inbox SET delivered_at = ? WHERE id = ?`);
      for (const id of ids) q.run(at, id);
    },
    unfinishedDispatches(since) {
      const rows = db
        .query(
          `SELECT s.order_id AS order_id, s.folder AS folder, s.data AS data, s.at AS at FROM events s
           WHERE s.kind = 'dispatch_start' AND s.at >= ? AND s.order_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind = 'dispatch_end' AND e.order_id = s.order_id)
           ORDER BY s.at, s.rowid`,
        )
        .all(since) as Array<{ order_id: string; folder: string | null; data: string | null; at: number }>;
      return rows.map((r) => {
        let project: string | undefined;
        try {
          const d = r.data ? (JSON.parse(r.data) as { project?: unknown }) : undefined;
          if (typeof d?.project === "string") project = d.project;
        } catch {
          // tolerate a corrupt blob — the folder still identifies the run
        }
        return { orderId: r.order_id, folder: r.folder ?? undefined, project, at: r.at };
      });
    },
  };

  /** Amortised retention for the low-volume decisions queue: only ever drop CLOSED
   *  (answered/dismissed) rows past the keep-window; OPEN rows are never pruned. Runs every
   *  DECISIONS_PRUNE_INTERVAL closes so the common resolve/dismiss stays a single UPDATE. */
  function pruneDecisions(): void {
    if (++decisionCloses % DECISIONS_PRUNE_INTERVAL !== 0) return;
    db.query(
      `DELETE FROM decisions WHERE status != 'open' AND rowid NOT IN (
         SELECT rowid FROM decisions WHERE status != 'open' ORDER BY COALESCE(answered_at, created_at) DESC, rowid DESC LIMIT ?
       )`,
    ).run(decisionsKeep);
  }
}

/** The raw decisions row shape as stored in SQLite (snake_case, nullable columns). */
interface DecisionDbRow {
  id: string;
  kind: string;
  project: string | null;
  folder: string | null;
  order_id: string | null;
  session_id: string | null;
  chat_id: number | null;
  question: string;
  options: string | null;
  spec: string | null;
  status: string;
  created_at: number;
  answered_at: number | null;
  answer: string | null;
  decision_chat_id: number | null;
  decision_message_id: number | null;
  last_reminded_at: number | null;
  reminder_count: number;
}

/** Map a stored decisions row to the public DecisionRow (drops nulls, parses the options JSON). */
function mapDecisionRow(r: DecisionDbRow): DecisionRow {
  let options: string[] | undefined;
  if (r.options) {
    try {
      const parsed = JSON.parse(r.options);
      if (Array.isArray(parsed)) options = parsed as string[];
    } catch {
      options = undefined; // tolerate a corrupt blob
    }
  }
  let spec: StructuredAsk | undefined;
  if (r.spec) {
    try {
      const parsed = JSON.parse(r.spec);
      if (parsed && Array.isArray(parsed.questions)) spec = parsed as StructuredAsk;
    } catch {
      spec = undefined; // tolerate a corrupt blob
    }
  }
  return {
    id: r.id,
    kind: r.kind as "decision" | "alert",
    project: r.project ?? undefined,
    folder: r.folder ?? undefined,
    orderId: r.order_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    chatId: r.chat_id ?? undefined,
    question: r.question,
    options,
    spec,
    status: r.status as DecisionRow["status"],
    createdAt: r.created_at,
    answeredAt: r.answered_at ?? undefined,
    answer: r.answer ?? undefined,
    decisionChatId: r.decision_chat_id ?? undefined,
    decisionMessageId: r.decision_message_id ?? undefined,
    lastRemindedAt: r.last_reminded_at ?? undefined,
    reminderCount: r.reminder_count,
  };
}
