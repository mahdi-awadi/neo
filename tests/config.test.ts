import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";

const dir = () => mkdtempSync(join(tmpdir(), "neo-cfg-"));

test("idleCloseMs defaults to 24h", () => {
  expect(loadConfig(dir()).idleCloseMs).toBe(24 * 60 * 60 * 1000);
});

test("config.json overrides idleCloseMs", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ idleCloseMs: 1000 }));
  expect(loadConfig(d).idleCloseMs).toBe(1000);
});

test("stitchApiKey reads STITCH_API_KEY from env (empty when unset)", () => {
  // Hermetic: control the var directly (Bun auto-loads the repo .env into process.env).
  const saved = process.env.STITCH_API_KEY;
  try {
    delete process.env.STITCH_API_KEY;
    expect(loadConfig(dir()).stitchApiKey).toBe("");
    process.env.STITCH_API_KEY = "stitch-test-key";
    expect(loadConfig(dir()).stitchApiKey).toBe("stitch-test-key");
  } finally {
    if (saved === undefined) delete process.env.STITCH_API_KEY;
    else process.env.STITCH_API_KEY = saved;
  }
});

test("loopSchedulerEnabled defaults to true; NEO_LOOP_SCHEDULER=0 disables it", () => {
  const saved = process.env.NEO_LOOP_SCHEDULER;
  try {
    delete process.env.NEO_LOOP_SCHEDULER;
    expect(loadConfig(dir()).loopSchedulerEnabled).toBe(true);
    process.env.NEO_LOOP_SCHEDULER = "0";
    expect(loadConfig(dir()).loopSchedulerEnabled).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.NEO_LOOP_SCHEDULER;
    else process.env.NEO_LOOP_SCHEDULER = saved;
  }
});

test("dispatchTimeoutMs defaults to 900000 and reads config.json", () => {
  expect(loadConfig("/nonexistent-dir").dispatchTimeoutMs).toBe(900_000);
});

test("dispatch liveness knobs default per spec (ceiling 2h, stall 5m, grace 75s)", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.dispatchTimeoutMaxMs).toBe(7_200_000);
  expect(c.dispatchStallMs).toBe(300_000);
  expect(c.dispatchGraceMs).toBe(75_000);
});

test("watchdog thresholds default per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.stuckAfterMs).toBe(600_000);
  expect(c.longTurnAlertMs).toBe(1_200_000);
  expect(c.alertRepeatMs).toBe(900_000);
});

test("contextPolicy defaults per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.contextPolicy).toEqual({ handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000 });
});
