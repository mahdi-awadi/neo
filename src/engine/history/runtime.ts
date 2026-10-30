// The task history in the running engine (ADR-0066, plan task 11): what the daemon starts once at boot.
// `startTaskHistory` opens the seam when `history.enabled` is on — never when it is off, so no store opens
// and no worker tool is attached. A `history.db` that cannot be opened never stops the engine: a corrupt
// file is moved to `history.db.corrupt-<UTC time>` (with its -wal and -shm files), the operator gets one
// alert, and the seam is a stand-in that answers "history is not available" until a snapshot is restored
// (docs/backup.md) and the daemon reloads. It also gives the two heartbeat steps: `tick` starts one indexer
// pass, and while that pass leaves a backlog that can drain, the next pass starts after
// `indexer.busyPauseMs` instead of at the next heartbeat (so a first backfill takes hours, not days);
// `feedPrune` keeps the ledger's change feed at `feedKeep` rows, also while history is off.
import { renameSync, existsSync } from "node:fs";
import type { Ledger } from "../ledger";
import type { HistoryCfg } from "./defaults";
import { openTaskHistory, type IndexReport, type TaskHistory, type TaskHistoryDeps } from "./index";
import { emptyIndexReport } from "./indexer";
import { isHistoryStoreError } from "./store";

/** The feed is pruned at most this often (the delete walks `feedKeep` ids of the primary key). */
const FEED_PRUNE_EVERY_MS = 3_600_000;
/** What every surface answers while `history.db` cannot be opened. */
export const HISTORY_UNAVAILABLE = "history_unavailable";

export interface HistoryTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HistoryRuntimeDeps {
  cfg: HistoryCfg;
  ledger: TaskHistoryDeps["ledger"] & Pick<Ledger, "pruneHistoryFeed">;
  workRoot: string;
  /** process.env after loadConfig (the engine's env loader); read once by the adapters. */
  env: Record<string, string | undefined>;
  /** ledger.recordEvent */
  events: (kind: string, data: Record<string, unknown>) => void;
  /** The operator alert (the Decisions channel, else the DM). */
  alert: (text: string) => void;
  now?: () => number;
  /** Tests inject the seam. */
  open?: (deps: TaskHistoryDeps) => TaskHistory;
  /** Tests fire the busy follow-up by hand. */
  timers?: HistoryTimers;
  /** faults.report: a follow-up pass that throws (the heartbeat's own pass is reported by faults.contain). */
  report?: (component: string, err: unknown) => void;
}

export interface HistoryRuntime {
  /** The seam the operator surfaces get. Absent when history is off (no tool is attached); a stand-in that
   *  answers `history_unavailable` when `history.db` could not be opened. */
  history?: TaskHistory;
  /** True when the seam is the real one. */
  available: boolean;
  /** Heartbeat step `history`: start one pass unless one runs or a busy follow-up waits. Resolves to the
   *  pass's report, or undefined when no pass ran; rejects only when the seam throws (which it should not),
   *  for the heartbeat's faults.contain to report. */
  tick(): Promise<IndexReport | undefined>;
  /** Heartbeat step `history.feedPrune`: at most once an hour, keep the newest `feedKeep` feed rows. */
  feedPrune(): number;
  /** The newest pass's report. */
  latest(): IndexReport | undefined;
  /** Stop the follow-ups and close the store (shutdown). */
  close(): void;
}

const NODE_TIMERS: HistoryTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** `20261030T091500Z`: a UTC time that sorts and fits in a file name. */
export function fileStamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** True when the pass left work that the next pass can do now: local work (feed rows, a reconcile) always;
 *  embeds only with the embedder up; uploads and point deletes only with Qdrant up. A pass that moved
 *  nothing, or found the writer lock held by another process, never starts a follow-up (no tight loop). */
export function backlogDrains(r: IndexReport): boolean {
  if (r.locked) return false;
  const reconciling = r.reconcile !== undefined && !r.reconcile.done;
  const moved = r.feed.read + r.sources.indexed + r.sources.archived + r.embedded + r.uploaded + r.pointsDeleted > 0 || reconciling;
  if (!moved) return false;
  const local = r.backlog.feed > 0 || reconciling;
  const embed = r.backlog.toEmbed > 0 && r.embedder.state === "up";
  const upload = (r.backlog.toUpload > 0 || r.backlog.pendingDeletes > 0) && r.vectors.state === "up";
  return local || embed || upload;
}

/** The seam while `history.db` cannot be opened: every call answers that history is not available. */
function unavailableHistory(): TaskHistory {
  const off = { state: "off" as const, since: 0 };
  return {
    search: async () => ({ ok: false, error: HISTORY_UNAVAILABLE, hits: [], mode: { meaning: "skipped" } }),
    remember: () => ({ ok: false, error: HISTORY_UNAVAILABLE }),
    indexTick: async () => emptyIndexReport(),
    forget: async () => ({ ok: false, error: HISTORY_UNAVAILABLE, chunks: 0, points: 0, pendingPoints: 0 }),
    status: () => ({ services: { embedder: off, vectors: off }, tags: [], pendingDeletes: 0 }),
    close: () => {},
  };
}

/** Move a corrupt store and its -wal and -shm files aside; the new name keeps them together. */
function moveAside(path: string, at: number): string | undefined {
  const target = `${path}.corrupt-${fileStamp(at)}`;
  try {
    renameSync(path, target);
  } catch {
    return undefined;
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${target}${suffix}`);
    } catch {
      // the main file is aside; a stale side file is recreated or ignored by SQLite
    }
  }
  return target;
}

export function startTaskHistory(deps: HistoryRuntimeDeps): HistoryRuntime {
  const { cfg, ledger, events } = deps;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? NODE_TIMERS;
  let lastPrune: number | undefined;
  const feedPrune = (): number => {
    const at = now();
    if (lastPrune !== undefined && at - lastPrune < FEED_PRUNE_EVERY_MS) return 0;
    lastPrune = at;
    return ledger.pruneHistoryFeed(cfg.feedKeep);
  };

  if (!cfg.enabled) {
    return { available: false, tick: async () => undefined, feedPrune, latest: () => undefined, close: () => {} };
  }

  let history: TaskHistory;
  let available = true;
  try {
    history = (deps.open ?? openTaskHistory)({ cfg, ledger, workRoot: deps.workRoot, env: deps.env, events, now });
  } catch (err) {
    available = false;
    history = unavailableHistory();
    const at = now();
    const code = isHistoryStoreError(err) ? err.code : "unreadable";
    const movedTo = code === "corrupt" ? moveAside(cfg.dbPath, at) : undefined;
    events("history_store_unavailable", { code, moved: movedTo !== undefined });
    deps.alert(
      movedTo
        ? `⚠️ history.db is corrupt and was moved to ${movedTo}. History search is not available. Restore the newest snapshot (docs/backup.md), then reload — the engine keeps running.`
        : `⚠️ history.db (${cfg.dbPath}) could not be opened (${code}). History search is not available until it can be read and the daemon reloads — the engine keeps running.`,
    );
  }

  let latest: IndexReport | undefined;
  let running = false;
  let followUp: unknown;
  let closed = false;

  const pass = async (): Promise<IndexReport | undefined> => {
    if (closed || !available || running || followUp !== undefined) return undefined;
    running = true;
    let r: IndexReport;
    try {
      r = await history.indexTick(now());
    } finally {
      running = false;
    }
    latest = r;
    if (!closed && backlogDrains(r)) {
      followUp = timers.set(() => {
        followUp = undefined;
        pass().catch((e: unknown) => deps.report?.("history.followUp", e));
      }, cfg.indexer.busyPauseMs);
    }
    return r;
  };

  return {
    history,
    available,
    tick: pass,
    feedPrune,
    latest: () => latest,
    close() {
      closed = true;
      if (followUp !== undefined) timers.clear(followUp);
      followUp = undefined;
      history.close();
    },
  };
}
