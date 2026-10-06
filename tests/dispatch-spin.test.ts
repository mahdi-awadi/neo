// P4 Task 4.3 (spec §8.1): a spinning dispatch is found by counting, not by AI — the same digest
// fingerprint N times in a row, or the same tool call N times in a row inside one turn.
import { test, expect } from "bun:test";
import { digestFingerprint, createSpinWatch } from "../src/engine/dispatch-report";

test("digestFingerprint: numbers, hex runs and absolute paths do not make a step look new", () => {
  const a = digestFingerprint("Bash: bun test /home/gold/tests/a.test.ts (run 3, 41s)", "fixing the fare list", "8694a46 feat: task 5");
  const b = digestFingerprint("Bash: bun test /home/gold/tests/b.test.ts (run 4, 97s)", "fixing the fare list", "8694a46 feat: task 5");
  expect(a).toBe(b);
  expect(digestFingerprint("Bash: bun test", "fixing the fare list", "9f1c2d0 feat: task 6")).not.toBe(digestFingerprint("Bash: bun test", "fixing the fare list", "8694a46 feat: task 5"));
  expect(digestFingerprint("Edit", "n", "h")).not.toBe(digestFingerprint("Bash", "n", "h"));
  expect(digestFingerprint("Edit", "note one", "h")).not.toBe(digestFingerprint("Edit", "note two", "h"));
});

test("the same fingerprint N times → spinning once; a 4th says nothing; a change resets", () => {
  const w = createSpinWatch({ digests: 3, toolLoopLimit: 8 });
  expect([w.digest("x").spinning, w.digest("x").spinning, w.digest("x").spinning, w.digest("x").spinning]).toEqual([false, false, true, false]);
  expect(w.digest("y")).toEqual({ spinning: false, changed: true });
  expect([w.digest("y").spinning, w.digest("y").spinning]).toEqual([false, true]);
});

test("the same (tool, input) toolLoopLimit times in one turn → once; a turn end resets the count", () => {
  const w = createSpinWatch({ digests: 3, toolLoopLimit: 3 });
  expect([w.tool("Bash", "h1"), w.tool("Bash", "h1"), w.tool("Bash", "h1"), w.tool("Bash", "h1")]).toEqual([false, false, true, false]);
  w.turnEnd();
  expect([w.tool("Bash", "h1"), w.tool("Bash", "h1")]).toEqual([false, false]);
  expect([w.tool("Bash", "h2"), w.tool("Read", "h2"), w.tool("Bash", "h2")]).toEqual([false, false, false]);
});
