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
