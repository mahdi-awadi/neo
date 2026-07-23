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

test("delimiter injection rejected — text with \\n§ or starting with § is forbidden", () => {
  const dir = scratch();
  // Add a base entry first
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Base entry" }, 500).ok).toBe(true);
  const before = readMemoryFiles(dir).memory;

  // Try to add text containing the delimiter
  const r = applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Foo\n§ Bar" }, 500);
  expect(r).toEqual({ ok: false, error: "text contains the entry delimiter" });
  expect(readMemoryFiles(dir).memory).toEqual(before); // File unchanged

  // Try to add text starting with §
  const r2 = applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "§ Bad" }, 500);
  expect(r2).toEqual({ ok: false, error: "text contains the entry delimiter" });
  expect(readMemoryFiles(dir).memory).toEqual(before); // File unchanged
});

test("empty text rejected — add/replace with empty or whitespace-only text errors", () => {
  const dir = scratch();
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "" }, 500))
    .toEqual({ ok: false, error: "empty text" });
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "   " }, 500))
    .toEqual({ ok: false, error: "empty text" });

  // Add a base entry for replace test
  applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Base entry" }, 500);
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "replace", oldText: "Base", text: "" }, 500))
    .toEqual({ ok: false, error: "empty text" });
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "replace", oldText: "Base", text: "\t" }, 500))
    .toEqual({ ok: false, error: "empty text" });
});

test("empty match text rejected — replace/remove with empty oldText errors", () => {
  const dir = scratch();
  applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Single entry" }, 500);

  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "replace", oldText: "", text: "new" }, 500))
    .toEqual({ ok: false, error: "empty match text" });
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "replace", oldText: "  ", text: "new" }, 500))
    .toEqual({ ok: false, error: "empty match text" });

  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "remove", oldText: "" }, 500))
    .toEqual({ ok: false, error: "empty match text" });
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "remove", oldText: "\n" }, 500))
    .toEqual({ ok: false, error: "empty match text" });

  // Verify the entry still exists and file is unchanged
  expect(readMemoryFiles(dir).memory).toContain("Single entry");
});

test("replace replaces the whole entry, not partial occurrences", () => {
  const dir = scratch();
  applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "uses Bun and Bun tooling" }, 500);

  // Replace with oldText: "Bun" should replace the entire entry with "uses Node"
  expect(applyMemoryOp(dir, "MEMORY.md", { kind: "replace", oldText: "Bun", text: "uses Node" }, 500).ok).toBe(true);

  const result = readMemoryFiles(dir).memory;
  expect(result).toContain("uses Node");
  expect(result).not.toContain("uses Bun and Bun tooling");
  expect(result).not.toContain("tooling"); // No residual text
});
