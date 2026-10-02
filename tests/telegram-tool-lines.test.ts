// Tool-step lines ("🔧 Bash: …", "↳ …") never reach Telegram by default — on EVERY worker-output
// path, not just the session `send()`: scheduled loops (sendOperatorLine), loops started from
// Telegram, and company briefs all leaked them. The web console keeps them.
import { afterEach, expect, test } from "bun:test";
import { sendFormatted, sendOperatorLine } from "../src/frontends/telegram";
import { makeLoopReply } from "../src/engine/loop-mirror";
import type { OperatorBus } from "../src/engine/operator-bus";

const TOOL_LINE = '🔧 Bash: grep -rnE --include=*.go "\\"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a…';

function fakeBot() {
  const sent: string[] = [];
  let id = 0;
  return {
    sent,
    bot: { api: { sendMessage: async (_chat: number, text: string) => (sent.push(text), { message_id: ++id }) } },
  };
}

test("sendFormatted: a tool_use line produces no Telegram send by default", async () => {
  const { bot, sent } = fakeBot();
  for (const line of [TOOL_LINE, "↳ 3 matches", "⚠️ ↳ exit 1", "🔓 auto-approved: risky shell command: git push"]) {
    expect(await sendFormatted(bot as never, 1, line, { project: "eticket_v3" })).toBeUndefined();
  }
  expect(sent).toEqual([]);
});

test("sendFormatted: worker text, decisions, errors and the final result still go out", async () => {
  const { bot, sent } = fakeBot();
  const lines = [
    "Found the root cause in booking.go — fixing it now.", // the worker's own progress note
    "❓ Decision needed: Postgres or Mongo?", // ask_operator
    "⚠️ eticket_v3 looks stuck: no activity for 10m", // stall / error
    "✅ Done. 3 files changed, tests green.", // final result
  ];
  for (const line of lines) await sendFormatted(bot as never, 1, line, { project: "eticket_v3" });
  expect(sent.length).toBe(lines.length);
});

test("sendFormatted: toolSteps opts back in", async () => {
  const { bot, sent } = fakeBot();
  await sendFormatted(bot as never, 1, TOOL_LINE, { toolSteps: true });
  expect(sent.length).toBe(1);
});

// sendOperatorLine posts over the raw Bot API with fetch (the scheduled-loop path).
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function captureFetch(): string[] {
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch;
  return bodies;
}

test("sendOperatorLine (scheduled loops): a tool_use line produces no Telegram send by default", async () => {
  const bodies = captureFetch();
  await sendOperatorLine("TOKEN", 1, TOOL_LINE, "waselni");
  expect(bodies).toEqual([]);
});

test("sendOperatorLine: worker text still goes out, and toolSteps opts back in", async () => {
  const bodies = captureFetch();
  await sendOperatorLine("TOKEN", 1, "Checklist row 14 done; moving to 15.", "waselni");
  await sendOperatorLine("TOKEN", 1, TOOL_LINE, "waselni", { toolSteps: true });
  expect(bodies.length).toBe(2);
});

test("a scheduled loop's tool line still reaches the web console", () => {
  const mirrored: string[] = [];
  const bus = { mirror: (_from: string, line: { text: string }) => void mirrored.push(line.text) } as unknown as OperatorBus;
  const reply = makeLoopReply({ toTelegram: () => {}, toStdout: () => {}, bus });
  reply(1, TOOL_LINE, "waselni");
  expect(mirrored).toEqual([TOOL_LINE]);
});
