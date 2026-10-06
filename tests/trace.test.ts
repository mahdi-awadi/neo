import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace, refSuffix, ENGINE_CHAT_ID } from "../src/engine/trace";
import type { Order } from "../src/types";

function order(id = "o1"): Order {
  return { id, source: "neo", folder: "/home/neo/projects/alpha", task: "t", chatId: 7, createdAt: 1 };
}
function setup() {
  const led = openLedger(":memory:");
  const reg = createRegistry();
  return { led, reg, t: createTrace({ ledger: led, registry: reg }) };
}

test("ref is base36 with an m prefix and parseRef accepts m4g2, #m4g2 and 4g2", () => {
  const { t } = setup();
  expect(t.ref(5762)).toBe("m4g2");
  for (const s of ["m4g2", "#m4g2", "4g2", " M4G2 "]) expect(t.parseRef(s)).toBe(5762);
  expect(t.parseRef("hello")).toBeUndefined();
  expect(t.parseRef("")).toBeUndefined();
  expect(t.parseRef("m4-2")).toBeUndefined();
  expect(t.parseRef("m 4g2")).toBeUndefined();
  expect(t.parseRef("m0")).toBeUndefined();
});

test("a new operator message roots a new thread", () => {
  const { led, t } = setup();
  const c = t.inbound({ chatId: 7, text: "fix the login bug\nmore", surface: "telegram", channelMsgId: 100 });
  expect(c.threadId).toBe(c.msgId);
  // No session has the message yet, so nothing is active: 'done'. The pipeline's setCause makes it 'open' (Task 1.4).
  expect(led.threadById(c.threadId)).toMatchObject({ origin: "operator", title: "fix the login bug", state: "done", lastMsgId: c.msgId });
  expect(led.messagesInThread(c.threadId, { limit: 10 }).map((m) => m.id)).toEqual([c.msgId]);
});

test("a Telegram reply to a known Neo line joins that line's thread", () => {
  const { led, t } = setup();
  const root = t.inbound({ chatId: 7, text: "deploy gold", surface: "telegram", channelMsgId: 100 });
  const out = t.outbound({ chatId: 7, text: "gold finished", cause: root, kind: "result" });
  t.bindChannel(out, 7, 101);
  const reply = t.inbound({ chatId: 7, text: "and the admin too", surface: "telegram", channelMsgId: 102, replyTo: { chatId: 7, channelMsgId: 101 } });
  expect(reply.threadId).toBe(root.threadId);
  expect(led.messageById(reply.msgId)?.causeId).toBe(out);
});

test("a reply is resolved through message_routes when the message row has no channel id", () => {
  const { led, t } = setup();
  const root = t.inbound({ chatId: 7, text: "deploy gold", surface: "telegram" });
  led.rememberRoute(7, 555, { sessionId: "s", folder: "/f", project: "p" }, root);
  const reply = t.inbound({ chatId: 7, text: "more", surface: "telegram", replyTo: { chatId: 7, channelMsgId: 555 } });
  expect(reply.threadId).toBe(root.threadId);
});

test("a reply to an unknown or pre-migration message starts a new thread, never throws", () => {
  const { t } = setup();
  const c = t.inbound({ chatId: 7, text: "what about this?", surface: "telegram", channelMsgId: 9, replyTo: { chatId: 7, channelMsgId: 1 } });
  expect(c.threadId).toBe(c.msgId);
});

test("the web composer inside a thread joins it; an unknown thread id starts a new one", () => {
  const { t } = setup();
  const root = t.inbound({ chatId: 7, text: "first", surface: "web" });
  const joined = t.inbound({ chatId: 7, text: "second", surface: "web", threadId: root.threadId });
  expect(joined.threadId).toBe(root.threadId);
  const orphan = t.inbound({ chatId: 7, text: "third", surface: "web", threadId: 99999 });
  expect(orphan.threadId).toBe(orphan.msgId);
});

test("a reply target wins over the web threadId (rule 1 before rule 2)", () => {
  const { t } = setup();
  const a = t.inbound({ chatId: 7, text: "a", surface: "telegram", channelMsgId: 1 });
  const b = t.inbound({ chatId: 7, text: "b", surface: "telegram", channelMsgId: 2 });
  const c = t.inbound({ chatId: 7, text: "c", surface: "web", threadId: b.threadId, replyTo: { chatId: 7, channelMsgId: 1 } });
  expect(c.threadId).toBe(a.threadId);
});

test("a root for background work has its origin and no operator message", () => {
  const { t } = setup();
  const c = t.root({ origin: "loop", title: "loop docs-sweep", project: "neo" });
  expect(c.threadId).toBe(c.msgId);
  const tree = t.tree(c.msgId);
  expect(tree.thread?.origin).toBe("loop");
  expect(tree.thread?.project).toBe("neo");
  expect(tree.messages.map((m) => m.id)).toEqual([c.msgId]);
});

test("outbound without a cause writes an unthreaded row and never throws", () => {
  const { led, t } = setup();
  const id = t.outbound({ chatId: 7, text: "Neo started", kind: "notice" });
  expect(led.messageById(id)).toMatchObject({ kind: "notice", role: "assistant" });
  expect(led.messageById(id)?.threadId).toBeUndefined();
  // A cause whose thread was pruned still writes the line.
  expect(() => t.outbound({ chatId: 7, text: "late", cause: { msgId: 9000, threadId: 9000 } })).not.toThrow();
  expect(t.tree(id)).toMatchObject({ thread: undefined, pruned: false, messages: [] });
});

test("refreshThread: a session in-turn opens the thread; an approval makes it wait; endTurn finishes it", () => {
  const { led, reg, t } = setup();
  const c = t.inbound({ chatId: 7, text: "do it", surface: "telegram" });
  reg.add(order("o1"));
  reg.setCause("o1", c);
  t.refreshThread(c.threadId);
  expect(led.threadById(c.threadId)?.state).toBe("open");
  reg.noteBlocked("o1", { kind: "approval", label: "Bash", since: 1 });
  t.refreshThread(c.threadId);
  expect(led.threadById(c.threadId)?.state).toBe("waiting");
  reg.noteBlocked("o1", { kind: "decision", label: "q", since: 1 });
  t.refreshThread(c.threadId); // a blocked-on decision is not an approval; the ledger has no open decision row
  expect(led.threadById(c.threadId)?.state).toBe("open");
  reg.endTurn("o1");
  t.refreshThread(c.threadId);
  expect(led.threadById(c.threadId)?.state).toBe("done");
});

test("a new operator message in a done thread reopens it while a session works it", () => {
  const { led, reg, t } = setup();
  const root = t.inbound({ chatId: 7, text: "do it", surface: "web" });
  expect(led.threadById(root.threadId)?.state).toBe("done");
  reg.add(order("o1"));
  reg.setCause("o1", root);
  t.inbound({ chatId: 7, text: "and more", surface: "web", threadId: root.threadId });
  expect(led.threadById(root.threadId)?.state).toBe("open");
});

test("refreshThread on a pruned thread is a no-op", () => {
  const { t } = setup();
  expect(() => t.refreshThread(424242)).not.toThrow();
});

test("tree: any message of a thread returns the thread, its messages oldest first and its artifacts", () => {
  const { led, t } = setup();
  const root = t.inbound({ chatId: 7, text: "build it", surface: "telegram" });
  const out = t.outbound({ chatId: 7, text: "ok", cause: root, kind: "ack" });
  led.recordOrder(order("o9"), { cause: root });
  led.addTodo({ project: "p", folder: "/f", brief: "b", workClass: "interactive", createdBy: "operator", cause: root });
  led.recordToolAction({ orderId: "o9", tool: "Bash", label: "ls", verdict: "auto", cause: root });
  const tree = t.tree(out);
  expect(tree.thread?.id).toBe(root.threadId);
  expect(tree.messages.map((m) => m.id)).toEqual([root.msgId, out]);
  expect(tree.truncated).toBe(false);
  expect(tree.orders.map((o) => o.id)).toEqual(["o9"]);
  expect(tree.todos).toHaveLength(1);
  expect(tree.toolActions).toBe(1);
});

test("tree is bounded by limit and keeps the newest messages", () => {
  const { t } = setup();
  const root = t.inbound({ chatId: 7, text: "r", surface: "web" });
  const ids = [1, 2, 3, 4].map((i) => t.outbound({ chatId: 7, text: `l${i}`, cause: root }));
  const tree = t.tree(root.msgId, { limit: 2 });
  expect(tree.messages.map((m) => m.id)).toEqual(ids.slice(2));
  expect(tree.truncated).toBe(true);
});

test("tree says pruned when the thread row is gone", () => {
  const { t } = setup();
  const root = t.inbound({ chatId: 7, text: "r", surface: "web" });
  const out = t.outbound({ chatId: 7, text: "x", cause: root });
  // No raw handle to delete the row: a cause on a missing thread stands in for a pruned one.
  const ghost = t.outbound({ chatId: 7, text: "ghost", cause: { msgId: root.msgId, threadId: 777_777 } });
  const tree = t.tree(ghost);
  expect(tree).toMatchObject({ thread: undefined, pruned: true });
  expect(out).toBeGreaterThan(0);
});

test("refSuffix: ack, first reply and result-like lines get the ref; progress does not; off hides all", () => {
  expect(refSuffix("ack", false, "m4g2", "auto")).toBe(" · `m4g2`");
  expect(refSuffix("text", true, "m4g2", "auto")).toBe(" · `m4g2`");
  expect(refSuffix("text", false, "m4g2", "auto")).toBe("");
  expect(refSuffix("progress", false, "m4g2", "auto")).toBe("");
  for (const k of ["result", "decision", "alert", "digest", "plan"] as const) expect(refSuffix(k, false, "m4g2", "auto")).toBe(" · `m4g2`");
  expect(refSuffix("result", false, "m4g2", "off")).toBe("");
});

test("a line posted to another chat than it was recorded under is still found by (posted chat, channel id)", () => {
  const { led, t } = setup();
  const root = t.inbound({ chatId: 7, text: "deploy gold", surface: "telegram", channelMsgId: 1 });
  const out = t.outbound({ chatId: 7, text: "gold deployed", cause: root, kind: "result" });
  t.bindChannel(out, -100777, 50); // the Decisions group, not chat 7
  const reply = t.inbound({ chatId: -100777, text: "nice", surface: "telegram", channelMsgId: 51, replyTo: { chatId: -100777, channelMsgId: 50 } });
  expect(reply.threadId).toBe(root.threadId);
  expect(led.messageById(reply.msgId)?.causeId).toBe(out);
  // A binding is not a delivery route: reply routing still finds no project for it.
  expect(led.routeFor(-100777, 50)).toBeUndefined();
});

test("engine-started roots live in their own reserved chat, apart from the web console's chat 0", () => {
  const { led, t } = setup();
  expect(ENGINE_CHAT_ID).toBe(-4);
  const c = t.root({ origin: "loop", title: "loop docs-sweep" });
  expect(led.messageById(c.msgId)?.chatId).toBe(-4);
});
