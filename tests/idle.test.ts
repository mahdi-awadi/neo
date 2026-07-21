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

test("sweepIdle writes a state note for each session it idle-closes", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const o = order({ id: "a", folder: "/proj", chatId: 9 });
  reg.add(o, 0);
  reg.setSdkSessionId(o.id, "sdk-a");
  reg.attachControl(o.id, fakeControl());
  const noted: string[] = [];

  sweepIdle(reg, led, { idleMs: 1000, now: 2000, writeStateNote: (s) => noted.push(s.id) });

  expect(noted).toEqual(["a"]); // captured where it left off before the close
});

test("sweepIdle does NOT write a state note for still-running or terminal-reaped sessions", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  reg.add(order({ id: "fresh" }), 1500); // not idle yet
  const dead = order({ id: "dead", folder: "/p/dead" });
  reg.add(dead, 0);
  reg.setStatus(dead.id, "error"); // terminal leftover — reaped, not "closed"
  const noted: string[] = [];

  sweepIdle(reg, led, { idleMs: 1000, now: 2000, writeStateNote: (s) => noted.push(s.id) });

  expect(noted).toEqual([]);
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

test("sweepIdle reaps terminal (error/done) leftovers so they never accumulate as zombies", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const bad = order({ id: "z1", folder: "/p/waselni" });
  reg.add(bad, 0);
  reg.setStatus(bad.id, "error"); // e.g. a timed-out dispatch from an older engine version
  const done = order({ id: "z2", folder: "/p/other" });
  reg.add(done, 0);
  reg.setStatus(done.id, "done");

  sweepIdle(reg, led, { idleMs: 1000, now: 2000 });

  expect(reg.get("z1")).toBeUndefined();
  expect(reg.get("z2")).toBeUndefined();
});

test("sweepIdle never closes the default project, however old", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  reg.add(o, 0); // lastActivityAt = 0 (ancient)
  reg.setStatus(o.id, "idle");
  reg.setDefault(o.id);
  reg.attachControl(o.id, fakeControl());

  const closed = sweepIdle(reg, led, { idleMs: 1000, now: 9_999_999 });

  expect(closed).toEqual([]);
  expect(reg.get("company")).toBeDefined(); // still registered
  expect(reg.getDefault()?.id).toBe("company");
});
