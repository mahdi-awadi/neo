import { test, expect } from "bun:test";
import { runProjectLoop } from "../src/engine/project-loop";
import type { RunResult } from "../src/engine/session-runner";

const ok = (sessionId: string): RunResult => ({ ok: true, sessionId, summary: "", costUsd: 0 });

test("runProjectLoop runs the worker until the goal passes, resuming each time", async () => {
  const checks = [false, false, true];
  let ci = 0;
  let runs = 0;
  const resumes: Array<string | undefined> = [];
  const out = await runProjectLoop(
    { folder: "/p/gold", prompt: "make tests pass", goalCommand: ["true"], maxIterations: 5 },
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
    { folder: "/p/gold", prompt: "x", goalCommand: ["true"], maxIterations: 1 },
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
