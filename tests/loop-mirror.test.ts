import { test, expect } from "bun:test";
import { makeLoopReply } from "../src/engine/loop-mirror";
import { createOperatorBus, type BusLine, type OperatorSink } from "../src/engine/operator-bus";

function recorder(id: string): OperatorSink & { lines: BusLine[] } {
  const lines: BusLine[] = [];
  return { id, lines, deliver: (l) => lines.push(l) };
}

test("scheduled-loop output mirrors a reply to the web console via the bus", () => {
  const bus = createOperatorBus();
  const web = recorder("web");
  bus.register(web);
  const loopReply = makeLoopReply({ toTelegram: () => {}, toStdout: () => {}, bus });

  loopReply(555, "nightly docs sweep: 3 files updated", "neo");

  expect(web.lines).toEqual([{ kind: "reply", text: "nightly docs sweep: 3 files updated", project: "neo" }]);
});

test("the loop mirror excludes Telegram (already delivered there) — no double-send", () => {
  const bus = createOperatorBus();
  const tg = recorder("telegram");
  const web = recorder("web");
  bus.register(tg);
  bus.register(web);
  const sent: Array<{ chatId: number; text: string }> = [];
  const loopReply = makeLoopReply({ toTelegram: (chatId, text) => sent.push({ chatId, text }), toStdout: () => {}, bus });

  loopReply(555, "loop line", "neo");

  expect(sent).toEqual([{ chatId: 555, text: "loop line" }]); // Telegram got it once, directly
  expect(tg.lines).toEqual([]); // and NOT again via the bus
  expect(web.lines.length).toBe(1); // web got it via the bus
});

test("delivers to Telegram when a chat id is present, else falls back to stdout", () => {
  const bus = createOperatorBus();
  const tgCalls: string[] = [];
  const outCalls: string[] = [];
  const loopReply = makeLoopReply({
    toTelegram: (_c, t) => tgCalls.push(t),
    toStdout: (t) => outCalls.push(t),
    bus,
  });

  loopReply(555, "has admin", "neo"); // chatId > 0 → Telegram
  loopReply(-1, "no admin yet", "neo"); // no admin → stdout

  expect(tgCalls).toEqual(["has admin"]);
  expect(outCalls).toEqual(["no admin yet"]);
});

test("no bus (e.g. web never started) → still delivers, no throw", () => {
  const tgCalls: string[] = [];
  const loopReply = makeLoopReply({ toTelegram: (_c, t) => tgCalls.push(t), toStdout: () => {} });
  expect(() => loopReply(555, "line", "neo")).not.toThrow();
  expect(tgCalls).toEqual(["line"]);
});
