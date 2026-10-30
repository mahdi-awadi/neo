// ADR-0066 review: the per-session sliding-window limit that `remember` and the worker `history_search` use.
// A session over its limit is refused until its oldest entry leaves the window; a session with nothing in the
// window is dropped, so the map never grows with sessions that ended.
import { expect, test } from "bun:test";
import { createSessionLimiter } from "../src/engine/history/limiter";

test("refuses over the limit inside the window, allows again once the oldest entry leaves it", () => {
  const l = createSessionLimiter(2, 1_000);
  expect(l.allow("a", 0)).toBe(true);
  l.record("a", 0);
  l.record("a", 500);
  expect(l.allow("a", 900)).toBe(false);
  expect(l.allow("b", 900)).toBe(true);
  expect(l.allow("a", 1_000)).toBe(true);
});

test("sessions whose entries all left the window are dropped", () => {
  const l = createSessionLimiter(5, 1_000);
  for (let i = 0; i < 100; i++) l.record(`s${i}`, i);
  expect(l.size()).toBe(100);
  l.record("late", 5_000);
  expect(l.size()).toBe(1);
});
