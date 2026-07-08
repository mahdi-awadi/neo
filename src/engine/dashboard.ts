// Structured snapshot the web dashboard renders — projects, usage, loops, recent orders, and
// the known repos (for the New-project picker). The dashboard is all UI controls over this
// data + the action endpoints; no command typing. Deterministic, AI-free.
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import type { UsageMeter, UsageSnapshot } from "./usage";
import { listLoops, type LoopInfo } from "./loops";
import { sessionContext, type ContextSignals } from "./context-policy";

export interface DashProject {
  id: string;
  name: string;
  folder: string;
  status: string;
  task: string;
  active: boolean;
  ageMs: number;
  activity?: { label: string; since: number };
  queued?: number;
  ctxPct?: number;
}

export interface DashState {
  projects: DashProject[];
  usage: UsageSnapshot | null;
  loops: LoopInfo[];
  recent: Array<{ folder: string; task: string; status: string }>;
  repos: string[];
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
  signals?: (folder: string, sdkSessionId: string) => ContextSignals;
}): DashState {
  const now = opts.now ?? Date.now();
  const activeId = opts.registry.findByChat(opts.chatId)?.id;
  const projects: DashProject[] = opts.registry.list().map((s) => {
    let ctxPct: number | undefined;
    if (s.sdkSessionId && opts.signals) {
      try {
        const sig = (opts.signals ?? sessionContext)(s.order.folder, s.sdkSessionId);
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
  return {
    projects,
    usage: opts.usage ? opts.usage.snapshot(now) : null,
    loops: listLoops(opts.ledger),
    recent,
    repos: listRepos(opts.reposRoot),
  };
}
