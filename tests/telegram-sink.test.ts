import { test, expect } from "bun:test";
import { makeTelegramSink } from "../src/frontends/telegram";

/** Capture the reply/plain calls the sink makes, so we can assert routing without a live Bot. */
function spy() {
  const replies: Array<{ chatId: number; text: string; project?: string }> = [];
  const plains: Array<{ chatId: number; text: string }> = [];
  return {
    replies,
    plains,
    reply: (chatId: number, text: string, project?: string) => replies.push({ chatId, text, project }),
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

test("with no admin claimed yet, the sink is a no-op (nothing to deliver to)", () => {
  const s = spy();
  const sink = makeTelegramSink({ adminId: () => undefined, reply: s.reply, plain: s.plain });
  sink.deliver({ kind: "reply", text: "x" });
  sink.deliver({ kind: "echo", text: "y" });
  sink.deliver({ kind: "notice", text: "z" });
  expect(s.replies).toEqual([]);
  expect(s.plains).toEqual([]);
});
