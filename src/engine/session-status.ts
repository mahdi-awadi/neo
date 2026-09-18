// Deterministic, human-readable status for a live worker session — the single source of truth for
// "what is this project doing right now" text. Used wherever a blocked message/dispatch must report
// the ACTUAL state instead of an opaque "busy": the operator's queued-follow-up reply, the company's
// `dispatch` busy return, `/list`, and the company-only `sessions` tool (session awareness).
//
// The judgement itself lives in liveness.ts (pure). This module's only job is to gather the LIVE
// signals a decision needs — is a turn in flight, how deep is the queue — from the control handle,
// so no call site can forget them and describe a session from half the facts. That omission is
// exactly what produced "adminli · running · waiting for 10h" for a healthy project.
import type { Registry } from "./registry";
import type { SessionInfo } from "../types";
import {
  DEFAULT_LIVENESS_THRESHOLDS,
  describeLiveness,
  humanAge,
  livenessEvidence,
  sessionState,
  type LivenessEvidence,
  type LivenessSignals,
  type LivenessThresholds,
  type SessionState,
} from "./liveness";

export { humanAge };

/** Extra live signals a caller can fold in (the registry doesn't hold these on SessionInfo). */
export interface StatusExtras {
  /** Context-window occupancy 0..1 (from the context policy), rendered as a percentage when given. */
  ctxPct?: number;
}

/** Read the live signals for a session off its control handle. A session with no live control has
 *  nothing in flight by definition — never "busy", which is the safe reading and the true one. */
export function liveSignals(registry: Registry, s: SessionInfo): LivenessSignals {
  const control = registry.getControl(s.id);
  return {
    inTurn: control?.active?.() === true,
    queued: control?.queued?.() ?? 0,
    hasWorker: !!control,
    blockedOn: s.blockedOn,
  };
}

/** The facts behind a session's state — for logging an abort/alert before it fires. */
export function sessionEvidence(
  registry: Registry,
  s: SessionInfo,
  now: number,
  th: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): LivenessEvidence {
  return livenessEvidence(s, liveSignals(registry, s), th, now);
}

/** The one word for what a session is doing (never its registry `status`). */
export function stateOf(
  registry: Registry,
  s: SessionInfo,
  now: number,
  th: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): SessionState {
  return sessionState(s, liveSignals(registry, s), th, now);
}

/**
 * One honest line describing what a session is doing right now — state first, then what it is
 * doing, then BOTH clocks, the queue depth and the session's age:
 *   working · Bash: bun test · last activity 4s ago · last output 2m ago · 1 queued · up 3h
 *   idle · nothing in flight · last activity 10h ago · last output 10h ago · up 1d
 */
export function describeSession(
  registry: Registry,
  s: SessionInfo,
  now: number,
  th: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
  extras: StatusExtras = {},
): string {
  const line = describeLiveness(s, liveSignals(registry, s), th, now);
  if (typeof extras.ctxPct !== "number") return line;
  return `${line} · ctx ${Math.round(extras.ctxPct * 100)}%`;
}

/** A project's live status as a render-friendly row (for the company's `sessions` tool). */
export interface SessionStatusView {
  name: string;
  folder: string;
  /** What it is DOING (working/quiet/idle/awaiting-operator/wedged) — not the registry lifecycle. */
  state: SessionState;
  line: string;
}

/**
 * Live status of every OPEN project session, **excluding the company/default project** (the company
 * knows its own state; it wants to see the OTHER projects). Backs the company-only `sessions` tool —
 * deterministic, no AI.
 */
export function sessionStatuses(
  registry: Registry,
  now: number,
  th: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): SessionStatusView[] {
  const defaultId = registry.getDefault()?.id;
  return registry
    .list()
    .filter((s) => s.id !== defaultId && (s.status === "running" || s.status === "idle"))
    .map((s) => ({
      name: s.name,
      folder: s.order.folder,
      state: stateOf(registry, s, now, th),
      line: describeSession(registry, s, now, th),
    }));
}

/** The legend the report carries. The `sessions` tool is read by the company session — an AI that
 *  will act on this text — so the vocabulary is spelled out rather than left to interpretation.
 *  Its absence is how "running · waiting for 10h" became "wedged, shall I restart it?". */
const LEGEND =
  "(idle = healthy and free, at any age · quiet = working but not talking · " +
  "starting = still being prepared · awaiting-operator = it needs YOUR answer · " +
  "wedged = genuinely stuck, worth killing)";

/** A ready-to-return text report of every live project session — the body of the company's
 *  `sessions` tool (session awareness) and any place that needs the whole-fleet status as one string. */
export function sessionsReport(
  registry: Registry,
  now: number,
  th: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): string {
  const views = sessionStatuses(registry, now, th);
  if (views.length === 0) return "No projects are open right now — nothing running or idle.";
  return [...views.map((v) => `${v.name} · ${v.folder} — ${v.line}`), LEGEND].join("\n");
}
