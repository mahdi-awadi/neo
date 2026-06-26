import { test, expect } from "bun:test";
import { commandGoal, judgeGoal, makeGoalCheck } from "../src/engine/goal";
import type { RunResult } from "../src/engine/session-runner";

const okRun = (summary: string): RunResult => ({ ok: true, sessionId: "s", summary, costUsd: 0 });

test("commandGoal is met when the command exits 0", async () => {
  const g = commandGoal({ command: ["sh", "-c", "echo ok; exit 0"], cwd: process.cwd() });
  const r = await g();
  expect(r.met).toBe(true);
  expect(r.detail).toContain("ok");
});

test("commandGoal is not met when the command exits non-zero", async () => {
  const g = commandGoal({ command: ["sh", "-c", "echo boom >&2; exit 1"], cwd: process.cwd() });
  const r = await g();
  expect(r.met).toBe(false);
  expect(r.detail).toContain("boom");
});

test("commandGoal runs in the given cwd", async () => {
  const g = commandGoal({ command: ["sh", "-c", "pwd"], cwd: "/tmp" });
  const r = await g();
  expect(r.met).toBe(true);
  expect(r.detail).toContain("/tmp");
});

test("commandGoal reports a timeout as not-met", async () => {
  const g = commandGoal({ command: ["sh", "-c", "sleep 5"], cwd: process.cwd(), timeoutMs: 100 });
  const r = await g();
  expect(r.met).toBe(false);
  expect(r.detail.toLowerCase()).toContain("timed out");
});

test("judgeGoal is met when the worker votes DONE", async () => {
  const check = judgeGoal({
    criteria: "docs match",
    cwd: "/p",
    run: async (_o, h) => {
      h.onMessage("looks consistent\nVERDICT: DONE — docs in sync");
      return okRun("");
    },
  });
  const r = await check();
  expect(r.met).toBe(true);
  expect(r.detail.toLowerCase()).toContain("done");
});

test("judgeGoal continues when the worker votes CONTINUE", async () => {
  const check = judgeGoal({
    criteria: "docs match",
    cwd: "/p",
    run: async (_o, h) => {
      h.onMessage("VERDICT: CONTINUE — README is stale");
      return okRun("");
    },
  });
  expect((await check()).met).toBe(false);
});

test("judgeGoal defaults to not-met when the verdict is unparseable", async () => {
  const check = judgeGoal({ criteria: "x", cwd: "/p", run: async () => okRun("I am unsure") });
  expect((await check()).met).toBe(false);
});

test("judgeGoal runs the worker read-only (denies Write/Edit/Bash)", async () => {
  let captured: { disallowedTools?: string[] } | undefined;
  const check = judgeGoal({
    criteria: "x",
    cwd: "/p",
    run: async (_o, _h, deps) => {
      captured = deps;
      return okRun("VERDICT: CONTINUE");
    },
  });
  await check();
  expect(captured?.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
});

test("makeGoalCheck dispatches to the judge for kind:judge", async () => {
  const check = makeGoalCheck(
    { kind: "judge", criteria: "x" },
    { cwd: "/p", run: async (_o, h) => (h.onMessage("VERDICT: DONE"), okRun("")) },
  );
  expect((await check()).met).toBe(true);
});
