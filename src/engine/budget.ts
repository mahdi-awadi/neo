// Budget guard. Background SDK work shares your Claude subscription pool, so the
// engine must reserve interactive headroom and not drain the plan you use yourself.
// No credit accounting — the monthly-credit feature is paused (YAGNI until it returns).
//
// MVP model: a per-window USD budget; background work may spend up to (1 - reservePct)
// of it, leaving the reserve as your interactive headroom. Cost comes from the SDK's
// `total_cost_usd` (verified in the Phase 0 spike).

export interface Meter {
  /** True when background work should pause to protect interactive headroom. */
  shouldThrottle(): boolean;
  /** Record usage observed from a finished/streaming run. */
  note(usage: { costUsd?: number; turns?: number }): void;
}

export function createMeter(opts: { windowBudgetUsd: number; reservePct: number }): Meter {
  const available = opts.windowBudgetUsd * (1 - opts.reservePct);
  let spent = 0;
  return {
    shouldThrottle: () => spent >= available,
    note: (usage) => {
      spent += usage.costUsd ?? 0;
    },
  };
}
