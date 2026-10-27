// Structured snapshot the web dashboard renders — projects, usage, loops, recent orders, and
// the known repos (for the New-project picker). The dashboard is all UI controls over this
// data + the action endpoints; no command typing. Deterministic, AI-free.
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import type { UsageMeter, UsageSnapshot } from "./usage";
import type { Provider } from "../types";
import { listLoops, type LoopInfo } from "./loops";
import { basename } from "node:path";
import { sessionContext, contextWindows, contextBand, lastContextReset, type BandCfg, type ContextBand, type ContextSignals } from "./context-policy";
import { workerSdkState, type WorkerSdkState } from "./sdk-choice";
import { describeSession, stateOf } from "./session-status";
import type { SessionState } from "./liveness";
import { todoTitle } from "./todo-queue";
import { limitWait } from "./api-retry";
import { waitingWork, type WaitingItem } from "./waiting-work";
import { DEFAULT_KEEP_PATTERNS } from "./decision-settle";

export interface DashProject {
  id: string;
  name: string;
  folder: string;
  /** Registry LIFECYCLE (running/idle/done/error) — bookkeeping only; never show it as a status. */
  status: string;
  /** What it is DOING: working / quiet / idle / starting / awaiting-operator / wedged. */
  state: SessionState;
  /** The same one-line status /list and the company's `sessions` tool render. */
  line: string;
  task: string;
  active: boolean;
  ageMs: number;
  activity?: { label: string; since: number };
  queued?: number;
  ctxPct?: number;
  /** Where ctxPct sits against the sweet spot (ADR-0021). */
  ctxBand?: ContextBand;
  /** The measured occupancy is over 100% — impossible, so the window is wrong: show "?" (spec §8.5). */
  ctxSuspect?: boolean;
  /** The project's newest context reset. */
  lastReset?: { verdict: string; reason?: string; at: number };
}

/** One row of the console's context-reset timeline (ADR-0021). */
export interface DashContextEvent {
  project: string;
  folder: string;
  verdict: string;
  reason?: string;
  boundary?: string;
  occupancy: number;
  at: number;
  /** A `resumed` row's orientation: model calls before the first edit/commit, and the verdict. */
  steps?: number;
  success?: boolean;
}

export interface DashState {
  projects: DashProject[];
  sdk: WorkerSdkState;
  usage: UsageSnapshot | null;
  loops: LoopInfo[];
  recent: Array<{ folder: string; task: string; status: string }>;
  repos: string[];
  /** Running + queued todos across projects (ADR-0008): running first, then each queue in order;
   *  then kept work (ADR-0027): waiting retries and the newest failed todos. `position` is the 1-based
   *  queue position, 0 for any other status. */
  todos: DashTodo[];
  /** Newest context resets and resumes across projects (ADR-0021). */
  contextEvents: DashContextEvent[];
  /** Everything that holds work back, each with its owner and next action (ADR-0054). */
  waiting: WaitingItem[];
}

/** Failed todos the console shows (newest first). All of them stay in the ledger (ADR-0027). */
const FAILED_SHOWN = 20;

/** Context events shown in the console's timeline. */
const CONTEXT_EVENTS_SHOWN = 20;

export interface DashTodo {
  id: number;
  project: string;
  status: "running" | "queued" | "retry" | "waiting" | "failed";
  /** The decision a `waiting` todo resumes on (ADR-0029). */
  waitingOn?: string;
  position: number;
  /** Automatic retries so far, and when a `retry` todo re-runs (ADR-0027). */
  attempts?: number;
  retryAt?: number;
  title: string;
  createdAt: number;
  startedAt?: number;
  /** Why the project's queue is paused, when it is. */
  paused?: string;
  /** A running todo waiting out a rate limit: when its brief is re-sent (ADR-0047). */
  limitResumesAt?: number;
}

/** Running + queued todos (all projects, or one folder's): running first, then each queue in order;
 *  `position` is the 1-based queue position, 0 for a running todo. The one todo mapping — the console
 *  and the project dashboard both read it. */
export function activeTodos(ledger: Ledger, folder?: string, now: number = Date.now()): DashTodo[] {
  const nextPos = new Map<string, number>();
  const where = folder !== undefined ? { folder } : {};
  const rows = [
    ...ledger.listTodos({ ...where, statuses: ["running", "queued"] }),
    ...ledger.listTodos({ ...where, statuses: ["retry"] }),
    ...ledger.listTodos({ ...where, statuses: ["waiting"] }),
    ...ledger.listTodos({ ...where, statuses: ["failed"], limit: FAILED_SHOWN }),
  ];
  return rows.map((t) => {
    const position = t.status === "queued" ? (nextPos.get(t.folder) ?? 0) + 1 : 0;
    if (t.status === "queued") nextPos.set(t.folder, position);
    const wait = t.status === "running" ? limitWait(ledger, t.orderId, now) : undefined;
    return {
      id: t.id,
      project: t.project,
      status: t.status as DashTodo["status"],
      position,
      title: todoTitle(t.brief),
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      paused: ledger.todoPaused(t.folder)?.reason,
      ...(t.status === "retry" || t.status === "failed" ? { attempts: t.attempts, ...(t.retryAt !== undefined ? { retryAt: t.retryAt } : {}) } : {}),
      ...(t.waitingOn ? { waitingOn: t.waitingOn } : {}),
      ...(wait ? { limitResumesAt: wait.resumesAt } : {}),
    };
  });
}

/** Folders directly under `root` that are git repos — the New-project picker's options. */
export function listRepos(root = "/home"): string[] {
  try {
    return readdirSync(root)
      .map((d) => join(root, d))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && existsSync(join(p, ".git"));
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

export function dashboardSnapshot(opts: {
  registry: Registry;
  ledger: Ledger;
  usage?: UsageMeter;
  chatId: number;
  now?: number;
  reposRoot?: string;
  sdkProvider?: Provider;
  signals?: (folder: string, sdkSessionId: string, opts?: { windowTokensByModel?: Record<string, number> }) => ContextSignals;
  /** Per-model context-window overrides (cfg.contextPolicy.windowTokensByModel), threaded into the
   *  SAME sessionContext call the gates use — so the dashboard's ctxPct agrees with the
   *  keep/handoff/clear verdict instead of drifting when an operator has configured an override
   *  (see context-policy.ts ContextPolicyCfg.windowTokensByModel doc). */
  windowTokensByModel?: Record<string, number>;
  /** The sweet-spot lines (cfg.contextPolicy), for each row's band. */
  contextPolicy?: BandCfg;
  /** cfg.decisionSettle.keepPatterns, for the waiting items' `keep` (default DEFAULT_KEEP_PATTERNS). */
  keepPatterns?: readonly string[];
}): DashState {
  const now = opts.now ?? Date.now();
  const activeId = opts.registry.findByChat(opts.chatId)?.id;
  const windows = contextWindows(opts.ledger, opts.windowTokensByModel);
  const projects: DashProject[] = opts.registry.list().map((s) => {
    let ctxPct: number | undefined;
    let ctxBand: ContextBand | undefined;
    let ctxSuspect = false;
    if (s.sdkSessionId) {
      try {
        const sig = (opts.signals ?? sessionContext)(s.order.folder, s.sdkSessionId, { windowTokensByModel: windows });
        // A guessed window gives a meaningless % (ADR-0013) — show none until the SDK reports one.
        if (sig.occupancy > 1) ctxSuspect = true; // impossible: show "?", never the number (spec §8.5)
        else if (sig.windowKnown !== false) {
          ctxPct = Math.round(sig.occupancy * 100);
          if (opts.contextPolicy) ctxBand = contextBand(sig.occupancy, opts.contextPolicy);
        }
      } catch {
        // skip on error
      }
    }
    let lastReset: DashProject["lastReset"];
    try {
      const last = lastContextReset(opts.ledger, s.order.folder);
      if (last) lastReset = { verdict: last.verdict, reason: last.reason, at: last.at };
    } catch {
      // skip on error
    }
    return {
      id: s.id,
      name: s.name,
      folder: s.order.folder,
      status: s.status,
      state: stateOf(opts.registry, s, now),
      line: describeSession(opts.registry, s, now),
      task: s.order.task,
      active: s.id === activeId,
      ageMs: now - s.startedAt,
      activity: s.activity,
      queued: opts.registry.getControl(s.id)?.queued?.() ?? 0,
      ctxPct,
      ctxBand,
      ...(ctxSuspect ? { ctxSuspect } : {}),
      lastReset,
    };
  });
  const recent = opts.ledger.listRecent(8).map((o) => ({
    folder: o.folder,
    task: o.task,
    status: opts.ledger.getOutcome(o.id)?.status ?? "pending",
  }));
  const todos = activeTodos(opts.ledger, undefined, now);
  const contextEvents: DashContextEvent[] = opts.ledger.listContextEvents({ limit: CONTEXT_EVENTS_SHOWN }).map((e) => ({
    project: basename(e.folder),
    folder: e.folder,
    verdict: e.verdict,
    reason: e.reason,
    boundary: e.boundary,
    occupancy: e.occupancy,
    at: e.at,
    ...(typeof e.detail?.steps === "number" ? { steps: e.detail.steps } : {}),
    ...(typeof e.detail?.success === "boolean" ? { success: e.detail.success } : {}),
  }));
  // One bad row must not blank the whole console: the waiting list fails soft to empty.
  let waiting: WaitingItem[] = [];
  try {
    waiting = waitingWork(opts.ledger, { keepPatterns: opts.keepPatterns ?? DEFAULT_KEEP_PATTERNS });
  } catch {
    // skip on error
  }
  return {
    todos,
    contextEvents,
    waiting,
    projects,
    sdk: workerSdkState(opts.sdkProvider ?? "subscription"),
    usage: opts.usage ? opts.usage.snapshot(now) : null,
    loops: listLoops(opts.ledger),
    recent,
    repos: listRepos(opts.reposRoot),
  };
}
