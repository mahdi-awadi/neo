import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  decideContext,
  contextBand,
  sessionContext,
  encodeCwd,
  windowTokensFor,
  contextWindows,
  runHandoff,
  HANDOFF_PROMPT,
  MEMORY_FLUSH_SENTENCE,
  idleStateNote,
  writeIdleStateNote,
  effectiveCacheTtlMs,
  transcriptLineCount,
  firstAssistantCacheReadAfter,
} from "../src/engine/context-policy";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import type { Order, SessionInfo } from "../src/types";
import type { ContextSignals } from "../src/engine/context-policy";
import type { RunHandlers } from "../src/engine/session-runner";

const CFG = {
  sweetSpotPct: 0.4,
  checkpointPct: 0.6,
  emergencyPct: 0.9,
  handoffNoteMaxChars: 20_000,
  handoffOrientationMaxSteps: 70,
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

const sig = (occupancy: number, over: Partial<ContextSignals> = {}): ContextSignals => ({ occupancy, turns: 1, ageMs: 0, idleMs: 0, ...over });
const FAR = 1e12; // a cache TTL nothing is idle past

test("contextBand splits occupancy at the three knobs", () => {
  expect([0.1, 0.4, 0.6, 0.9].map((o) => contextBand(o, CFG))).toEqual(["healthy", "above", "heavy", "emergency"]);
});

test("resume and settled boundaries hand off above the sweet spot and keep inside it", () => {
  for (const boundary of ["resume", "settled"] as const) {
    expect(decideContext(sig(0.39), CFG, FAR, { boundary })).toEqual({ verdict: "keep", band: "healthy" });
    expect(decideContext(sig(0.41), CFG, FAR, { boundary })).toEqual({ verdict: "handoff", reason: "above-sweet-spot", band: "above" });
  }
});

test("the boundary defaults to a resume (the gate callers that predate boundaries)", () => {
  expect(decideContext(sig(0.92), CFG, FAR).verdict).toBe("clear");
});

test("a checkpoint hands off only in the heavy band, or when the plan projects past emergency", () => {
  expect(decideContext(sig(0.5), CFG, FAR, { boundary: "checkpoint" }).verdict).toBe("keep");
  expect(decideContext(sig(0.61), CFG, FAR, { boundary: "checkpoint" })).toEqual({ verdict: "handoff", reason: "heavy", band: "heavy" });
  expect(decideContext(sig(0.45), CFG, FAR, { boundary: "checkpoint", projected: 1.05 }).reason).toBe("projected-overflow");
  // inside the sweet spot a task is never interrupted, whatever the projection says
  expect(decideContext(sig(0.3), CFG, FAR, { boundary: "checkpoint", projected: 1.5 }).verdict).toBe("keep");
  // turns/age are boundary rules, never a reason to stop mid-task
  expect(decideContext(sig(0.1, { turns: 900 }), CFG, FAR, { boundary: "checkpoint" }).verdict).toBe("keep");
});

test("emergency: clear only at a resume on a known window; every other case hands off", () => {
  expect(decideContext(sig(0.92), CFG, FAR, { boundary: "resume" })).toEqual({ verdict: "clear", reason: "emergency", band: "emergency" });
  expect(decideContext(sig(0.92, { windowKnown: false }), CFG, FAR, { boundary: "resume" }).verdict).toBe("handoff");
  expect(decideContext(sig(0.92), CFG, FAR, { boundary: "settled" })).toEqual({ verdict: "handoff", reason: "emergency", band: "emergency" });
  expect(decideContext(sig(0.92), CFG, FAR, { boundary: "checkpoint" }).reason).toBe("emergency");
});

test("a guessed window drives no band rule, only turns, age and staleness", () => {
  expect(decideContext(sig(0.7, { windowKnown: false }), CFG, FAR, { boundary: "settled" }).verdict).toBe("keep");
  expect(decideContext(sig(0.1, { windowKnown: false, turns: 200 }), CFG, FAR, { boundary: "settled" }).reason).toBe("max-turns");
  expect(decideContext(sig(0.1, { ageMs: 604_800_000 }), CFG, FAR, { boundary: "resume" }).reason).toBe("max-age");
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

test("decideContext: a resume idle past the cache TTL on a fat transcript hands off; either alone keeps", () => {
  const ttl = 3_600_000;
  expect(decideContext(sig(0.36, { idleMs: 2 * ttl }), POLICY, ttl, { boundary: "resume" }).reason).toBe("stale-resume");
  expect(decideContext(sig(0.2, { idleMs: 2 * ttl }), POLICY, ttl, { boundary: "resume" }).verdict).toBe("keep");
  expect(decideContext(sig(0.36, { idleMs: 60_000 }), POLICY, ttl, { boundary: "resume" }).verdict).toBe("keep");
  // a settled session's cache is warm by definition — staleness is a resume-only rule
  expect(decideContext(sig(0.36, { idleMs: 2 * ttl }), POLICY, ttl, { boundary: "settled" }).verdict).toBe("keep");
});

test("sessionContext reports idleMs from the transcript mtime; 0 on any error (fail-open)", async () => {
  const { folder, id } = writeFakeTranscript();
  expect((await sessionContext(folder, id)).idleMs).toBeGreaterThanOrEqual(0);
  expect((await sessionContext("/nope", "missing")).idleMs).toBe(0);
  rmSync(join(homedir(), ".claude", "projects", encodeCwd(folder)), { recursive: true, force: true });
});

test("firstAssistantCacheReadAfter returns the FIRST matching turn after afterLine, not a later one", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-ctx-"));
  const dir = join(projectsDir, encodeCwd("/p/cache-fixture"));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: 999 } } }), // pre-resume, line 0
    JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: 0 } } }), // first post-resume, line 1
    JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: 500 } } }), // later turn, line 2
  ].join("\n");
  writeFileSync(join(dir, "sess-cache.jsonl"), lines);
  expect(firstAssistantCacheReadAfter("/p/cache-fixture", "sess-cache", 1, { projectsDir })).toBe(0);
  expect(firstAssistantCacheReadAfter("/p/cache-fixture", "sess-cache", 0, { projectsDir })).toBe(999);
});

test("firstAssistantCacheReadAfter / transcriptLineCount fail OPEN (undefined) on a missing transcript", () => {
  expect(firstAssistantCacheReadAfter("/nowhere", "nope", 0, { projectsDir: "/nonexistent" })).toBeUndefined();
  expect(transcriptLineCount("/nowhere", "nope", { projectsDir: "/nonexistent" })).toBeUndefined();
});

test("transcriptLineCount counts the transcript's lines", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-ctx-"));
  const dir = join(projectsDir, encodeCwd("/p/cache-lines"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sess-lines.jsonl"), "a\nb\nc");
  expect(transcriptLineCount("/p/cache-lines", "sess-lines", { projectsDir })).toBe(3);
});

test("transcriptLineCount / firstAssistantCacheReadAfter agree on a real, every-line-newline-terminated transcript (2026-07-23 review: a naive split() would count a phantom trailing line)", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-ctx-"));
  const dir = join(projectsDir, encodeCwd("/p/cache-realistic"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sess-realistic.jsonl");
  const line = (n: number) => JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: n } } }) + "\n";
  // Real ~/.claude/projects/.../*.jsonl transcripts end every line, including the last, in "\n".
  writeFileSync(path, line(999)); // pre-resume — captured as the boundary
  const preLines = transcriptLineCount("/p/cache-realistic", "sess-realistic", { projectsDir });
  expect(preLines).toBe(1); // NOT 2 — no phantom trailing element from the file's own final "\n"
  appendFileSync(path, line(0) + line(500)); // two post-resume turns, each newline-terminated
  // afterLine = preLines must land on the FIRST appended turn (0), not the second (500).
  expect(firstAssistantCacheReadAfter("/p/cache-realistic", "sess-realistic", preLines!, { projectsDir })).toBe(0);
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
  // No `message.model` in this fixture → the default fact (windowTokensFor(undefined)).
  expect(sig.occupancy).toBeCloseTo((2_000 + 120_000 + 8_000) / windowTokensFor(undefined), 5); // LAST turn's input-side tokens
  expect(sig.ageMs).toBe(2 * 3_600_000); // now - first line
});

test("window tokens derive from the session's model via the facts map, with config override winning", () => {
  expect(windowTokensFor(undefined)).toBe(200_000); // unknown model → conservative default fact
  expect(windowTokensFor("weird-model", { "weird-model": 500_000 })).toBe(500_000); // override map (config) wins
});

test("sessionContext divides occupancy by the model's window when the transcript reports one, not the default", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-ctx-"));
  const dir = join(projectsDir, encodeCwd("/p/model-window"));
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-08T00:00:00.000Z",
    message: { model: "weird-model", usage: { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  writeFileSync(join(dir, "sess-model.jsonl"), line);
  const sig = sessionContext("/p/model-window", "sess-model", { projectsDir, windowTokensByModel: { "weird-model": 500_000 } });
  expect(sig.occupancy).toBeCloseTo(100_000 / 500_000, 5);
});

// The console polls this for every live session, and the transcripts grow to tens of MB. A call
// must parse only what was appended since the last call, never the whole file again.
function growing(name: string) {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-ctx-"));
  const dir = join(projectsDir, encodeCwd(`/p/${name}`));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s.jsonl");
  const turn = (input: number) => JSON.stringify({ type: "assistant", timestamp: "2026-07-08T00:00:00.000Z", message: { usage: { input_tokens: input } } });
  const read = () => sessionContext(`/p/${name}`, "s", { projectsDir });
  return { file, turn, read };
}

test("sessionContext parses only the bytes appended since its last read", () => {
  const g = growing("grow");
  writeFileSync(g.file, g.turn(10) + "\n" + g.turn(20) + "\n");
  expect(g.read().turns).toBe(2);
  // Blank out the already-read prefix in place (same size): a full re-read would now see 0 turns there.
  const size = Bun.file(g.file).size;
  writeFileSync(g.file, " ".repeat(size - 1) + "\n");
  appendFileSync(g.file, g.turn(30) + "\n");
  const sig = g.read();
  expect(sig.turns).toBe(3);
  expect(sig.occupancy).toBeCloseTo(30 / windowTokensFor(undefined), 8);
});

test("sessionContext re-reads from the start when the transcript shrank (rewritten)", () => {
  const g = growing("shrink");
  writeFileSync(g.file, g.turn(10) + "\n" + g.turn(20) + "\n" + g.turn(30) + "\n");
  expect(g.read().turns).toBe(3);
  writeFileSync(g.file, g.turn(5) + "\n");
  expect(g.read().turns).toBe(1);
});

test("sessionContext counts a last line with no newline once, also after it is completed", () => {
  const g = growing("partial");
  writeFileSync(g.file, g.turn(10) + "\n" + g.turn(20));
  expect(g.read().turns).toBe(2);
  appendFileSync(g.file, "\n" + g.turn(30) + "\n");
  expect(g.read().turns).toBe(3);
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

test("runHandoff prepends the memory flush sentence before HANDOFF_PROMPT when memoryFlush is true", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "h5", source: "neo", folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.setSdkSessionId(s.id, "fat-5");
  let sawTask: string | undefined;
  const fakeRun = async (o: Order, _h: RunHandlers, _d?: { resume?: string }) => {
    sawTask = o.task;
    return { ok: true, sessionId: "fat-5", summary: "written", costUsd: 0 };
  };
  await runHandoff(s, { ...CFG }, { registry, ledger, run: fakeRun as never, memoryFlush: true });
  expect(sawTask?.startsWith(MEMORY_FLUSH_SENTENCE)).toBe(true);
  expect(sawTask).toContain(HANDOFF_PROMPT);
});

test("runHandoff's task is byte-identical to HANDOFF_PROMPT when memoryFlush is absent (Phase-1 fence pin)", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "h6", source: "neo", folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.setSdkSessionId(s.id, "fat-6");
  let sawTask: string | undefined;
  const fakeRun = async (o: Order, _h: RunHandlers, _d?: { resume?: string }) => {
    sawTask = o.task;
    return { ok: true, sessionId: "fat-6", summary: "written", costUsd: 0 };
  };
  await runHandoff(s, { ...CFG }, { registry, ledger, run: fakeRun as never });
  expect(sawTask).toBe(HANDOFF_PROMPT);
});

// ADR-0013 — the live bug: transcripts report `claude-opus-5-5` (the SDK strips `[1m]`), the code
// table only knew `default: 200_000`, so a 547k-token Opus turn read as 274% and tripped `clear`.
test("contextWindows: operator override beats the SDK-reported window, which beats the default", () => {
  const ledger = openLedger(":memory:");
  ledger.recordModelWindow("claude-opus-5-5", 1_000_000);
  ledger.recordModelWindow("claude-sonnet-5-5", 200_000);
  const w = contextWindows(ledger, { "claude-sonnet-5-5": 1_000_000 });
  expect(windowTokensFor("claude-opus-5-5", w)).toBe(1_000_000); // SDK-reported
  expect(windowTokensFor("claude-sonnet-5-5", w)).toBe(1_000_000); // operator override wins
  expect(windowTokensFor("never-seen", w)).toBe(200_000); // default fact
  expect(contextWindows(ledger)).toEqual({ "claude-opus-5-5": 1_000_000, "claude-sonnet-5-5": 200_000 });
});

test("sessionContext measures an Opus 5.5 transcript against the SDK-reported 1M window", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-ctxwin-"));
  try {
    const folder = "/p/waselni";
    mkdirSync(join(dir, encodeCwd(folder)), { recursive: true });
    const turn = { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 546_145, cache_creation_input_tokens: 1_572 } } };
    writeFileSync(join(dir, encodeCwd(folder), "s-opus.jsonl"), `${JSON.stringify(turn)}\n`);
    const ledger = openLedger(":memory:");
    ledger.recordModelWindow("claude-opus-5-5", 1_000_000);
    const sig = sessionContext(folder, "s-opus", { projectsDir: dir, windowTokensByModel: contextWindows(ledger) });
    expect(sig.occupancy).toBeCloseTo(0.547719, 6); // was 2.738595 against the 200k default
    expect(sig.occupancy).toBeLessThan(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADR-0013 review: right after a restart no model has reported its window yet, and the resume gate
// runs BEFORE the first turn. A guessed window must never destroy a session — at most a handoff.
test("decideContext: over the emergency line on a GUESSED window hands off, never clears", () => {
  const s = { occupancy: 2.74, turns: 10, ageMs: 0, idleMs: 0 };
  expect(decideContext({ ...s, windowKnown: false }, CFG, 3_600_000).verdict).toBe("handoff");
  expect(decideContext({ ...s, windowKnown: true }, CFG, 3_600_000).verdict).toBe("clear");
  expect(decideContext(s, CFG, 3_600_000).verdict).toBe("clear"); // unset = known (hand-built signals)
});

test("sessionContext says whether the window was reported or guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-ctxknown-"));
  try {
    const folder = "/p/gold";
    mkdirSync(join(dir, encodeCwd(folder)), { recursive: true });
    const turn = { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 470_000 } } };
    writeFileSync(join(dir, encodeCwd(folder), "s.jsonl"), `${JSON.stringify(turn)}\n`);
    expect(sessionContext(folder, "s", { projectsDir: dir }).windowKnown).toBe(false);
    expect(sessionContext(folder, "s", { projectsDir: dir, windowTokensByModel: { "claude-opus-5-5": 1_000_000 } }).windowKnown).toBeUndefined(); // known
    expect(sessionContext(folder, "missing", { projectsDir: dir }).windowKnown).toBeUndefined(); // nothing measured
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
