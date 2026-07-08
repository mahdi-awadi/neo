import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decideContext, sessionContext, encodeCwd, CONTEXT_WINDOW_TOKENS } from "../src/engine/context-policy";

const CFG = { handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000 };

test("decideContext verdict matrix", () => {
  expect(decideContext({ occupancy: 0.1, turns: 5, ageMs: 0 }, CFG)).toBe("keep");
  expect(decideContext({ occupancy: 0.65, turns: 5, ageMs: 0 }, CFG)).toBe("handoff"); // at threshold
  expect(decideContext({ occupancy: 0.2, turns: 200, ageMs: 0 }, CFG)).toBe("handoff"); // turns
  expect(decideContext({ occupancy: 0.2, turns: 5, ageMs: 604_800_000 }, CFG)).toBe("handoff"); // age
  expect(decideContext({ occupancy: 0.85, turns: 5, ageMs: 0 }, CFG)).toBe("clear"); // emergency wins over handoff
  expect(decideContext({ occupancy: 0.99, turns: 300, ageMs: 999_999_999 }, CFG)).toBe("clear");
});

test("encodeCwd matches Claude Code's project-dir encoding", () => {
  expect(encodeCwd("/home/neo")).toBe("-home-neo");
  expect(encodeCwd("/home/neo/agent")).toBe("-home-neo-agent");
  expect(encodeCwd("/home/my.app")).toBe("-home-my-app"); // dots encode too
});

test("sessionContext reads occupancy/turns/age from the transcript JSONL", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-ctx-"));
  const dir = join(projectsDir, encodeCwd("/p/gold"));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-08T00:00:00.000Z", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 9_000, output_tokens: 500 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-08T01:00:00.000Z", message: { usage: { input_tokens: 2_000, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 8_000, output_tokens: 700 } } }),
  ].join("\n");
  writeFileSync(join(dir, "sess-1.jsonl"), lines);
  const now = Date.parse("2026-07-08T02:00:00.000Z");
  const sig = sessionContext("/p/gold", "sess-1", { projectsDir, now: () => now });
  expect(sig.turns).toBe(2);
  expect(sig.occupancy).toBeCloseTo((2_000 + 120_000 + 8_000) / CONTEXT_WINDOW_TOKENS, 5); // LAST turn's input-side tokens
  expect(sig.ageMs).toBe(2 * 3_600_000); // now - first line
});

test("sessionContext fails OPEN on a missing transcript", () => {
  expect(sessionContext("/nowhere", "nope", { projectsDir: "/nonexistent" })).toEqual({ occupancy: 0, turns: 0, ageMs: 0 });
});
