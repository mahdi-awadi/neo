import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMemoryOp, memoryCaps, readMemoryFiles, CHARS_PER_TOKEN } from "../src/engine/memory";

const scratch = () => mkdtempSync(join(tmpdir(), "neo-mem-"));
const CFG = { scopes: ["company"], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 };

test("caps derive from the window as ratios (no fixed absolutes)", () => {
  const caps = memoryCaps(CFG, 200_000);
  expect(caps.memoryChars).toBe(200_000 * 0.004 * CHARS_PER_TOKEN); // = 3,200 chars ≈ 800 tokens
  expect(caps.userChars).toBe(200_000 * 0.0025 * CHARS_PER_TOKEN);  // = 2,000 chars ≈ 500 tokens
});

test("add/replace/remove with dup, ambiguity, no-match, and over-cap errors", () => {
  const dir = scratch();
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Runs Bun on Linux" }, 500).ok).toBe(true);
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Runs Bun on Linux" }, 500)).toEqual({ ok: false, error: "duplicate entry" });
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "replace", oldText: "Bun", text: "Runs Bun 1.3 on Linux" }, 500).ok).toBe(true);
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "remove", oldText: "nope" }, 500)).toEqual({ ok: false, error: "no match" });
  applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Linux box A" }, 500);
  expect((applyMemoryOp(dir, "MEMORY.md", { kind: "replace", oldText: "Linux", text: "x" }, 500) as { error: string }).error).toBe("ambiguous match");
  const big = "y".repeat(600);
  const r = applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: big }, 500);
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toContain("over capacity");
  expect(readMemoryFiles(dir).memory).toContain("Runs Bun 1.3 on Linux"); // failed ops never partially write
});
