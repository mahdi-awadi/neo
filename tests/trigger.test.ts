import { test, expect } from "bun:test";
import { cronMatches, isDue, isValidCron } from "../src/engine/trigger";

test("isValidCron accepts well-formed 5-field expressions", () => {
  for (const e of ["* * * * *", "30 3 * * *", "*/15 * * * *", "0 9-17 * * 1-5", "0 0 1,15 * *", "0 0 * * 7"]) {
    expect(isValidCron(e)).toBe(true);
  }
});

test("isValidCron rejects malformed or out-of-range expressions", () => {
  for (const e of ["* * * *", "", "abc", "60 * * * *", "0 24 * * *", "0 0 * * 8", "0 0 0 * *", "*/0 * * * *"]) {
    expect(isValidCron(e)).toBe(false);
  }
});

const at = (s: string) => new Date(s).getTime(); // local time

test("cronMatches wildcard fires every minute", () => {
  expect(cronMatches("* * * * *", at("2026-06-26T03:30:00"))).toBe(true);
});

test("cronMatches specific minute and hour", () => {
  expect(cronMatches("30 3 * * *", at("2026-06-26T03:30:00"))).toBe(true);
  expect(cronMatches("30 3 * * *", at("2026-06-26T03:31:00"))).toBe(false);
  expect(cronMatches("30 3 * * *", at("2026-06-26T04:30:00"))).toBe(false);
});

test("cronMatches steps, ranges, and lists", () => {
  expect(cronMatches("*/15 * * * *", at("2026-06-26T03:45:00"))).toBe(true);
  expect(cronMatches("*/15 * * * *", at("2026-06-26T03:46:00"))).toBe(false);
  expect(cronMatches("0 9-17 * * *", at("2026-06-26T13:00:00"))).toBe(true);
  expect(cronMatches("0 9-17 * * *", at("2026-06-26T18:00:00"))).toBe(false);
  expect(cronMatches("0 0 1,15 * *", at("2026-06-15T00:00:00"))).toBe(true);
});

test("cronMatches day-of-week treats 0 and 7 as Sunday", () => {
  // 2026-06-28 is a Sunday
  expect(cronMatches("0 0 * * 0", at("2026-06-28T00:00:00"))).toBe(true);
  expect(cronMatches("0 0 * * 7", at("2026-06-28T00:00:00"))).toBe(true);
  expect(cronMatches("0 0 * * 1", at("2026-06-28T00:00:00"))).toBe(false);
});

test("isDue: manual never fires via the scheduler", () => {
  expect(isDue({ kind: "manual" }, undefined, at("2026-06-26T03:30:00"))).toBe(false);
});

test("isDue: interval respects everyMs", () => {
  const now = at("2026-06-26T03:30:00");
  expect(isDue({ kind: "interval", everyMs: 60_000 }, undefined, now)).toBe(true);
  expect(isDue({ kind: "interval", everyMs: 3_600_000 }, now - 60_000, now)).toBe(false);
  expect(isDue({ kind: "interval", everyMs: 3_600_000 }, now - 3_600_000, now)).toBe(true);
});

test("isDue: cron fires on a match but not twice in the same minute", () => {
  const now = at("2026-06-26T03:30:00");
  expect(isDue({ kind: "cron", expr: "30 3 * * *" }, undefined, now)).toBe(true);
  expect(isDue({ kind: "cron", expr: "30 3 * * *" }, now - 1000, now)).toBe(false);
});
