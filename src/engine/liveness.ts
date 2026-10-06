// Is this session working, or is it wedged? — the ONE place that answers that question.
//
// The engine used to hold several partial signals (`status`, `activity.since`, `lastActivityAt`,
// a dispatch-local stall clock) and report whichever one was nearest, which is how a healthy
// project came to be described as "running · waiting for 10h" and offered for a restart. Every
// judgement now goes through here: pure, clock-injected, no I/O, no registry access.
//
// Two clocks, and only one of them decides anything:
//   • lastActivityAt — ANY streamed SDK event (partial delta, tool call, tool result, system,
//     result). The authoritative liveness signal. Alive-or-wedged reads this and nothing else.
//   • lastOutputAt   — the last operator-VISIBLE line. Reported, never judged: a worker writing one
//     huge file for ten minutes is silent to the operator and perfectly alive.
// See docs/adr/0003-one-activity-clock-one-derived-session-state.md and CONTEXT.md.
import type { SessionInfo } from "../types";

/** What a session is doing, derived from the clocks — never stored. See CONTEXT.md. */
export type SessionState =
  /** Registered, but no worker handle is attached yet — the engine is still preparing it (indexing
   *  the folder, running the context gate). It cannot take a brief; it is not broken either. */
  | "starting"
  /** In-turn, activity seen recently. */
  | "working"
  /** In-turn and alive, but nothing operator-visible for a while (a long build, a big file). */
  | "quiet"
  /** Open, between turns. Healthy and available NOW, at any age. */
  | "idle"
  /** In-turn but blocked on the operator — their clock, so never wedged and never stall-aborted. */
  | "awaiting-operator"
  /** In-turn and genuinely silent past the threshold. The only state that means something is wrong. */
  | "wedged";

/** Why the operator owes this session an answer. Set by the engine when it raises the ask. */
export interface BlockedOn {
  /** `approval` = a governor permission escalation (the worker's tool call is suspended mid-turn);
   *  `decision` = a tracked decision raised via ask_operator / AskUserQuestion. */
  kind: "approval" | "decision";
  /** Short human text — the tool/reason or the decision title. */
  label: string;
  since: number;
}

/** Live signals the registry doesn't hold on SessionInfo (they come from the control handle). */
export interface LivenessSignals {
  /** A turn is being worked RIGHT NOW (`SessionControl.active()`), as opposed to sitting between
   *  turns. Absent/false is the safe reading: a session with nothing in flight is never wedged. */
  inTurn: boolean;
  /** Follow-ups waiting behind the in-flight turn. */
  queued: number;
  /** A live worker handle is attached. Explicit `false` = the engine registered the session but has
   *  not started/attached its worker yet (indexing, context gate, a lost handle after a reload).
   *  Undefined means "don't know, assume yes" so older callers/fakes keep their behaviour. */
  hasWorker?: boolean;
  /** Set while the operator owes an answer (mirrors `SessionInfo.blockedOn`; passed for callers
   *  that know it before the registry does). */
  blockedOn?: BlockedOn;
}

export interface LivenessThresholds {
  /** In-turn with NO activity for this long → wedged. */
  wedgedAfterMs: number;
  /** In-turn and alive, but no operator-visible output for this long → quiet. */
  quietAfterMs: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  wedgedAfterMs: 5 * 60 * 1000,
  quietAfterMs: 3 * 60 * 1000,
};

/** Compact duration: 5s · 3m · 4h · 2d. The one duration renderer for operator-facing text. */
export function humanAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The blocked-on fact, preferring the caller's live signal over the stored one. */
function blocked(s: SessionInfo, sig: LivenessSignals): BlockedOn | undefined {
  return sig.blockedOn ?? s.blockedOn;
}

/** The last time this session produced operator-visible output. Falls back to the activity clock
 *  for entries created before `lastOutputAt` existed (and for freshly-added sessions). */
function outputAt(s: SessionInfo): number {
  return s.lastOutputAt ?? s.lastActivityAt;
}

/**
 * What this session is doing, right now. First match wins:
 *   1. the run has ended        → idle
 *   2. the operator owes it an answer → awaiting-operator
 *   3. no worker attached yet   → starting
 *   4. nothing in flight        → idle   (healthy at ANY age — this is not a fault)
 *   5. no activity past wedgedAfterMs → wedged
 *   6. no OUTPUT past quietAfterMs    → quiet
 *   7. otherwise                → working
 */
export function sessionState(
  s: SessionInfo,
  sig: LivenessSignals,
  th: LivenessThresholds,
  now: number,
): SessionState {
  if (s.status !== "running") return "idle";
  if (blocked(s, sig)) return "awaiting-operator";
  if (sig.hasWorker === false) return "starting";
  if (!sig.inTurn) return "idle";
  if (now - s.lastActivityAt >= th.wedgedAfterMs) return "wedged";
  if (now - outputAt(s) >= th.quietAfterMs) return "quiet";
  return "working";
}

/** The facts a liveness decision was made on — logged BEFORE any abort/alert fires, so an
 *  operator (or an agent reading the log alone) can check the engine's reasoning after the fact. */
export interface LivenessEvidence {
  state: SessionState;
  inTurn: boolean;
  queued: number;
  /** Age in ms of each clock at decision time. */
  lastActivityMs: number;
  lastOutputMs: number;
  /** What it was last seen doing, and how long it has carried that label. */
  activity?: string;
  activityForMs?: number;
  blockedOn?: BlockedOn;
  blockedForMs?: number;
  /** Best-effort: the last activity looks like a command that sits on an interactive prompt. */
  stdinWait: boolean;
}

export function livenessEvidence(
  s: SessionInfo,
  sig: LivenessSignals,
  th: LivenessThresholds,
  now: number,
): LivenessEvidence {
  const b = blocked(s, sig);
  return {
    state: sessionState(s, sig, th, now),
    inTurn: sig.inTurn,
    queued: sig.queued,
    lastActivityMs: Math.max(0, now - s.lastActivityAt),
    lastOutputMs: Math.max(0, now - outputAt(s)),
    activity: s.activity?.label,
    activityForMs: s.activity ? Math.max(0, now - s.activity.since) : undefined,
    blockedOn: b,
    blockedForMs: b ? Math.max(0, now - b.since) : undefined,
    stdinWait: looksLikeStdinWait(s.activity?.label),
  };
}

/**
 * One honest, self-explaining line about a session — the single renderer behind `/list`, the
 * `sessions` tool and dispatch's busy replies. It leads with the derived STATE (never the registry
 * `status`, which only says whether the entry is open) and always carries both clocks, so nothing
 * downstream has to interpret an ambiguous number:
 *   working · Bash: bun test · last activity 1s ago · last output 5s ago · 2 queued · up 3h
 *   idle · nothing in flight · last activity 10h ago · last output 10h ago · up 1d
 *   awaiting-operator · decision: Postgres or Mongo? · blocked 6m · last activity 6m ago · up 2h
 *   wedged · no activity for 12m · last: Bash: cp -i a b · possible interactive prompt (stdin wait)
 */
export function describeLiveness(
  s: SessionInfo,
  sig: LivenessSignals,
  th: LivenessThresholds,
  now: number,
): string {
  const ev = livenessEvidence(s, sig, th, now);
  const parts: string[] = [ev.state];

  if (ev.state === "awaiting-operator" && ev.blockedOn) {
    parts.push(`${ev.blockedOn.kind}: ${ev.blockedOn.label}`);
    parts.push(`blocked ${humanAge(ev.blockedForMs ?? 0)}`);
  } else if (ev.state === "idle") {
    parts.push("nothing in flight");
  } else if (ev.state === "starting") {
    parts.push(ev.activity ? `${ev.activity} (no worker attached yet)` : "no worker attached yet");
  } else if (ev.state === "wedged") {
    parts.push(`no activity for ${humanAge(ev.lastActivityMs)}`);
    if (ev.activity) parts.push(`last: ${ev.activity}`);
    if (ev.stdinWait) parts.push("possible interactive prompt (stdin wait)");
  } else if (ev.activity) {
    parts.push(ev.activity);
  }

  parts.push(`last activity ${humanAge(ev.lastActivityMs)} ago`);
  parts.push(`last output ${humanAge(ev.lastOutputMs)} ago`);
  if (ev.queued > 0) parts.push(`${ev.queued} queued`);
  parts.push(`up ${humanAge(Math.max(0, now - s.startedAt))}`);
  return parts.join(" · ");
}

/** Commands that sit on a prompt forever when nothing is on stdin — the `cp -i` hang the operator
 *  watched for nine minutes. Evidence only: it annotates a wedge that has ALREADY been declared on
 *  the activity clock, and never causes one (a false positive must not be able to kill a worker). */
const INTERACTIVE_COMMANDS: RegExp[] = [
  /\b(cp|mv|rm|ln)\b[^|;&]*?\s-{1,2}[a-zA-Z]*i\b/, // cp -i / mv --interactive
  /\bgit\s+\w+\b[^|;&]*?\s-{1,2}[a-zA-Z]*i\b/, // git rebase -i / git add -i
  /\b(npm|yarn|pnpm)\s+init\b(?![^|;&]*\s-{1,2}y\b)/, // npm init without --yes
  /\b(apt|apt-get|dnf|yum)\s+\w+\b(?![^|;&]*\s-{1,2}y\b)/, // package installs without --yes
  /\bssh\b(?![^|;&]*BatchMode)/, // host-key / password prompt
  /(^|[;&|]\s*)read\b/, // a bare shell `read`
];

/** True when an activity label is a shell command that plausibly waits on stdin. Pure + cheap. */
export function looksLikeStdinWait(label: string | undefined): boolean {
  if (!label) return false;
  const m = /^Bash(?::\s*(.*))?$/.exec(label);
  if (!m) return false;
  const cmd = m[1] ?? "";
  return INTERACTIVE_COMMANDS.some((re) => re.test(cmd));
}
