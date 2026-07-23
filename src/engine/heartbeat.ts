// The daemon's single derived tick. AI-free, deterministic: no fixed "poll every N seconds" knob —
// the tick derives from the enabled loops' own trigger definitions. Cron expressions resolve at
// minute granularity (a property of cron itself, not a tuning choice, hence CRON_RESOLUTION_MS is a
// documented FACT, not a knob); an enabled interval trigger shorter than that pulls the tick down to
// its own period, so a fast interval loop takes effect immediately with no restart. Disabled loops
// contribute nothing — matching the scheduler's own enabled resolution (isEnabled ?? enabledByDefault).
import type { Trigger } from "./trigger";

/** Cron's own resolution: a 5-field cron expression can't fire more than once a minute. This is a
 *  fact of cron, not tuning — the floor the derived heartbeat never goes below on its own. */
export const CRON_RESOLUTION_MS = 60_000;

/** OPERATOR-FACING FLOOR for an interval loop's `intervalMinutes` (loop-validate.ts), tied to
 *  CRON_RESOLUTION_MS: the daemon's own tick can't fire more often than that resolution, so an
 *  interval below it is unsatisfiable — a fact about the tick, not a tuning choice. Exported here
 *  so validation and the tick derivation cite the SAME number. */
export const MIN_INTERVAL_MS = CRON_RESOLUTION_MS;

/** DEFENSIVE FLOOR on the derived tick itself (heartbeatMs's return), independent of validation:
 *  below ~1s the tick body's own sqlite reads (idle/stuck sweep, loop scheduler) dominate the
 *  loop, so this guards against a `setTimeout(0)` hot-loop if a ledger row predates
 *  MIN_INTERVAL_MS validation (e.g. written by an older build). Not reachable through validated
 *  input today — a last-resort clamp, not a knob. */
export const MIN_TICK_FLOOR_MS = 1_000;

export interface HeartbeatLoop {
  enabled: boolean;
  trigger: Trigger;
}

/** The daemon's tick: the cron resolution, unless an ENABLED interval loop asks for something
 *  shorter — in which case the fastest such interval wins. Disabled loops and non-interval
 *  triggers (manual/cron) never speed up the tick. Always clamped to at least MIN_TICK_FLOOR_MS,
 *  regardless of what an interval loop asks for (see MIN_TICK_FLOOR_MS). */
export function heartbeatMs(loops: HeartbeatLoop[]): number {
  const intervals = loops
    .filter((l): l is HeartbeatLoop & { trigger: Extract<Trigger, { kind: "interval" }> } => l.enabled && l.trigger.kind === "interval")
    .map((l) => l.trigger.everyMs);
  return Math.max(MIN_TICK_FLOOR_MS, Math.min(CRON_RESOLUTION_MS, ...intervals));
}

/** Delay (ms) until the NEXT tick boundary, aligned to hbMs-wide windows from the epoch — not
 *  "now + hbMs", which would drift by however long the previous tick's body took to run (the
 *  self-rescheduling setTimeout chain in daemon.ts re-arms AFTER the body). That drift can push a
 *  tick's minute-instant sampling past a `30 3 * * *` cron's one matching minute and silently skip
 *  the day's firing (trigger.ts isDue needs an exact minute match at the tick instant). Landing each
 *  tick just after its boundary regardless of body duration closes that gap. Exactly ON a boundary
 *  (nowMs % hbMs === 0) returns a FULL window, not 0 — a boundary instant must still wait one window,
 *  never busy-loop. Deterministic: pure function of (nowMs, hbMs). */
export function nextTickDelayMs(nowMs: number, hbMs: number): number {
  return hbMs - (nowMs % hbMs);
}
