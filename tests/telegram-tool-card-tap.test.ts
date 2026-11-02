// ADR-0058 amendment, wired end to end: a tap on a tool-call card through the real bot handler.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramBot } from "../src/frontends/telegram";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { createToolNotices } from "../src/engine/tool-control";

const ADMIN = 42;
const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

function rig() {
  const ledger = openLedger(":memory:");
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(ADMIN);
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-tg-cards-"))), telegramToken: "123456:TESTTOKEN", telegramAllowFrom: [], decisionsChatId: undefined };
  const calls: Array<{ method: string; payload: any }> = [];
  const fetch = (async (url: string | URL, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, payload: typeof init?.body === "string" ? JSON.parse(init.body) : {} });
    return new Response(JSON.stringify({ ok: true, result: true }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const registry = createRegistry();
  const toolNotices = createToolNotices();
  const reload = { toolNotices, lifecycle: { draining: () => true } };
  const bot = createTelegramBot(cfg, ledger, admin, registry, createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), openTrustStore(":memory:"), undefined, undefined, undefined, reload, undefined, { botInfo, client: { fetch } });
  const chat = { id: ADMIN, type: "private" as const, first_name: "Neo" };
  const from = { id: ADMIN, is_bot: false, first_name: "Neo" };
  let updateId = 1;
  const press = async (data: string, messageId: number) => {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), from, chat_instance: "c", data, message: { message_id: messageId, date: 0, chat, text: "x" } } } as never);
    await Bun.sleep(10);
  };
  return { calls, press, registry, toolNotices };
}

test("a tap on a card whose command has ended deletes the card, with a silent answer (no 'already ended' toast)", async () => {
  const r = rig();
  await r.press("tc:b:12345", 9);
  const answer = r.calls.find((c) => c.method === "answerCallbackQuery");
  expect(answer?.payload.text).toBeUndefined();
  expect(r.calls.filter((c) => c.method === "deleteMessage").map((c) => c.payload)).toEqual([{ chat_id: ADMIN, message_id: 9 }]);
  expect(r.calls.some((c) => c.method === "editMessageText" || c.method === "sendMessage")).toBe(false);
});

test("Background on a live card: the call is backgrounded, the card deleted, and one line names the log", async () => {
  const r = rig();
  const s = r.registry.add({ id: "s1", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  const log = "/tmp/claude-0/tasks/b1.output";
  let running = [{ toolUseId: "toolu_A", tool: "Bash", summary: "sleep 600", since: 0 }];
  r.registry.attachControl(s.id, {
    followUp: () => {},
    interrupt: async () => {},
    tools: { provider: "claude", running: () => running, background: async () => ((running = []), { ok: true }), stop: async () => ({ ok: true }), logOf: () => log },
  } as never);
  const [d] = r.toolNotices.due(r.registry, Date.now(), 1);
  r.toolNotices.attach(d!.key, { chatId: ADMIN, messageId: 9 });
  await r.press(`tc:b:${d!.key}`, 9);
  expect(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).toBe("moved to the background");
  expect(r.calls.filter((c) => c.method === "deleteMessage").map((c) => c.payload)).toEqual([{ chat_id: ADMIN, message_id: 9 }]);
  expect(r.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)).toEqual([expect.stringContaining(log)]);
  expect(r.toolNotices.resolve(d!.key)).toBeUndefined();
});
