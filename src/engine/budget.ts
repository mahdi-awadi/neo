// Budget guard. Background SDK work shares your Claude subscription pool, so the
// engine must reserve interactive headroom and not drain the plan you use yourself.
// No credit accounting — the monthly-credit feature is paused (YAGNI until it returns).
// Phase 1 (TDD): track usage, throttle when the reserve is threatened.

export interface Meter {
  /** True when background work should pause to protect interactive headroom. */
  shouldThrottle(): boolean;
  /** Record usage observed from a finished/streaming run. */
  note(usage: { costUsd?: number; turns?: number }): void;
}

export function createMeter(_reservePct: number): Meter {
  throw new Error("not implemented (Phase 1)");
}
