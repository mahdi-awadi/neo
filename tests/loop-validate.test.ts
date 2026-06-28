import { test, expect } from "bun:test";
import { validateLoopInput, type LoopInput } from "../src/engine/loop-validate";

const base = (over: Partial<LoopInput> = {}): LoopInput => ({
  name: "Nightly Fmt",
  summary: "format nightly",
  folder: "/home/proj",
  prompt: "run fmt",
  goalKind: "command",
  goalCommand: "gofmt -l .",
  triggerKind: "cron",
  cronExpr: "0 4 * * *",
  maxIterations: 3,
  ...over,
});
const opts = { existingNames: ["green"], folderOk: () => true };

test("valid input builds a normalized LoopDef", () => {
  const r = validateLoopInput(base(), opts);
  expect("def" in r).toBe(true);
  if ("def" in r) {
    expect(r.def.name).toBe("nightly-fmt"); // slugified
    expect(r.def.usage).toBe("/loop nightly-fmt");
    expect(r.def.goal).toEqual({ kind: "command", command: ["sh", "-c", "gofmt -l ."], timeoutMs: 120000 });
    expect(r.def.trigger).toEqual({ kind: "cron", expr: "0 4 * * *" });
    expect(r.def.bounds.maxIterations).toBe(3);
  }
});

test("rejects blank name, duplicate name, bad folder", () => {
  expect(validateLoopInput(base({ name: "  " }), opts)).toEqual({ error: expect.stringContaining("name") });
  expect(validateLoopInput(base({ name: "green" }), opts)).toEqual({ error: expect.stringContaining("already exists") });
  expect(validateLoopInput(base(), { existingNames: [], folderOk: () => false })).toEqual({
    error: expect.stringContaining("/home"),
  });
});

test("goal kind requires its field", () => {
  expect(validateLoopInput(base({ goalKind: "command", goalCommand: "" }), opts)).toEqual({
    error: expect.stringContaining("command"),
  });
  expect(validateLoopInput(base({ goalKind: "judge", goalCriteria: "" }), opts)).toEqual({
    error: expect.stringContaining("criteria"),
  });
  const j = validateLoopInput(base({ goalKind: "judge", goalCriteria: "docs ok", goalCommand: undefined }), opts);
  expect("def" in j && j.def.goal).toEqual({ kind: "judge", criteria: "docs ok", timeoutMs: 120000 });
});

test("trigger kind requires its field; interval converts to ms", () => {
  expect(validateLoopInput(base({ triggerKind: "cron", cronExpr: "nope" }), opts)).toEqual({
    error: expect.stringContaining("cron"),
  });
  expect(validateLoopInput(base({ triggerKind: "interval", intervalMinutes: 0 }), opts)).toEqual({
    error: expect.stringContaining("interval"),
  });
  const iv = validateLoopInput(base({ triggerKind: "interval", intervalMinutes: 30, cronExpr: undefined }), opts);
  expect("def" in iv && iv.def.trigger).toEqual({ kind: "interval", everyMs: 1800000 });
});

test("bounds floors are enforced", () => {
  expect(validateLoopInput(base({ maxIterations: 0 }), opts)).toEqual({ error: expect.stringContaining("maxIterations") });
  expect(validateLoopInput(base({ budgetUsd: -1 }), opts)).toEqual({ error: expect.stringContaining("budgetUsd") });
});
