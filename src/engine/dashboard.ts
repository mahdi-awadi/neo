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
import { sessionContext, contextWindows, type ContextSignals } from "./context-policy";
import { workerSdkState, type WorkerSdkState } from "./sdk-choice";
import { describeSession, stateOf } from "./session-status";
import type { SessionState } from "./liveness";
import { todoTitle } from "./todo-queue";

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
}

export interface DashState {
  projects: DashProject[];
  sdk: WorkerSdkState;
  usage: UsageSnapshot | null;
  loops: LoopInfo[];
  recent: Array<{ folder: string; task: string; status: string }>;
  repos: string[];
  /** Running + queued todos across projects (ADR-0008): running first, then each queue in order.
   *  `position` is the 1-based queue position, 0 for a running todo. */
  todos: DashTodo[];
}

export interface DashTodo {
  id: number;
  project: string;
  status: "running" | "queued";
  position: number;
  title: string;
  createdAt: number;
  startedAt?: number;
  /** Why the project's queue is paused, when it is. */
  paused?: string;
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
}): DashState {
  const now = opts.now ?? Date.now();
  const activeId = opts.registry.findByChat(opts.chatId)?.id;
  const windows = contextWindows(opts.ledger, opts.windowTokensByModel);
  const projects: DashProject[] = opts.registry.list().map((s) => {
    let ctxPct: number | undefined;
    if (s.sdkSessionId) {
      try {
        const sig = (opts.signals ?? sessionContext)(s.order.folder, s.sdkSessionId, { windowTokensByModel: windows });
        ctxPct = Math.round(sig.occupancy * 100);
      } catch {
        // skip on error
      }
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
    };
  });
  const recent = opts.ledger.listRecent(8).map((o) => ({
    folder: o.folder,
    task: o.task,
    status: opts.ledger.getOutcome(o.id)?.status ?? "pending",
  }));
  const nextPos = new Map<string, number>();
  const todos: DashTodo[] = opts.ledger.listTodos({ statuses: ["running", "queued"] }).map((t) => {
    const position = t.status === "queued" ? (nextPos.get(t.folder) ?? 0) + 1 : 0;
    if (t.status === "queued") nextPos.set(t.folder, position);
    return {
      id: t.id,
      project: t.project,
      status: t.status as DashTodo["status"],
      position,
      title: todoTitle(t.brief),
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      paused: opts.ledger.todoPaused(t.folder)?.reason,
    };
  });
  return {
    todos,
    projects,
    sdk: workerSdkState(opts.sdkProvider ?? "subscription"),
    usage: opts.usage ? opts.usage.snapshot(now) : null,
    loops: listLoops(opts.ledger),
    recent,
    repos: listRepos(opts.reposRoot),
  };
}
