// A held run's API wait, ended early on purpose (ADR-0060). After an API error, dispatch waits (up to a
// usage-limit reset) and then re-sends the brief into the same still-open run. This registry gives that
// wait a handle: `todo retry` wakes it now, a successful turn of the run itself wakes it at once (it went
// on), a run that ends drops it, and a successful turn on the same account wakes the other limit holds. In every case the
// re-send happens at most once. Each end is recorded as `api_wait_ended` on the order, so the ledger-read
// limit-wait display (ADR-0047) stops showing it. Plain code, no AI; in memory (a restart ends every run).
import type { Ledger } from "./ledger";
import { apiWait } from "./api-retry";

export type WaitEndReason = "timer" | "retry" | "went_on" | "superseded" | "limit_cleared";

export interface HeldWait {
  orderId: string;
  /** The API error kind (`rate_limit` is a usage limit). */
  kind: string;
  /** The SDK the run uses: a limit is one account's, so only the same provider's success clears it. */
  provider: string;
  /** When the timer would re-send. */
  until: number;
}

export interface ApiWaits {
  /** Hold one run's re-send: `resend` runs exactly once — when `delay` resolves, or on `wake` — and is told
   *  why (`timer`, or an early end). */
  hold(h: HeldWait, delay: Promise<void>, resend: (reason: WaitEndReason) => void): void;
  /** End the wait now and re-send: `todo retry`, the limit cleared, or the run went on (a turn of it went
   *  through). False when the order holds no wait. */
  wake(orderId: string, reason: "retry" | "limit_cleared" | "went_on"): boolean;
  /** The run is over: end the wait with no re-send. */
  drop(orderId: string): boolean;
  /** A turn succeeded on `provider`: every OTHER rate-limit hold of it wakes after its own `jitter()` ms.
   *  Returns the order ids it scheduled. */
  limitCleared(provider: string, exceptOrderId: string, jitter: () => number): string[];
  held(orderId: string): HeldWait | undefined;
}

export function createApiWaits(deps: { ledger: Pick<Ledger, "recordEvent">; now?: () => number }): ApiWaits {
  const now = deps.now ?? Date.now;
  const holds = new Map<string, { h: HeldWait; resend: (reason: WaitEndReason) => void }>();

  /** End a hold once; `send` says whether its brief is re-sent. */
  function end(orderId: string, reason: WaitEndReason, send: boolean): boolean {
    const x = holds.get(orderId);
    if (!x) return false;
    holds.delete(orderId);
    try {
      deps.ledger.recordEvent("api_wait_ended", { orderId, at: now(), data: { reason, kind: x.h.kind, provider: x.h.provider } });
    } catch { /* the trail never blocks the run */ }
    if (send) {
      try { x.resend(reason); } catch { /* a re-send fault is the run's own, never the registry's */ }
    }
    return true;
  }

  return {
    hold(h, delay, resend) {
      holds.set(h.orderId, { h, resend });
      void delay.then(() => {
        // Only THIS hold: a later hold of the same order (its next retry) is not ended by an old timer.
        if (holds.get(h.orderId)?.resend === resend) end(h.orderId, "timer", true);
      });
    },
    wake: (orderId, reason) => end(orderId, reason, true),
    drop: (orderId) => end(orderId, "superseded", false),
    limitCleared(provider, exceptOrderId, jitter) {
      const ids = [...holds.values()].filter((x) => x.h.provider === provider && x.h.kind === "rate_limit" && x.h.orderId !== exceptOrderId).map((x) => x.h.orderId);
      for (const id of ids) {
        const resend = holds.get(id)!.resend;
        setTimeout(() => { if (holds.get(id)?.resend === resend) end(id, "limit_cleared", true); }, Math.max(0, jitter()));
      }
      return ids;
    },
    held: (orderId) => holds.get(orderId)?.h,
  };
}

/** How a run held in an API wait is named: a usage limit, or a shorter error backoff. */
export const heldText = (limit: boolean): string => (limit ? "held: limit wait" : "held: API retry");

/** "14:30" (UTC) — or "2026-10-25 14:30" when the resume is not today: a weekly limit can be days off. */
export function resumeClock(at: number, now: number): string {
  const iso = new Date(at).toISOString();
  return iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** A run held in an API wait, for the `sessions` report: what it waits for, when it resumes, and the
 *  `todo retry` that resumes it now. Undefined when the order is not held. */
export function heldLine(ledger: Pick<Ledger, "listEvents" | "todoByOrder">, orderId: string, now: number): string | undefined {
  const w = apiWait(ledger, orderId, now);
  if (!w) return undefined;
  const t = ledger.todoByOrder(orderId);
  return `${heldText(w.limit)} · resumes ${resumeClock(w.resumesAt, now)} UTC${t ? ` · todo retry #${t.id} resumes now` : ""}`;
}
