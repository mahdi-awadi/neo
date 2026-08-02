// Rate-limit/overload policy: which API failures are worth retrying, how long to wait, and the
// engine-wide cooldown that stops several throttled workers from retrying into the same wall.
// Pure and clock-injected — no timers, no AI.
import { test, expect } from "bun:test";
import {
  API_RETRY_DELAYS_MS,
  MAX_API_RETRIES,
  apiFailureNotice,
  apiHoldMessage,
  apiRetryDelayMs,
  apiRetryFollowUp,
  apiRetryNotice,
  createApiCooldown,
  isRetryableApiError,
  resolveApiRetryDelayMs,
  humanDelay,
  shouldRetryApi,
} from "../src/engine/api-retry";

// --- what is worth retrying ---------------------------------------------------------------------

test("server-side throttles are retryable; our own bad requests are not", () => {
  expect(isRetryableApiError("rate_limit")).toBe(true);
  expect(isRetryableApiError("overloaded")).toBe(true);
  expect(isRetryableApiError("server_error")).toBe(true);
  for (const kind of ["authentication_failed", "billing_error", "invalid_request", "model_not_found", "max_output_tokens"] as const) {
    expect(isRetryableApiError(kind)).toBe(false); // retrying these just repeats the failure
  }
  expect(isRetryableApiError(undefined)).toBe(false); // a clean turn is not a retry candidate
});

test("shouldRetryApi stops at the attempt cap and never fights the operator or a reload", () => {
  const base = { kind: "rate_limit" as const, attempt: 1 };
  expect(shouldRetryApi(base)).toBe(true);
  expect(shouldRetryApi({ ...base, attempt: MAX_API_RETRIES })).toBe(true); // the last allowed retry
  expect(shouldRetryApi({ ...base, attempt: MAX_API_RETRIES + 1 })).toBe(false); // cap reached — give up loudly
  expect(shouldRetryApi({ ...base, draining: true })).toBe(false); // reload in progress
  expect(shouldRetryApi({ ...base, interrupted: true })).toBe(false); // operator killed it
  expect(shouldRetryApi({ ...base, throttled: true })).toBe(false); // budget meter says stop
  expect(shouldRetryApi({ ...base, kind: "billing_error" })).toBe(false);
});

// --- backoff ------------------------------------------------------------------------------------

test("backoff grows 30s -> 2m -> 8m instead of hammering at a fixed interval", () => {
  expect(API_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 480_000]);
  const mid = () => 0.5; // no jitter offset
  expect(apiRetryDelayMs(1, mid)).toBe(30_000);
  expect(apiRetryDelayMs(2, mid)).toBe(120_000);
  expect(apiRetryDelayMs(3, mid)).toBe(480_000);
});

test("each retry is jittered +/-20% so simultaneously-throttled sessions do not sync up", () => {
  expect(apiRetryDelayMs(1, () => 0)).toBe(24_000); // -20%
  expect(apiRetryDelayMs(1, () => 1)).toBe(36_000); // +20%
  // Four sessions throttled in the same second must not all come back at the same instant.
  const delays = [0.1, 0.4, 0.6, 0.9].map((r) => apiRetryDelayMs(1, () => r));
  expect(new Set(delays).size).toBe(4);
});

test("an attempt past the table stays at the longest delay rather than overflowing", () => {
  expect(apiRetryDelayMs(99, () => 0.5)).toBe(480_000);
});

// --- the ladder + jitter are config, not baked-in --------------------------------------------------

test("the backoff ladder is configurable, defaulting to the built-in policy", () => {
  const ladder = [1000, 5000];
  expect(apiRetryDelayMs(1, () => 0.5, ladder, 0)).toBe(1000);
  expect(apiRetryDelayMs(2, () => 0.5, ladder, 0)).toBe(5000);
  expect(apiRetryDelayMs(99, () => 0.5, ladder, 0)).toBe(5000); // clamp to the last configured step
  // Omitting the ladder falls back to the built-in default — behavior preserved.
  expect(apiRetryDelayMs(1, () => 0.5)).toBe(30_000);
});

test("the jitter fraction is configurable (default 0.2 = ±20%)", () => {
  expect(apiRetryDelayMs(1, () => 0, [1000], 0.5)).toBe(500); // -50%
  expect(apiRetryDelayMs(1, () => 1, [1000], 0.5)).toBe(1500); // +50%
  expect(apiRetryDelayMs(1, () => 0, [1000], 0)).toBe(1000); // no jitter
});

test("resolveApiRetryDelayMs takes a configurable ladder + jitter for the fallback path", () => {
  const now = 1_700_000_000_000;
  expect(resolveApiRetryDelayMs({ attempt: 1, rateLimits: [], now, rand: () => 0.5, ladder: [7000], jitterFrac: 0 }))
    .toMatchObject({ delayMs: 7000, source: "ladder" });
  // Reset path honors the same configurable jitter fraction.
  const rl = [{ status: "rejected", resetsAt: now / 1000 + 100 }];
  expect(resolveApiRetryDelayMs({ attempt: 1, rateLimits: rl, now, rand: () => 1, jitterFrac: 0.5 }).delayMs).toBe(150_000); // 100_000 × 1.5
});

test("shouldRetryApi's cap follows the configured ladder length, not a fixed 3", () => {
  const base = { kind: "rate_limit" as const };
  expect(shouldRetryApi({ ...base, attempt: 2, maxRetries: 2 })).toBe(true);
  expect(shouldRetryApi({ ...base, attempt: 3, maxRetries: 2 })).toBe(false);
  // Omitting maxRetries keeps the default cap (built-in ladder length).
  expect(shouldRetryApi({ ...base, attempt: MAX_API_RETRIES })).toBe(true);
});

test("the operator notices show the configured cap in the countdown", () => {
  expect(apiRetryNotice("safari", 1, 1000, undefined, 2)).toContain("1/2");
  expect(apiFailureNotice("safari", "rate_limit", 2)).toContain("2 retries");
});

// --- reset-aware backoff (smart, not a blind ladder) --------------------------------------------

test("when the API reports when the limit resets, the retry waits until then — not the fixed ladder", () => {
  const now = 1_700_000_000_000; // epoch ms
  const rateLimits = [{ rateLimitType: "five_hour", status: "rejected", resetsAt: now / 1000 + 600 }];
  const r = resolveApiRetryDelayMs({ attempt: 1, rateLimits, now, rand: () => 0 });
  expect(r.source).toBe("reset");
  expect(r.delayMs).toBe(600_000); // exactly the time until the reported reset (no jitter at rand()=0)
  expect(r.resetsAt).toBe(now / 1000 + 600);
});

test("the reset-based wait is jittered upward only, so it never retries before the limit clears", () => {
  const now = 1_700_000_000_000;
  const rateLimits = [{ status: "rejected", resetsAt: now / 1000 + 600 }];
  expect(resolveApiRetryDelayMs({ attempt: 1, rateLimits, now, rand: () => 0 }).delayMs).toBe(600_000); // floor = reset
  expect(resolveApiRetryDelayMs({ attempt: 1, rateLimits, now, rand: () => 1 }).delayMs).toBe(720_000); // +20% ceiling
});

test("with several throttled windows it waits for the SOONEST reset", () => {
  const now = 1_700_000_000_000;
  const rateLimits = [
    { rateLimitType: "seven_day", status: "rejected", resetsAt: now / 1000 + 600 },
    { rateLimitType: "five_hour", status: "rejected", resetsAt: now / 1000 + 300 },
  ];
  const r = resolveApiRetryDelayMs({ attempt: 1, rateLimits, now, rand: () => 0 });
  expect(r.delayMs).toBe(300_000);
});

test("no reset info (or a stale, already-passed reset) falls back to the ladder", () => {
  const now = 1_700_000_000_000;
  expect(resolveApiRetryDelayMs({ attempt: 2, rateLimits: [], now, rand: () => 0.5 }))
    .toMatchObject({ delayMs: 120_000, source: "ladder" });
  const stale = [{ status: "rejected", resetsAt: now / 1000 - 10 }];
  expect(resolveApiRetryDelayMs({ attempt: 1, rateLimits: stale, now, rand: () => 0.5 }).source).toBe("ladder");
});

// --- what the worker and the operator are told ---------------------------------------------------

test("humanMs reads hours for long real reset windows, not just seconds/minutes", () => {
  expect(humanDelay(45_000)).toBe("45s");
  expect(humanDelay(120_000)).toBe("2m");
  expect(humanDelay(2 * 3600_000)).toBe("2h");
  expect(humanDelay(90 * 60_000)).toBe("1.5h");
});

test("a retry scheduled from a real reset tells the operator the wall-clock resume time, not '3 retries'", () => {
  const resetsAt = 1_700_000_000; // epoch seconds
  const notice = apiRetryNotice("safari", 1, 600_000, resetsAt);
  expect(notice).toContain("safari");
  expect(notice).toContain(new Date(resetsAt * 1000).toUTCString());
  expect(notice).not.toContain(`1/${MAX_API_RETRIES}`); // reset-based retries aren't a countdown to giving up
});

test("the give-up notice states how many attempts actually ran, never a fixed '3'", () => {
  expect(apiFailureNotice("safari", "rate_limit", 0)).toContain("without retrying"); // held immediately
  expect(apiFailureNotice("safari", "rate_limit", 2)).toContain("2 retries");
  expect(apiFailureNotice("safari", "rate_limit", 2).toLowerCase()).toContain("not done");
});

test("unknown API failures do not pretend the engine is still throttled", () => {
  const notice = apiFailureNotice("agent", "unknown", 0);
  expect(notice).toContain("the API failed (unknown) without retrying");
  expect(notice).not.toContain("still throttled");
});

// --- what the worker and the operator are told (existing) ----------------------------------------

test("the retry brief re-sends the task AND warns that the cut-off attempt may be half-done", () => {
  const text = apiRetryFollowUp("port the NDC request classes");
  expect(text).toContain("port the NDC request classes");
  expect(text.toLowerCase()).toContain("rate limit");
  expect(text.toLowerCase()).toContain("already"); // "check what you already completed"
});

test("operator notices name the project, the attempt and the wait", () => {
  const notice = apiRetryNotice("safari", 1, 30_000);
  expect(notice).toContain("safari");
  expect(notice).toContain("30s");
  expect(notice).toContain(`1/${MAX_API_RETRIES}`);
  const failed = apiFailureNotice("safari", "rate_limit");
  expect(failed).toContain("safari");
  expect(failed.toLowerCase()).toContain("not done"); // never silently dropped
});

// --- the engine-wide cooldown gate ---------------------------------------------------------------

test("a throttle report holds new background work for the cooldown, then clears", () => {
  const cooldown = createApiCooldown({ cooldownMs: 60_000 });
  expect(cooldown.activeAt(1_000)).toBe(false);
  cooldown.note("rate_limit", 1_000);
  expect(cooldown.activeAt(1_000)).toBe(true);
  expect(cooldown.remainingMs(31_000)).toBe(30_000);
  expect(cooldown.activeAt(60_999)).toBe(true);
  expect(cooldown.activeAt(61_000)).toBe(false); // window elapsed — work flows again
  expect(cooldown.remainingMs(61_000)).toBe(0);
});

test("a fresh throttle extends the window (the storm is still going)", () => {
  const cooldown = createApiCooldown({ cooldownMs: 60_000 });
  cooldown.note("overloaded", 1_000);
  cooldown.note("overloaded", 50_000);
  expect(cooldown.activeAt(100_000)).toBe(true); // 50_000 + 60_000
  expect(cooldown.activeAt(110_001)).toBe(false);
});

test("only server-side throttles arm the gate — a billing error must not freeze the engine", () => {
  const cooldown = createApiCooldown({ cooldownMs: 60_000 });
  cooldown.note("billing_error", 1_000);
  expect(cooldown.activeAt(1_000)).toBe(false);
});

test("the hold message tells the operator how long the engine is pausing", () => {
  expect(apiHoldMessage(45_000)).toContain("45s");
});
