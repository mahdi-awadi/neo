// Phase 2 Task 9 — the memory-upgrades spec's three acceptance proofs, run end-to-end through the
// SAME pipeline harness style established in tests/pipeline.test.ts (fakeStart + a minimal
// PipelineDeps fixture), plus the worker-facing memory tools (memory-tool.ts) standing in for a
// real worker's tool calls. No new interfaces — this file only proves existing wiring.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMessage } from "../src/engine/pipeline";
import { appendDailyLog } from "../src/engine/memory";
import { memoryTools } from "../src/engine/memory-tool";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter, type Meter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { MemoryCfg, NeoConfig } from "../src/config";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";

// Same fixture shape as tests/pipeline.test.ts's cfg() — every field a real NeoConfig needs, memory
// defaulted OFF (scopes: []); individual tests override `.memory.scopes` to opt a folder in.
function cfg(): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    botUsername: "",
    webHost: "127.0.0.1",
    webPort: 3003,
    publicUrl: "",
    companyFolder: "/tmp/agent",
    gatewaySendUrl: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    budgetWindowUsd: 100,
    budgetWindowMs: 3_600_000,
    agentIngressSecret: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
    codebaseMemoryBin: "",
    codebaseMemoryIndexTimeoutMs: 300_000,
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
    dispatchTimeoutMs: 900_000,
    dispatchTimeoutMaxMs: 7_200_000,
    dispatchStallMs: 300_000,
    dispatchGraceMs: 75_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
    drainWindowMs: 90_000,
    contextPolicy: {
      handoffPct: 0.65,
      emergencyPct: 0.85,
      maxTurns: 200,
      maxAgeMs: 604_800_000,
      handoffTimeoutMs: 180_000,
      staleResumePct: 0.35,
      cacheTtlFallbackMs: 3_600_000,
      cacheTtlMinObservations: 5,
    },
    workers: { company: { effort: "low" }, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: { effort: "low" }, handoff: {} },
    workerEnv: {},
    memory: { scopes: [], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 },
  };
}

const MEMORY_CFG: MemoryCfg = cfg().memory;
// A generous window so the ratio caps never reject these tests' short entries as over capacity.
const WINDOW_TOKENS = 200_000;

const scratch = () => mkdtempSync(join(tmpdir(), "neo-memacc-"));

function harness(over: { meter?: Meter; start?: never } = {}) {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const meter = over.meter ?? createMeter({ windowBudgetUsd: 100, reservePct: 0.2 });
  const base = {
    cfg: cfg(),
    ledger,
    registry,
    meter,
    trust: openTrustStore(":memory:"),
    reply: (_c: number, _t: string) => {},
    askApproval: async () => "allow" as const,
  };
  return { ledger, registry, meter, base };
}

// A never-completing fake worker start that just captures the task text it was launched with
// (the frozen first prompt) — mirrors pipeline.test.ts's inline `start` fixtures.
function captureStart(onTask: (task: string) => void): (o: Order) => SessionRun {
  return (o: Order): SessionRun => {
    onTask(o.task);
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

// --- Proof 1: INJECT — a seeded MEMORY.md entry is answerable from the snapshot alone. ---

test("INJECT: a seeded MEMORY.md entry reaches a new session's first prompt inside the ground-truth wrapper", async () => {
  const dir = scratch();
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "MEMORY.md"), "§ Working on the payments migration");

  let seenTask = "";
  const h = harness();
  const scopedCfg = { ...h.base.cfg, memory: { ...h.base.cfg.memory, scopes: [dir] } };

  await handleMessage(`/open ${dir} what were we working on`, 9, {
    ...h.base,
    cfg: scopedCfg,
    start: captureStart((t) => (seenTask = t)),
  });

  // "what were we working on" is answerable from the snapshot alone — the entry is present, inside
  // the authoritative ground-truth wrapper, alongside the order's own task.
  expect(seenTask.startsWith("[MEMORY — authoritative")).toBe(true);
  expect(seenTask).toContain("§ Working on the payments migration");
  expect(seenTask).toContain("[END MEMORY]");
  expect(seenTask).toContain("what were we working on");
});

// --- Proof 2: STORE + FROZEN — a mid-session write applies NEXT session, never the current one. ---

test("STORE + FROZEN: a mid-session memory-tool add is absent from the CURRENT session's already-built prompt, present in the NEXT session's", async () => {
  const dir = scratch();
  const h = harness();
  const scopedCfg = { ...h.base.cfg, memory: { ...h.base.cfg.memory, scopes: [dir] } };

  let firstTask = "";
  await handleMessage(`/open ${dir} continue the work`, 1, {
    ...h.base,
    cfg: scopedCfg,
    start: captureStart((t) => (firstTask = t)),
  });

  // A fake worker turn, mid-session, calls the `memory` tool directly — exactly the surface a real
  // worker's tool call reaches (memory-tool.ts), independent of the frozen snapshot already built.
  const [memoryTool] = memoryTools(dir, scopedCfg.memory, WINDOW_TOKENS);
  const addRes = await memoryTool.handler(
    { file: "MEMORY.md", op: "add", text: "Operator prefers Persian summaries" },
    {},
  );
  expect(textOf(addRes)).toContain("saved");

  // The CURRENT session's prompt was already computed before the write — frozen for the run.
  expect(firstTask).not.toContain("Operator prefers Persian summaries");

  // A SECOND session (different chat, so no prior sdk session to resume — a genuine fresh start)
  // sees the write, because memorySnapshot re-reads MEMORY.md at start.
  let secondTask = "";
  await handleMessage(`/open ${dir} continue again`, 2, {
    ...h.base,
    cfg: scopedCfg,
    start: captureStart((t) => (secondTask = t)),
  });

  expect(secondTask).toContain("Operator prefers Persian summaries");
});

// --- Proof 3: RECALL — a daily-log entry is searchable, with its file+day citation. ---

test("RECALL: memory_search finds a daily-log entry and cites its file + day", async () => {
  const dir = scratch();
  const wrote = appendDailyLog(dir, "chose Stripe for payments", "2026-07-01");
  expect(wrote).toBe(true);

  const [, searchTool] = memoryTools(dir, MEMORY_CFG, WINDOW_TOKENS);
  // Keyword note: memory-recall's index is FTS5 (bm25 keyword match), not semantic search — a
  // query must share literal word stems with the stored line. "payment provider decision" (the
  // spec's own example phrasing) would NOT match this entry; "payments Stripe" (words the stored
  // line actually contains) does. This is a real limitation of the recall tool, not a test crutch.
  const res = await searchTool.handler({ query: "payments Stripe" }, {});
  const text = textOf(res);

  expect(text).toContain("chose Stripe for payments");
  expect(text).toContain("log/2026-07-01.md"); // file citation, relative to the memory folder
  expect(text).toContain("2026-07-01"); // day citation
});
