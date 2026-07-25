// Rate-limit / overload recovery policy.
//
// Anthropic throttles the subscription server-side ("API Error: Server is temporarily limiting
// requests · Rate limited"). The SDK retries internally first (system/api_retry); what reaches the
// engine is what survived those retries, so the whole turn is lost — and before this module the
// engine recorded it as a completed turn and silently dropped the brief.
//
// Two mechanisms, both deterministic (no AI, injected clock/rand):
//   1. bounded backoff retry — re-send the SAME brief into the SAME session, 30s -> 2m -> 8m with
//      +/-20% jitter, because several workers are always throttled in the same second and a fixed
//      delay marches them back into the wall together.
//   2. a cooldown gate — while a throttle is fresh, background work (dispatches, loop fires) is
//      held instead of started, so retries and the 60s scheduler cannot amplify the storm. The
//      operator's own interactive messages are never held: that is the reserved headroom.
import type { ApiErrorKind } from "./session-runner";
import type { RateLimitInfo } from "./usage";

/** Server-side conditions that clear on their own — the only ones worth waiting out. An auth,
 *  billing or invalid-request failure repeats identically however long we wait. */
const RETRYABLE: ReadonlySet<ApiErrorKind> = new Set<ApiErrorKind>(["rate_limit", "overloaded", "server_error"]);

export function isRetryableApiError(kind?: ApiErrorKind): boolean {
  return kind !== undefined && RETRYABLE.has(kind);
}

/** Second-tier backoff: the SDK already burned its own fast retries before we got here. */
export const API_RETRY_DELAYS_MS = [30_000, 120_000, 480_000] as const;
export const MAX_API_RETRIES = API_RETRY_DELAYS_MS.length;

/** Default hold on new background work after a throttle report. */
export const API_COOLDOWN_MS_DEFAULT = 60_000;

/** Wait before retry `attempt` (1-based), jittered +/-20% so co-throttled sessions spread out. */
export function apiRetryDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = API_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), MAX_API_RETRIES) - 1];
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/** Spread applied to a reset-based wait — one-sided (never *earlier* than the reported reset, or we
 *  just earn another 429), same 20% magnitude as the ladder's jitter so the two behave alike. */
export const RESET_JITTER_FRAC = 0.2;

/** Smart backoff. The subscription's rate_limit_event tells us the *actual* epoch-second `resetsAt`
 *  for each window; when a window is throttling us, wait until its real reset (jittered up only)
 *  instead of a blind 30s→2m→8m ladder that will just keep failing for the whole window. The ladder
 *  is the fallback for when the API told us nothing (or the reported reset already passed). */
export function resolveApiRetryDelayMs(opts: {
  attempt: number;
  rateLimits?: RateLimitInfo[];
  now: number; // epoch ms
  rand?: () => number;
}): { delayMs: number; source: "reset" | "ladder"; resetsAt?: number } {
  const rand = opts.rand ?? Math.random;
  // A window is "governing" if it rejected us (or, lacking a status, simply carries a future reset).
  const future = (opts.rateLimits ?? []).filter(
    (r) => typeof r.resetsAt === "number" && r.resetsAt * 1000 > opts.now && r.status !== "allowed",
  );
  if (future.length > 0) {
    const soonest = future.reduce((a, b) => (a.resetsAt! <= b.resetsAt! ? a : b));
    const base = soonest.resetsAt! * 1000 - opts.now;
    return { delayMs: Math.round(base * (1 + RESET_JITTER_FRAC * rand())), source: "reset", resetsAt: soonest.resetsAt };
  }
  return { delayMs: apiRetryDelayMs(opts.attempt, rand), source: "ladder" };
}

/** Gate every automatic retry: bounded, and never fighting the operator, a reload or the budget. */
export function shouldRetryApi(opts: {
  kind?: ApiErrorKind;
  /** 1-based number of the retry being considered. */
  attempt: number;
  /** Reload/drain in progress — the process is about to exit. */
  draining?: boolean;
  /** The operator interrupted or killed this session. */
  interrupted?: boolean;
  /** The budget meter is throttling background work. */
  throttled?: boolean;
}): boolean {
  if (!isRetryableApiError(opts.kind)) return false;
  if (opts.attempt > MAX_API_RETRIES) return false;
  return !opts.draining && !opts.interrupted && !opts.throttled;
}

/** Human-readable duration for operator lines ("45s", "2m", "1.5h"). Real reset windows can be
 *  hours (the 5-hour / 7-day plan limits), so minutes alone would round a 2h wait to "120m". */
export function humanDelay(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

/** The brief re-sent into the session. The cut-off turn may have half-executed (a file written, a
 *  commit made), so the worker is told to check its own work before redoing it. */
export function apiRetryFollowUp(task: string): string {
  return (
    `⏳ Your previous turn was cut off by an API rate limit before you could reply — nothing was lost on our side. ` +
    `Check what you already completed (files written, commits made) before redoing anything, then continue.\n\n` +
    `The original brief was:\n\n${task}`
  );
}

/** "⏳ safari hit an API rate limit — retrying in 30s (1/3)." When the wait comes from the API's
 *  real reset (`resetsAt`, epoch seconds), name the wall-clock resume time instead of a countdown to
 *  giving up — a reset-based retry isn't racing a cap, it's simply waiting out the window. */
export function apiRetryNotice(project: string | undefined, attempt: number, delayMs: number, resetsAt?: number): string {
  const who = project ? `${project} ` : "";
  if (resetsAt) {
    return `⏳ ${who}hit an API rate limit — auto-resuming at ${new Date(resetsAt * 1000).toUTCString()} (in ${humanDelay(delayMs)}).`;
  }
  return `⏳ ${who}hit an API rate limit — retrying in ${humanDelay(delayMs)} (${attempt}/${MAX_API_RETRIES}).`;
}

/** The give-up line. Says plainly that the work did NOT happen, so nothing is dropped in silence.
 *  Reports how many retries ACTUALLY ran (`attempts`) rather than a fixed "3" — when work is held
 *  immediately (a fresh cooldown / budget throttle) zero retries happened, and claiming three is a
 *  lie the operator learns to distrust. */
export function apiFailureNotice(project: string | undefined, kind: ApiErrorKind, attempts: number = MAX_API_RETRIES): string {
  const who = project ? `${project}: ` : "";
  const why = kind === "rate_limit" || kind === "overloaded" ? "the API kept throttling us" : `the API failed (${kind})`;
  const ran = attempts <= 0 ? "without retrying (still throttled)" : `after ${attempts} ${attempts === 1 ? "retry" : "retries"}`;
  return `✗ ${who}${why} ${ran} — the work is NOT done. Re-run it when you're ready.`;
}

/** What a held dispatch/loop fire reports back. */
export function apiHoldMessage(remainingMs: number): string {
  return `⏸ The API is throttling us — new background work is on hold for ${humanDelay(remainingMs)}. It'll run after that.`;
}

/** The engine-wide throttle gate: one shared window, armed by any worker's throttle report. */
export interface ApiCooldown {
  /** Record an API failure; only server-side throttles arm the window. */
  note(kind: ApiErrorKind, at: number): void;
  activeAt(at: number): boolean;
  remainingMs(at: number): number;
}

export function createApiCooldown(opts: { cooldownMs?: number } = {}): ApiCooldown {
  const cooldownMs = opts.cooldownMs ?? API_COOLDOWN_MS_DEFAULT;
  let until = 0;
  return {
    note: (kind, at) => {
      if (isRetryableApiError(kind)) until = Math.max(until, at + cooldownMs);
    },
    activeAt: (at) => at < until,
    remainingMs: (at) => Math.max(0, until - at),
  };
}
