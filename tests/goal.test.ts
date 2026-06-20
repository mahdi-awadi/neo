import { test, expect } from "bun:test";
import { commandGoal } from "../src/engine/goal";

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
