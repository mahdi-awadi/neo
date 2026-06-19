import { test, expect } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { sweepIdle } from "../src/engine/idle";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: "neo",
    folder: over.folder ?? "/p/a",
    task: "t",
    chatId: over.chatId ?? 1,
    createdAt: 1,
  };
}

function fakeControl() {
  let interrupted = false;
  return {
    followUp: () => {},
    interrupt: async () => void (interrupted = true),
    wasInterrupted: () => interrupted,
  };
}

test("sweepIdle closes a session idle past the threshold and persists its sdk id", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const o = order({ id: "a", folder: "/proj", chatId: 9 });
  led.recordOrder(o);
  reg.add(o, 0); // lastActivityAt = 0
  reg.setSdkSessionId(o.id, "sdk-a");
  const ctrl = fakeControl();
  reg.attachControl(o.id, ctrl);

  const closed = sweepIdle(reg, led, { idleMs: 1000, now: 2000 }); // 2000 - 0 > 1000

  expect(closed.map((c) => c.id)).toEqual(["a"]);
  expect(ctrl.wasInterrupted()).toBe(true);
  expect(reg.get("a")).toBeUndefined(); // removed from the live registry
  expect(led.lastSessionFor("/proj", 9)).toBe("sdk-a"); // persisted for resume
});

test("sweepIdle leaves a fresh session running", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const o = order({ id: "b" });
  reg.add(o, 1500);
  reg.attachControl(o.id, fakeControl());

  const closed = sweepIdle(reg, led, { idleMs: 1000, now: 2000 }); // 2000 - 1500 = 500 < 1000

  expect(closed).toEqual([]);
  expect(reg.get("b")?.status).toBe("running");
});

test("sweepIdle ignores already-closed sessions", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const o = order({ id: "c" });
  reg.add(o, 0);
  reg.setStatus(o.id, "done");
  reg.attachControl(o.id, fakeControl());

  const closed = sweepIdle(reg, led, { idleMs: 1000, now: 9999 });

  expect(closed).toEqual([]);
});
