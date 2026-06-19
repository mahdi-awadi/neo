// Budget guard. Background SDK work shares your Claude subscription pool, so the
// engine must reserve interactive headroom and not drain the plan you use yourself.
// No credit accounting — the monthly-credit feature is paused (YAGNI until it returns).
//
// MVP model: a per-window USD budget; background work may spend up to (1 - reservePct)
// of it, leaving the reserve as your interactive headroom. Cost comes from the SDK's
// `total_cost_usd` (verified in the Phase 0 spike).

export interface Meter {
  /** True when background work should pause to protect interactive headroom. */
  shouldThrottle(now?: number): boolean;
  /** Record usage observed from a finished/streaming run. */
  note(usage: { costUsd?: number; turns?: number }, now?: number): void;
  /** USD spent within the current window (for `/status`). */
  spent(now?: number): number;
  /** USD of non-reserved budget still available within the window (for `/status`). */
  remaining(now?: number): number;
}

/**
 * `windowMs` omitted → charges accumulate forever (single ever-growing window).
 * `windowMs` set → a rolling window: charges older than `now - windowMs` roll off, so a
 * burst of background spend throttles for a while but never permanently.
 */
export function createMeter(opts: {
  windowBudgetUsd: number;
  reservePct: number;
  windowMs?: number;
}): Meter {
  const available = opts.windowBudgetUsd * (1 - opts.reservePct);
  const { windowMs } = opts;
  const charges: Array<{ at: number; usd: number }> = [];

  function spent(now: number = Date.now()): number {
    if (windowMs !== undefined) {
      const cutoff = now - windowMs;
      while (charges.length > 0 && charges[0].at < cutoff) charges.shift();
    }
    return charges.reduce((sum, c) => sum + c.usd, 0);
  }

  return {
    spent,
    remaining: (now = Date.now()) => Math.max(0, available - spent(now)),
    shouldThrottle: (now = Date.now()) => spent(now) >= available,
    note: (usage, now = Date.now()) => {
      charges.push({ at: now, usd: usage.costUsd ?? 0 });
    },
  };
}
