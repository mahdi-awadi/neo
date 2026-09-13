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

/** Second-tier backoff DEFAULTS: the SDK already burned its own fast retries before we got here.
 *  These are the built-in fallback; the operator can override the ladder via config
 *  (`apiRetryLadderMs`) — the number of retries is DERIVED from the ladder's length, so a longer
 *  ladder means more retries with no separate knob to keep in sync. */
export const API_RETRY_DELAYS_MS = [30_000, 120_000, 480_000] as const;
export const MAX_API_RETRIES = API_RETRY_DELAYS_MS.length;

/** Default hold on new background work after a throttle report (config: `apiCooldownMs`). */
export const API_COOLDOWN_MS_DEFAULT = 60_000;

/** Default jitter magnitude (config: `apiRetryJitterFrac`): ladder waits get ±frac; a reset-based
 *  wait gets +frac only (never *earlier* than the reported reset, or we just earn another 429). */
export const API_RETRY_JITTER_FRAC_DEFAULT = 0.2;

/** Wait before retry `attempt` (1-based), jittered ±`jitterFrac` so co-throttled sessions spread
 *  out. `ladder`/`jitterFrac` default to the built-in policy — pass the config values to tune. */
export function apiRetryDelayMs(
  attempt: number,
  rand: () => number = Math.random,
  ladder: readonly number[] = API_RETRY_DELAYS_MS,
  jitterFrac: number = API_RETRY_JITTER_FRAC_DEFAULT,
): number {
  const steps = ladder.length > 0 ? ladder : API_RETRY_DELAYS_MS;
  const base = steps[Math.min(Math.max(attempt, 1), steps.length) - 1];
  return Math.round(base * (1 - jitterFrac + 2 * jitterFrac * rand()));
}

/** @deprecated superseded by the configurable `apiRetryJitterFrac`; kept as the documented default. */
export const RESET_JITTER_FRAC = API_RETRY_JITTER_FRAC_DEFAULT;

/** Smart backoff. The subscription's rate_limit_event tells us the *actual* epoch-second `resetsAt`
 *  for each window; when a window is throttling us, wait until its real reset (jittered up only)
 *  instead of a blind ladder that will just keep failing for the whole window. The ladder is the
 *  fallback for when the API told us nothing (or the reported reset already passed). `ladder`/
 *  `jitterFrac` default to the built-in policy — pass the config values to tune. */
export function resolveApiRetryDelayMs(opts: {
  attempt: number;
  rateLimits?: RateLimitInfo[];
  now: number; // epoch ms
  rand?: () => number;
  ladder?: readonly number[];
  jitterFrac?: number;
}): { delayMs: number; source: "reset" | "ladder"; resetsAt?: number } {
  const rand = opts.rand ?? Math.random;
  const jitterFrac = opts.jitterFrac ?? API_RETRY_JITTER_FRAC_DEFAULT;
  // A window is "governing" only if it actually REJECTED us. `allowed_warning` means we are merely
  // approaching that window's limit — waiting out its full reset (up to 7 days for `seven_day`) for
  // a transient error the API never refused parks the session for days. Lacking a status at all we
  // still treat a future reset as governing: the SDK only reports a window when it is biting.
  const future = (opts.rateLimits ?? []).filter(
    (r) => typeof r.resetsAt === "number" && r.resetsAt * 1000 > opts.now && (r.status === undefined || r.status === "rejected"),
  );
  if (future.length > 0) {
    const soonest = future.reduce((a, b) => (a.resetsAt! <= b.resetsAt! ? a : b));
    const base = soonest.resetsAt! * 1000 - opts.now;
    return { delayMs: Math.round(base * (1 + jitterFrac * rand())), source: "reset", resetsAt: soonest.resetsAt };
  }
  return { delayMs: apiRetryDelayMs(opts.attempt, rand, opts.ladder ?? API_RETRY_DELAYS_MS, jitterFrac), source: "ladder" };
}

/** Gate every automatic retry: bounded, and never fighting the operator, a reload or the budget.
 *  `maxRetries` defaults to the built-in ladder length; pass the configured ladder's length so the
 *  cap follows the operator's ladder instead of a fixed 3. */
export function shouldRetryApi(opts: {
  kind?: ApiErrorKind;
  /** 1-based number of the retry being considered. */
  attempt: number;
  /** Cap on automatic retries — defaults to the built-in ladder length. */
  maxRetries?: number;
  /** Reload/drain in progress — the process is about to exit. */
  draining?: boolean;
  /** The operator interrupted or killed this session. */
  interrupted?: boolean;
  /** The budget meter is throttling background work. */
  throttled?: boolean;
}): boolean {
  if (!isRetryableApiError(opts.kind)) return false;
  if (opts.attempt > (opts.maxRetries ?? MAX_API_RETRIES)) return false;
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
export function apiRetryNotice(
  project: string | undefined,
  attempt: number,
  delayMs: number,
  resetsAt?: number,
  maxRetries: number = MAX_API_RETRIES,
): string {
  const who = project ? `${project} ` : "";
  if (resetsAt) {
    return `⏳ ${who}hit an API rate limit — auto-resuming at ${new Date(resetsAt * 1000).toUTCString()} (in ${humanDelay(delayMs)}).`;
  }
  return `⏳ ${who}hit an API rate limit — retrying in ${humanDelay(delayMs)} (${attempt}/${maxRetries}).`;
}

/** The give-up line. Says plainly that the work did NOT happen, so nothing is dropped in silence.
 *  Reports how many retries ACTUALLY ran (`attempts`) rather than a fixed "3" — when work is held
 *  immediately (a fresh cooldown / budget throttle) zero retries happened, and claiming three is a
 *  lie the operator learns to distrust. */
export function apiFailureNotice(project: string | undefined, kind: ApiErrorKind, attempts: number = MAX_API_RETRIES): string {
  const who = project ? `${project}: ` : "";
  const why = kind === "rate_limit" || kind === "overloaded" ? "the API kept throttling us" : `the API failed (${kind})`;
  const held = kind === "rate_limit" || kind === "overloaded" || kind === "server_error";
  const ran =
    attempts <= 0
      ? held
        ? "without retrying (still throttled)"
        : "without retrying"
      : `after ${attempts} ${attempts === 1 ? "retry" : "retries"}`;
  return `✗ ${who}${why} ${ran} — the work is NOT done. Re-run it when you're ready.`;
}

/** The operator-facing warning when Anthropic is actively REJECTING a window (not merely warning),
 *  with its real reset still ahead of us. Advisory only: the engine never refuses the operator's
 *  own turn — only Anthropic can, and when it does the retry path above reports it honestly. This
 *  exists so the operator learns the true reason and reset time up front instead of a misleading
 *  engine-side "throttled" line. Returns undefined when nothing is rejecting us. */
export function apiExhaustionWarning(rateLimits: RateLimitInfo[] | undefined, now: number): string | undefined {
  const rejected = (rateLimits ?? []).filter(
    (r) => r.status === "rejected" && typeof r.resetsAt === "number" && r.resetsAt * 1000 > now,
  );
  if (rejected.length === 0) return undefined;
  const soonest = rejected.reduce((a, b) => (a.resetsAt! <= b.resetsAt! ? a : b));
  const at = soonest.resetsAt! * 1000;
  return (
    `⚠ Anthropic is rate-limiting the subscription until ${new Date(at).toUTCString()} ` +
    `(in ${humanDelay(at - now)}) — starting your turn anyway; it may fail until then.`
  );
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
