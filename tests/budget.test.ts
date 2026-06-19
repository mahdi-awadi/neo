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
