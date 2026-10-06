import { test, expect } from "bun:test";
import { makeTelegramSink, decisionKeyboard, createTelegramBot } from "../src/frontends/telegram";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { createTrace, type Trace } from "../src/engine/trace";
import { createOperatorBus } from "../src/engine/operator-bus";

test("decisionKeyboard renders one dec:<id>:<idx> button per option + an 'other' affordance", () => {
  const kb = decisionKeyboard("abc-123", ["Postgres", "Mongo"]);
  const rows = kb.inline_keyboard;
  expect(rows.flat().map((b: any) => b.callback_data)).toEqual(["dec:abc-123:0", "dec:abc-123:1", "deco:abc-123"]);
  expect(rows.flat().map((b: any) => b.text)).toEqual(["Postgres", "Mongo", "✏️ Other / type an answer"]);
});

test("decisionKeyboard with no options shows only the 'other / type an answer' button", () => {
  const kb = decisionKeyboard("x9", []);
  expect(kb.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual(["deco:x9"]);
});

test("decisionKeyboard caps at 8 option buttons (callback data stays under Telegram's limit)", () => {
  const kb = decisionKeyboard("z", Array.from({ length: 12 }, (_, i) => `opt${i}`));
  const optBtns = kb.inline_keyboard.flat().filter((b: any) => b.callback_data.startsWith("dec:"));
  expect(optBtns).toHaveLength(8);
});

/** Capture the reply/plain calls the sink makes, so we can assert routing without a live Bot. */
function spy() {
  const replies: Array<{ chatId: number; text: string; project?: string; priority?: string }> = [];
  const plains: Array<{ chatId: number; text: string }> = [];
  return {
    replies,
    plains,
    reply: (chatId: number, text: string, project?: string, priority?: string) =>
      replies.push({ chatId, text, project, priority }),
    plain: (chatId: number, text: string) => plains.push({ chatId, text }),
  };
}

test("the telegram sink has id 'telegram'", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 7, reply: s.reply, plain: s.plain });
  expect(sink.id).toBe("telegram");
});

test("a reply line is delivered to the admin DM as a project-tagged reply", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 555, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "reply", text: "worker output", project: "eticket" });
  expect(s.replies).toEqual([{ chatId: 555, text: "worker output", project: "eticket" }]);
  expect(s.plains).toEqual([]);
});

test("an echo line is delivered as plain text attributed to the web console", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 555, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "echo", text: "typed on the web" });
  expect(s.plains).toEqual([{ chatId: 555, text: "🌐 you (web): typed on the web" }]);
  expect(s.replies).toEqual([]);
});

test("a notice line is delivered as plain text", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 555, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "notice", text: "⏳ approval pending on the web console: rm -rf" });
  expect(s.plains).toEqual([{ chatId: 555, text: "⏳ approval pending on the web console: rm -rf" }]);
});

test("decision, alert + result go to the decisions chat; progress + done stay in the DM", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 111, decisionsChatId: () => 222, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "reply", text: "which design?", priority: "decision" });
  sink.deliver({ kind: "reply", text: "an error", priority: "alert" });
  sink.deliver({ kind: "reply", text: "eticket finished: shipped the fix", priority: "result" });
  sink.deliver({ kind: "reply", text: "working…", priority: "progress" });
  sink.deliver({ kind: "reply", text: "done!", priority: "done" });
  expect(s.replies.map((r) => r.chatId)).toEqual([222, 222, 222, 111, 111]);
  // priority is forwarded so downstream (send/mirror) can act on it.
  expect(s.replies[0]!.priority).toBe("decision");
});

test("the decisions group receives no routine progress — a progress line only ever lands in the DM", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 111, decisionsChatId: () => 222, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "reply", text: "step 1 of 4…", priority: "progress" });
  sink.deliver({ kind: "reply", text: "streamed worker text" }); // untagged = progress
  expect(s.replies.every((r) => r.chatId === 111)).toBe(true);
  expect(s.replies.some((r) => r.chatId === 222)).toBe(false);
});

test("with no decisions chat configured, a decision line falls back to the admin DM", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 111, decisionsChatId: () => undefined, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "reply", text: "which design?", priority: "decision" });
  expect(s.replies[0]!.chatId).toBe(111); // safe degrade: still delivered, just to the DM
});

test("an untagged reply (no priority) defaults to the firehose DM", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => 111, decisionsChatId: () => 222, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "reply", text: "plain worker output" });
  expect(s.replies[0]!.chatId).toBe(111);
});

test("with no admin claimed yet, the sink is a no-op (nothing to deliver to)", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => undefined, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "reply", text: "x" });
  sink.deliver({ kind: "echo", text: "y" });
  sink.deliver({ kind: "notice", text: "z" });
  expect(s.replies).toEqual([]);
  expect(s.plains).toEqual([]);
});

// ── the cause seam on Telegram (ADR-0015, spec §4.1 rule 1 + rule 3) ──────────────────────

const ADMIN = 42;
const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

/** A bot with a stubbed Bot API (grammy's client.fetch) and a real trace over an in-memory ledger. */
function tgRig(o: { wrap?: (t: Trace) => Trace } = {}) {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const real = createTrace({ ledger, registry });
  const trace = o.wrap ? o.wrap(real) : real;
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(ADMIN);
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-tg-trace-"))), telegramToken: "123456:TESTTOKEN", telegramAllowFrom: [], decisionsChatId: undefined };
  const sent: Array<{ text: string; message_id: number; chat_id: number }> = [];
  let nextId = 100;
  const fetch = (async (url: string | URL, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop()!;
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const result = method === "sendMessage" ? { message_id: nextId++, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } : true;
    if (method === "sendMessage") sent.push({ text: String(payload.text), message_id: result === true ? 0 : result.message_id, chat_id: payload.chat_id });
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const bus = createOperatorBus();
  const bot = createTelegramBot(cfg, ledger, admin, registry, createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), openTrustStore(":memory:"), undefined, undefined, undefined, { trace }, bus, { botInfo, client: { fetch } });
  let updateId = 1;
  let messageId = 1;
  const chat = { id: ADMIN, type: "private" as const, first_name: "Neo" };
  const from = { id: ADMIN, is_bot: false, first_name: "Neo" };
  const text = async (t: string, replyTo?: number) => {
    const id = messageId++;
    const reply_to_message = replyTo === undefined ? undefined : { message_id: replyTo, date: 0, chat, text: "x" };
    await bot.handleUpdate({ update_id: updateId++, message: { message_id: id, date: 0, chat, from, text: t, ...(reply_to_message ? { reply_to_message } : {}) } } as never);
    await Bun.sleep(10); // sends are fire-and-forget
    return id;
  };
  return { ledger, registry, bus, trace: real, sent, text };
}

test("an operator message is traced with its Telegram id; Neo's answer is bound to the message it posted", async () => {
  const r = tgRig();
  const mid = await r.text("hello there");
  const inbound = r.ledger.messageByChannel(ADMIN, mid)!;
  expect(inbound).toMatchObject({ role: "user", content: "hello there", surface: "telegram" });
  expect(inbound.threadId).toBe(inbound.id); // rule 4: a new thread
  const answer = r.sent.at(-1)!;
  const bound = r.ledger.messageByChannel(ADMIN, answer.message_id)!;
  expect(bound.role).toBe("assistant");
  expect(bound.threadId).toBe(inbound.threadId);
});

test("a reply to a Neo line of a project joins that line's thread (rule 1), and the project gets the cause", async () => {
  const r = tgRig();
  // A live project session whose input we can see.
  const gold = r.registry.add({ id: "o-gold", source: "neo", folder: "/home/gold", task: "t", chatId: ADMIN, createdAt: 1 });
  r.registry.setStatus(gold.id, "running");
  const delivered: Array<{ text: string; cause?: { msgId: number; threadId: number } }> = [];
  r.registry.attachControl(gold.id, { followUp: (text, cause) => void delivered.push({ text, cause }), interrupt: async () => {} });
  // A gold line recorded on the web and mirrored to Telegram: its route remembers the line and thread.
  const root = r.trace.inbound({ chatId: 0, text: "ship gold", surface: "web" });
  const line = r.trace.outbound({ chatId: 0, text: "gold: tests green", cause: root, project: "gold" });
  r.bus.mirror("web", { kind: "reply", text: "gold: tests green", project: "gold", msgId: line, threadId: root.threadId });
  await Bun.sleep(10);
  const posted = r.sent.at(-1)!.message_id;

  const mid = await r.text("now deploy it", posted);
  const row = r.ledger.messageByChannel(ADMIN, mid)!;
  expect(row.threadId).toBe(root.threadId);
  expect(row.causeId).toBe(line);
  expect(delivered.at(-1)!.cause).toEqual({ msgId: row.id, threadId: root.threadId });
});

test("engine commands open no thread (rule 3); reply /trace to a Neo line shows that line's thread", async () => {
  const r = tgRig();
  await r.text("hello there");
  const thread = r.ledger.messageByChannel(ADMIN, 1)!.threadId!;
  const answer = r.sent.at(-1)!.message_id;
  const rows = r.ledger.conversation(ADMIN).length;
  await r.text("/todo");
  await r.text("/trace", answer);
  expect(r.ledger.conversation(ADMIN).length).toBe(rows);
  expect(r.sent.at(-1)!.text.split("\n")[0]).toContain(r.trace.ref(thread));
});

test("a trace that fails on inbound or bind never blocks the operator's message", async () => {
  const r = tgRig({
    wrap: (t) => ({
      ...t,
      inbound: () => { throw new Error("ledger is locked"); },
      bindChannel: () => { throw new Error("ledger is locked"); },
    }),
  });
  const before = r.sent.length;
  await r.text("hello there");
  expect(r.sent.length).toBeGreaterThan(before); // the pipeline still answered
});
