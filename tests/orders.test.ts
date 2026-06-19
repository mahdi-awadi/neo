import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOrder } from "../src/engine/orders";

test("parseOrder extracts folder, task, source, and chatId from /open", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-orders-"));
  const result = parseOrder(`/open ${dir} build the login page`, "neo", 42);
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  expect(result.folder).toBe(dir);
  expect(result.task).toBe("build the login page");
  expect(result.source).toBe("neo");
  expect(result.chatId).toBe(42);
  expect(result.id.length).toBeGreaterThan(0);
  expect(result.createdAt).toBeGreaterThan(0);
});

test("parseOrder rejects a nonexistent folder", () => {
  const result = parseOrder("/open /no/such/neo/dir do something", "neo", 1);
  expect("error" in result).toBe(true);
});

test("parseOrder rejects when the task is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-orders-"));
  const result = parseOrder(`/open ${dir}`, "neo", 1);
  expect("error" in result).toBe(true);
});

test("parseOrder rejects a message that is not an /open command", () => {
  const result = parseOrder("hello there", "neo", 1);
  expect("error" in result).toBe(true);
});
