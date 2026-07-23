import { test, expect } from "bun:test";
import { heartbeatMs, nextTickDelayMs, CRON_RESOLUTION_MS, MIN_TICK_FLOOR_MS } from "../src/engine/heartbeat";

test("heartbeat derives from enabled triggers: cron resolution by default, faster only if a shorter interval loop is enabled", () => {
  expect(heartbeatMs([])).toBe(CRON_RESOLUTION_MS); // nothing enabled → cron resolution floor
  expect(heartbeatMs([{ enabled: true, trigger: { kind: "cron", expr: "0 6 * * *" } }])).toBe(CRON_RESOLUTION_MS);
  expect(heartbeatMs([{ enabled: true, trigger: { kind: "interval", everyMs: 30_000 } }])).toBe(30_000);
  expect(heartbeatMs([{ enabled: false, trigger: { kind: "interval", everyMs: 5_000 } }])).toBe(CRON_RESOLUTION_MS); // disabled loops don't drive the tick
});

// 2026-07-23 review finding #2: an interval loop's everyMs can, in principle, predate
// MIN_INTERVAL_MS validation (an old ledger row) — heartbeatMs must never hot-loop on it.
test("heartbeatMs never returns below MIN_TICK_FLOOR_MS, even fed a 0ms interval loop", () => {
  expect(heartbeatMs([{ enabled: true, trigger: { kind: "interval", everyMs: 0 } }])).toBe(MIN_TICK_FLOOR_MS);
  expect(MIN_TICK_FLOOR_MS).toBeGreaterThan(0);
});

// 2026-07-23 review finding #1: the self-rescheduling setTimeout chain in daemon.ts re-arms AFTER
// the tick body runs, so "now + hb" would drift by body-duration + timer lag each cycle — enough to
// make a cron tick sample the wrong minute and silently skip a `30 3 * * *` firing for the day.
// nextTickDelayMs aligns to hb-wide windows from the epoch instead, so drift never compounds.
test("nextTickDelayMs aligns to the next hb-wide window boundary from the epoch, not from `now`", () => {
  const hb = 60_000;
  expect(nextTickDelayMs(0, hb)).toBe(hb); // exactly on a boundary → a FULL window, never 0 (no busy-loop)
  expect(nextTickDelayMs(hb, hb)).toBe(hb); // any exact multiple of hb is still "on a boundary"
  expect(nextTickDelayMs(30_000, hb)).toBe(30_000); // mid-window: only the remainder to the next boundary
  expect(nextTickDelayMs(59_999, hb)).toBe(1); // just shy of the boundary → 1ms left
  expect(nextTickDelayMs(60_001, hb)).toBe(59_999); // just past a boundary → wait almost a full window
});
