/** The disk guard (ADR-0068): a heartbeat step that keeps the host disk from filling, with no AI session.
 *  Each tick it samples the disk use and decides, in plain code (`decideDisk`): run the disk kit's Tier A
 *  cleanup at once when free space is below `pressureFreePct` (with a cooldown), run it in the daily hour
 *  once a day, and alert the operator when the use crosses an alert step (80/90/95 %), with the fill rate
 *  and the hours left. The run itself is the kit's own `cleanup.ts run` (ADR-0040/0041): Tier A only,
 *  its own lock, never Tier B. Before this, Tier A ran only through the `disk-cleanup` loop, which the
 *  scheduler skips while its folder is busy — on 2026-10-30 that left the disk to fill to 100 %. */

const HOUR = 3_600_000;
const MIN = 60_000;

export interface DiskGuardCfg {
  mount: string;
  /** Alert when the use reaches each step (ascending percentages). */
  alertStepsPct: number[];
  /** The same step alerts again after this long. */
  alertRepeatMinutes: number;
  /** Less free space than this (percent) starts Tier A at once. */
  pressureFreePct: number;
  /** No second pressure run sooner than this. */
  pressureCooldownMinutes: number;
  /** The daily Tier A run starts in this server-local hour. */
  dailyHour: number;
  /** The fill rate is measured over this many hours of samples. */
  sampleKeepHours: number;
  /** The kit's back-off (ADR-0040): a run that freed less than this … */
  nothingLeftBytes: number;
  /** … stops pressure runs for this long (nothing safe is left to remove). */
  cooldownHours: number;
  /** An alert step clears only when the use falls this far below the first step. */
  alertHysteresisPct: number;
  /** A run the guard started with no result after this long is reported as failed. */
  pendingTimeoutMinutes: number;
}

export interface DiskSample {
  at: number;
  used: number;
}

export interface DiskGuardState {
  samples: DiskSample[];
  /** The last step alerted, when, and at what use (cleared below the first step minus the hysteresis). */
  alert?: { stepPct: number; at: number; pct?: number };
  lastPressureRun?: number;
  lastDaily?: number;
  /** A run this guard started, waiting for its result to be reported. */
  pending?: { at: number; reason: RunReason };
}

export type RunReason = "pressure" | "daily";

export interface DiskDecision {
  run?: RunReason;
  alert?: { stepPct: number; text: string };
  state: DiskGuardState;
}

const gb = (b: number): string => `${(b / 1e9).toFixed(1)} GB`;

/** Bytes per hour the disk grows, by a least-squares line through the samples; 0 when there are fewer
 *  than two samples or the disk is not growing. */
export function fillRateBytesPerHour(all: DiskSample[]): number {
  // A cleanup drop is not a negative fill: measure only since the last drop of more than 1 GB.
  let from = 0;
  for (let i = 1; i < all.length; i++) if (all[i]!.used < all[i - 1]!.used - 1e9) from = i;
  const samples = all.slice(from);
  if (samples.length < 2) return 0;
  const xs = samples.map((s) => s.at / HOUR);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = samples.reduce((a, s) => a + s.used, 0) / samples.length;
  let sxy = 0;
  let sxx = 0;
  samples.forEach((s, i) => {
    sxy += (xs[i]! - mx) * (s.used - my);
    sxx += (xs[i]! - mx) ** 2;
  });
  const slope = sxx > 0 ? sxy / sxx : 0;
  return slope > 0 ? slope : 0;
}

/** What to do now. Pure: the caller reads the disk and the kit lock, and applies the decision. */
export function decideDisk(
  input: {
    now: number;
    usage: { size: number; used: number };
    state: DiskGuardState;
    runActive: boolean;
    /** The kit's last finished run, by anyone (this guard, the loop, the operator). */
    lastRun?: { at: number; freedBytes: number };
    /** False when the kit cannot be read: alerts only. */
    canRun?: boolean;
  },
  cfg: DiskGuardCfg,
): DiskDecision {
  const { now, usage, runActive, lastRun } = input;
  const prev = input.state;
  const pct = usage.size > 0 ? Math.round((usage.used / usage.size) * 1000) / 10 : 0;
  const free = Math.max(0, usage.size - usage.used);
  const samples = [...prev.samples, { at: now, used: usage.used }].filter((s) => s.at >= now - cfg.sampleKeepHours * HOUR);
  const state: DiskGuardState = { ...prev, samples };

  let run: RunReason | undefined;
  if (!runActive && input.canRun !== false) {
    const pressured = 100 - pct < cfg.pressureFreePct;
    // The newest start: this guard's own pressure run or the kit's last run by anyone.
    const lastStart = Math.max(prev.lastPressureRun ?? 0, lastRun?.at ?? 0);
    const cooling = now - lastStart < cfg.pressureCooldownMinutes * MIN;
    // The kit's back-off: a recent run found nothing worth removing; running again would only spin.
    const nothingLeft = lastRun !== undefined && lastRun.freedBytes < cfg.nothingLeftBytes && now - lastRun.at < cfg.cooldownHours * HOUR;
    // Today's daily slot. It is due in the daily hour, or later the same day when the kit's last run is
    // known and older than the slot (the daemon was down in the hour). A run shortly before the slot counts.
    const slot = new Date(now);
    slot.setHours(cfg.dailyHour, 0, 0, 0);
    const slotAt = slot.getTime();
    const ranForSlot = (prev.lastDaily ?? 0) >= slotAt || (lastRun !== undefined && lastRun.at >= slotAt - cfg.pressureCooldownMinutes * MIN);
    const inHour = new Date(now).getHours() === cfg.dailyHour;
    const dailyDue = now >= slotAt && !ranForSlot && (inHour || lastRun !== undefined);
    if (pressured && !cooling && !nothingLeft) {
      run = "pressure";
      state.lastPressureRun = now;
      if (dailyDue) state.lastDaily = now; // one run serves both
    } else if (dailyDue) {
      run = "daily";
      state.lastDaily = now;
    }
    if (run) state.pending = { at: now, reason: run };
  }

  const steps = [...cfg.alertStepsPct].sort((a, b) => a - b);
  const step = steps.filter((s) => pct >= s).pop();
  let alert: DiskDecision["alert"];
  if (step === undefined) {
    // Hysteresis: hovering just under the first step keeps the alert; only a real fall clears it.
    if (pct < (steps[0] ?? 0) - cfg.alertHysteresisPct) delete state.alert;
  } else if (
    !prev.alert ||
    step > prev.alert.stepPct ||
    // A repeat only while the use still rises (more than one point since the last alert).
    (now - prev.alert.at >= cfg.alertRepeatMinutes * MIN && pct > (prev.alert.pct ?? 0) + 1)
  ) {
    const rate = fillRateBytesPerHour(samples);
    const eta = rate > 0 ? `full in about ${Math.round(free / rate)} h at ${gb(rate)}/h` : "not growing now";
    const action = run ? `Tier A cleanup (${run}) started now.` : runActive ? "A cleanup is running." : input.canRun === false ? "The disk kit cannot be read: no cleanup can start." : "Tier A runs at the next pressure point or the daily hour.";
    alert = { stepPct: step, text: `⚠️ Disk ${cfg.mount} ${pct.toFixed(1)}% used, ${Math.round(free / 1e9)} GB free; ${eta}. ${action}` };
    state.alert = { stepPct: step, at: now, pct };
  }
  return { ...(run ? { run } : {}), ...(alert ? { alert } : {}), state };
}

export interface DiskGuardDeps {
  cfg: DiskGuardCfg;
  /** False when the kit cannot be read: the guard still alerts, but starts no run. */
  canRun?: boolean;
  usage: () => { size: number; used: number };
  /** The kit's run lock is held by a live process. */
  runActive: () => boolean;
  loadState: () => DiskGuardState | undefined;
  saveState: (s: DiskGuardState) => void;
  /** Start the kit's Tier A run as a detached child (argv, no shell). */
  spawnRun: (argv: string[]) => void;
  runArgv: string[];
  /** The kit's last finished run (its `state/last-run.json`), if any. */
  lastRun?: () => { at: number; freedBytes: number; afterPct?: number } | undefined;
  alert: (text: string) => void;
  event: (kind: string, data: Record<string, unknown>) => void;
  now: () => number;
}

/** One heartbeat step. Never throws: a failure is an event, and the heartbeat goes on. */
export function runDiskGuard(d: DiskGuardDeps): void {
  try {
    const now = d.now();
    const usage = d.usage();
    const prev = d.loadState() ?? { samples: [] };
    const last = d.lastRun?.();
    const active = d.runActive();
    if (prev.pending) {
      if (last && last.at >= prev.pending.at) {
        // A run this guard started has finished: report what it freed, once.
        d.alert(`🧹 Disk cleanup (${prev.pending.reason}) freed ${gb(last.freedBytes)}${last.afterPct !== undefined ? `; ${d.cfg.mount} is now ${last.afterPct.toFixed(1)}% used` : ""}.`);
        d.event("disk_cleanup_done", { reason: prev.pending.reason, freedBytes: last.freedBytes, afterPct: last.afterPct });
        delete prev.pending;
      } else if (!active && now - prev.pending.at > d.cfg.pendingTimeoutMinutes * MIN) {
        // No result and no live run: it failed. Its output is in the journal (unit neo-disk-tier-a).
        d.alert(`⚠️ Disk cleanup (${prev.pending.reason}) started ${Math.round((now - prev.pending.at) / MIN)} min ago did not finish; see \`journalctl -u neo-disk-tier-a\`.`);
        d.event("disk_cleanup_failed", { reason: prev.pending.reason, error: "no result" });
        delete prev.pending;
      }
    }
    const dec = decideDisk({ now, usage, state: prev, runActive: active, ...(last ? { lastRun: last } : {}), canRun: d.canRun ?? true }, d.cfg);
    if (dec.alert) {
      d.alert(dec.alert.text);
      d.event("disk_alert", { stepPct: dec.alert.stepPct, usedPct: Math.round((usage.used / usage.size) * 1000) / 10 });
    }
    if (dec.run) {
      try {
        d.spawnRun(d.runArgv);
        d.event("disk_cleanup_started", { reason: dec.run });
      } catch (e) {
        delete dec.state.pending;
        d.event("disk_cleanup_failed", { reason: dec.run, error: e instanceof Error ? e.message : String(e) });
      }
    }
    d.saveState(dec.state);
  } catch (e) {
    try {
      d.event("disk_guard_failed", { error: e instanceof Error ? e.message : String(e) });
    } catch {
      // the event log itself failed: nothing more to do in a heartbeat step
    }
  }
}

/** The guard's values when the installed kit's config predates them (ADR-0068). A test keeps them equal
 *  to tools/disk/defaults.json, the one source; `install.ts` copies that file into the installed kit. */
export const DISK_GUARD_FALLBACK = {
  alertStepsPct: [80, 90, 95],
  alertRepeatMinutes: 120,
  pressureFreePct: 10,
  pressureCooldownMinutes: 30,
  sampleKeepHours: 6,
  alertHysteresisPct: 2,
  pendingTimeoutMinutes: 120,
} as const satisfies Omit<DiskGuardCfg, "mount" | "dailyHour" | "nothingLeftBytes" | "cooldownHours">;

/** The kit's back-off defaults (tools/disk/defaults.json `nothingLeftBytes`, `cooldownHours`). */
export const KIT_BACKOFF_FALLBACK = { nothingLeftBytes: 1_000_000_000, cooldownHours: 6 } as const;

const positive = (v: unknown, fb: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fb);

/** The guard's config from the disk kit's config (`loadDiskConfig`); a missing or broken value falls back,
 *  so a bad edit never turns the guard off. */
export function guardCfgFrom(kit: {
  mount?: unknown;
  dailyHour?: unknown;
  alertStepsPct?: unknown;
  alertRepeatMinutes?: unknown;
  pressureFreePct?: unknown;
  pressureCooldownMinutes?: unknown;
  sampleKeepHours?: unknown;
  nothingLeftBytes?: unknown;
  cooldownHours?: unknown;
  alertHysteresisPct?: unknown;
  pendingTimeoutMinutes?: unknown;
}): DiskGuardCfg {
  const steps = Array.isArray(kit.alertStepsPct) && kit.alertStepsPct.length && kit.alertStepsPct.every((s) => typeof s === "number" && s > 0 && s < 100)
    ? [...(kit.alertStepsPct as number[])].sort((a, b) => a - b)
    : [...DISK_GUARD_FALLBACK.alertStepsPct];
  const hour = typeof kit.dailyHour === "number" && Number.isInteger(kit.dailyHour) && kit.dailyHour >= 0 && kit.dailyHour < 24 ? kit.dailyHour : 4;
  const floor = typeof kit.pressureFreePct === "number" && kit.pressureFreePct > 0 && kit.pressureFreePct < 100 ? kit.pressureFreePct : DISK_GUARD_FALLBACK.pressureFreePct;
  return {
    mount: typeof kit.mount === "string" && kit.mount.startsWith("/") ? kit.mount : "/",
    alertStepsPct: steps,
    alertRepeatMinutes: positive(kit.alertRepeatMinutes, DISK_GUARD_FALLBACK.alertRepeatMinutes),
    pressureFreePct: floor,
    pressureCooldownMinutes: positive(kit.pressureCooldownMinutes, DISK_GUARD_FALLBACK.pressureCooldownMinutes),
    dailyHour: hour,
    sampleKeepHours: positive(kit.sampleKeepHours, DISK_GUARD_FALLBACK.sampleKeepHours),
    // The kit's own back-off keys (ADR-0040); their fallbacks are the kit's defaults too.
    nothingLeftBytes: positive(kit.nothingLeftBytes, KIT_BACKOFF_FALLBACK.nothingLeftBytes),
    cooldownHours: positive(kit.cooldownHours, KIT_BACKOFF_FALLBACK.cooldownHours),
    alertHysteresisPct: typeof kit.alertHysteresisPct === "number" && kit.alertHysteresisPct >= 0 ? kit.alertHysteresisPct : DISK_GUARD_FALLBACK.alertHysteresisPct,
    pendingTimeoutMinutes: positive(kit.pendingTimeoutMinutes, DISK_GUARD_FALLBACK.pendingTimeoutMinutes),
  };
}
