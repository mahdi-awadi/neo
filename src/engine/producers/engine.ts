/** The engine producer (ADR-0018, spec §7 + §8): what the engine itself knows needs the operator — a
 *  stuck approval, a dispatch that repeats itself (the mark dispatch.ts sets, spec §8.1), a paused
 *  queue, a failed or long-waiting thread, a stale decision, an impossible context %, and (ADR-0067) the
 *  task history's services off or down too long and a failing snapshot backup. It reads only the ledger,
 *  the registry and in-memory states (an injectable context measure, the newest indexer pass, the backup
 *  schedule), so it runs on every heartbeat tick. Plain code, no AI. */
import { basename } from "node:path";
import { PAGE_MAX, type AttentionDraft, type Ledger, type ThreadRow } from "../ledger";
import type { Registry } from "../registry";
import type { SessionInfo } from "../../types";
import { liveDrafts, reconcileAll } from "../attention";
import { faults } from "../fault";
import { isValidCron } from "../trigger";
import type { HistoryCfg } from "../history/defaults";
import type { ServiceReport } from "../history/indexer";
import { operatorStep, type HistoryService } from "../history/services";
import type { BackupState } from "../backup/schedule";

const HOUR = 3_600_000;

/** Every kind this producer raises (the attention briefs need one template per kind). */
export const ENGINE_KINDS = [
  "approval_stuck", "dispatch_spinning", "queue_paused", "thread_failed", "thread_waiting", "decision_stale", "ctx_window_suspect",
  "history_off", "history_degraded", "backup_failed",
] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

/** Config `attention` (config.json): how long a state may last before it needs the operator. */
export interface AttentionCfg {
  queuePausedHours: number;
  waitingHours: number;
  decisionStaleHours: number;
  /** A failed thread stays an item this long after it failed. */
  failedLookbackHours: number;
  /** Resolved items are deleted this long after they resolved (a dismissed one is kept). */
  keepResolvedDays: number;
  /** How long `snooze` hides an item. */
  snoozeHours: number;
  /** `/attention`: at most this many lines, and one-tap buttons for the first `listButtons` items. */
  listLines: number;
  listButtons: number;
  /** The git scan: an unmerged branch with no commit this long is stale. */
  staleBranchDays: number;
  /** The git scan: a linked worktree nobody worked in this long is left over. */
  worktreeIdleHours: number;
  /** When the daily digest is sent (cron, server time). */
  digestAt: string;
}

export const DEFAULT_ATTENTION_CFG: AttentionCfg = { queuePausedHours: 6, waitingHours: 12, decisionStaleHours: 24, failedLookbackHours: 72, keepResolvedDays: 30, snoozeHours: 24, listLines: 30, listButtons: 10, staleBranchDays: 21, worktreeIdleHours: 12, digestAt: "0 8 * * *" };

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
    keepResolvedDays: positive(r.keepResolvedDays, d.keepResolvedDays),
    snoozeHours: positive(r.snoozeHours, d.snoozeHours),
    listLines: Math.floor(positive(r.listLines, d.listLines)),
    listButtons: Math.floor(positive(r.listButtons, d.listButtons)),
    staleBranchDays: positive(r.staleBranchDays, d.staleBranchDays),
    worktreeIdleHours: positive(r.worktreeIdleHours, d.worktreeIdleHours),
    digestAt: typeof r.digestAt === "string" && isValidCron(r.digestAt) ? r.digestAt : d.digestAt,
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
  /** Where the engine's own items (history, backup) are filed; default the company. */
  neoFolder?: string;
  /** The task history (ADR-0067), absent when it is off: its config and the service states of the newest
   *  indexer pass (undefined before the first pass — the live items are kept, never resolved by mistake). */
  history?: { cfg: Pick<HistoryCfg, "embedder" | "vectors" | "degradedAlertMinutes">; services: () => { embedder: ServiceReport; vectors: ServiceReport } | undefined };
  /** The snapshot backup schedule's state (ADR-0067 Decision 8). */
  backups?: () => Pick<BackupState, "failing">;
}

/** What the engine sees now, as drafts. */
export function engineDrafts(deps: EngineProducerDeps, now: number): AttentionDraft[] {
  return engineScan(deps, now).drafts;
}

/** The drafts, plus the kinds whose read failed or was cut at a page. Each kind is read on its own: a
 *  failed read is reported and costs that kind only, never the others. */
function engineScan(deps: EngineProducerDeps, now: number): { drafts: AttentionDraft[]; failed: Set<EngineKind> } {
  const { ledger, registry, cfg } = deps;
  const company = { project: basename(cfg.companyFolder), folder: cfg.companyFolder };
  // One name per project for every kind: the folder's (a session may be named `gold-2`).
  const at = (folder: string | undefined) => (folder ? { project: basename(folder), folder } : company);
  const out: AttentionDraft[] = [];
  // `kind` is an EngineKind: a new kind must join ENGINE_KINDS, so the brief-coverage test sees it.
  const draft = (d: Omit<AttentionDraft, "source" | "severity" | "kind"> & { kind: EngineKind; severity?: AttentionDraft["severity"] }): void =>
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
      draft({ ...at(s.order.folder), kind: "approval_stuck", key: s.id, severity: "high", title: `approval pending ${age(now - b.since)}: ${b.label}`, facts: { since: b.since, label: b.label } });
    }
  });

  kind("dispatch_spinning", () => {
    for (const s of sessions) {
      if (!s.spinning || s.status !== "running") continue;
      draft({ ...at(s.order.folder), kind: "dispatch_spinning", key: s.id, severity: "high", title: `repeating itself for ${age(now - s.spinning.since)}: ${s.spinning.label}`, facts: { since: s.spinning.since, label: s.spinning.label } });
    }
  });

  kind("queue_paused", () => {
    for (const p of ledger.listTodoPaused()) {
      if (now - p.at <= cfg.queuePausedHours * HOUR) continue;
      draft({ ...at(p.folder), kind: "queue_paused", key: p.folder, title: `todo queue paused ${age(now - p.at)}: ${p.reason}`, facts: { since: p.at, reason: p.reason } });
    }
  });

  // A read cut at one page is partial: its drafts count, and its other live rows are kept, so the
  // threads past the page are never resolved by mistake. Oldest first: those are the ones that matter.
  const page = (name: EngineKind, rows: ThreadRow[]): ThreadRow[] => {
    if (rows.length <= PAGE_MAX) return rows;
    failed.add(name);
    return rows.slice(0, PAGE_MAX);
  };

  kind("thread_failed", () => {
    for (const t of page("thread_failed", ledger.threadsByState("failed", { since: now - cfg.failedLookbackHours * HOUR, limit: PAGE_MAX + 1 }))) {
      draft({ ...at(t.folder), kind: "thread_failed", key: String(t.id), title: `thread failed: ${t.title}`, facts: { thread: t.id, threadTitle: t.title } });
    }
  });

  // Waiting with no new line for waitingHours (the thread's clock is its last update).
  kind("thread_waiting", () => {
    for (const t of page("thread_waiting", ledger.threadsByState("waiting", { until: now - cfg.waitingHours * HOUR, limit: PAGE_MAX + 1 }))) {
      draft({ ...at(t.folder), kind: "thread_waiting", key: String(t.id), title: `thread waiting ${age(now - t.updatedAt)}: ${t.title}`, facts: { thread: t.id, threadTitle: t.title, since: t.updatedAt } });
    }
  });

  kind("decision_stale", () => {
    for (const d of ledger.listOpenDecisions()) {
      if (d.kind !== "decision" || now - d.createdAt <= cfg.decisionStaleHours * HOUR) continue;
      draft({ ...at(d.folder), kind: "decision_stale", key: d.id, title: `decision open ${age(now - d.createdAt)}: ${d.question}`, facts: { decision: d.id.slice(0, 8), question: d.question, since: d.createdAt } });
    }
  });

  kind("ctx_window_suspect", () => {
    if (!deps.measure) return;
    for (const s of sessions) {
      if (!s.sdkSessionId || s.status !== "running") continue;
      const m = deps.measure(s);
      if (!m || m.occupancy <= 1) continue;
      draft({
        ...at(s.order.folder), kind: "ctx_window_suspect", key: s.order.folder,
        title: `ctx ${Math.round(m.occupancy * 100)}% is impossible: model ${m.model ?? "unknown"}, window ${m.windowTokens ?? "unknown"} tokens`,
        detail: JSON.stringify({ occupancy: m.occupancy, model: m.model ?? null, windowTokens: m.windowTokens ?? null }),
        facts: { pct: Math.round(m.occupancy * 100), model: m.model ?? "unknown", window: m.windowTokens ?? 0 },
      });
    }
  });
  // The task history's services (ADR-0067): `off` needs the operator at once, and the item names the step;
  // `down` (or slow) becomes an item only after `degradedAlertMinutes`. One item per service.
  const neo = at(deps.neoFolder);
  const services = deps.history ? faults.guard("attention.engine.history", () => deps.history!.services()) : undefined;
  if (deps.history && services === undefined) failed.add("history_off").add("history_degraded");
  const serviceList: Array<[HistoryService, ServiceReport]> = services ? [["embedder", services.embedder], ["vectors", services.vectors]] : [];
  kind("history_off", () => {
    for (const [service, s] of serviceList) {
      if (s.state !== "off" || !s.reason) continue;
      const step = operatorStep(service, s.reason, deps.history!.cfg);
      draft({ ...neo, kind: "history_off", key: service, severity: "high", title: `history search off (${service}): ${s.reason}`, facts: { service, reason: s.reason, step, since: s.since } });
    }
  });
  kind("history_degraded", () => {
    const limit = deps.history!.cfg.degradedAlertMinutes * 60_000;
    for (const [service, s] of serviceList) {
      if (s.state !== "down" || !s.reason || now - s.since < limit) continue;
      const step = operatorStep(service, s.reason, deps.history!.cfg);
      draft({ ...neo, kind: "history_degraded", key: service, title: `history ${service} down ${age(now - s.since)}: ${s.reason}`, facts: { service, reason: s.reason, step, since: s.since } });
    }
  });

  // A snapshot backup or the restore drill in a failure streak; the next success ends it.
  kind("backup_failed", () => {
    for (const f of deps.backups?.().failing ?? []) {
      const drill = f.kind === "drill";
      draft({
        ...neo, kind: "backup_failed", key: f.job, severity: "high",
        title: `${drill ? "restore drill" : "snapshot backup"} of ${f.path} failed: ${f.code}`,
        facts: { path: f.path, code: f.code, reason: `${drill ? "restore drill, " : ""}${f.code}: ${f.reason}`, since: f.since, streak: f.streak },
      });
    }
  });
  return { drafts: out, failed };
}

/** One heartbeat step: read the drafts, reconcile them (ADR-0018). A kind whose read failed keeps
 *  its live rows as they are — a failed read never resolves anything. */
export function runEngineProducer(deps: EngineProducerDeps, now: number): { opened: number[]; resolved: number[] } {
  const { drafts, failed } = engineScan(deps, now);
  drafts.push(...liveDrafts(deps.ledger, "engine", failed));
  const r = reconcileAll(deps.ledger, "engine", drafts, now, { keepResolvedMs: deps.cfg.keepResolvedDays * 24 * HOUR });
  // An impossible ctx% is also an event (spec §8.5) — once, when its item opens.
  for (const id of r.opened) {
    const row = deps.ledger.attentionById(id);
    if (row?.kind !== "ctx_window_suspect") continue;
    deps.ledger.recordEvent("ctx_window_suspect", { folder: row.folder, data: { project: row.project, ...(JSON.parse(row.detail ?? "{}") as object) } });
  }
  return r;
}

/** A compact age for a title: `45m`, `7h`, `3d`. */
function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
