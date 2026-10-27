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

test("commandGoal reports a missing cwd as not-met, never throws (folder deleted → Bun.spawn ENOENT)", async () => {
  const g = commandGoal({ command: ["sh", "-c", "false"], cwd: "/home/definitely-does-not-exist-xyz" });
  const r = await g(); // must NOT throw
  expect(r.met).toBe(false);
  expect(r.detail.toLowerCase()).toContain("spawn");
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

test("commandGoal keeps the whole stdout as output, capped (ADR-0045)", async () => {
  const g = commandGoal({ command: ["sh", "-c", "printf 'line one\\nline two\\n'; exit 0"], cwd: process.cwd() });
  const r = await g();
  expect(r).toEqual({ met: true, detail: "exit 0: line two", output: "line one\nline two" });
  const big = await commandGoal({ command: ["sh", "-c", "head -c 9000 /dev/zero | tr '\\0' x"], cwd: process.cwd() })();
  expect(big.output?.length).toBe(4000);
});

test("judgeGoal reports the judge run's cost, so a loop's budget counts it", async () => {
  const check = judgeGoal({
    criteria: "x",
    cwd: "/p",
    run: async (_o, h) => {
      h.onMessage("VERDICT: CONTINUE — not yet");
      return { ok: true, sessionId: "s", summary: "", costUsd: 0.42 };
    },
  });
  expect((await check()).costUsd).toBe(0.42);
});

test("judgeGoal honours timeoutMs: it aborts the judge run and is not met", async () => {
  let aborted = false;
  const check = judgeGoal({
    criteria: "x",
    cwd: "/p",
    timeoutMs: 20,
    run: (_o, _h, deps) =>
      new Promise((resolve) => {
        deps?.abortController?.signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ ok: false, sessionId: "s", summary: "aborted", costUsd: 0.1 });
        });
      }),
  });
  const r = await check();
  expect(aborted).toBe(true);
  expect(r.met).toBe(false);
  expect(r.detail).toContain("timed out after 20ms");
  expect(r.costUsd).toBe(0.1);
});

test("judgeGoal keeps the caller's runDeps and adds only the abort", async () => {
  let seen: unknown;
  const check = judgeGoal({
    criteria: "x",
    cwd: "/p",
    timeoutMs: 1000,
    runDeps: { disallowedTools: ["Write"] },
    run: async (_o, h, deps) => {
      seen = deps?.disallowedTools;
      h.onMessage("VERDICT: DONE — ok");
      return okRun("");
    },
  });
  expect((await check()).met).toBe(true);
  expect(seen).toEqual(["Write"]);
});
