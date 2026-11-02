// Structured snapshot the web dashboard renders — projects, usage, loops, recent orders, and
// the known repos (for the New-project picker). The dashboard is all UI controls over this
// data + the action endpoints; no command typing. Deterministic, AI-free.
import type { LaneKind } from "./lanes";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry";
import type { Ledger, TodoRow } from "./ledger";
import type { UsageMeter, UsageSnapshot } from "./usage";
import type { Provider } from "../types";
import { listLoops, type LoopInfo } from "./loops";
import { basename } from "node:path";
import { sessionContext, contextWindows, contextBand, lastContextReset, type BandCfg, type ContextBand, type ContextSignals } from "./context-policy";
import { workerSdkState, type WorkerSdkState } from "./sdk-choice";
import { describeSession, stateOf } from "./session-status";
import type { SessionState } from "./liveness";
import { todoLabel } from "./todo-queue";
import { apiWait } from "./api-retry";
import { waitingWork, type WaitingItem } from "./waiting-work";
import { DEFAULT_KEEP_PATTERNS } from "./decision-settle";
import type { IntegrationGap, RunningBuild } from "./producers/restart";

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
  /** Finished work that does not run (ADR-0054): the console header shows it. */
  deploy?: IntegrationGap;
  /** The running build (ADR-0056): the build label under the console logo. */
  build?: RunningBuild;
  /** Every session's running tool calls (ADR-0058): the console's "Running now" strip. */
  running: DashRunningCall[];
}

/** One running tool call in the console (ADR-0058). */
export interface DashRunningCall {
  session: string;
  name: string;
  project: string;
  toolUseId: string;
  tool: string;
  summary: string;
  since: number;
  provider: "claude" | "codex";
}

/** Failed todos the console shows (newest first). All of them stay in the ledger (ADR-0027). */
const FAILED_SHOWN = 20;

/** Context events shown in the console's timeline. */
const CONTEXT_EVENTS_SHOWN = 20;

/** Max chars of a todo's brief in the dashboard snapshot (the console shows it on tap). */
const BRIEF_MAX = 4000;

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
  /** The full brief (bounded), shown when the operator taps the todo (ADR-0059). */
  brief: string;
  createdAt: number;
  startedAt?: number;
  /** Why the project's queue is paused, when it is. */
  paused?: string;
  /** A running todo waiting out a rate limit: when its brief is re-sent (ADR-0047). `todo retry` ends the
   *  wait now (ADR-0060). */
  limitResumesAt?: number;
  /** The same for a shorter API error backoff (overloaded, server error) (ADR-0060). */
  apiResumesAt?: number;
  /** A side-lane todo (ADR-0057) and its kind. Absent = the main lane. */
  lane?: "side";
  kind?: LaneKind;
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
    // A queue position counts the main lane only; a side todo waits for a side slot, not a place (ADR-0057).
    const queuedMain = t.status === "queued" && t.lane === "main";
    const position = queuedMain ? (nextPos.get(t.folder) ?? 0) + 1 : 0;
    if (queuedMain) nextPos.set(t.folder, position);
    const wait = t.status === "running" ? apiWait(ledger, t.orderId, now) : undefined;
    return {
      id: t.id,
      project: t.project,
      status: t.status as DashTodo["status"],
      position,
      title: todoLabel(t),
      brief: t.brief.length > BRIEF_MAX ? `${t.brief.slice(0, BRIEF_MAX - 1)}…` : t.brief,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      paused: ledger.todoPaused(t.folder)?.reason,
      ...(t.status === "retry" || t.status === "failed" ? { attempts: t.attempts, ...(t.retryAt !== undefined ? { retryAt: t.retryAt } : {}) } : {}),
      ...(t.waitingOn ? { waitingOn: t.waitingOn } : {}),
      ...(wait ? (wait.limit ? { limitResumesAt: wait.resumesAt } : { apiResumesAt: wait.resumesAt }) : {}),
      ...(t.lane === "side" && t.laneKind ? { lane: "side" as const, kind: t.laneKind } : {}),
    };
  });
}

/** What the operator can do to a todo from its detail (ADR-0065), by its state — the same rules the
 *  `/todo` command applies (it refuses anything else anyway). */
export type TodoDetailAction = "retry" | "up" | "cancel";

/** One todo, everything the detail view shows (ADR-0065). */
export interface TodoDetail {
  id: number;
  project: string;
  folder: string;
  /** The plain summary (ADR-0059). */
  title: string;
  /** The full brief, capped. */
  brief: string;
  lane: "main" | "side";
  kind?: LaneKind;
  status: TodoRow["status"];
  /** The 1-based place in the main queue; 0 when not queued there. */
  position: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  attempts: number;
  retryAt?: number;
  /** The last bad end's reason (`stall`, `restart`, …). */
  failure?: string;
  /** The final result or last note, capped. */
  result?: string;
  waitingOn?: string;
  limitResumesAt?: number;
  apiResumesAt?: number;
  threadId?: number;
  /** The attention items this todo was made from. */
  attention: Array<{ id: number; title: string }>;
  actions: TodoDetailAction[];
  pinned: boolean;
}

const cap = (s: string): string => (s.length > BRIEF_MAX ? `${s.slice(0, BRIEF_MAX - 1)}…` : s);

/** A todo's detail (ADR-0065), or undefined for an unknown id. Plain reads. */
export function todoDetail(ledger: Ledger, id: number, now: number = Date.now()): TodoDetail | undefined {
  const t = ledger.todoById(id);
  if (!t) return undefined;
  const active = t.status === "queued" || t.status === "running" ? activeTodos(ledger, t.folder, now).find((x) => x.id === t.id) : undefined;
  const position = active?.position ?? 0;
  const held = t.status === "running" && (active?.limitResumesAt !== undefined || active?.apiResumesAt !== undefined);
  const actions: TodoDetailAction[] = [];
  if (t.status === "failed" || t.status === "retry" || held) actions.push("retry");
  if (t.status === "queued" && position > 1) actions.push("up");
  if (t.status === "queued" || t.status === "retry" || t.status === "waiting" || t.status === "failed") actions.push("cancel");
  return {
    id: t.id,
    project: t.project,
    folder: t.folder,
    title: todoLabel(t),
    brief: cap(t.brief),
    lane: t.lane,
    ...(t.lane === "side" && t.laneKind ? { kind: t.laneKind } : {}),
    status: t.status,
    position,
    createdAt: t.createdAt,
    ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
    ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
    attempts: t.attempts,
    ...(t.retryAt !== undefined ? { retryAt: t.retryAt } : {}),
    ...(t.failure ? { failure: t.failure } : {}),
    ...(t.result ? { result: cap(t.result) } : {}),
    ...(t.waitingOn ? { waitingOn: t.waitingOn } : {}),
    ...(active?.limitResumesAt !== undefined ? { limitResumesAt: active.limitResumesAt } : {}),
    ...(active?.apiResumesAt !== undefined ? { apiResumesAt: active.apiResumesAt } : {}),
    ...(t.cause ? { threadId: t.cause.threadId } : {}),
    attention: ledger.attentionByTodo(t.id).map((r) => ({ id: r.id, title: r.title })),
    actions,
    pinned: ledger.listPins().some((p) => p.ref === `todo:${t.id}` && p.state === "pinned"),
  };
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
  /** The deploy gap, read by the caller (it reads git). */
  deploy?: IntegrationGap;
  /** The running build, fixed at boot (ADR-0056). */
  build?: RunningBuild;
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
    ...(opts.deploy ? { deploy: opts.deploy } : {}),
    ...(opts.build ? { build: opts.build } : {}),
    running: runningCalls(opts.registry),
    projects,
    sdk: workerSdkState(opts.sdkProvider ?? "subscription"),
    usage: opts.usage ? opts.usage.snapshot(now) : null,
    loops: listLoops(opts.ledger),
    recent,
    repos: listRepos(opts.reposRoot),
  };
}

/** Every open session's running tool calls, newest first (ADR-0058). A broken handle hides only itself. */
function runningCalls(registry: Registry): DashRunningCall[] {
  const out: DashRunningCall[] = [];
  for (const s of registry.list()) {
    try {
      const tools = registry.getControl(s.id)?.tools;
      for (const c of tools?.running() ?? []) {
        out.push({ session: s.id, name: s.name, project: basename(s.lane?.projectFolder ?? s.order.folder), toolUseId: c.toolUseId, tool: c.tool, summary: c.summary, since: c.since, provider: tools!.provider });
      }
    } catch {
      // skip on error
    }
  }
  return out.sort((a, b) => b.since - a.since);
}
