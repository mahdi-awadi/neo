// Graceful daemon reload — deploy engine code without losing open project sessions.
// Shutdown: flip the lifecycle gate (pipeline + dispatch refuse new work), push a wrap-up
// follow-up into every RUNNING session (the dispatch grace-window pattern: commit green work +
// leave a WIP note), wait a bounded drain window for turns to finish, hard-interrupt stragglers,
// then persist every open session's folder + SDK resume id in the ledger. Boot: restore that
// snapshot as idle+resumable registry entries so a follow-up or dispatch resumes them.
// Deterministic and clock/sleep-injected (no AI, no real timers in tests).
import type { SessionInfo } from "../types";
import type { Ledger, OpenSessionRow } from "./ledger";
import type { Registry } from "./registry";
import type { MemoryCfg } from "../config";
import { memoryEnabledFor } from "./memory";
import { MEMORY_FLUSH_SENTENCE } from "./context-policy";

/** Gate shared by the pipeline and dispatch: once draining, no new orders/sub-runs start. */
export interface Lifecycle {
  draining(): boolean;
  beginDrain(): void;
}

export function createLifecycle(): Lifecycle {
  let draining = false;
  return {
    draining: () => draining,
    beginDrain: () => void (draining = true),
  };
}

/** Default bounded drain window before running turns are hard-interrupted. */
export const DRAIN_WINDOW_MS_DEFAULT = 90_000;

/** The wrap-up follow-up pushed into every running worker (mirrors dispatch's grace message).
 *  `memoryFlush` (true when the session's folder is in memory scope — same memoryScopeEnabled gate
 *  every other memory injection uses) prepends MEMORY_FLUSH_SENTENCE so the worker saves durable
 *  facts to memory before its WIP note; absent/false leaves the message byte-identical to before
 *  this parameter existed. */
export function wrapUpFollowUp(drainMs: number, memoryFlush?: boolean): string {
  const base =
    `♻️ Neo is restarting for an engine reload — stop working now. ` +
    `Commit any green work and write a brief WIP note (plan doc or WIP.md) so a follow-up run can resume. ` +
    `You have ~${Math.round(drainMs / 1000)}s before this session is closed; it will be resumed after the restart.`;
  return memoryFlush ? MEMORY_FLUSH_SENTENCE + "\n\n" + base : base;
}

const OPEN = (s: SessionInfo): boolean => s.status === "running" || s.status === "idle";

export interface DrainResult {
  /** Sessions that were running and finished their turn inside the drain window. */
  drained: string[];
  /** Sessions still running at the deadline — hard-interrupted. */
  interrupted: string[];
  /** Open sessions persisted for boot-time restore. */
  persisted: number;
}

/**
 * The SIGTERM//reload path: gate new work, ask running workers to wrap up, wait `drainMs`,
 * interrupt what's left, and snapshot every open session (with its resume id) into the ledger.
 * The caller exits 0 afterwards; the supervisor restarts the daemon, which calls restoreSessions.
 */
export async function drainAndPersist(opts: {
  registry: Registry;
  ledger: Ledger;
  lifecycle?: Lifecycle;
  drainMs: number;
  /** Poll interval while waiting for turns to finish. Default 1s. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Memory system config (Phase 2) — presence alone does NOT flush; a running session's wrap-up
   *  follow-up only gains MEMORY_FLUSH_SENTENCE when BOTH this and `companyFolder` are set AND
   *  `memoryScopeEnabled` says its folder is in scope (same gate every other memory injection
   *  uses). Absent → wrapUpFollowUp is called with no flag, byte-identical to before this field. */
  memory?: MemoryCfg;
  /** The always-on company folder (config `companyFolder`) — needed alongside `memory` to
   *  evaluate the `"company"` scope keyword. Absent ⇒ fail-closed: no flush even if `memory` set. */
  companyFolder?: string;
}): Promise<DrainResult> {
  const { registry, ledger } = opts;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 1_000;
  opts.lifecycle?.beginDrain();

  // Ask every mid-turn worker to wrap up (commit green work + WIP note), like the dispatch grace window.
  const running = registry.list().filter((s) => s.status === "running");
  for (const s of running) {
    const memoryFlush = memoryEnabledFor(opts.memory, s.order.folder, opts.companyFolder);
    registry.getControl(s.id)?.followUp(wrapUpFollowUp(opts.drainMs, memoryFlush));
  }

  // Bounded drain: wait for turns to finish (their done-handlers mark the sessions idle).
  const deadline = now() + opts.drainMs;
  while (registry.list().some((s) => s.status === "running") && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }

  // Hard-interrupt stragglers; their runs settle and the resume id was persisted on each turn.
  const stuck = registry.list().filter((s) => s.status === "running");
  for (const s of stuck) await registry.getControl(s.id)?.interrupt();

  // Snapshot every open session — folder + resume id — so boot can re-register them.
  const rows: OpenSessionRow[] = registry
    .list()
    .filter(OPEN)
    .map((s) => ({
      id: s.id,
      name: s.name,
      folder: s.order.folder,
      chatId: s.order.chatId,
      sdkSessionId: s.sdkSessionId || ledger.lastSessionFor(s.order.folder, s.order.chatId) || "",
      task: s.order.task,
      source: s.order.source,
      createdAt: s.order.createdAt,
    }));
  ledger.saveOpenSessions(rows);

  const stuckIds = new Set(stuck.map((s) => s.id));
  return {
    drained: running.filter((s) => !stuckIds.has(s.id)).map((s) => s.id),
    interrupted: stuck.map((s) => s.id),
    persisted: rows.length,
  };
}

/** Default bound on a frontend's stop hook — a hung Bot API call must never block the exit. */
export const STOP_FRONTENDS_TIMEOUT_MS = 5_000;

/**
 * Stop the operator frontends before the process exits — the step that keeps a reload from
 * repeating forever. Telegram long polling only *confirms* an update by sending the next
 * getUpdates with `offset = update_id + 1`; grammy does that inside `bot.stop()`. Exiting straight
 * after the `/reload` handler left that update unconfirmed, so Telegram redelivered it to the
 * fresh process, which reloaded again — a restart loop that spammed the operator (fixed here).
 * Best-effort and bounded: hooks run in order, a throwing hook is swallowed, and a hook that never
 * settles is abandoned after `timeoutMs` so shutdown always proceeds.
 */
export async function stopFrontends(
  hooks: Array<() => Promise<unknown>>,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? STOP_FRONTENDS_TIMEOUT_MS;
  for (const hook of hooks) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        hook(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } catch {
      // best-effort: a frontend that fails to stop must not keep the daemon alive
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Boot-time re-registration: consume the shutdown snapshot and register each session as an
 * idle, resumable registry entry. A folder already registered (the always-on company) keeps
 * its entry and just gains the persisted resume id. Returns the newly registered sessions.
 */
export function restoreSessions(registry: Registry, ledger: Ledger, now: () => number = Date.now): SessionInfo[] {
  const restored: SessionInfo[] = [];
  for (const row of ledger.takeOpenSessions()) {
    const sdkSessionId = row.sdkSessionId || ledger.lastSessionFor(row.folder, row.chatId) || "";
    const existing = registry.findByFolder(row.folder);
    if (existing) {
      if (sdkSessionId && !existing.sdkSessionId) registry.setSdkSessionId(existing.id, sdkSessionId);
      continue;
    }
    const session = registry.add(
      { id: row.id, source: row.source, folder: row.folder, task: row.task, chatId: row.chatId, createdAt: row.createdAt },
      now(),
    );
    registry.setStatus(session.id, "idle"); // idle = resumable; the next follow-up/dispatch resumes it
    if (sdkSessionId) registry.setSdkSessionId(session.id, sdkSessionId);
    restored.push(session);
  }
  return restored;
}
