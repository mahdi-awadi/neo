import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return { id: "o1", source: "neo", folder: "/tmp", task: "t", chatId: 1, createdAt: 1000, ...over };
}

test("recordOrder then listRecent returns the order with its fields", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", task: "build x", folder: "/p", chatId: 7, createdAt: 5 }));
  const recent = led.listRecent();
  expect(recent).toEqual([
    { id: "a", source: "neo", folder: "/p", task: "build x", chatId: 7, createdAt: 5 },
  ]);
});

test("listRecent returns most-recent first and respects the limit", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", createdAt: 1 }));
  led.recordOrder(order({ id: "b", createdAt: 2 }));
  led.recordOrder(order({ id: "c", createdAt: 3 }));
  expect(led.listRecent(2).map((o) => o.id)).toEqual(["c", "b"]);
});

test("message routes persist (chat,message) -> session/folder/project and read back", () => {
  const led = openLedger(":memory:");
  led.rememberRoute(5, 100, { sessionId: "sess-a", folder: "/home/acme", project: "acme" });
  expect(led.routeFor(5, 100)).toEqual({ sessionId: "sess-a", folder: "/home/acme", project: "acme" });
  expect(led.routeFor(5, 999)).toBeUndefined(); // unknown message id
  expect(led.routeFor(6, 100)).toBeUndefined(); // right message id, wrong chat
});

test("rememberRoute upserts on the same (chat,message) key", () => {
  const led = openLedger(":memory:");
  led.rememberRoute(1, 7, { sessionId: "old", folder: "/home/x", project: "x" });
  led.rememberRoute(1, 7, { sessionId: "new", folder: "/home/y", project: "y" });
  expect(led.routeFor(1, 7)?.sessionId).toBe("new");
});

test("recordOutcome is retrievable via getOutcome", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a" }));
  led.recordOutcome("a", "done", "added function");
  expect(led.getOutcome("a")).toEqual({ status: "done", summary: "added function" });
});

test("recordSession persists the SDK session id for an order; lastSessionFor reads it back", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/proj", chatId: 9 }));
  led.recordSession("a", "sdk-123");
  expect(led.lastSessionFor("/proj", 9)).toBe("sdk-123");
});

test("lastSessionFor returns the most recent session id for a folder/chat", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/proj", chatId: 9, createdAt: 1 }));
  led.recordOrder(order({ id: "b", folder: "/proj", chatId: 9, createdAt: 2 }));
  led.recordSession("a", "sdk-old");
  led.recordSession("b", "sdk-new");
  expect(led.lastSessionFor("/proj", 9)).toBe("sdk-new");
});

test("lastSessionFor is undefined when no session was recorded for that folder/chat", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/proj", chatId: 9 }));
  expect(led.lastSessionFor("/proj", 9)).toBeUndefined();
  expect(led.lastSessionFor("/other", 9)).toBeUndefined();
});

test("records conversation messages and reads them back chronologically per chat", () => {
  const led = openLedger(":memory:");
  led.recordMessage(7, "user", "do the thing");
  led.recordMessage(7, "assistant", "doing work");
  led.recordMessage(7, "assistant", "done");
  led.recordMessage(8, "user", "a different conversation");
  expect(led.conversation(7).map((m) => [m.role, m.content])).toEqual([
    ["user", "do the thing"],
    ["assistant", "doing work"],
    ["assistant", "done"],
  ]);
  expect(led.conversation(8).map((m) => m.content)).toEqual(["a different conversation"]);
  expect(led.conversation(9)).toEqual([]);
});

test("conversation(limit) returns the most recent N messages, still oldest-first", () => {
  const led = openLedger(":memory:");
  for (let i = 1; i <= 5; i++) led.recordMessage(1, "user", `m${i}`);
  expect(led.conversation(1, 2).map((m) => m.content)).toEqual(["m4", "m5"]);
});

test("records and reads auto-approvals for an order", () => {
  const led = openLedger(":memory:");
  led.recordAutoApproval("o1", "risky shell command: git push");
  led.recordAutoApproval("o1", "risky shell command: rm -rf build");
  expect(led.autoApprovalsFor("o1")).toEqual([
    "risky shell command: git push",
    "risky shell command: rm -rf build",
  ]);
  expect(led.autoApprovalsFor("o2")).toEqual([]);
});

test("context events record + list, and clearSessionsFor wipes resume targets", () => {
  const l = openLedger(":memory:");
  l.recordContextEvent("/p/gold", "handoff", 0.71, 123);
  expect(l.listContextEvents()[0]).toMatchObject({ folder: "/p/gold", verdict: "handoff", occupancy: 0.71, at: 123 });
  const o = order({ id: "o9", folder: "/p/gold", chatId: 5 });
  l.recordOrder(o);
  l.recordSession("o9", "sess-9");
  expect(l.lastSessionFor("/p/gold", 5)).toBe("sess-9");
  l.clearSessionsFor("/p/gold");
  expect(l.lastSessionFor("/p/gold", 5)).toBeUndefined();
});

test("cache observations record + list, newest-first, capped by limit", () => {
  const l = openLedger(":memory:");
  l.recordCacheObservation(10 * 60_000, true);
  l.recordCacheObservation(70 * 60_000, false);
  const rows = l.listCacheObservations(50);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ gapMs: 70 * 60_000, hit: false }); // newest first
  expect(rows[1]).toMatchObject({ gapMs: 10 * 60_000, hit: true });
  for (let i = 0; i < 5; i++) l.recordCacheObservation(i, true);
  expect(l.listCacheObservations(3)).toHaveLength(3);
});
