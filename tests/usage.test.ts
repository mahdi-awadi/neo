import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseTranscriptUsage,
  tokensInWindow,
  contextOccupancy,
  computeUsageSnapshot,
  readPlanLimitsEndDate,
  createUsageMeter,
  type UsageTurn,
} from "../src/engine/usage";

test("parseTranscriptUsage reads assistant turns and tolerates junk lines", () => {
  const jsonl = [
    '{"type":"assistant","timestamp":"2026-06-19T00:00:00.000Z","message":{"usage":{"input_tokens":100,"cache_creation_input_tokens":50,"cache_read_input_tokens":200,"output_tokens":30}}}',
    "not json at all",
    '{"type":"user","message":{}}',
    '{"type":"assistant","timestamp":"2026-06-19T01:00:00.000Z","message":{"usage":{"input_tokens":10,"output_tokens":5}}}',
  ].join("\n");
  const turns = parseTranscriptUsage(jsonl);
  expect(turns.length).toBe(2);
  expect(turns[0]).toEqual({
    ts: Date.parse("2026-06-19T00:00:00.000Z"),
    input: 100,
    cacheCreation: 50,
    cacheRead: 200,
    output: 30,
  });
  expect(turns[1].input).toBe(10);
});

test("tokensInWindow sums total/input/output within the window only", () => {
  const turns: UsageTurn[] = [
    { ts: 1000, input: 10, cacheCreation: 0, cacheRead: 0, output: 5 },
    { ts: 2000, input: 20, cacheCreation: 5, cacheRead: 5, output: 10 },
    { ts: 9999, input: 100, cacheCreation: 0, cacheRead: 0, output: 100 }, // outside
  ];
  const w = tokensInWindow(turns, 500, 3000);
  expect(w.tokens).toBe(15 + 40);
  expect(w.input).toBe(30);
  expect(w.output).toBe(15);
});

test("computeUsageSnapshot fills 1h/24h/7d windows and derives remaining from caps", () => {
  const now = 10_000_000;
  const turns: UsageTurn[] = [
    { ts: now - 1000, input: 100, cacheCreation: 0, cacheRead: 0, output: 50 }, // all windows
    { ts: now - 2 * 3600_000, input: 1000, cacheCreation: 0, cacheRead: 0, output: 0 }, // daily+weekly
  ];
  const snap = computeUsageSnapshot(turns, now, { caps: { hourly: 1000 }, weeklyResetAt: 12345 });
  expect(snap.perWindow.hourly.consumedTokens).toBe(150);
  expect(snap.perWindow.hourly.remaining).toBe(850);
  expect(snap.perWindow.daily.consumedTokens).toBe(1150);
  expect(snap.perWindow.weekly.consumedTokens).toBe(1150);
  expect(snap.perWindow.daily.remaining).toBeNull(); // no daily cap
  expect(snap.weeklyResetAt).toBe(12345);
  expect(snap.turnCount).toBe(2);
});

test("contextOccupancy is the latest turn's input + cache fields", () => {
  const turns: UsageTurn[] = [
    { ts: 1, input: 10, cacheCreation: 1, cacheRead: 1, output: 5 },
    { ts: 9, input: 100, cacheCreation: 20, cacheRead: 30, output: 5 },
  ];
  expect(contextOccupancy(turns)).toBe(150);
});

test("readPlanLimitsEndDate extracts the weekly reset, or null on any miss", () => {
  const cj = { cachedGrowthBookFeatures: { tengu_saffron_lattice: { planLimitsEndDate: "2026-06-26T00:00:00.000Z" } } };
  expect(readPlanLimitsEndDate(cj)).toBe(Date.parse("2026-06-26T00:00:00.000Z"));
  expect(readPlanLimitsEndDate({})).toBeNull();
  expect(readPlanLimitsEndDate(null)).toBeNull();
});

test("the meter retains the latest rate-limit info per window type", () => {
  const meter = createUsageMeter({ projectsDir: "/nonexistent-neo" });
  meter.noteRateLimit({ status: "allowed", rateLimitType: "five_hour", resetsAt: 100 });
  meter.noteRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 200, utilization: 0.9 });
  meter.noteRateLimit({ status: "allowed", rateLimitType: "seven_day", resetsAt: 999 });
  const rl = meter.snapshot(0).rateLimits;
  const five = rl.find((r) => r.rateLimitType === "five_hour")!;
  expect(five.resetsAt).toBe(200); // latest wins
  expect(five.utilization).toBe(0.9);
  expect(rl.find((r) => r.rateLimitType === "seven_day")).toBeTruthy();
});

test("createUsageMeter aggregates transcripts across the projects dir", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-usage-"));
  const proj = join(projectsDir, "-home-neo-alpha");
  mkdirSync(proj);
  const now = Date.parse("2026-06-19T12:00:00.000Z");
  const line = JSON.stringify({
    type: "assistant",
    timestamp: new Date(now - 1000).toISOString(),
    message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 } },
  });
  writeFileSync(join(proj, "sess-1.jsonl"), line + "\n");

  const meter = createUsageMeter({ projectsDir });
  const snap = meter.snapshot(now);
  expect(snap.perWindow.weekly.consumedTokens).toBe(350);
  expect(snap.turnCount).toBe(1);
});
