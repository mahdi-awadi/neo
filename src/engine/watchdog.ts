// Stuck-watchdog: alert the operator ONCE when a running session looks wedged — silent past
// stuckAfterMs, or grinding one activity past longTurnAlertMs. Pure + clock-injected (daemon
// drives it on the 60s tick). Observer only: it never interrupts a worker; recovery is /kill.
import type { SessionInfo } from "../types";
import type { Registry } from "./registry";

export interface WatchdogOpts {
  now: number;
  stuckAfterMs: number;
  longTurnAlertMs: number;
  alertRepeatMs: number;
  alert: (s: SessionInfo, reason: string) => void;
}

/** Alert on wedged-looking running sessions (deduped via alertedAt). Returns those alerted. */
export function sweepStuck(registry: Registry, opts: WatchdogOpts): SessionInfo[] {
  const { now, stuckAfterMs, longTurnAlertMs, alertRepeatMs } = opts;
  const alerted: SessionInfo[] = [];
  for (const s of registry.list()) {
    if (s.status !== "running") continue;
    // "waiting" = the worker just hit a turn boundary and is idle between turns, not stuck
    // mid-turn — it is healthy no matter how long it sits there (F1).
    if (s.activity?.label === "waiting") continue;
    if (s.alertedAt !== undefined && now - s.alertedAt < alertRepeatMs) continue; // dedup window
    const silentFor = now - s.lastActivityAt;
    const grindingFor = s.activity ? now - s.activity.since : 0;
    let reason: string | undefined;
    if (silentFor >= stuckAfterMs) {
      reason = `${s.name} has been silent for ${Math.round(silentFor / 60000)}m` + (s.activity ? ` (last: ${s.activity.label})` : "");
    } else if (s.activity && grindingFor >= longTurnAlertMs) {
      reason = `${s.name} has been on "${s.activity.label}" for ${Math.round(grindingFor / 60000)}m`;
    }
    if (!reason) continue;
    registry.noteAlert(s.id, now);
    try {
      opts.alert(s, `⚠️ ${reason} — reply /kill ${s.name} to abort.`);
    } catch {
      // observer only — an alert-channel failure must never break the sweep
    }
    alerted.push(s);
  }
  return alerted;
}
