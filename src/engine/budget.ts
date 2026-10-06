// Budget guard. Background SDK work shares your Claude subscription pool, so the
// engine must reserve interactive headroom and not drain the plan you use yourself.
// No credit accounting — the monthly-credit feature is paused (YAGNI until it returns).
//
// MVP model: a per-window USD budget; background work may spend up to (1 - reservePct)
// of it, leaving the reserve as your interactive headroom. Cost comes from the SDK's
// `total_cost_usd` (verified in the Phase 0 spike).
//
// The window charges TOTAL spend — interactive turns, dispatches and ingress all book here — and
// background work is what gets measured against the allowance. So a heavy interactive day also
// stops background work: correct, because only the reserve would be left and that is yours. The
// converse never holds; see shouldThrottleBackground and ADR 0001.
//
// NOT persisted: the window lives in this process, so a restart zeroes it. Known gap, and loops
// never call note() either — both mean measured spend under-reports. Worth fixing when the budget
// becomes load-bearing; today it only gates dispatch + the scheduler.

export interface Meter {
  /** True when BACKGROUND work (dispatches, loop fires, scheduled jobs) must pause because the
   *  window is spent down to the interactive reserve.
   *
   *  There is deliberately no interactive counterpart. The reserve is a ceiling ON background work,
   *  held FOR the operator's own turns — gating an interactive turn with it is the exact failure it
   *  exists to prevent (see docs/adr/0001-interactive-reserve-gates-background-work-only.md). The
   *  name carries the work class so no call site can gate the operator by accident. */
  shouldThrottleBackground(now?: number): boolean;
  /** Record usage observed from a finished/streaming run. */
  note(usage: { costUsd?: number; turns?: number }, now?: number): void;
  /** USD spent within the current window (for `/status`). */
  spent(now?: number): number;
  /** The background allowance: `windowBudgetUsd × (1 - reservePct)`. The rest of the window is the
   *  operator's reserve. Exposed so a hold can report the real numbers instead of an opaque refusal. */
  allowance(): number;
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
    allowance: () => available,
    remaining: (now = Date.now()) => Math.max(0, available - spent(now)),
    shouldThrottleBackground: (now = Date.now()) => spent(now) >= available,
    note: (usage, now = Date.now()) => {
      charges.push({ at: now, usd: usage.costUsd ?? 0 });
    },
  };
}

/** Which trigger a piece of work traces back to. `interactive` = the operator asked for it and is
 *  waiting (a message/command, and anything the engine does one hop from it on their behalf, like a
 *  dispatch the company makes while servicing that message). `background` = the engine started it
 *  while they were elsewhere (a loop fire, a scheduler tick, the secretary, the dream sweep, a
 *  customer-brief ingress run). It follows the ORIGINATING TRIGGER, never the mechanism — see
 *  docs/adr/0001-interactive-reserve-gates-background-work-only.md. */
export type WorkClass = "interactive" | "background";

/** The class for a launch that does not state one. Unclassified work is BACKGROUND on purpose: a
 *  missed wiring can then only over-protect the reserve — a visible hold that names its numbers and
 *  that the operator can bypass with `/open` — and can never silently switch the guard off. */
export const DEFAULT_WORK_CLASS: WorkClass = "background";

/** The ONE answer to "does the interactive reserve apply to this work?": true only when the work is
 *  BACKGROUND and the window is spent down to the reserve. Interactive work is never held, however
 *  far over the allowance the window is — that is what the reserve is being held for (ADR 0001). */
export function heldByReserve(
  workClass: WorkClass,
  meter: Pick<Meter, "shouldThrottleBackground">,
  now?: number,
): boolean {
  return workClass === "background" && meter.shouldThrottleBackground(now);
}

/** What a held background dispatch reports back. Names the real numbers so a hold diagnoses itself
 *  instead of looking like the engine being down, and says plainly that the work was DROPPED — the
 *  engine queues nothing and will not re-issue it. */
export function budgetHoldMessage(spentUsd: number, allowanceUsd: number): string {
  return (
    `⏸ Background work is on hold — $${spentUsd.toFixed(2)} of the $${allowanceUsd.toFixed(2)} background ` +
    `allowance is spent this window, and the rest is reserved for your own turns. This dispatch was ` +
    `NOT queued; re-send it after the window rolls off, or open the project yourself with /open — ` +
    `your own turns are never held. Raise \`budgetWindowUsd\` if this fires too often.`
  );
}
