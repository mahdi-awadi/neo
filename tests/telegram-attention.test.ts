// P4 Task 4.6 on Telegram: /attention with one-tap buttons, and the att:<id>:<action> taps.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramBot, attentionKeyboard } from "../src/frontends/telegram";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { reconcile, listOpen } from "../src/engine/attention";

const ADMIN = 42;
const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
const item = { project: "gold", folder: "/home/gold", source: "engine" as const, kind: "queue_paused", key: "/home/gold", title: "todo queue paused 7h", severity: "normal" as const };

test("attentionKeyboard: one row per item — → todo, snooze (configured hours), dismiss — as att:<id>:<action>", () => {
  const kb = attentionKeyboard([{ id: 7 }], 48);
  expect(kb.inline_keyboard.map((row) => row.map((b) => [b.text, (b as { callback_data: string }).callback_data]))).toEqual([
    [["#7 → todo", "att:7:todo"], ["snooze 48h", "att:7:snooze"], ["dismiss", "att:7:dismiss"]],
  ]);
});

function rig() {
  const ledger = openLedger(":memory:");
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(ADMIN);
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-tg-att-"))), telegramToken: "123456:TESTTOKEN", telegramAllowFrom: [], decisionsChatId: undefined };
  const calls: Array<{ method: string; payload: any }> = [];
  let nextId = 100;
  const fetch = (async (url: string | URL, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop()!;
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: nextId++, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const bot = createTelegramBot(cfg, ledger, admin, createRegistry(), createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), openTrustStore(":memory:"), undefined, undefined, undefined, {}, undefined, { botInfo, client: { fetch } });
  let updateId = 1;
  const chat = { id: ADMIN, type: "private" as const, first_name: "Neo" };
  const from = { id: ADMIN, is_bot: false, first_name: "Neo" };
  const press = async (data: string) => {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), from, chat_instance: "c", data, message: { message_id: 1, date: 0, chat, text: "x" } } } as never);
    await Bun.sleep(10);
  };
  const say = async (text: string) => {
    await bot.handleUpdate({ update_id: updateId++, message: { message_id: updateId, date: 0, chat, from, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : [] } } as never);
    await Bun.sleep(10);
  };
  return { ledger, calls, press, say };
}

test("/attention sends the list with one row of buttons per item", async () => {
  const r = rig();
  reconcile(r.ledger, "engine", "gold", [item], 100);
  await r.say("/attention");
  const sent = r.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes("attention: 1 open"))!;
  expect(sent.payload.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(["att:1:todo", "att:1:snooze", "att:1:dismiss"]);
});

test("tapping dismiss closes the item, answers the tap and drops the item's row", async () => {
  const r = rig();
  reconcile(r.ledger, "engine", "gold", [item], 100);
  await r.press("att:1:dismiss");
  expect(listOpen(r.ledger, { now: Date.now() })).toEqual([]);
  expect(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).toContain("#1 dismissed");
  expect(r.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
});

test("tapping → todo without a todo queue is refused in the tap's answer", async () => {
  const r = rig();
  reconcile(r.ledger, "engine", "gold", [item], 100);
  await r.press("att:1:todo");
  expect(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).toBe("the todo queue is unavailable — → todo needs it");
});

test("a removable worktree item gets a remove button first", () => {
  const kb = attentionKeyboard([{ id: 3, actions: ["remove", "todo", "snooze", "dismiss"] }], 24);
  expect(kb.inline_keyboard[0]!.map((b) => (b as { callback_data: string }).callback_data)).toEqual(["att:3:remove", "att:3:todo", "att:3:snooze", "att:3:dismiss"]);
});

test("a refused action keeps the item's row (its answer may point at → todo)", async () => {
  const r = rig();
  reconcile(r.ledger, "engine", "gold", [item], 100);
  await r.press("att:1:remove"); // not a worktree: refused
  expect(r.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(false);
});

test("an answer too long for a tap toast is also posted in the chat in full", async () => {
  const r = rig();
  const wt = "/tmp/" + "x".repeat(220);
  reconcile(r.ledger, "git", "gold", [{ project: "gold", folder: "/tmp/gold", source: "git", kind: "worktree", key: wt, title: "worktree idle", detail: JSON.stringify({ path: wt, branch: "b", dirty: false, merged: false, pushed: false }), severity: "normal" }], 100);
  await r.press("att:1:remove");
  const full = r.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes(wt));
  expect(full).toBeDefined();
  expect(String(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).length).toBeLessThanOrEqual(200);
});

test("a tap on an item already resolved elsewhere drops its row", async () => {
  const r = rig();
  reconcile(r.ledger, "engine", "gold", [item], 100);
  r.ledger.updateAttention(1, { resolvedAt: 150 });
  await r.press("att:1:snooze");
  expect(r.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
});
