import { test, expect } from "bun:test";
import { makeTelegramSink, decisionKeyboard } from "../src/frontends/telegram";

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
