import { test, expect } from "bun:test";
import { runProjectLoop } from "../src/engine/project-loop";
import type { RunResult } from "../src/engine/session-runner";

const ok = (sessionId: string, costUsd = 0): RunResult => ({ ok: true, sessionId, summary: "", costUsd });

test("runProjectLoop runs the worker until the goal passes, resuming each time", async () => {
  const checks = [false, false, true];
  let ci = 0;
  let runs = 0;
  const resumes: Array<string | undefined> = [];
  const out = await runProjectLoop(
    { folder: "/p/gold", prompt: "make tests pass", goal: { kind: "command", command: ["true"] }, bounds: { maxIterations: 5 } },
    {
      run: async (_o, h, d) => {
        runs++;
        resumes.push(d?.resume);
        h.onMessage("working");
        return ok(`s${runs}`);
      },
      check: async () => ({ met: checks[ci++] ?? true, detail: "c" }),
    },
  );
  expect(out.met).toBe(true);
  expect(runs).toBe(2);
  expect(resumes).toEqual([undefined, "s1"]); // first fresh, then resume the prior session
});

test("loop workers auto-deny risky escalations (no autonomous push/deploy)", async () => {
  let decision: "allow" | "deny" | undefined;
  await runProjectLoop(
    { folder: "/p/gold", prompt: "x", goal: { kind: "command", command: ["true"] }, bounds: { maxIterations: 1 } },
    {
      run: async (_o, h) => {
        decision = await h.onEscalation("git push");
        return ok("s");
      },
      check: async () => ({ met: false, detail: "" }),
    },
  );
  expect(decision).toBe("deny");
});

test("runProjectLoop routes worker text to onMessage, engine progress to onProgress", async () => {
  const messages: string[] = [];
  const progress: string[] = [];
  await runProjectLoop(
    {
      folder: "/p",
      prompt: "x",
      goal: { kind: "command", command: ["true"] },
      bounds: { maxIterations: 1 },
      onMessage: (t) => void messages.push(t),
      onProgress: (m) => void progress.push(m),
    },
    {
      run: async (_o, h) => {
        h.onMessage("hello from worker");
        return ok("s");
      },
      check: async () => ({ met: false, detail: "not yet" }),
    },
  );
  // Worker assistant text goes to onMessage, NOT duplicated onto the engine progress channel.
  expect(messages).toContain("hello from worker");
  expect(progress.some((p) => p.includes("hello from worker"))).toBe(false);
  // The engine's per-iteration chrome stays on onProgress.
  expect(progress.some((p) => p.includes("iteration 1"))).toBe(true);
});

test("runProjectLoop still forwards worker text to onProgress when onMessage is absent", async () => {
  const progress: string[] = [];
  await runProjectLoop(
    { folder: "/p", prompt: "x", goal: { kind: "command", command: ["true"] }, bounds: { maxIterations: 1 }, onProgress: (m) => void progress.push(m) },
    { run: async (_o, h) => (h.onMessage("legacy line"), ok("s")), check: async () => ({ met: false, detail: "" }) },
  );
  expect(progress).toContain("legacy line"); // backward-compatible fallback
});

test("runProjectLoop stops over-budget using worker cost", async () => {
  const out = await runProjectLoop(
    { folder: "/p", prompt: "x", goal: { kind: "command", command: ["false"] }, bounds: { maxIterations: 10, budgetUsd: 1 } },
    { run: async (_o, _h) => ok("s", 1), check: async () => ({ met: false, detail: "" }) },
  );
  expect(out.reason).toBe("over-budget");
});
