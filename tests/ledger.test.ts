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
