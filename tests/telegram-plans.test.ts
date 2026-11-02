// Task 2.2 (ADR-0019) on Telegram: the plan poster, its buttons, and the plan:<id>:<action> taps.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api } from "grammy";
import { createTelegramBot, createPlanEditor, createPlanPoster, planKeyboard } from "../src/frontends/telegram";
import { planActions, PLAN_LABELS, type EditPlanCard } from "../src/engine/plans";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";

const ADMIN = 42;
const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

const callbacks = (kb: ReturnType<typeof planKeyboard>) => kb.inline_keyboard.flat().map((b) => [b.text, (b as { callback_data: string }).callback_data]);

test("planKeyboard: the engine's actions, each a plan:<id>:<version>:<action> callback with the shared label", () => {
  expect(callbacks(planKeyboard(3, 1, planActions({ status: "sent", gate: "approval" })))).toEqual([["Approve & build", "plan:3:1:approve"], ["Changes", "plan:3:1:changes"], ["Drop", "plan:3:1:drop"]]);
  expect(callbacks(planKeyboard(3, 1, planActions({ status: "sent", gate: "info" })))).toEqual([["Stop", "plan:3:1:stop"]]);
  expect(callbacks(planKeyboard(3, 2, planActions({ status: "executing" })))).toEqual([["Done", "plan:3:2:done"], ["Drop", "plan:3:2:drop"]]);
  expect(callbacks(planKeyboard(3, 2, planActions({ status: "done" })))).toEqual([]);
});

// ADR-0036: each button means one thing, and Telegram shows the console's English label for it.
test("PLAN_LABELS equal the console's English catalogue (one label per action, everywhere)", () => {
  expect(en.threads.planAction).toEqual(PLAN_LABELS);
  expect(Object.keys(ar.threads.planAction).sort()).toEqual(Object.keys(PLAN_LABELS).sort());
  expect(Object.keys(en.threads.planState).sort()).toEqual(["approved", "awaiting", "building", "done", "draft", "dropped", "info"]);
  expect(Object.keys(ar.threads.planState).sort()).toEqual(Object.keys(en.threads.planState).sort());
});

test("createPlanEditor: edits the card's caption and buttons in place; 'not modified' is fine, other failures are false", async () => {
  const calls: unknown[][] = [];
  const api = { editMessageCaption: async (...a: unknown[]) => (calls.push(a), true) } as unknown as Api;
  expect(await createPlanEditor(api)({ chatId: -100, messageId: 7 }, { planId: 5, version: 2, caption: "c", actions: ["done", "drop"] })).toBe(true);
  expect(calls[0]!.slice(0, 2)).toEqual([-100, 7]);
  expect(callbacks((calls[0]![2] as { reply_markup: ReturnType<typeof planKeyboard> }).reply_markup)).toEqual([["Done", "plan:5:2:done"], ["Drop", "plan:5:2:drop"]]);
  const failing = { editMessageCaption: async () => Promise.reject(new Error("boom")) } as unknown as Api;
  expect(await createPlanEditor(failing)({ chatId: 1, messageId: 1 }, { planId: 5, version: 1, caption: "c", actions: [] })).toBe(false);
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
  const rec = { planId: 5, project: "gold", folder: "/home/gold", status: "sent" as const, version: 1, actions: planActions({ status: "sent" }) };
  expect(await post(rec, "/home/gold/plans/a.md", "📄 plan · gold · A")).toEqual({ chatId: -100, messageId: 77 });
  expect(sent[0]).toMatchObject({ chat: -100, caption: "📄 plan · gold · A" });
  expect(callbacks(sent[0]!.markup as ReturnType<typeof planKeyboard>)[0]).toEqual(["Approve & build", "plan:5:1:approve"]);
  target = undefined;
  expect(await post(rec, "/x", "c")).toBeUndefined();
  const failing = createPlanPoster({ sendDocument: async () => Promise.reject(new Error("400")) } as unknown as Api, () => 1);
  expect(await failing(rec, "/x", "c")).toBeUndefined();
});

function rig(o: { held?: boolean } = {}) {
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
  const edits: Array<{ messageId: number; caption: string; actions: string[] }> = [];
  const editPlan: EditPlanCard = async (at, card) => (edits.push({ messageId: at.messageId, caption: card.caption, actions: card.actions }), true);
  // Draining: a resumed pipeline refuses instead of starting a real worker in the test.
  const reload = { editPlan, lifecycle: { draining: () => true } };
  const bot = createTelegramBot(cfg, ledger, admin, createRegistry(), createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), openTrustStore(":memory:"), undefined, undefined, undefined, reload, undefined, { botInfo, client: { fetch } });
  let updateId = 1;
  const chat = { id: ADMIN, type: "private" as const, first_name: "Neo" };
  const from = { id: ADMIN, is_bot: false, first_name: "Neo" };
  const press = async (data: string) => {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), from, chat_instance: "c", data, message: { message_id: 1, date: 0, chat, text: "x" } } } as never);
    await Bun.sleep(10);
  };
  /** A sent plan with its open review decision. */
  const plan = () => {
    const p = ledger.upsertPlan({ project: "gold", folder: "/home/gold", path: "plans/a.md", title: "A", sha256: "s", status: "sent", stepsTotal: 0, stepsDone: 0, version: 1, gate: "approval", cardChatId: -100, cardMessageId: 9, ...(o.held ? { heldAt: 1 } : {}) });
    const decisionId = ledger.openDecision({ kind: "decision", project: "gold", folder: "/home/gold", chatId: ADMIN, question: "Plan waiting for your approval: plans/a.md — A", options: ["Approve & build", "Changes", "Drop"] });
    return ledger.upsertPlan({ ...p, decisionId });
  };
  return { ledger, calls, press, plan, edits };
}

test("Approve & build on a held plan answers its decision, resumes the worker, and the card shows building", async () => {
  const r = rig({ held: true });
  const p = r.plan();
  await r.press(`plan:${p.id}:1:approve`);
  expect(r.ledger.planById(p.id)!.status).toBe("executing");
  expect(r.calls.find((c) => c.method === "answerCallbackQuery")?.payload.text).toBe("Approved — the worker that wrote it builds it now");
  // The same path as any decision answer: resolved with the approval brief, then the resume.
  expect(r.ledger.decisionById(p.decisionId!)).toMatchObject({ status: "answered", answer: expect.stringContaining("Approved by the operator. Execute the plan at plans/a.md") });
  expect(r.calls.some((c) => c.method === "sendMessage" && c.payload.text === "✅ answered — resuming gold.")).toBe(true);
  expect(r.edits).toEqual([{ messageId: 9, actions: ["done", "drop"], caption: expect.stringContaining("🔨 building") }]);
});

test("Drop redraws the card: dropped, no buttons", async () => {
  const r = rig();
  const p = r.plan();
  await r.press(`plan:${p.id}:1:drop`);
  expect(r.ledger.planById(p.id)!.status).toBe("abandoned");
  expect(r.edits).toEqual([{ messageId: 9, actions: [], caption: expect.stringContaining("✖ dropped") }]);
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
