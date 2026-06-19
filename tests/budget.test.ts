import { test, expect } from "bun:test";
import { createMeter } from "../src/engine/budget";

test("meter does not throttle before spend reaches the non-reserved budget", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // available = $8
  m.note({ costUsd: 5 });
  expect(m.shouldThrottle()).toBe(false);
});

test("meter throttles once background spend exhausts the non-reserved budget", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // available = $8
  m.note({ costUsd: 5 });
  m.note({ costUsd: 3.5 }); // total 8.5 >= 8
  expect(m.shouldThrottle()).toBe(true);
});

test("a larger interactive reserve throttles background work sooner", () => {
  const m = createMeter({ windowBudgetUsd: 10, reservePct: 0.5 }); // available = $5
  m.note({ costUsd: 5 });
  expect(m.shouldThrottle()).toBe(true);
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
  expect(m.shouldThrottle(500)).toBe(true); // both in window: 12 >= 8
  m.note({ costUsd: 1 }, 1400);
  // at t=1400 the cutoff is 400: the t=0 charge has rolled off, t=500 and t=1400 remain.
  expect(m.spent(1400)).toBe(7);
  expect(m.shouldThrottle(1400)).toBe(false); // 7 < 8
});
