// Review fix (ADR-0010): when long polling stops for good — a revoked token (401) or a second poller
// on the same token (409) — the daemon can no longer hear the operator, so it exits for the
// supervisor. Anything else that stops polling (a network error on the startup getMe) is
// recoverable: reported, then polling restarts after a backoff. The process stays up.
import { expect, test } from "bun:test";
import { GrammyError } from "grammy";
import { pollingStopIsUnrecoverable, superviseTelegramPolling } from "../src/frontends/telegram";

const grammyError = (code: number) =>
  new GrammyError(`Call to 'getUpdates' failed! (${code})`, { ok: false, error_code: code, description: "x" }, "getUpdates", {});

test("only 401 (revoked token) and 409 (second poller) are unrecoverable", () => {
  expect(pollingStopIsUnrecoverable(grammyError(401))).toBe(true);
  expect(pollingStopIsUnrecoverable(grammyError(409))).toBe(true);
  expect(pollingStopIsUnrecoverable(grammyError(429))).toBe(false);
  expect(pollingStopIsUnrecoverable(grammyError(500))).toBe(false);
  expect(pollingStopIsUnrecoverable(new Error("fetch failed"))).toBe(false);
});

function rig(outcomes: Array<"ok" | unknown>) {
  const calls = { start: 0, exit: [] as number[], reports: [] as unknown[], slept: [] as number[] };
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  superviseTelegramPolling(
    async () => {
      const o = outcomes[calls.start++];
      if (outcomes.length === calls.start) queueMicrotask(resolveDone);
      if (o === "ok") return;
      throw o;
    },
    {
      report: (e) => void calls.reports.push(e),
      exit: (code) => void calls.exit.push(code),
      sleep: async (ms) => void calls.slept.push(ms),
      retryMs: [1_000, 5_000],
    },
  );
  return { calls, done };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("a revoked token: reported, then exit(1) so the supervisor restarts Neo", async () => {
  const { calls } = rig([grammyError(401)]);
  await settle();
  expect(calls.reports).toHaveLength(1);
  expect(calls.exit).toEqual([1]);
  expect(calls.start).toBe(1);
});

test("a recoverable stop: reported, polling restarts after the backoff ladder, never exits", async () => {
  const { calls } = rig([new Error("fetch failed"), new Error("fetch failed"), new Error("fetch failed"), "ok"]);
  await settle();
  expect(calls.start).toBe(4);
  expect(calls.slept).toEqual([1_000, 5_000, 5_000]); // the last step repeats
  expect(calls.reports).toHaveLength(3);
  expect(calls.exit).toEqual([]);
});

test("a recoverable stop followed by a 409 still exits", async () => {
  const { calls } = rig([new Error("fetch failed"), grammyError(409)]);
  await settle();
  expect(calls.exit).toEqual([1]);
});

test("a clean stop (bot.stop at shutdown) neither restarts nor exits", async () => {
  const { calls } = rig(["ok"]);
  await settle();
  expect(calls.start).toBe(1);
  expect(calls.exit).toEqual([]);
  expect(calls.reports).toEqual([]);
});
