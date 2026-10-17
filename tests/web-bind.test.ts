import { test, expect } from "bun:test";
import { keepBinding } from "../src/frontends/web";

/** A manual timer: the test fires each scheduled retry itself, so no real waiting. */
function manualTimer() {
  const queue: { fn: () => void; ms: number }[] = [];
  return {
    queue,
    schedule: (fn: () => void, ms: number) => { queue.push({ fn, ms }); return queue.length; },
    cancel: () => { queue.length = 0; },
    fire: () => queue.shift()!.fn(),
  };
}

test("a failed bind does not throw — it is reported and retried until it works", () => {
  const t = manualTimer();
  const failures: unknown[] = [];
  let bound: string | undefined;
  let tries = 0;
  const bind = () => {
    tries++;
    if (tries < 3) throw new Error("Failed to start server. Is port 3003 in use?");
    return "server";
  };

  expect(() => keepBinding(bind, { retryMs: 5000, onFail: (e) => failures.push(e), onBound: (s) => { bound = s; }, schedule: t.schedule, cancel: t.cancel })).not.toThrow();
  expect(failures.length).toBe(1);
  expect(t.queue[0]!.ms).toBe(5000);
  expect(bound).toBeUndefined();

  t.fire();
  expect(failures.length).toBe(2);
  t.fire();
  expect(bound).toBe("server");
  expect(t.queue.length).toBe(0); // bound: nothing left scheduled
});

test("a bind that works first time reports nothing and schedules nothing", () => {
  const t = manualTimer();
  let bound: string | undefined;
  keepBinding(() => "server", { retryMs: 5000, onFail: () => { throw new Error("must not fail"); }, onBound: (s) => { bound = s; }, schedule: t.schedule, cancel: t.cancel });
  expect(bound).toBe("server");
  expect(t.queue.length).toBe(0);
});

test("stop() cancels a pending retry (shutdown never leaves a bind loop behind)", () => {
  const t = manualTimer();
  const handle = keepBinding(() => { throw new Error("no address"); }, { retryMs: 5000, onFail: () => {}, onBound: () => {}, schedule: t.schedule, cancel: t.cancel });
  expect(t.queue.length).toBe(1);
  handle.stop();
  expect(t.queue.length).toBe(0);
});
