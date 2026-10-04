import { describe, expect, test } from "bun:test";
import { createFloodGate, isToolStepLine, type ApiResult } from "../src/frontends/telegram-flood";

const OK: ApiResult = { ok: true };
const tooMany = (retryAfterSec: number): ApiResult => ({
  ok: false,
  error_code: 429,
  description: `Too Many Requests: retry after ${retryAfterSec}`,
  parameters: { retry_after: retryAfterSec },
});

function harness(maxWaitMs = 30_000) {
  let t = 1_000_000;
  const logs: string[] = [];
  const slept: number[] = [];
  const recovered: Array<{ chatId: number | string; dropped: number }> = [];
  const gate = createFloodGate({
    now: () => t,
    sleep: async (ms) => void slept.push(ms),
    log: (line) => void logs.push(line),
    maxWaitMs,
    onRecovered: (chatId, dropped) => void recovered.push({ chatId, dropped }),
  });
  return { gate, logs, slept, recovered, advance: (ms: number) => void (t += ms) };
}

describe("createFloodGate", () => {
  test("passes a successful send straight through", async () => {
    const h = harness();
    let calls = 0;
    const r = await h.gate.run("sendMessage", 1, async () => (calls++, OK));
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(h.logs).toEqual([]);
  });

  test("never gates non-send methods (polling must keep working)", async () => {
    const h = harness();
    await h.gate.run("sendMessage", 1, async () => tooMany(9_000));
    let calls = 0;
    const r = await h.gate.run("getUpdates", undefined, async () => (calls++, OK));
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test("logs a non-429 send failure instead of swallowing it", async () => {
    const h = harness();
    await h.gate.run("sendMessage", 7, async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toContain("sendMessage");
    expect(h.logs[0]).toContain("7");
    expect(h.logs[0]).toContain("400");
    expect(h.logs[0]).toContain("chat not found");
  });

  test("a short 429 waits retry_after and retries once", async () => {
    const h = harness(30_000);
    const results = [tooMany(3), OK];
    let calls = 0;
    const r = await h.gate.run("sendMessage", 1, async () => results[calls++]!);
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(h.slept).toEqual([3_000]);
  });

  test("a long 429 blocks the chat: later sends are held without calling Telegram", async () => {
    const h = harness(30_000);
    await h.gate.run("sendMessage", 1, async () => tooMany(33_261));
    expect(h.logs.some((l) => l.includes("429") && l.includes("33261"))).toBe(true);
    let calls = 0;
    const r = await h.gate.run("sendMessage", 1, async () => (calls++, OK));
    expect(calls).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(429);
    // another chat is not blocked
    const other = await h.gate.run("sendMessage", 2, async () => OK);
    expect(other.ok).toBe(true);
  });

  test("logs the block once, not once per held message", async () => {
    const h = harness();
    await h.gate.run("sendMessage", 1, async () => tooMany(600));
    for (let i = 0; i < 5; i++) await h.gate.run("sendMessage", 1, async () => OK);
    expect(h.logs.length).toBe(1);
  });

  test("after the block lifts, sends resume and the held count is reported once", async () => {
    const h = harness();
    await h.gate.run("sendMessage", 1, async () => tooMany(600));
    await h.gate.run("sendMessage", 1, async () => OK);
    await h.gate.run("editMessageText", 1, async () => OK);
    h.advance(600_000);
    let calls = 0;
    const r = await h.gate.run("sendMessage", 1, async () => (calls++, OK));
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    // the original 429'd send + the 2 held ones were not delivered
    expect(h.recovered).toEqual([{ chatId: 1, dropped: 3 }]);
    await h.gate.run("sendMessage", 1, async () => OK);
    expect(h.recovered.length).toBe(1);
  });

  test("a second 429 on the retry blocks instead of looping", async () => {
    const h = harness(30_000);
    let calls = 0;
    const r = await h.gate.run("sendMessage", 1, async () => (calls++, tooMany(5)));
    expect(r.ok).toBe(false);
    expect(calls).toBe(2);
    let later = 0;
    await h.gate.run("sendMessage", 1, async () => (later++, OK));
    expect(later).toBe(0);
  });
});

describe("isToolStepLine", () => {
  test("matches the worker tool-step stream lines", () => {
    expect(isToolStepLine("🔧 Bash: ls -la")).toBe(true);
    expect(isToolStepLine("↳ ok  github.com/x 0.3s")).toBe(true);
    expect(isToolStepLine("⚠️ ↳ exit status 1")).toBe(true);
    expect(isToolStepLine("🔓 auto-approved: file write outside the project folder")).toBe(true);
  });

  test("keeps real worker prose and engine notices", () => {
    expect(isToolStepLine("Hi Neo! 👋")).toBe(false);
    expect(isToolStepLine("Progress: gate tests green.")).toBe(false);
    expect(isToolStepLine("↩︎ queued for agent — idle")).toBe(false);
    expect(isToolStepLine("🔓 trusting adminli (/home/adminli) — actions auto-approve")).toBe(false);
    expect(isToolStepLine("✗ mirshad: the API failed")).toBe(false);
  });
});
