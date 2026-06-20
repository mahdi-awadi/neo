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
