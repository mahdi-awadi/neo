import { test, expect } from "bun:test";
import { runLoop } from "../src/engine/loop-runner";
import { runProjectLoop } from "../src/engine/project-loop";

test("runLoop passes each resumeId through gateResume; undefined verdict starts fresh", async () => {
  const seen: (string | undefined)[] = [];
  let met = false;
  await runLoop({
    maxIterations: 3,
    check: async () => ({ met, detail: "" }),
    gateResume: async (id) => (id === "s1" ? undefined : id), // drop the first session's context
    iterate: async (resumeId, n) => {
      seen.push(resumeId);
      if (n === 3) met = true;
      return { sessionId: `s${n}`, summary: "" };
    },
  });
  expect(seen).toEqual([undefined, undefined, "s2"]); // s1 was gated away → iteration 2 fresh
});

test("runProjectLoop forwards runDeps to every run and freshSession never resumes", async () => {
  const deps: unknown[] = [];
  const resumes: (string | undefined)[] = [];
  let calls = 0;
  await runProjectLoop(
    {
      folder: "/tmp", prompt: "p", freshSession: true,
      runDeps: { model: "sonnet", skills: [] },
      goal: { kind: "command", command: ["true"] },
      bounds: { maxIterations: 2 },
    },
    {
      check: async () => ({ met: ++calls > 2, detail: "" }),
      run: async (_o, _h, d) => {
        deps.push(d); resumes.push((d as { resume?: string }).resume);
        return { ok: true, sessionId: `s${calls}`, summary: "", costUsd: 0 };
      },
    },
  );
  expect(resumes).toEqual([undefined, undefined]);              // freshSession: no resume ever
  expect((deps[0] as { model?: string }).model).toBe("sonnet"); // runDeps reach the worker
});
