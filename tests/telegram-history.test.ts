// ADR-0067 plan task 14 on Telegram: `/forget <ref>` shows the entry with a Forget button; the tap forgets
// it and answers with the counts; a tap from another chat is ignored.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramBot } from "../src/frontends/telegram";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { TaskHistory } from "../src/engine/history/index";

const ADMIN = 42;
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "neo-tg-hist-"));
  made.push(dir);
  const forgot: Array<{ ref: string; reason: string }> = [];
  const history: TaskHistory = {
    async search() {
      return { ok: true, mode: { meaning: "on" }, hits: [{ ref: "todo:884", kind: "todo", project: "gold", at: Date.UTC(2026, 9, 20), title: "bus seats", snippet: "seats", todo: 884, commits: [], archived: false, via: ["exact"] }] };
    },
    remember: () => ({ ok: true, ref: "mem:1", duplicate: false }),
    async indexTick() {
      return {} as never;
    },
    async forget(ref, reason) {
      forgot.push({ ref, reason });
      return { ok: true, chunks: 3, points: 2, pendingPoints: 1 };
    },
    status: () => ({}) as never,
    close() {},
  };
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(ADMIN);
  const cfg = { ...loadConfig(dir), telegramToken: "123456:TESTTOKEN", telegramAllowFrom: [], decisionsChatId: undefined, publicUrl: "https://neo.example" };
  const calls: Array<{ method: string; payload: any }> = [];
  let nextId = 100;
  const fetch = (async (url: string | URL, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop()!;
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: nextId++, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const bot = createTelegramBot(cfg, openLedger(":memory:"), admin, createRegistry(), createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), openTrustStore(":memory:"), undefined, undefined, undefined, { history }, undefined, { botInfo, client: { fetch } });
  let updateId = 1;
  const from = { id: ADMIN, is_bot: false, first_name: "Neo" };
  const chatOf = (id: number) => ({ id, type: "private" as const, first_name: "Neo" });
  const press = async (data: string, chatId = ADMIN) => {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), from, chat_instance: "c", data, message: { message_id: 1, date: 0, chat: chatOf(chatId), text: "x" } } } as never);
    await Bun.sleep(30);
  };
  const say = async (text: string) => {
    await bot.handleUpdate({ update_id: updateId++, message: { message_id: updateId, date: 0, chat: chatOf(ADMIN), from, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } } as never);
    await Bun.sleep(30);
  };
  return { calls, forgot, press, say };
}

test("/forget shows the entry with a Forget button; the tap forgets it and answers with the counts", async () => {
  const r = rig();
  await r.say("/forget todo:884 wrong project");
  const m = r.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes("bus seats"))!;
  expect(m).toBeDefined();
  const btn = m.payload.reply_markup.inline_keyboard[0][0];
  expect(btn.callback_data).toMatch(/^hf:[0-9a-f]{16}$/);
  expect(r.forgot).toEqual([]);
  await r.press(btn.callback_data);
  expect(r.forgot).toEqual([{ ref: "todo:884", reason: "wrong project" }]);
  const edit = r.calls.find((c) => c.method === "editMessageText")!;
  expect(edit.payload.text).toBe("Forgot todo:884: 3 text chunks and 2 vectors removed; 1 vector waits for the shared index.");
  // A second tap finds nothing to forget.
  await r.press(btn.callback_data);
  expect(r.forgot.length).toBe(1);
});

test("a Forget tap from another chat is ignored, and the button still works in its own chat", async () => {
  const r = rig();
  await r.say("/forget todo:884");
  const m = r.calls.find((c) => c.method === "sendMessage" && c.payload.reply_markup)!;
  const data = m.payload.reply_markup.inline_keyboard[0][0].callback_data;
  await r.press(data, -100777);
  expect(r.forgot).toEqual([]);
  expect(r.calls.some((c) => c.method === "editMessageText")).toBe(false);
  await r.press(data);
  expect(r.forgot.length).toBe(1);
  expect(r.forgot[0]!.reason).toBe("forgotten by the operator in Telegram");
});
