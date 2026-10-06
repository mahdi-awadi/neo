/** The engine producer (ADR-0018, spec §7 + §8): what the engine itself knows needs the operator — a
 *  stuck approval, a paused queue, a failed or long-waiting thread, a stale decision, an impossible
 *  context %. It reads only the ledger and the registry (plus an injectable context measure), so it
 *  runs on every heartbeat tick. Plain code, no AI. `dispatch_spinning` is added with its detector
 *  (Task 4.3). */
import { basename } from "node:path";
import type { AttentionDraft, Ledger } from "../ledger";
import type { Registry } from "../registry";
import type { SessionInfo } from "../../types";
import { reconcileAll } from "../attention";
import { faults } from "../fault";

const HOUR = 3_600_000;

/** Every kind this producer raises (the attention briefs need one template per kind). */
export const ENGINE_KINDS = ["approval_stuck", "queue_paused", "thread_failed", "thread_waiting", "decision_stale", "ctx_window_suspect"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

/** Config `attention` (config.json): how long a state may last before it needs the operator. */
export interface AttentionCfg {
  queuePausedHours: number;
  waitingHours: number;
  decisionStaleHours: number;
  /** A failed thread stays an item this long after it failed. */
  failedLookbackHours: number;
}

export const DEFAULT_ATTENTION_CFG: AttentionCfg = { queuePausedHours: 6, waitingHours: 12, decisionStaleHours: 24, failedLookbackHours: 72 };

/** Config `attention` from config.json: each positive number is kept, anything else is the default. */
export function readAttentionCfg(raw: unknown): AttentionCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const positive = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const d = DEFAULT_ATTENTION_CFG;
  return {
    queuePausedHours: positive(r.queuePausedHours, d.queuePausedHours),
    waitingHours: positive(r.waitingHours, d.waitingHours),
    decisionStaleHours: positive(r.decisionStaleHours, d.decisionStaleHours),
    failedLookbackHours: positive(r.failedLookbackHours, d.failedLookbackHours),
  };
}

/** One session's measured context: the occupancy and the model and window it was divided by. */
export type ContextMeasure = (s: SessionInfo) => { occupancy: number; model?: string; windowTokens?: number } | undefined;

export interface EngineProducerDeps {
  ledger: Ledger;
  registry: Registry;
  cfg: AttentionCfg & {
    /** The governor's approval reminder: an approval older than this is stuck. */
    approvalRemindMs: number;
    /** Items with no project are filed under the company. */
    companyFolder: string;
  };
  /** Measures a live session's context (the daemon passes sessionContext over the SDK-reported windows). */
  measure?: ContextMeasure;
}

/** What the engine sees now, as drafts. */
export function engineDrafts(deps: EngineProducerDeps, now: number): AttentionDraft[] {
  return engineScan(deps, now).drafts;
}

/** The drafts, plus the kinds whose read failed. Each kind is read on its own: a failed read is
 *  reported and costs that kind only, never the others. */
function engineScan(deps: EngineProducerDeps, now: number): { drafts: AttentionDraft[]; failed: Set<EngineKind> } {
  const { ledger, registry, cfg } = deps;
  const company = { project: basename(cfg.companyFolder), folder: cfg.companyFolder };
  const out: AttentionDraft[] = [];
  const draft = (d: Omit<AttentionDraft, "source" | "severity"> & { severity?: AttentionDraft["severity"] }): void =>
    void out.push({ source: "engine", severity: "normal", ...d });
  const failed = new Set<EngineKind>();
  const kind = (name: EngineKind, read: () => void): void => {
    const before = out.length;
    if (faults.guard(`attention.engine.${name}`, () => (read(), true)) === undefined) {
      out.length = before; // a half-read kind reports nothing; its live rows are carried instead
      failed.add(name);
    }
  };
  const sessions = registry.list();

  kind("approval_stuck", () => {
    for (const s of sessions) {
      const b = s.blockedOn;
      if (b?.kind !== "approval" || now - b.since <= cfg.approvalRemindMs) continue;
      draft({ project: s.name, folder: s.order.folder, kind: "approval_stuck", key: s.id, severity: "high", title: `approval pending ${age(now - b.since)}: ${b.label}` });
    }
  });

  kind("queue_paused", () => {
    for (const p of ledger.listTodoPaused()) {
      if (now - p.at <= cfg.queuePausedHours * HOUR) continue;
      draft({ project: basename(p.folder), folder: p.folder, kind: "queue_paused", key: p.folder, title: `todo queue paused ${age(now - p.at)}: ${p.reason}` });
    }
  });

  kind("thread_failed", () => {
    for (const t of ledger.listThreads({ state: "failed", since: now - cfg.failedLookbackHours * HOUR }, { limit: 100 }).rows) {
      draft({ ...(t.project && t.folder ? { project: t.project, folder: t.folder } : company), kind: "thread_failed", key: String(t.id), title: `thread failed: ${t.title}` });
    }
  });

  kind("thread_waiting", () => {
    for (const t of ledger.listThreads({ state: "waiting" }, { limit: 100 }).rows) {
      if (now - t.updatedAt <= cfg.waitingHours * HOUR) continue;
      draft({ ...(t.project && t.folder ? { project: t.project, folder: t.folder } : company), kind: "thread_waiting", key: String(t.id), title: `thread waiting ${age(now - t.updatedAt)}: ${t.title}` });
    }
  });

  kind("decision_stale", () => {
    for (const d of ledger.listOpenDecisions()) {
      if (d.kind !== "decision" || now - d.createdAt <= cfg.decisionStaleHours * HOUR) continue;
      draft({ ...(d.project && d.folder ? { project: d.project, folder: d.folder } : company), kind: "decision_stale", key: d.id, title: `decision open ${age(now - d.createdAt)}: ${d.question}` });
    }
  });

  kind("ctx_window_suspect", () => {
    if (!deps.measure) return;
    for (const s of sessions) {
      if (!s.sdkSessionId || s.status !== "running") continue;
      const m = deps.measure(s);
      if (!m || m.occupancy <= 1) continue;
      draft({
        project: s.name, folder: s.order.folder, kind: "ctx_window_suspect", key: s.order.folder,
        title: `ctx ${Math.round(m.occupancy * 100)}% is impossible: model ${m.model ?? "unknown"}, window ${m.windowTokens ?? "unknown"} tokens`,
      });
    }
  });
  return { drafts: out, failed };
}

/** One heartbeat step: read the drafts, reconcile them (ADR-0018). A kind whose read failed keeps
 *  its live rows as they are — a failed read never resolves anything. */
export function runEngineProducer(deps: EngineProducerDeps, now: number): { opened: number[]; resolved: number[] } {
  const { drafts, failed } = engineScan(deps, now);
  if (failed.size) {
    for (const project of deps.ledger.attentionProjects("engine")) {
      for (const r of deps.ledger.attentionRows(project, "engine")) {
        if (!failed.has(r.kind as EngineKind) || (r.resolvedAt !== undefined && !r.dismissed)) continue;
        drafts.push({ project: r.project, folder: r.folder, source: "engine", kind: r.kind, key: r.key, title: r.title, detail: r.detail, url: r.url, severity: r.severity });
      }
    }
  }
  return reconcileAll(deps.ledger, "engine", drafts, now);
}

/** A compact age for a title: `45m`, `7h`, `3d`. */
function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
