import { test, expect } from "bun:test";
import { handleLoop, startLoop, startScheduledLoop, matchLoop, listLoops, createLoop, updateLoop, deleteLoop, effectiveLoops, type LoopDef } from "../src/engine/loops";
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
  expect(matchLoop("docs sweep")?.name).toBe("docs-sweep");
  expect(matchLoop("docs-sweep")?.name).toBe("docs-sweep");
  expect(matchLoop("DOCS   SWEEP")?.name).toBe("docs-sweep"); // case + extra spaces
  expect(matchLoop("nope")).toBeUndefined();
});

test("listLoops returns the available loops with name/usage/summary", () => {
  const ls = listLoops();
  const sweep = ls.find((l) => l.name === "docs-sweep");
  expect(sweep).toBeTruthy();
  expect(sweep?.usage).toContain("/loop");
  expect(typeof sweep?.summary).toBe("string");
});

test("handleLoop ignores non-loop text", () => {
  expect(handleLoop("hello there", 1, { reply: () => {} })).toBe(false);
  expect(handleLoop("/list", 1, { reply: () => {} })).toBe(false);
});

test("/loop with no args lists the available loops", () => {
  const replies: string[] = [];
  expect(handleLoop("/loop", 1, { reply: (_c, t) => void replies.push(t) })).toBe(true);
  expect(replies.join("\n").toLowerCase()).toContain("green");
});

test("/loop with an unknown loop replies with the list", () => {
  const replies: string[] = [];
  handleLoop("/loop wat huh", 1, { reply: (_c, t) => void replies.push(t) });
  expect(replies.join("\n").toLowerCase()).toContain("green");
});

test("startLoop runs the loop, streams progress, and reports the outcome", async () => {
  const replies: string[] = [];
  let ran = 0;
  let n = 0;
  const out = await startLoop(matchLoop("green")!, 1, {
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

// A fire-once reminder-style scheduled loop (like a nightly hearings reminder): one iteration,
// goal never met on its own, folder under /home so its project tag is the basename.
const remLoop = (folder = "/home/acme"): LoopDef => ({
  name: "rem",
  usage: "/loop rem",
  summary: "reminder",
  folder,
  prompt: "check hearings",
  goal: { kind: "command", command: ["sh", "-c", "false"] },
  trigger: { kind: "cron", expr: "0 4 * * *" },
  bounds: { maxIterations: 1 },
});

test("startScheduledLoop forwards worker text to the operator channel tagged with the loop's project, no chrome", async () => {
  const replies: Array<{ chatId: number; text: string; project?: string }> = [];
  const out = await startScheduledLoop(remLoop(), {
    chatId: 4242,
    reply: (chatId, text, project) => void replies.push({ chatId, text, project }),
    run: async (_o, h) => {
      h.onMessage("You have a hearing tomorrow at 9am (case #123).");
      return okRun();
    },
    check: async () => ({ met: false, detail: "no hearings check" }),
  });
  expect(out.iterations).toBe(1);
  // Exactly the worker's line reaches the operator, tagged with the folder-derived project.
  expect(replies).toEqual([
    { chatId: 4242, text: "You have a hearing tomorrow at 9am (case #123).", project: "acme" },
  ]);
  // No starting / iteration / outcome chrome — only real worker output.
  expect(replies.some((r) => /start|iteration|goal met|⚠️|🔁/i.test(r.text))).toBe(false);
});

test("startScheduledLoop stays silent when the worker produces no text (silent success)", async () => {
  const replies: string[] = [];
  await startScheduledLoop(remLoop(), {
    chatId: 1,
    reply: (_c, t) => void replies.push(t),
    run: async () => okRun(), // worker emits no assistant text
    check: async () => ({ met: false, detail: "" }),
  });
  expect(replies).toEqual([]); // nothing forwarded → no per-iteration spam
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
  expect(matchLoop("green", led)?.folder).toBe(process.cwd()); // the built-in (self-repo), not the custom row
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
