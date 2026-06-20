import { test, expect } from "bun:test";
import { handleLoop, startLoop, matchLoop, listLoops } from "../src/engine/loops";
import type { RunResult } from "../src/engine/session-runner";

const okRun = (sid = "s"): RunResult => ({ ok: true, sessionId: sid, summary: "", costUsd: 0 });

test("matchLoop normalizes '<project> <goal>' and finds the loop", () => {
  expect(matchLoop("gold gofmt")?.name).toBe("gold-gofmt");
  expect(matchLoop("gold-gofmt")?.name).toBe("gold-gofmt");
  expect(matchLoop("GOLD   GOFMT")?.name).toBe("gold-gofmt"); // case + extra spaces
  expect(matchLoop("nope")).toBeUndefined();
});

test("listLoops returns the available loops with name/usage/summary", () => {
  const ls = listLoops();
  const gofmt = ls.find((l) => l.name === "gold-gofmt");
  expect(gofmt).toBeTruthy();
  expect(gofmt?.usage).toContain("/loop");
  expect(typeof gofmt?.summary).toBe("string");
});

test("handleLoop ignores non-loop text", () => {
  expect(handleLoop("hello there", 1, { reply: () => {} })).toBe(false);
  expect(handleLoop("/list", 1, { reply: () => {} })).toBe(false);
});

test("/loop with no args lists the available loops", () => {
  const replies: string[] = [];
  expect(handleLoop("/loop", 1, { reply: (_c, t) => void replies.push(t) })).toBe(true);
  expect(replies.join("\n").toLowerCase()).toContain("gold");
});

test("/loop with an unknown loop replies with the list", () => {
  const replies: string[] = [];
  handleLoop("/loop wat huh", 1, { reply: (_c, t) => void replies.push(t) });
  expect(replies.join("\n").toLowerCase()).toContain("gold");
});

test("startLoop runs the loop, streams progress, and reports the outcome", async () => {
  const replies: string[] = [];
  let ran = 0;
  let n = 0;
  const out = await startLoop(matchLoop("gold gofmt")!, 1, {
    reply: (_c, t) => void replies.push(t),
    run: async (_o, h) => {
      ran++;
      h.onMessage("formatting");
      return okRun();
    },
    check: async () => ({ met: n++ > 0, detail: `c${n}` }), // not met, then met
  });
  expect(out.met).toBe(true);
  expect(ran).toBe(1);
  expect(replies.some((r) => r.toLowerCase().includes("start"))).toBe(true);
  expect(replies.some((r) => r.toLowerCase().includes("goal met"))).toBe(true);
});
