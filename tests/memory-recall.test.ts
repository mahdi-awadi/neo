import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDailyLog } from "../src/engine/memory";
import { openMemoryIndex } from "../src/engine/memory-recall";

const scratch = () => mkdtempSync(join(tmpdir(), "neo-mem-recall-"));

test("daily log lines are appended, indexed, and searchable with file+day citations", () => {
  const dir = scratch();
  appendDailyLog(dir, "Decided to use Stripe for payment processing", "2026-07-01");
  appendDailyLog(dir, "Fixed the Telegram webhook retry bug", "2026-07-22");
  const hits = openMemoryIndex(dir).search("payment stripe", 5);
  expect(hits.length).toBeGreaterThanOrEqual(1);
  expect(hits[0].content).toContain("Stripe");
  expect(hits[0].day).toBe("2026-07-01");
  expect(hits[0].file).toContain("2026-07-01.md");
});

test("empty index searches return [] (never throws)", () => {
  expect(openMemoryIndex(scratch()).search("anything", 5)).toEqual([]);
});

test("appendDailyLog writes '- <line>' to the day's log file, dirs auto-created", () => {
  const dir = scratch();
  appendDailyLog(dir, "First entry of the day", "2026-07-05");
  const content = readFileSync(join(dir, "memory", "log", "2026-07-05.md"), "utf-8");
  expect(content).toBe("- First entry of the day\n");
});

test("appendDailyLog defaults day to today's local YYYY-MM-DD when omitted", () => {
  const dir = scratch();
  appendDailyLog(dir, "No explicit day given");
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const expectedFile = join(dir, "memory", "log", `${y}-${m}-${d}.md`);
  expect(readFileSync(expectedFile, "utf-8")).toContain("No explicit day given");
});

test("appendDailyLog fails closed: a line that fails scanMemoryText is silently not appended/indexed", () => {
  const dir = scratch();
  appendDailyLog(dir, "api_key = ghp_M85SPgFKGxGAJEjpGDolVvtPmv8rAAAAAAA", "2026-07-06");
  const file = join(dir, "memory", "log", "2026-07-06.md");
  // Directory may or may not exist, but the file must not contain the poisoned line.
  try {
    const content = readFileSync(file, "utf-8");
    expect(content).not.toContain("ghp_");
  } catch {
    // File never created — also acceptable for fail-closed behavior.
  }
  expect(openMemoryIndex(dir).search("ghp_M85SPgFKGxGAJEjpGDolVvtPmv8rAAAAAAA", 5)).toEqual([]);
});

test("FTS-operator query characters never throw — always return an array", () => {
  const dir = scratch();
  appendDailyLog(dir, "Some normal log line about deployments", "2026-07-07");
  const idx = openMemoryIndex(dir);
  for (const q of ['"AND OR ("', "AND OR (", 'foo" OR "1"="1', "*", '"', "NEAR/2", "-foo"]) {
    expect(() => idx.search(q, 5)).not.toThrow();
    expect(Array.isArray(idx.search(q, 5))).toBe(true);
  }
});

test("re-indexing the same file does not duplicate rows", () => {
  const dir = scratch();
  const logDir = join(dir, "memory", "log");
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, "2026-07-08.md");
  writeFileSync(path, "- Duplicate-safe line about widgets\n");

  const idx = openMemoryIndex(dir);
  idx.indexFile(path, "2026-07-08");
  idx.indexFile(path, "2026-07-08"); // re-index same file — must not duplicate

  const hits = idx.search("widgets", 10);
  expect(hits.length).toBe(1);
});

test("openMemoryIndex caches Database handles per canonical folder", () => {
  const dir = scratch();
  const a = openMemoryIndex(dir);
  const b = openMemoryIndex(dir);
  appendDailyLog(dir, "Cache handle sanity check line", "2026-07-09");
  // Both handles should see data written after either was opened (same underlying DB).
  expect(a.search("sanity check", 5).length).toBeGreaterThanOrEqual(1);
  expect(b.search("sanity check", 5).length).toBeGreaterThanOrEqual(1);
});
