// Task 2.2 (ADR-0019) on Telegram: the plan poster, its buttons, and the plan:<id>:<action> taps.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api } from "grammy";
import { createTelegramBot, createPlanPoster, planKeyboard } from "../src/frontends/telegram";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";

const ADMIN = 42;
const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

const callbacks = (kb: ReturnType<typeof planKeyboard>) => kb.inline_keyboard.flat().map((b) => [b.text, (b as { callback_data: string }).callback_data]);

test("planKeyboard: the buttons for the plan's status, each a plan:<id>:<version>:<action> callback", () => {
  expect(callbacks(planKeyboard(3, "sent", 1))).toEqual([["Approve", "plan:3:1:approve"], ["Changes", "plan:3:1:changes"], ["Execute", "plan:3:1:execute"], ["Drop", "plan:3:1:drop"]]);
  expect(callbacks(planKeyboard(3, "executing", 2))).toEqual([["Done", "plan:3:2:done"], ["Drop", "plan:3:2:drop"]]);
  expect(callbacks(planKeyboard(3, "done", 2))).toEqual([]);
});

test("createPlanPoster: the file as a document in the target chat, with its caption and buttons; no target or a failed send → undefined", async () => {
  const sent: Array<{ chat: number; caption?: string; markup: unknown }> = [];
  const api = {
    sendDocument: async (chat: number, _file: unknown, opts: { caption?: string; reply_markup?: unknown }) => {
      sent.push({ chat, caption: opts.caption, markup: opts.reply_markup });
      return { message_id: 77 };
    },
  } as unknown as Api;
  let target: number | undefined = -100;
  const post = createPlanPoster(api, () => target);
  const rec = { planId: 5, project: "gold", folder: "/home/gold", status: "sent" as const, version: 1 };
  expect(await post(rec, "/home/gold/plans/a.md", "📄 plan · gold · A")).toEqual({ chatId: -100, messageId: 77 });
  expect(sent[0]).toMatchObject({ chat: -100, caption: "📄 plan · gold · A" });
  expect(callbacks(sent[0]!.markup as ReturnType<typeof planKeyboard>)[0]).toEqual(["Approve", "plan:5:1:approve"]);
  target = undefined;
  expect(await post(rec, "/x", "c")).toBeUndefined();
  const failing = createPlanPoster({ sendDocument: async () => Promise.reject(new Error("400")) } as unknown as Api, () => 1);
  expect(await failing(rec, "/x", "c")).toBeUndefined();
});

function rig() {
  const ledger = openLedger(":memory:");
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(ADMIN);
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-tg-plans-"))), telegramToken: "123456:TESTTOKEN", telegramAllowFrom: [], decisionsChatId: undefined };
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
  /** A sent plan with its open review decision. */
  const plan = () => {
    const p = ledger.upsertPlan({ project: "gold", folder: "/home/gold", path: "plans/a.md", title: "A", sha256: "s", status: "sent", stepsTotal: 0, stepsDone: 0, version: 1 });
    const decisionId = ledger.openDecision({ kind: "decision", project: "gold", folder: "/home/gold", chatId: ADMIN, question: "Plan ready for review: plans/a.md — A", options: ["Approve", "Changes", "Execute", "Done", "Drop"] });
    return ledger.upsertPlan({ ...p, decisionId });
  };
  return { ledger, calls, press, plan };
}

test("tapping Approve moves the plan, answers the tap and redraws the card's buttons", async () => {
  const r = rig();
  const p = r.plan();
  await r.press(`plan:${p.id}:1:approve`);
  expect(r.ledger.planById(p.id)!.status).toBe("approved");
  expect(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).toBe("Approved");
  const redraw = r.calls.find((c) => c.method === "editMessageReplyMarkup")!;
  expect(redraw.payload.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data)).toEqual([`plan:${p.id}:1:execute`, `plan:${p.id}:1:drop`]);
});

test("tapping Execute without a todo queue is refused in the tap's answer, the plan unchanged", async () => {
  const r = rig();
  const p = r.plan();
  await r.press(`plan:${p.id}:1:execute`);
  expect(r.ledger.planById(p.id)!.status).toBe("sent");
  expect(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).toBe("the todo queue is unavailable — Execute needs it");
});

test("tapping Changes asks for the changes as the next message (the review decision stays open)", async () => {
  const r = rig();
  const p = r.plan();
  await r.press(`plan:${p.id}:1:changes`);
  expect(r.calls.some((c) => c.method === "sendMessage" && String(c.payload.text).includes("Send your changes"))).toBe(true);
  expect(r.ledger.decisionById(p.decisionId!)!.status).toBe("open");
});

test("a tap on an older version's card is refused in the tap's answer", async () => {
  const r = rig();
  const p = r.ledger.upsertPlan({ ...r.plan(), version: 2 });
  await r.press(`plan:${p.id}:1:approve`);
  expect(r.ledger.planById(p.id)!.status).toBe("sent");
  expect(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).toBe("this card is v1 — the newest is v2; use that card");
});
