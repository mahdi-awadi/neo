// The task history's one seam (ADR-0066 Decision 6, spec "The seam"): `openTaskHistory` builds the store,
// the embedder, the vector index, the indexer and search behind the small `TaskHistory` interface that the
// daemon and the operator surfaces use. It also owns the two writes the operator and workers make directly:
// `remember` (an explicit entry, refused when it is empty, too short or long, secret-shaped or
// injection-shaped, rate-limited per session, keyword-searchable at once) and `forget` (operator surfaces
// only: the entry goes everywhere, its points are deleted or queued while Qdrant is down, and a tombstone
// stops the feed and the reconcile from adding a ledger-backed ref again). Nothing here throws to the
// caller; events carry refs and counts, never text.
import type { Ledger } from "../ledger";
import { scanMemoryText } from "../memory";
import { findSecret } from "../secret-patterns";
import { todoTitle } from "../todo-title";
import type { HistoryCfg } from "./defaults";
import { openEmbedder, type Embedder } from "./embedder";
import { findShas, hashText } from "./extract";
import { createIndexer, type IndexReport, type ServiceReport } from "./indexer";
import { searchHistory, type HistoryQuery, type HistoryRef, type HistoryResult } from "./search";
import { createQueryGate } from "./services";
import { prepareChunks, sameWorkRefs } from "./sources";
import { openHistoryStore, type HistoryStore } from "./store";
import { NoVectorIndex, openVectorIndex, type VectorIndex } from "./vector-index";

export type { HistoryCfg } from "./defaults";
export type { IndexReport, ServiceReport } from "./indexer";
export type { HistoryHit, HistoryQuery, HistoryRef, HistoryResult, MeaningMode } from "./search";
export type { MeaningOffReason } from "./services";
export type { HistoryKind } from "./store";

export interface RememberInput {
  text: string;
  project?: string;
  by: "operator" | "company" | "worker";
  /** The operator message ref of the turn that asked for it. */
  cause?: string;
  /** The session the rate limit counts for (default: `by`). */
  session?: string;
}
export type RememberResult = { ok: true; ref: HistoryRef; duplicate: boolean } | { ok: false; error: string };
export interface ForgetResult {
  ok: boolean;
  error?: string;
  chunks: number;
  points: number;
  /** Points still queued for Qdrant (it did not answer). */
  pendingPoints: number;
}

export interface HistoryStatus {
  /** The newest indexer pass. */
  report?: IndexReport;
  services: { embedder: ServiceReport; vectors: ServiceReport };
  tags: Array<{ tag: string; role: "active" | "next"; coverage: number }>;
  pendingDeletes: number;
  lock?: { pid: number; at: number };
}

export interface TaskHistory {
  /** Hybrid search over every list that answers now. Never throws. `ok: false` for a refused query or a
   *  `history.db` that cannot be read. */
  search(q: HistoryQuery): Promise<HistoryResult>;
  /** Save an explicit entry. Keyword-searchable at once, meaning-searchable after its vector is made. */
  remember(e: RememberInput): RememberResult;
  /** One indexer pass, single-flight. Never throws. */
  indexTick(now: number): Promise<IndexReport>;
  /** Operator surfaces only: remove one entry everywhere and keep a tombstone, so it never comes back. */
  forget(ref: HistoryRef, reason: string, now: number): Promise<ForgetResult>;
  /** What the admin command and the attention producer read. */
  status(): HistoryStatus;
  close(): void;
}

export interface TaskHistoryDeps {
  cfg: HistoryCfg;
  ledger: Pick<Ledger, "historyFeed" | "historyFeedBounds" | "historyRows" | "historyScan" | "historyLineage" | "threadById" | "searchWorkerLines">;
  workRoot: string;
  /** process.env after loadConfig; read once. */
  env: Record<string, string | undefined>;
  /** ledger.recordEvent */
  events: (kind: string, data: Record<string, unknown>) => void;
  /** Tests inject fakes. */
  embedder?: Embedder;
  vectors?: VectorIndex;
  next?: { embedder: Embedder; vectors: VectorIndex };
  store?: HistoryStore;
  now?: () => number;
  pid?: number;
}

const HOUR = 3_600_000;
/** A ref that names an entry of `history.db` (a `line:` ref names a ledger line: nothing to forget). */
export const FORGETTABLE = /^(?:todo|order|result|msg|plan|note|att|dec|mem):[0-9a-z-]+$/i;
const MEM = "mem:";

/** The next model's embedder and index: the same collection when the dimensions match, else its own
 *  (which openVectorIndex checks against the allowed list); other dimensions with no collection are refused. */
function openNext(cfg: HistoryCfg, env: Record<string, string | undefined>, vectors: VectorIndex): TaskHistoryDeps["next"] {
  const n = cfg.next;
  if (!n) return undefined;
  const embedder = openEmbedder(n, env);
  if (n.collection) return { embedder, vectors: openVectorIndex(cfg.vectors, env, { dims: n.dims, collection: n.collection }) };
  return { embedder, vectors: n.dims === cfg.embedder.dims ? vectors : new NoVectorIndex("config_refused") };
}

/** Open the task history. Throws a `HistoryStoreError` when `history.db` cannot be opened (the daemon
 *  moves the file aside and runs on, plan task 11). */
export function openTaskHistory(deps: TaskHistoryDeps): TaskHistory {
  const { cfg, events } = deps;
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const store = deps.store ?? openHistoryStore(cfg.dbPath, cfg.store);
  const embedder = deps.embedder ?? openEmbedder(cfg.embedder, deps.env);
  const vectors = deps.vectors ?? openVectorIndex(cfg.vectors, deps.env, { dims: embedder.dims });
  const next = deps.next ?? openNext(cfg, deps.env, vectors);
  const gate = createQueryGate();
  const indexer = createIndexer({ store, ledger: deps.ledger, cfg, workRoot: deps.workRoot, embedder, vectors, ...(next ? { next } : {}), events, gate, pid });
  /** Save times per session, for the hourly limit. */
  const saves = new Map<string, number[]>();

  function remember(e: RememberInput): RememberResult {
    const text = typeof e.text === "string" ? e.text.trim() : "";
    if (!text) return { ok: false, error: "empty" };
    if (text.length < cfg.remember.minChars) return { ok: false, error: "too_short" };
    if (text.length > cfg.remember.maxChars) return { ok: false, error: "too_long" };
    const secret = findSecret(text);
    if (secret) return { ok: false, error: `secret: ${secret}` };
    const scan = scanMemoryText(text);
    if (scan) return { ok: false, error: scan };
    const at = now();
    const session = e.session ?? e.by;
    const recent = (saves.get(session) ?? []).filter((t) => at - t < HOUR);
    if (recent.length >= cfg.remember.perSessionHour) return { ok: false, error: "rate_limited" };
    const project = e.project?.trim() || undefined;
    try {
      const out = store.transaction(() => {
        const { id, duplicate } = store.addRemembered({ text, ...(project ? { project } : {}), by: e.by, ...(e.cause ? { cause: e.cause } : {}), at });
        const ref = `${MEM}${id}`;
        if (duplicate && store.getSource(ref)) return { ref, duplicate };
        const chunkCfg = { ...cfg.chunk, minChars: Math.min(cfg.chunk.minChars, cfg.remember.minChars) };
        const { chunks } = prepareChunks(ref, text, chunkCfg, events);
        const row = store.getRemembered(id)!;
        store.putSource({
          ref, kind: "remembered", ...(project ? { project } : {}), at: row.at, title: todoTitle(text),
          hash: hashText(JSON.stringify(["remembered", project ?? null, row.at, text])), meta: { commits: findShas(text) },
        }, chunks, at);
        return { ref, duplicate };
      });
      if (!out.duplicate) saves.set(session, [...recent, at]);
      events("history_remember", { ref: out.ref, duplicate: out.duplicate, by: e.by, chars: text.length });
      return { ok: true, ...out };
    } catch {
      return { ok: false, error: "history_unreadable" };
    }
  }

  /** The ledger's link of a todo to its order, or of an order to its todo (the stored meta may predate it). */
  function workLink(ref: string): { todo?: number; order?: string } {
    try {
      const [kind, key] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
      if (kind === "todo") {
        const t = deps.ledger.historyRows("project_todos", [key])[0]?.row;
        return t?.orderId !== undefined ? { order: t.orderId } : {};
      }
      if (kind === "order" || kind === "result") {
        const o = deps.ledger.historyRows("orders", [key])[0]?.row;
        return o?.todoId !== undefined ? { todo: o.todoId } : {};
      }
    } catch {
      // the stored meta is enough
    }
    return {};
  }

  async function forget(ref: HistoryRef, reason: string, at: number): Promise<ForgetResult> {
    const none = (error: string): ForgetResult => ({ ok: false, error, chunks: 0, points: 0, pendingPoints: 0 });
    if (typeof ref !== "string" || !FORGETTABLE.test(ref)) return none(ref?.startsWith?.("line:") ? "not_forgettable" : "bad_ref");
    if (typeof reason !== "string" || !reason.trim()) return none("reason_required");
    let removed: { chunks: number; points: string[] };
    try {
      const isMem = ref.startsWith(MEM);
      const memId = isMem ? Number(ref.slice(MEM.length)) : NaN;
      const src = store.getSource(ref);
      const mem = isMem && Number.isInteger(memId) ? store.getRemembered(memId) : undefined;
      if (!src && !mem) return none("unknown_ref");
      // A todo, its order and the order's result are one piece of work: each of them goes and is tombstoned.
      const refs = mem ? [ref] : sameWorkRefs(ref, { ...workLink(ref), ...src!.meta });
      removed = store.transaction(() => {
        const r = { chunks: 0, points: [] as string[] };
        for (const each of refs) {
          if (!store.getSource(each)) continue;
          const x = store.removeSource(each, at);
          r.chunks += x.chunks;
          r.points.push(...x.points);
        }
        // A remembered entry lives only in history.db: deleting its row is enough, and no tombstone is kept
        // (its id may be given again to a new entry). A ledger-backed ref gets a tombstone.
        if (mem) store.deleteRemembered(memId);
        else for (const each of refs) store.addTombstone(each, reason.trim(), at);
        return r;
      });
    } catch {
      return none("history_unreadable");
    }
    // The points are queued in pending_deletes; send them now, and leave them queued if Qdrant does not answer.
    let pendingPoints = removed.points.length;
    if (removed.points.length) {
      try {
        const targets = [...new Set([vectors, ...(next ? [next.vectors] : [])])];
        const results = await Promise.all(targets.map((v) => v.delete(removed.points)));
        if (results.every((r) => r.ok)) {
          store.clearPendingDeletes(removed.points);
          pendingPoints = 0;
        }
      } catch {
        // stays queued for the next pass
      }
    }
    events("history_forget", { ref, chunks: removed.chunks, points: removed.points.length, pendingPoints });
    return { ok: true, chunks: removed.chunks, points: removed.points.length, pendingPoints };
  }

  return {
    async search(q) {
      try {
        return await searchHistory({ store, ledger: deps.ledger, embedder, vectors, cfg, gate, events }, q);
      } catch {
        return { ok: false, error: "history_unreadable", hits: [], mode: { meaning: "skipped" } };
      }
    },
    remember,
    indexTick: (t) => indexer.tick(t),
    forget,
    status() {
      const report = indexer.latest();
      const cov = (tag: string): number => {
        try {
          return store.coverage(tag).ratio;
        } catch {
          return 0;
        }
      };
      let pendingDeletes = 0;
      let lock: HistoryStatus["lock"];
      try {
        pendingDeletes = store.countPendingDeletes();
        lock = store.lockHolder();
      } catch {
        // an unreadable store reports zeros
      }
      return {
        ...(report ? { report } : {}),
        services: indexer.services(),
        tags: [
          { tag: embedder.tag, role: "active" as const, coverage: cov(embedder.tag) },
          ...(next ? [{ tag: next.embedder.tag, role: "next" as const, coverage: cov(next.embedder.tag) }] : []),
        ],
        pendingDeletes,
        ...(lock ? { lock } : {}),
      };
    },
    close() {
      try {
        store.releaseLock(pid);
      } catch {
        // closing anyway
      }
      store.close();
    },
  };
}
