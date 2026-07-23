import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  decideContext,
  sessionContext,
  encodeCwd,
  CONTEXT_WINDOW_TOKENS,
  runHandoff,
  idleStateNote,
  writeIdleStateNote,
  effectiveCacheTtlMs,
} from "../src/engine/context-policy";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import type { Order, SessionInfo } from "../src/types";
import type { RunHandlers } from "../src/engine/session-runner";

const CFG = {
  handoffPct: 0.65,
  emergencyPct: 0.85,
  maxTurns: 200,
  maxAgeMs: 604_800_000,
  handoffTimeoutMs: 180_000,
  staleResumePct: 0.35,
  cacheTtlFallbackMs: 3_600_000,
  cacheTtlMinObservations: 5,
};
const POLICY = CFG;

/** Writes a real transcript under the REAL ~/.claude/projects tree (sessionContext's default
 *  path — the idleMs test below calls sessionContext with no projectsDir override, so it has to
 *  exist there). Reuses one fixed folder so repeat runs just overwrite it. */
function writeFakeTranscript(): { folder: string; id: string } {
  const folder = "/p/cache-ttl-fixture";
  const id = "sess-idle";
  const dir = join(homedir(), ".claude", "projects", encodeCwd(folder));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }),
  );
  return { folder, id };
}

function sessionOn(folder: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "x",
    name: "acme",
    sdkSessionId: "sdk1",
    order: { id: "o", source: "neo", folder, task: "build the thing", chatId: 1, createdAt: 0 },
    status: "idle",
    startedAt: 0,
    lastActivityAt: 0,
    activity: { label: "Edit: server.ts", since: 0 },
    ...over,
  };
}

test("idleStateNote captures the folder, opening brief, last activity, and an idle-closed marker", () => {
  const note = idleStateNote(sessionOn("/home/acme"), Date.parse("2026-07-21T09:00:00Z"));
  expect(note).toContain("/home/acme");
  expect(note).toContain("build the thing");
  expect(note).toContain("Edit: server.ts");
  expect(note.toLowerCase()).toContain("idle-closed");
});

test("writeIdleStateNote writes the note to HANDOFF.md in the project folder", () => {
  const writes: Array<{ path: string; content: string }> = [];
  writeIdleStateNote(sessionOn("/home/acme"), { now: () => 0, write: (path, content) => void writes.push({ path, content }) });
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe("/home/acme/HANDOFF.md");
  expect(writes[0].content.toLowerCase()).toContain("idle-closed");
});

test("writeIdleStateNote swallows write errors so idle-close never breaks", () => {
  expect(() =>
    writeIdleStateNote(sessionOn("/home/acme"), {
      write: () => {
        throw new Error("EACCES");
      },
    }),
  ).not.toThrow();
});

test("decideContext verdict matrix", () => {
  const ttl = CFG.cacheTtlFallbackMs;
  expect(decideContext({ occupancy: 0.1, turns: 5, ageMs: 0, idleMs: 0 }, CFG, ttl)).toBe("keep");
  expect(decideContext({ occupancy: 0.65, turns: 5, ageMs: 0, idleMs: 0 }, CFG, ttl)).toBe("handoff"); // at threshold
  expect(decideContext({ occupancy: 0.2, turns: 200, ageMs: 0, idleMs: 0 }, CFG, ttl)).toBe("handoff"); // turns
  expect(decideContext({ occupancy: 0.2, turns: 5, ageMs: 604_800_000, idleMs: 0 }, CFG, ttl)).toBe("handoff"); // age
  expect(decideContext({ occupancy: 0.85, turns: 5, ageMs: 0, idleMs: 0 }, CFG, ttl)).toBe("clear"); // emergency wins over handoff
  expect(decideContext({ occupancy: 0.99, turns: 300, ageMs: 999_999_999, idleMs: 0 }, CFG, ttl)).toBe("clear");
});

test("effectiveCacheTtlMs: with too few observations, returns the fallback", () => {
  expect(effectiveCacheTtlMs([], POLICY)).toBe(POLICY.cacheTtlFallbackMs);
  expect(effectiveCacheTtlMs([{ gapMs: 60_000, hit: true }], POLICY)).toBe(POLICY.cacheTtlFallbackMs);
});

test("effectiveCacheTtlMs: learns the boundary between observed hits and misses", () => {
  const obs = [
    { gapMs: 10 * 60_000, hit: true }, { gapMs: 30 * 60_000, hit: true },
    { gapMs: 50 * 60_000, hit: true }, { gapMs: 70 * 60_000, hit: false },
    { gapMs: 90 * 60_000, hit: false },
  ];
  // deterministic midpoint between the longest observed hit and the shortest observed miss
  expect(effectiveCacheTtlMs(obs, POLICY)).toBe((50 * 60_000 + 70 * 60_000) / 2);
});

test("decideContext: idle past the effective TTL + fat transcript → handoff; either alone → keep", () => {
  const ttl = 3_600_000;
  expect(decideContext({ occupancy: 0.4, turns: 10, ageMs: 0, idleMs: 2 * ttl }, POLICY, ttl)).toBe("handoff");
  expect(decideContext({ occupancy: 0.2, turns: 10, ageMs: 0, idleMs: 2 * ttl }, POLICY, ttl)).toBe("keep");
  expect(decideContext({ occupancy: 0.4, turns: 10, ageMs: 0, idleMs: 60_000 }, POLICY, ttl)).toBe("keep");
});

test("sessionContext reports idleMs from the transcript mtime; 0 on any error (fail-open)", async () => {
  const { folder, id } = writeFakeTranscript();
  expect((await sessionContext(folder, id)).idleMs).toBeGreaterThanOrEqual(0);
  expect((await sessionContext("/nope", "missing")).idleMs).toBe(0);
  rmSync(join(homedir(), ".claude", "projects", encodeCwd(folder)), { recursive: true, force: true });
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
  expect(sessionContext("/nowhere", "nope", { projectsDir: "/nonexistent" })).toEqual({ occupancy: 0, turns: 0, ageMs: 0, idleMs: 0 });
});

test("runHandoff runs the handoff turn against the persisted session, then clears it", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "h1", source: "neo", folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.setSdkSessionId(s.id, "fat-session");
  const order = { id: "h1", source: "neo" as const, folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 };
  ledger.recordOrder(order);
  ledger.recordSession("h1", "fat-session");
  let sawResume: string | undefined;
  let sawTask: string | undefined;
  const fakeRun = async (o: Order, _h: RunHandlers, d?: { resume?: string }) => {
    sawResume = d?.resume;
    sawTask = o.task;
    return { ok: true, sessionId: "fat-session", summary: "written", costUsd: 0 };
  };
  await runHandoff(s, { ...CFG }, { registry, ledger, run: fakeRun as never, now: () => 9 });
  expect(sawResume).toBe("fat-session");
  expect(sawTask).toContain("HANDOFF.md");
  expect(registry.get(s.id)?.sdkSessionId).toBe(""); // cleared
  expect(ledger.lastSessionFor("/p/gold", 1)).toBeUndefined(); // cleared
  expect(ledger.listContextEvents()[0]?.verdict).toBe("handoff");
});

test("runHandoff clears even when the handoff turn times out, AND interrupts the abandoned run", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "h2", source: "neo", folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.setSdkSessionId(s.id, "fat-2");
  let interrupted = false;
  const fakeStart = () => ({
    followUp: () => {},
    queued: () => 0,
    interrupt: async () => {
      interrupted = true;
    },
    done: new Promise<never>(() => {}), // never resolves — must be raced against the timeout
  });
  await runHandoff(s, { ...CFG, handoffTimeoutMs: 5 }, { registry, ledger, start: fakeStart as never });
  expect(registry.get(s.id)?.sdkSessionId).toBe("");
  expect(interrupted).toBe(true); // the timed-out worker is interrupted, not abandoned
});
