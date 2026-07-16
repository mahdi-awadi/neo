// Deterministic, human-readable status for a live worker session — the single source of truth
// for "what is this project doing right now" text. Used wherever a blocked message/dispatch must
// report the ACTUAL status instead of an opaque "busy": the operator's queued-follow-up reply, the
// company's `dispatch` busy return, and the company-only `sessions` tool (session awareness). It
// mirrors what `/list` already shows the operator (activity label + how long + queue depth).
import type { Registry } from "./registry";
import type { SessionInfo } from "../types";

/** Compact duration: 5s · 3m · 4h · 2d. Shared with commands.ts (the /list renderer). */
export function humanAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Extra live signals a caller can fold in (the registry doesn't hold these on SessionInfo). */
export interface StatusExtras {
  /** Follow-ups waiting behind the in-flight turn (from the control handle's `queued()`). */
  queued?: number;
  /** Context-window occupancy 0..1 (from the context policy), rendered as a percentage when given. */
  ctxPct?: number;
}

/**
 * One line describing what a session is doing right now:
 *   running · <activity> for <age> · <n> queued · ctx 42% · up <age>
 *   idle · last active <age> ago
 * Only the parts that apply are shown, so a quiet idle session reads clean.
 */
export function describeSessionStatus(s: SessionInfo, now: number, extras: StatusExtras = {}): string {
  const parts: string[] = [s.status];
  if (s.status === "running") {
    if (s.activity) parts.push(`${s.activity.label} for ${humanAge(Math.max(0, now - s.activity.since))}`);
    if (extras.queued && extras.queued > 0) parts.push(`${extras.queued} queued`);
    if (typeof extras.ctxPct === "number") parts.push(`ctx ${Math.round(extras.ctxPct * 100)}%`);
    parts.push(`up ${humanAge(Math.max(0, now - s.startedAt))}`);
  } else {
    // idle / done / error — report how long since it last did anything.
    parts.push(`last active ${humanAge(Math.max(0, now - s.lastActivityAt))} ago`);
  }
  return parts.join(" · ");
}

/** A project's live status as a render-friendly row (for the company's `sessions` tool). */
export interface SessionStatusView {
  name: string;
  folder: string;
  status: SessionInfo["status"];
  line: string;
}

/**
 * Live status of every OPEN project session, **excluding the company/default project** (the company
 * knows its own state; it wants to see the OTHER projects). Reads the queue depth from each session's
 * control handle. Backs the company-only `sessions` tool — deterministic, no AI.
 */
export function sessionStatuses(registry: Registry, now: number): SessionStatusView[] {
  const defaultId = registry.getDefault()?.id;
  return registry
    .list()
    .filter((s) => s.id !== defaultId && (s.status === "running" || s.status === "idle"))
    .map((s) => {
      const queued = registry.getControl(s.id)?.queued?.() ?? 0;
      return {
        name: s.name,
        folder: s.order.folder,
        status: s.status,
        line: describeSessionStatus(s, now, { queued }),
      };
    });
}

/** A ready-to-return text report of every live project session — the body of the company's
 *  `sessions` tool (session awareness) and any place that needs the whole-fleet status as one string. */
export function sessionsReport(registry: Registry, now: number): string {
  const views = sessionStatuses(registry, now);
  if (views.length === 0) return "No projects are open right now — nothing running or idle.";
  return views.map((v) => `${v.name} · ${v.folder} — ${v.line}`).join("\n");
}
