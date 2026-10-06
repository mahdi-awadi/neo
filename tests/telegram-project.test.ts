// P6 Task 6.2 on Telegram: /project <name> (alias /p) with its buttons, and the buttons' taps.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramBot, projectDashKeyboard } from "../src/frontends/telegram";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { reconcile } from "../src/engine/attention";

const ADMIN = 42;
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

function rig(publicUrl = "https://neo.example", gitRead?: import("../src/engine/git-read").GitRead) {
  const root = mkdtempSync(join(tmpdir(), "neo-tg-pj-"));
  made.push(root);
  const gold = join(root, "gold");
  const neo = join(root, "neo");
  mkdirSync(gold);
  mkdirSync(neo);
  const ledger = openLedger(":memory:");
  ledger.recordOrder({ id: crypto.randomUUID(), source: "neo", folder: gold, task: "t", chatId: 0, createdAt: 1 });
  reconcile(ledger, "git", "gold", [{ project: "gold", folder: gold, source: "git", kind: "dirty", key: "k", title: "3 files uncommitted", severity: "high" }], Date.now());
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(ADMIN);
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-tg-pj-cfg-"))), telegramToken: "123456:TESTTOKEN", telegramAllowFrom: [], decisionsChatId: undefined, publicUrl };
  const calls: Array<{ method: string; payload: any }> = [];
  let nextId = 100;
  const fetch = (async (url: string | URL, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop()!;
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: nextId++, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const bot = createTelegramBot(cfg, ledger, admin, createRegistry(), createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), openTrustStore(":memory:"), undefined, undefined, undefined, { neoFolder: neo, gitRead }, undefined, { botInfo, client: { fetch } });
  let updateId = 1;
  const chat = { id: ADMIN, type: "private" as const, first_name: "Neo" };
  const from = { id: ADMIN, is_bot: false, first_name: "Neo" };
  const press = async (data: string) => {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), from, chat_instance: "c", data, message: { message_id: 1, date: 0, chat, text: "x" } } } as never);
    await Bun.sleep(30);
  };
  const say = async (text: string) => {
    await bot.handleUpdate({ update_id: updateId++, message: { message_id: updateId, date: 0, chat, from, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : [] } } as never);
    await Bun.sleep(30);
  };
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  return { ledger, calls, sent, press, say };
}

test("projectDashKeyboard: [attention (N)] [threads] [open console]; no console button without a URL", () => {
  const kb = projectDashKeyboard({ name: "gold", attention: 5, consoleUrl: "https://neo.example/#project=gold" });
  expect(kb.inline_keyboard[0]!.map((b) => [b.text, (b as { callback_data?: string }).callback_data ?? (b as { url?: string }).url])).toEqual([
    ["attention (5)", "pj:a:gold"],
    ["threads", "pj:t:gold"],
    ["open console", "https://neo.example/#project=gold"],
  ]);
  expect(projectDashKeyboard({ name: "gold", attention: 0 }).inline_keyboard[0]!.map((b) => b.text)).toEqual(["attention (0)", "threads"]);
  // A name too long for Telegram's 64-byte callback data keeps only the console link.
  expect(projectDashKeyboard({ name: "x".repeat(80), attention: 1, consoleUrl: "https://n/" }).inline_keyboard[0]!.map((b) => b.text)).toEqual(["open console"]);
});

test("/project gold sends the dashboard with its buttons; /p is the same", async () => {
  const r = rig();
  await r.say("/project gold");
  const m = r.sent().find((c) => String(c.payload.text).startsWith("gold · 🟠 attention"))!;
  expect(m).toBeDefined();
  expect(m.payload.reply_markup.inline_keyboard[0].map((b: { text: string }) => b.text)).toEqual(["attention (1)", "threads", "open console"]);
  await r.say("/p gold");
  expect(r.sent().filter((c) => String(c.payload.text).startsWith("gold · 🟠 attention")).length).toBe(2);
});

test("/project with no name lists the projects; an unknown one says so", async () => {
  const r = rig();
  await r.say("/project");
  expect(r.sent().some((c) => String(c.payload.text).includes("gold · 🟠 attention · no session"))).toBe(true);
  await r.say("/project ghost");
  expect(r.sent().some((c) => String(c.payload.text).startsWith('No project "ghost"'))).toBe(true);
});

test("tapping [attention (N)] sends what /attention gold sends, with its one-tap buttons", async () => {
  const r = rig();
  await r.press("pj:a:gold");
  const m = r.sent().find((c) => String(c.payload.text).includes("attention: 1 open in gold"))!;
  expect(m.payload.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)).toEqual(["att:1:todo", "att:1:snooze", "att:1:dismiss"]);
  expect(r.calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
});

test("tapping [threads] sends the project's threads", async () => {
  const r = rig();
  await r.press("pj:t:gold");
  expect(r.sent().some((c) => String(c.payload.text).includes("gold has no threads yet"))).toBe(true);
});

test("the update handler returns at once; a slow /project answer is sent when its git reads settle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = { git: async () => (await gate, { ok: false, out: "", err: "slow" }), gh: async () => ({ ok: false, out: "", err: "x" }) };
  const r = rig("https://neo.example", slow);
  await r.say("/project gold"); // returns while the git reads are still pending
  expect(r.sent().some((c) => String(c.payload.text).startsWith("gold ·"))).toBe(false);
  release();
  await Bun.sleep(30);
  expect(r.sent().some((c) => String(c.payload.text).startsWith("gold · 🟠 attention"))).toBe(true);
});
