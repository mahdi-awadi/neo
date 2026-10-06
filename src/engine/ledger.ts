// Durable record of orders and their outcomes. The deterministic bookkeeping layer —
// the part of operant that already was an "engine" (ported to bun:sqlite, trimmed).
import { Database } from "bun:sqlite";
import { openSqlite } from "./sqlite";
import { migrate } from "./ledger-migrations";
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
  /** Every distinct folder an order was ever recorded for, sorted (the projects Neo has seen). */
  folders(): string[];
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
  /** One context reset or its follow-up (ADR-0021): `handoff`, `clear`, `deferred`, `resumed`
   *  (a fresh session started from a handoff note) or `fresh` (a loop started fresh). Returns the
   *  row id, so a later measurement can fill in its detail. */
  recordContextEvent(folder: string, verdict: string, occupancy: number, at?: number, extra?: ContextEventExtra): number;
  /** Newest first. A number is the legacy `limit`. */
  listContextEvents(opts?: number | { folder?: string; limit?: number }): ContextEventRow[];
  /** Merge `detail` into a context event's detail (e.g. a resumed session's orientation). */
  updateContextEventDetail(id: number, detail: Record<string, unknown>): void;
  /** The folder's newest `handoff` that no `resumed` (or later `clear`) row has followed yet — the
   *  note a fresh session there must start from. */
  pendingHandoff(folder: string): ContextEventRow | undefined;
  /** LEARNED cache-TTL input: one (idle gap before a resume, was the prompt cache still warm?)
   *  observation, so the effective staleness TTL can be derived from real behavior instead of a
   *  fixed provider-documented number (see context-policy.ts effectiveCacheTtlMs). */
  recordCacheObservation(gapMs: number, hit: boolean, at?: number): void;
  /** Most recent observations, newest-first, capped by `limit`. */
  listCacheObservations(limit?: number): Array<{ gapMs: number; hit: boolean; at: number }>;
  /** The SDK-reported context window of `model` (its canonical id) as of `at` (ADR-0013). */
  recordModelWindow(model: string, tokens: number, at?: number): void;
  /** The newest SDK-reported context window per model: canonical model id → tokens. */
  modelWindows(): Record<string, number>;
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
  /** `SELECT 1` — throws when the database cannot be read (the health check, ADR-0010). */
  ping(): void;
  /** Pending (undelivered) dispatcher reports, oldest first. */
  pendingDispatcherReports(): DispatcherReport[];
  /** Mark reports delivered (`at`), or back to pending (`null`) when a delivery failed. */
  setDispatcherReportsDelivered(ids: number[], at: number | null): void;
  /** Dispatches that recorded `dispatch_start` at or after `since` but never `dispatch_end` — the
   *  daemon died or was reloaded during them. Oldest first. */
  unfinishedDispatches(since: number): Array<{ orderId: string; folder?: string; project?: string; at: number }>;
  /** Todo queue (ADR-0008): add one todo at the END of its project's queue. */
  addTodo(rec: NewTodo, at?: number): TodoRow;
  todoById(id: number): TodoRow | undefined;
  /** The todo a dispatch order belongs to (its run's end releases the queue). */
  todoByOrder(orderId: string): TodoRow | undefined;
  /** Todos filtered by folder and/or status. Queued ones come in queue order; others newest first.
   *  `limit` caps the result. */
  listTodos(opts: { folder?: string; statuses?: TodoStatus[]; limit?: number }): TodoRow[];
  updateTodo(id: number, patch: Partial<Pick<TodoRow, "status" | "orderId" | "result" | "startedAt" | "endedAt">>): void;
  /** Move a queued todo to a 1-based position among its project's queued todos (clamped). */
  moveTodo(id: number, position: number): void;
  /** Folders that have at least one queued todo, oldest queue head first. */
  queuedTodoFolders(): string[];
  /** Pause (`reason`) or resume (`null`) a project's queue. */
  setTodoPaused(folder: string, reason: string | null, at?: number): void;
  todoPaused(folder: string): { reason: string; at: number } | undefined;
}

export type TodoStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** A brief handed to the todo queue. `createdBy` follows the work class: an operator turn → operator. */
export interface NewTodo {
  project: string;
  folder: string;
  brief: string;
  team?: "frontend-backend";
  workClass: "interactive" | "background";
  createdBy: "operator" | "company";
}

export interface TodoRow extends NewTodo {
  id: number;
  status: TodoStatus;
  position: number;
  createdAt: number;
  orderId?: string;
  result?: string;
  startedAt?: number;
  endedAt?: number;
}

/** Finished (done/failed/cancelled) todos kept as history; queued and running ones are never pruned. */
export const TODOS_KEEP = 1_000;

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
/** What a context event carries beyond its verdict (ADR-0021). */
export interface ContextEventExtra {
  reason?: string;
  boundary?: string;
  sessionId?: string;
  detail?: Record<string, unknown>;
}

export interface ContextEventRow extends ContextEventExtra {
  id: number;
  folder: string;
  verdict: string;
  occupancy: number;
  at: number;
}

interface ContextEventDbRow {
  id: number;
  folder: string;
  verdict: string;
  occupancy: number;
  at: number;
  reason: string | null;
  boundary: string | null;
  session_id: string | null;
  detail: string | null;
}

function parseDetail(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined; // tolerate a corrupt blob
  }
}

function contextEventRow(r: ContextEventDbRow): ContextEventRow {
  return {
    id: r.id,
    folder: r.folder,
    verdict: r.verdict,
    occupancy: r.occupancy,
    at: r.at,
    reason: r.reason ?? undefined,
    boundary: r.boundary ?? undefined,
    sessionId: r.session_id ?? undefined,
    detail: parseDetail(r.detail),
  };
}

export function openLedger(
  path: string,
  opts: { routeKeep?: number; eventsKeep?: number; decisionsKeep?: number; busyTimeoutMs?: number } = {},
): Ledger {
  const db = openSqlite(path, { busyTimeoutMs: opts.busyTimeoutMs });
  const routeKeep = opts.routeKeep ?? ROUTE_KEEP;
  const eventsKeep = opts.eventsKeep ?? EVENTS_KEEP;
  const decisionsKeep = opts.decisionsKeep ?? DECISIONS_KEEP;
  migrate(db, { path });
  let eventInserts = 0;
  let decisionCloses = 0;

  const todoById = (id: number): TodoRow | undefined => {
    const r = db.query(`SELECT * FROM project_todos WHERE id = ?`).get(id) as TodoDbRow | null;
    return r ? mapTodoRow(r) : undefined;
  };

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
    folders() {
      return (db.query(`SELECT DISTINCT folder FROM orders ORDER BY folder`).all() as Array<{ folder: string }>).map(
        (r) => r.folder,
      );
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
    recordContextEvent(folder, verdict, occupancy, at = Date.now(), extra = {}) {
      const r = db
        .query(
          `INSERT INTO context_events (folder, verdict, occupancy, at, reason, boundary, session_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(folder, verdict, occupancy, at, extra.reason ?? null, extra.boundary ?? null, extra.sessionId ?? null, extra.detail ? JSON.stringify(extra.detail) : null);
      return Number(r.lastInsertRowid);
    },
    listContextEvents(opts = {}) {
      const { folder, limit = 50 } = typeof opts === "number" ? { limit: opts } : opts;
      const rows = (
        folder === undefined
          ? db.query(`SELECT rowid AS id, * FROM context_events ORDER BY at DESC, rowid DESC LIMIT ?`).all(limit)
          : db.query(`SELECT rowid AS id, * FROM context_events WHERE folder = ? ORDER BY at DESC, rowid DESC LIMIT ?`).all(folder, limit)
      ) as ContextEventDbRow[];
      return rows.map(contextEventRow);
    },
    updateContextEventDetail(id, detail) {
      const row = db.query(`SELECT detail FROM context_events WHERE rowid = ?`).get(id) as { detail: string | null } | null;
      if (!row) return;
      const merged = { ...parseDetail(row.detail), ...detail };
      db.query(`UPDATE context_events SET detail = ? WHERE rowid = ?`).run(JSON.stringify(merged), id);
    },
    pendingHandoff(folder) {
      const row = db
        .query(`SELECT rowid AS id, * FROM context_events WHERE folder = ? AND verdict IN ('handoff', 'resumed', 'clear') ORDER BY at DESC, rowid DESC LIMIT 1`)
        .get(folder) as ContextEventDbRow | null;
      return row && row.verdict === "handoff" ? contextEventRow(row) : undefined;
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
    recordModelWindow(model, tokens, at = Date.now()) {
      db.query(
        `INSERT INTO model_windows (model, tokens, at) VALUES (?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET tokens = excluded.tokens, at = excluded.at WHERE excluded.at >= model_windows.at`,
      ).run(model, tokens, at);
    },
    modelWindows() {
      const rows = db.query(`SELECT model, tokens FROM model_windows`).all() as Array<{ model: string; tokens: number }>;
      return Object.fromEntries(rows.map((r) => [r.model, r.tokens]));
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
    ping() {
      db.query("SELECT 1").get();
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
    addTodo(rec, at = Date.now()) {
      const { next } = db
        .query(`SELECT COALESCE(MAX(position), 0) + 1 AS next FROM project_todos WHERE folder = ? AND status = 'queued'`)
        .get(rec.folder) as { next: number };
      const r = db
        .query(
          `INSERT INTO project_todos (project, folder, brief, team, work_class, created_by, created_at, status, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING id`,
        )
        .get(rec.project, rec.folder, rec.brief, rec.team ?? null, rec.workClass, rec.createdBy, at, next) as { id: number };
      return todoById(r.id)!;
    },
    todoById,
    todoByOrder(orderId) {
      const r = db.query(`SELECT * FROM project_todos WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(orderId) as TodoDbRow | null;
      return r ? mapTodoRow(r) : undefined;
    },
    listTodos(opts) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (opts.folder) {
        where.push("folder = ?");
        params.push(opts.folder);
      }
      if (opts.statuses?.length) {
        where.push(`status IN (${opts.statuses.map(() => "?").join(", ")})`);
        params.push(...opts.statuses);
      }
      params.push(opts.limit ?? -1);
      const rows = db
        .query(
          `SELECT * FROM project_todos ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                    CASE WHEN status = 'queued' THEN position END ASC,
                    COALESCE(ended_at, created_at) DESC, id DESC
           LIMIT ?`,
        )
        .all(...params) as TodoDbRow[];
      return rows.map(mapTodoRow);
    },
    updateTodo(id, patch) {
      const cols: Record<string, string> = { status: "status", orderId: "order_id", result: "result", startedAt: "started_at", endedAt: "ended_at" };
      const sets = Object.entries(patch).filter(([k, v]) => k in cols && v !== undefined);
      if (sets.length === 0) return;
      db.query(`UPDATE project_todos SET ${sets.map(([k]) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(
        ...sets.map(([, v]) => v as string | number),
        id,
      );
      if (patch.status === "done" || patch.status === "failed" || patch.status === "cancelled") {
        db.query(
          `DELETE FROM project_todos WHERE status IN ('done','failed','cancelled') AND id NOT IN
             (SELECT id FROM project_todos WHERE status IN ('done','failed','cancelled') ORDER BY id DESC LIMIT ?)`,
        ).run(TODOS_KEEP);
      }
    },
    moveTodo(id, position) {
      const t = todoById(id);
      if (!t || t.status !== "queued") return;
      const ids = (
        db.query(`SELECT id FROM project_todos WHERE folder = ? AND status = 'queued' ORDER BY position, id`).all(t.folder) as Array<{ id: number }>
      )
        .map((r) => r.id)
        .filter((x) => x !== id);
      ids.splice(Math.max(0, Math.min(ids.length, position - 1)), 0, id);
      const q = db.query(`UPDATE project_todos SET position = ? WHERE id = ?`);
      db.transaction(() => ids.forEach((x, i) => q.run(i + 1, x)))();
    },
    queuedTodoFolders() {
      return (
        db
          .query(`SELECT folder, MIN(id) AS first FROM project_todos WHERE status = 'queued' GROUP BY folder ORDER BY first`)
          .all() as Array<{ folder: string }>
      ).map((r) => r.folder);
    },
    setTodoPaused(folder, reason, at = Date.now()) {
      if (reason === null) db.query(`DELETE FROM todo_paused WHERE folder = ?`).run(folder);
      else
        db.query(
          `INSERT INTO todo_paused (folder, reason, at) VALUES (?, ?, ?)
           ON CONFLICT(folder) DO UPDATE SET reason = excluded.reason, at = excluded.at`,
        ).run(folder, reason, at);
    },
    todoPaused(folder) {
      return (db.query(`SELECT reason, at FROM todo_paused WHERE folder = ?`).get(folder) as { reason: string; at: number } | null) ?? undefined;
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

/** The raw project_todos row shape as stored in SQLite. */
interface TodoDbRow {
  id: number;
  project: string;
  folder: string;
  brief: string;
  team: string | null;
  work_class: string;
  created_by: string;
  created_at: number;
  status: string;
  position: number;
  order_id: string | null;
  result: string | null;
  started_at: number | null;
  ended_at: number | null;
}

function mapTodoRow(r: TodoDbRow): TodoRow {
  return {
    id: r.id,
    project: r.project,
    folder: r.folder,
    brief: r.brief,
    team: r.team === "frontend-backend" ? "frontend-backend" : undefined,
    workClass: r.work_class === "interactive" ? "interactive" : "background",
    createdBy: r.created_by === "operator" ? "operator" : "company",
    createdAt: r.created_at,
    status: r.status as TodoStatus,
    position: r.position,
    orderId: r.order_id ?? undefined,
    result: r.result ?? undefined,
    startedAt: r.started_at ?? undefined,
    endedAt: r.ended_at ?? undefined,
  };
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
