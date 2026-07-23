// Sentinel-guarded deterministic bootstrap: seed a folder's memory log from what the ledger
// (outcomes) and an existing HANDOFF.md already know, so a project's memory doesn't start empty.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { openMemoryIndex } from "../src/engine/memory-recall";
import { bootstrapMemory } from "../src/engine/memory-bootstrap";
import type { Order } from "../src/types";

const scratch = () => mkdtempSync(join(tmpdir(), "neo-bootstrap-"));

function order(over: Partial<Order> = {}): Order {
  return { id: "o1", source: "neo", folder: "/tmp", task: "t", chatId: 1, createdAt: 1000, ...over };
}

function seedOutcome(ledger: Ledger, id: string, folder: string, summary: string) {
  ledger.recordOrder(order({ id, folder }));
  ledger.recordOutcome(id, "done", summary);
}

const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

test("imports outcomes for this folder only, and they're searchable", () => {
  const folder = scratch();
  const other = scratch();
  const ledger = openLedger(":memory:");

  seedOutcome(ledger, "a", folder, "built the widget");
  seedOutcome(ledger, "b", folder, "fixed the login bug");
  seedOutcome(ledger, "c", other, "unrelated project work"); // different folder — must not import

  const result = bootstrapMemory(folder, ledger);
  expect(result).toEqual({ imported: 2, skipped: false });

  const logPath = join(folder, "memory", "log", `${todayStr()}.md`);
  expect(existsSync(logPath)).toBe(true);
  const content = readFileSync(logPath, "utf-8");
  expect(content).toContain("[bootstrap] built the widget");
  expect(content).toContain("[bootstrap] fixed the login bug");
  expect(content).not.toContain("unrelated project work");

  const hits = openMemoryIndex(folder).search("widget", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].content).toContain("built the widget");
});

test("imports each non-empty HANDOFF.md line into today's log", () => {
  const folder = scratch();
  const ledger = openLedger(":memory:");
  writeFileSync(
    join(folder, "HANDOFF.md"),
    "# Handoff\n\nDo the thing next.\nWatch out for the flaky test.\n\n",
  );

  const result = bootstrapMemory(folder, ledger);
  // 3 non-empty lines: "# Handoff", "Do the thing next.", "Watch out for the flaky test."
  expect(result).toEqual({ imported: 3, skipped: false });

  const logPath = join(folder, "memory", "log", `${todayStr()}.md`);
  const content = readFileSync(logPath, "utf-8");
  expect(content).toContain("[bootstrap] HANDOFF: Do the thing next.");
  expect(content).toContain("[bootstrap] HANDOFF: Watch out for the flaky test.");

  const hits = openMemoryIndex(folder).search("flaky", 5);
  expect(hits.length).toBeGreaterThan(0);
});

test("sentinel guards re-import: second call is a no-op, no duplicate index rows", () => {
  const folder = scratch();
  const ledger = openLedger(":memory:");
  seedOutcome(ledger, "a", folder, "built the widget");

  const first = bootstrapMemory(folder, ledger);
  expect(first).toEqual({ imported: 1, skipped: false });
  expect(existsSync(join(folder, "memory", ".bootstrapped"))).toBe(true);

  const beforeHits = openMemoryIndex(folder).search("widget", 10).length;
  const second = bootstrapMemory(folder, ledger);
  expect(second).toEqual({ imported: 0, skipped: true });
  const afterHits = openMemoryIndex(folder).search("widget", 10).length;
  expect(afterHits).toBe(beforeHits);
});

test("a scan-rejected outcome line is not counted and not written to disk", () => {
  const folder = scratch();
  const ledger = openLedger(":memory:");
  seedOutcome(ledger, "a", folder, "api_key: abcdef1234567890"); // trips the credential pattern

  const result = bootstrapMemory(folder, ledger);
  expect(result).toEqual({ imported: 0, skipped: false });

  const logPath = join(folder, "memory", "log", `${todayStr()}.md`);
  expect(existsSync(logPath)).toBe(false);

  // Sentinel still gets written — a run that finds nothing importable is still "bootstrapped".
  expect(existsSync(join(folder, "memory", ".bootstrapped"))).toBe(true);
});
