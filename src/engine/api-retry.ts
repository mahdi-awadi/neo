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

/** Human-readable seconds for operator lines ("30s", "8m"). */
function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
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

/** "⏳ #safari rate-limited by the API — retrying in 30s (1/3)." */
export function apiRetryNotice(project: string | undefined, attempt: number, delayMs: number): string {
  const who = project ? `${project} ` : "";
  return `⏳ ${who}hit an API rate limit — retrying in ${humanMs(delayMs)} (${attempt}/${MAX_API_RETRIES}).`;
}

/** The give-up line. Says plainly that the work did NOT happen, so nothing is dropped in silence. */
export function apiFailureNotice(project: string | undefined, kind: ApiErrorKind): string {
  const who = project ? `${project}: ` : "";
  const why = kind === "rate_limit" || kind === "overloaded" ? "the API kept throttling us" : `the API failed (${kind})`;
  return `✗ ${who}${why} after ${MAX_API_RETRIES} retries — the work is NOT done. Re-run it when you're ready.`;
}

/** What a held dispatch/loop fire reports back. */
export function apiHoldMessage(remainingMs: number): string {
  return `⏸ The API is throttling us — new background work is on hold for ${humanMs(remainingMs)}. It'll run after that.`;
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
