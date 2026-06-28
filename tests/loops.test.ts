import { test, expect } from "bun:test";
import { handleLoop, startLoop, matchLoop, listLoops, createLoop, updateLoop, deleteLoop, effectiveLoops } from "../src/engine/loops";
import { openLedger } from "../src/engine/ledger";
import type { LoopInput } from "../src/engine/loop-validate";
import type { RunResult } from "../src/engine/session-runner";

const okRun = (sid = "s"): RunResult => ({ ok: true, sessionId: sid, summary: "", costUsd: 0 });
const defMethods = { listLoopDefs: () => [], saveLoopDef: () => {}, deleteLoopDef: () => {} };
const cinput = (over: Partial<LoopInput> = {}): LoopInput => ({
  name: "nightly-fmt",
  summary: "fmt",
  folder: "/home/neo",
  prompt: "do it",
  goalKind: "command",
  goalCommand: "true",
  triggerKind: "cron",
  cronExpr: "0 4 * * *",
  maxIterations: 3,
  ...over,
});

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

test("/loop <name> on enables a scheduled loop via the store", () => {
  const replies: string[] = [];
  const enabled = new Map<string, boolean>();
  const store = {
    getLastRun: () => undefined,
    setLastRun: () => {},
    isEnabled: (n: string) => enabled.get(n),
    setEnabled: (n: string, on: boolean) => void enabled.set(n, on),
    ...defMethods,
  };
  const handled = handleLoop("/loop docs-sweep on", 1, { reply: (_c, t) => void replies.push(t), store });
  expect(handled).toBe(true);
  expect(enabled.get("docs-sweep")).toBe(true);
  expect(replies.join("\n").toLowerCase()).toContain("on");
});

test("/loop <name> off disables it", () => {
  const enabled = new Map<string, boolean>([["docs-sweep", true]]);
  const store = {
    getLastRun: () => undefined,
    setLastRun: () => {},
    isEnabled: (n: string) => enabled.get(n),
    setEnabled: (n: string, on: boolean) => void enabled.set(n, on),
    ...defMethods,
  };
  handleLoop("/loop docs-sweep off", 1, { reply: () => {}, store });
  expect(enabled.get("docs-sweep")).toBe(false);
});

test("createLoop persists a custom loop that then appears in the merged set", () => {
  const led = openLedger(":memory:");
  const r = createLoop(cinput(), led);
  expect(r.ok).toBe(true);
  expect(matchLoop("nightly-fmt", led)?.name).toBe("nightly-fmt");
  expect(effectiveLoops(led).some((l) => l.name === "nightly-fmt")).toBe(true);
  expect(listLoops(led).find((l) => l.name === "nightly-fmt")?.custom).toBe(true);
});

test("createLoop rejects a name that collides with a built-in", () => {
  const led = openLedger(":memory:");
  expect(createLoop(cinput({ name: "green" }), led).ok).toBe(false);
});

test("built-ins win over a custom row with the same name", () => {
  const led = openLedger(":memory:");
  led.saveLoopDef("green", JSON.stringify({ name: "green", folder: "/x", goal: {}, trigger: {}, bounds: {} }));
  expect(effectiveLoops(led).filter((l) => l.name === "green")).toHaveLength(1);
  expect(matchLoop("green", led)?.folder).toBe("/home/neo"); // the built-in, not the custom row
});

test("updateLoop and deleteLoop reject built-ins, accept custom", () => {
  const led = openLedger(":memory:");
  createLoop(cinput(), led);
  expect(updateLoop("green", cinput(), led).ok).toBe(false);
  expect(deleteLoop("green", led).ok).toBe(false);
  expect(updateLoop("nightly-fmt", cinput({ summary: "fmt v2" }), led).ok).toBe(true);
  expect(matchLoop("nightly-fmt", led)?.summary).toBe("fmt v2");
  expect(deleteLoop("nightly-fmt", led).ok).toBe(true);
  expect(matchLoop("nightly-fmt", led)).toBeUndefined();
});

test("effectiveLoops skips unparseable custom rows", () => {
  const led = openLedger(":memory:");
  led.saveLoopDef("broken", "{not json");
  expect(effectiveLoops(led).some((l) => l.name === "broken")).toBe(false);
});
