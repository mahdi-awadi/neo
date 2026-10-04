// 2026-07-25 issue 3: worker lines were fire-and-forget sends racing each other, and a Telegram 429
// silently dropped them. These pin the per-chat FIFO queue and the flood-control retry.
import { test, expect } from "bun:test";
import { HttpError } from "grammy";
import { createChatQueue, telegramRetryTransformer, sendOperatorLine } from "../src/frontends/telegram-delivery";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("lines to one chat are delivered strictly in call order, even when earlier sends are slower", async () => {
  const q = createChatQueue();
  const delivered: string[] = [];
  const slow = (text: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => (delivered.push(text), r()), ms));
  await Promise.all([q.run(1, slow("first", 20)), q.run(1, slow("second", 1)), q.run(1, slow("third", 5))]);
  expect(delivered).toEqual(["first", "second", "third"]);
});

test("a failed send does not stall the chat's queue", async () => {
  const q = createChatQueue();
  const delivered: string[] = [];
  const a = q.run(1, async () => {
    throw new Error("boom");
  });
  const b = q.run(1, async () => void delivered.push("after"));
  await expect(a).rejects.toThrow("boom");
  await b;
  expect(delivered).toEqual(["after"]);
});

test("different chats don't wait on each other", async () => {
  const q = createChatQueue();
  let release!: () => void;
  const blocked = q.run(1, () => new Promise<void>((r) => (release = r)));
  let otherDone = false;
  await q.run(2, async () => void (otherDone = true));
  expect(otherDone).toBe(true);
  release();
  await blocked;
});

test("a 429 is retried after Telegram's retry_after instead of being dropped", async () => {
  const sleeps: number[] = [];
  const t = telegramRetryTransformer({ sleep: async (ms) => void sleeps.push(ms) });
  let calls = 0;
  const prev = (async () => {
    calls++;
    if (calls < 3) return { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } };
    return { ok: true, result: { message_id: 9 } };
  }) as any;
  const res = await t(prev, "sendMessage" as any, { chat_id: 1, text: "hi" } as any);
  expect(res).toEqual({ ok: true, result: { message_id: 9 } } as any);
  expect(calls).toBe(3);
  expect(sleeps).toEqual([2000, 2000]);
});

test("a network failure is retried with backoff, then surfaces if it never recovers", async () => {
  const sleeps: number[] = [];
  const t = telegramRetryTransformer({ sleep: async (ms) => void sleeps.push(ms), maxRetries: 3 });
  let calls = 0;
  const prev = (async () => {
    calls++;
    throw new HttpError("Network request failed", new Error("ECONNRESET"));
  }) as any;
  await expect(t(prev, "sendMessage" as any, { chat_id: 1, text: "hi" } as any)).rejects.toThrow("Network");
  expect(calls).toBe(4); // first try + 3 retries
  expect(sleeps).toEqual([1000, 2000, 4000]);
});

test("other API errors (e.g. bad HTML) pass straight through for the caller's plain-text fallback", async () => {
  const t = telegramRetryTransformer({ sleep: async () => {} });
  let calls = 0;
  const bad = { ok: false, error_code: 400, description: "Bad Request: can't parse entities" };
  const res = await t((async () => (calls++, bad)) as any, "sendMessage" as any, { chat_id: 1, text: "<b" } as any);
  expect(res).toEqual(bad as any);
  expect(calls).toBe(1);
});

test("sendOperatorLine waits out a 429 and resends instead of dropping the loop line", async () => {
  const bodies: string[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const fetchFn = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    n++;
    if (n === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } }), { status: 429 });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as any;
  await sendOperatorLine("tok", 5, "loop finished", "waselni", { fetch: fetchFn, sleep: async (ms) => void sleeps.push(ms) });
  expect(n).toBe(2);
  expect(sleeps).toEqual([3000]);
  expect(JSON.parse(bodies[1]!).parse_mode).toBe("HTML"); // the retry is the same formatted send, not a downgrade
});

test("sendOperatorLine logs a line it finally can't deliver rather than dropping it silently", async () => {
  const logged: string[] = [];
  const fetchFn = (async () => {
    throw new Error("offline");
  }) as any;
  await sendOperatorLine("tok", 5, "the important bit", undefined, {
    fetch: fetchFn,
    sleep: async () => {},
    log: (m) => void logged.push(m),
  });
  expect(logged.some((l) => l.includes("the important bit"))).toBe(true);
});
