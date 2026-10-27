import { test, expect } from "bun:test";
import { runLoop } from "../src/engine/loop-runner";

test("runLoop does nothing if the goal is already met", async () => {
  let iterated = 0;
  const out = await runLoop({
    iterate: async () => (iterated++, { sessionId: "s", summary: "" }),
    check: async () => ({ met: true, detail: "green" }),
    maxIterations: 5,
  });
  expect(out.met).toBe(true);
  expect(out.iterations).toBe(0);
  expect(out.reason).toBe("goal-met");
  expect(iterated).toBe(0);
});

test("runLoop iterates until the goal is met, resuming the session each time", async () => {
  const checks = [false, false, true];
  let ci = 0;
  const resumes: Array<string | undefined> = [];
  let session = 0;
  const out = await runLoop({
    check: async () => ({ met: checks[ci++], detail: `c${ci}` }),
    iterate: async (resumeId) => {
      resumes.push(resumeId);
      return { sessionId: `s${++session}`, summary: "" };
    },
    maxIterations: 5,
  });
  expect(out.met).toBe(true);
  expect(out.iterations).toBe(2);
  expect(resumes).toEqual([undefined, "s1"]); // first run fresh, then resume the prior session
});

test("runLoop stops at maxIterations if the goal is never met", async () => {
  let iterated = 0;
  const out = await runLoop({
    check: async () => ({ met: false, detail: "red" }),
    iterate: async () => (iterated++, { sessionId: "s", summary: "" }),
    maxIterations: 3,
  });
  expect(out.met).toBe(false);
  expect(out.reason).toBe("max-iterations");
  expect(out.iterations).toBe(3);
  expect(iterated).toBe(3);
});

test("runLoop stops early when shouldStop fires (e.g. usage cap)", async () => {
  let stop = false;
  let iterated = 0;
  const out = await runLoop({
    check: async () => ({ met: false, detail: "red" }),
    iterate: async () => {
      iterated++;
      stop = true;
      return { sessionId: "s", summary: "" };
    },
    shouldStop: () => stop,
    maxIterations: 10,
  });
  expect(out.reason).toBe("stopped");
  expect(out.met).toBe(false);
  expect(iterated).toBe(1);
});

test("runLoop stops with over-budget once spent reaches budgetUsd", async () => {
  let iterated = 0;
  const out = await runLoop({
    check: async () => ({ met: false, detail: "red" }),
    iterate: async () => (iterated++, { sessionId: "s", summary: "", costUsd: 2 }),
    maxIterations: 10,
    budgetUsd: 3,
  });
  // iter1 spends 2 (<3, continue), iter2 spends 2 → 4 (≥3, stop before iter3)
  expect(out.reason).toBe("over-budget");
  expect(iterated).toBe(2);
  expect(out.spentUsd).toBe(4);
});

test("runLoop accumulates spentUsd across iterations", async () => {
  const checks = [false, true];
  let ci = 0;
  const out = await runLoop({
    check: async () => ({ met: checks[ci++], detail: "c" }),
    iterate: async () => ({ sessionId: "s", summary: "", costUsd: 1.5 }),
    maxIterations: 5,
  });
  expect(out.met).toBe(true);
  expect(out.spentUsd).toBe(1.5);
});

test("runLoop counts a goal check's own cost (a judge run) toward the budget", async () => {
  let iterations = 0;
  const out = await runLoop({
    check: async () => ({ met: false, detail: "judge: continue", costUsd: 0.6 }),
    iterate: async () => (iterations++, { sessionId: "s", summary: "", costUsd: 0.5 }),
    maxIterations: 10,
    budgetUsd: 2,
  });
  // check 0.6 → iter 0.5 (1.1) → check 0.6 (1.7) → iter 0.5 (2.2) → check 0.6 (2.8) → over budget
  expect(out.reason).toBe("over-budget");
  expect(iterations).toBe(2);
  expect(out.spentUsd).toBeCloseTo(2.8);
});
