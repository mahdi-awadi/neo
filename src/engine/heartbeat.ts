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

export interface HeartbeatLoop {
  enabled: boolean;
  trigger: Trigger;
}

/** The daemon's tick: the cron resolution, unless an ENABLED interval loop asks for something
 *  shorter — in which case the fastest such interval wins. Disabled loops and non-interval
 *  triggers (manual/cron) never speed up the tick. */
export function heartbeatMs(loops: HeartbeatLoop[]): number {
  const intervals = loops
    .filter((l): l is HeartbeatLoop & { trigger: Extract<Trigger, { kind: "interval" }> } => l.enabled && l.trigger.kind === "interval")
    .map((l) => l.trigger.everyMs);
  return Math.min(CRON_RESOLUTION_MS, ...intervals);
}
