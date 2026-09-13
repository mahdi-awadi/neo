import { test, expect } from "bun:test";
import { createMeter, heldByReserve, DEFAULT_WORK_CLASS } from "../src/engine/budget";

test("meter does not throttle before spend reaches the non-reserved budget", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // available = $8
  m.note({ costUsd: 5 });
  expect(m.shouldThrottleBackground()).toBe(false);
});

test("meter throttles once background spend exhausts the non-reserved budget", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // available = $8
  m.note({ costUsd: 5 });
  m.note({ costUsd: 3.5 }); // total 8.5 >= 8
  expect(m.shouldThrottleBackground()).toBe(true);
});

test("a larger interactive reserve throttles background work sooner", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.5 }); // available = $5
  m.note({ costUsd: 5 });
  expect(m.shouldThrottleBackground()).toBe(true);
});

test("spent and remaining report the budget for /status", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // available = $8
  m.note({ costUsd: 3 });
  expect(m.spent()).toBe(3);
  expect(m.remaining()).toBe(5); // 8 available - 3 spent
});

test("charges outside the rolling window roll off (no permanent throttle)", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2, windowMs: 1000 }); // available = $8
  m.note({ costUsd: 6 }, 0);
  m.note({ costUsd: 6 }, 500);
  expect(m.shouldThrottleBackground(500)).toBe(true); // both in window: 12 >= 8
  m.note({ costUsd: 1 }, 1400);
  // at t=1400 the cutoff is 400: the t=0 charge has rolled off, t=500 and t=1400 remain.
  expect(m.spent(1400)).toBe(7);
  expect(m.shouldThrottleBackground(1400)).toBe(false); // 7 < 8
});

// Work class follows the ORIGINATING TRIGGER (ADR 0001 follow-up). `heldByReserve` is the ONE
// place that answers "does the interactive reserve apply to this work?", so no call site has to
// re-derive it — and an interactive answer can never be produced from the meter alone.
test("the reserve never holds interactive work, however far over the allowance", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // allowance $8
  m.note({ costUsd: 42 });
  expect(m.shouldThrottleBackground()).toBe(true); // the window IS spent
  expect(heldByReserve("interactive", m)).toBe(false); // …and it still does not hold the operator
});

test("the reserve holds background work once the allowance is spent", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 });
  m.note({ costUsd: 42 });
  expect(heldByReserve("background", m)).toBe(true);
});

test("background work under the allowance is not held", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 });
  m.note({ costUsd: 1 });
  expect(heldByReserve("background", m)).toBe(false);
});

test("work that states no class is BACKGROUND (fail-safe: a forgotten wiring can only over-protect)", () => {
  expect(DEFAULT_WORK_CLASS).toBe("background");
});
