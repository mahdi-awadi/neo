import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { migrate, MIGRATIONS } from "../src/engine/ledger-migrations";
import { todoTitle } from "../src/engine/todo-queue";

const DAY = 86_400_000;

/** A pre-migration (user_version 0) ledger file holding only the legacy 4-column messages table. */
function legacyDb(rows: Array<[number, string, string, number]>): string {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trace-")), "ledger.db");
  const db = new Database(path);
  db.run(`CREATE TABLE messages (chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL)`);
  const q = db.query(`INSERT INTO messages VALUES (?, ?, ?, ?)`);
  for (const r of rows) q.run(...r);
  db.close();
  return path;
}

test("insertMessage returns increasing ids and conversation() still reads oldest-first", () => {
  const led = openLedger(":memory:");
  const a = led.insertMessage({ chatId: 7, role: "user", content: "a", at: 1 });
  const b = led.insertMessage({ chatId: 7, role: "assistant", content: "b", at: 2 });
  expect(b).toBeGreaterThan(a);
  expect(led.conversation(7).map((m) => m.content)).toEqual(["a", "b"]);
});

test("recordMessage still works as a thin wrapper and writes a text row", () => {
  const led = openLedger(":memory:");
  led.recordMessage(7, "user", "hello");
  expect(led.conversation(7).map((m) => m.content)).toEqual(["hello"]);
});

test("messagesInThread pages newest-first with a keyset cursor", () => {
  const led = openLedger(":memory:");
  const root = led.insertMessage({ chatId: 7, role: "user", content: "r", at: 1 });
  led.insertThread({ id: root, origin: "operator", title: "r", state: "open", createdAt: 1 });
  const ids = [root];
  for (let i = 0; i < 5; i++)
    ids.push(led.insertMessage({ chatId: 7, role: "assistant", content: `x${i}`, at: 2 + i, threadId: root, causeId: root }));
  const page1 = led.messagesInThread(root, { limit: 2 });
  expect(page1.map((m) => m.id)).toEqual([ids[5], ids[4]]);
  const page2 = led.messagesInThread(root, { before: page1.at(-1)!.id, limit: 2 });
  expect(page2.map((m) => m.id)).toEqual([ids[3], ids[2]]);
  expect(page2[0]).toMatchObject({ chatId: 7, role: "assistant", content: "x2", threadId: root, causeId: root, kind: "text" });
});

test("insertMessage stores every optional field and reads it back", () => {
  const led = openLedger(":memory:");
  const id = led.insertMessage({
    chatId: 7, role: "assistant", content: "done", at: 5, threadId: 3, causeId: 3, surface: "telegram",
    channelMsgId: 900, project: "neo", folder: "/home/neo", orderId: "o1", kind: "result", priority: "result",
  });
  expect(led.messageByChannel(7, 900)).toEqual({
    id, chatId: 7, role: "assistant", content: "done", at: 5, threadId: 3, causeId: 3, surface: "telegram",
    channelMsgId: 900, project: "neo", folder: "/home/neo", orderId: "o1", kind: "result", priority: "result",
  });
});

test("setChannelMsg binds a Telegram id so messageByChannel finds the row", () => {
  const led = openLedger(":memory:");
  const id = led.insertMessage({ chatId: 7, role: "assistant", content: "hi", at: 1 });
  expect(led.messageByChannel(7, 42)).toBeUndefined();
  led.setChannelMsg(id, 7, 42);
  expect(led.messageByChannel(7, 42)?.id).toBe(id);
  expect(led.messageByChannel(8, 42)).toBeUndefined();
});

test("threads: insert, read, set state, touch", () => {
  const led = openLedger(":memory:");
  const root = led.insertMessage({ chatId: 7, role: "user", content: "fix the bug", at: 10 });
  led.insertThread({ id: root, origin: "operator", title: "fix the bug", state: "open", createdAt: 10, project: "neo", folder: "/home/neo" });
  expect(led.threadById(root)).toEqual({
    id: root, origin: "operator", project: "neo", folder: "/home/neo", title: "fix the bug", state: "open",
    closedByOperator: false, createdAt: 10, updatedAt: 10, lastMsgId: root,
  });
  led.setThreadState(root, "waiting", 20);
  expect(led.threadById(root)).toMatchObject({ state: "waiting", updatedAt: 20 });
  led.touchThread(root, 99, 30);
  expect(led.threadById(root)).toMatchObject({ lastMsgId: 99, updatedAt: 30, state: "waiting" });
  expect(led.threadById(12345)).toBeUndefined();
});

test("legacy rows are grouped into one legacy thread per chat per UTC day", () => {
  const path = legacyDb([
    [7, "user", "\n  first line of day one\nmore", 1 * DAY + 100],
    [7, "assistant", "reply one", 1 * DAY + 200],
    [8, "user", "other chat same day", 1 * DAY + 300],
    [7, "user", "x".repeat(200), 2 * DAY + 5],
    [7, "assistant", "reply two", 2 * DAY + 6],
  ]);
  const led = openLedger(path);
  // ids follow the old rowid order: 1..5
  expect(led.conversation(7).map((m) => m.content)).toEqual(["\n  first line of day one\nmore", "reply one", "x".repeat(200), "reply two"]);
  const t1 = led.threadById(1)!;
  expect(t1).toMatchObject({ origin: "legacy", state: "done", title: "first line of day one", createdAt: DAY + 100, updatedAt: DAY + 200, lastMsgId: 2 });
  expect(led.threadById(3)).toMatchObject({ origin: "legacy", state: "done", title: "other chat same day" });
  expect(led.threadById(4)).toMatchObject({ origin: "legacy", state: "done", title: todoTitle("x".repeat(200)), lastMsgId: 5 });
  expect(led.threadById(2)).toBeUndefined();
  expect(led.messagesInThread(1, { limit: 10 }).map((m) => m.id)).toEqual([2, 1]);
  expect(led.messagesInThread(3, { limit: 10 }).map((m) => m.id)).toEqual([3]);
  expect(led.messagesInThread(4, { limit: 10 }).map((m) => m.id)).toEqual([5, 4]);
  // a legacy row never claims a cause that was never recorded
  expect(led.messagesInThread(1, { limit: 10 }).every((m) => m.causeId === undefined)).toBe(true);
});

test("messages_fts finds Latin and Arabic words and follows inserts", () => {
  const path = legacyDb([[7, "user", "deploy the gold service", 1000]]);
  const led = openLedger(path);
  led.insertMessage({ chatId: 7, role: "user", content: "مرحبا بالعالم الجميل", at: 2000 });
  const db = new Database(path, { readonly: true });
  const hit = (q: string) => (db.query(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`).all(q) as Array<{ rowid: number }>).map((r) => r.rowid);
  expect(hit("gold")).toEqual([1]); // from the one-time rebuild
  expect(hit("بالعالم")).toEqual([2]); // from the insert trigger
  db.close();
});

test("recordOrder stores the cause; an order without a cause stays NULL", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trace-")), "ledger.db");
  const led = openLedger(path);
  led.recordOrder({ id: "o1", source: "neo", folder: "/f", task: "t", chatId: 7, createdAt: 1 }, { cause: { msgId: 11, threadId: 10 }, parentOrderId: "o0" });
  led.recordOrder({ id: "o2", source: "neo", folder: "/f", task: "t", chatId: 7, createdAt: 2 });
  const db = new Database(path, { readonly: true });
  const rows = db.query(`SELECT id, cause_msg_id, thread_id, parent_order_id FROM orders ORDER BY id`).all();
  expect(rows).toEqual([
    { id: "o1", cause_msg_id: 11, thread_id: 10, parent_order_id: "o0" },
    { id: "o2", cause_msg_id: null, thread_id: null, parent_order_id: null },
  ]);
  db.close();
});

test("the other writers store an optional cause", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trace-")), "ledger.db");
  const led = openLedger(path);
  const cause = { msgId: 21, threadId: 20 };
  const todo = led.addTodo({ project: "p", folder: "/f", brief: "b", workClass: "interactive", createdBy: "operator", cause });
  expect(todo.cause).toEqual(cause);
  expect(led.addTodo({ project: "p", folder: "/f", brief: "b2", workClass: "interactive", createdBy: "operator" }).cause).toBeUndefined();
  const dec = led.openDecision({ kind: "decision", question: "q?", cause });
  expect(led.decisionById(dec)?.cause).toEqual(cause);
  led.queueDispatcherReport("p", "done", 5, cause);
  led.rememberRoute(7, 500, { sessionId: "s", folder: "/f", project: "p" }, cause);
  led.recordEvent("dispatch_start", { orderId: "o1", cause });
  const db = new Database(path, { readonly: true });
  expect(db.query(`SELECT cause_msg_id, thread_id FROM dispatcher_inbox`).get()).toEqual({ cause_msg_id: 21, thread_id: 20 });
  expect(db.query(`SELECT msg_id, thread_id FROM message_routes`).get()).toEqual({ msg_id: 21, thread_id: 20 });
  expect(db.query(`SELECT msg_id FROM events`).get()).toEqual({ msg_id: 21 });
  db.close();
});

test("threadFacts counts open decisions and active todos, and reads the newest end", () => {
  const led = openLedger(":memory:");
  const root = led.insertMessage({ chatId: 7, role: "user", content: "r", at: 1 });
  led.insertThread({ id: root, origin: "operator", title: "r", state: "open", createdAt: 1 });
  const cause = { msgId: root, threadId: root };
  expect(led.threadFacts(root)).toEqual({ openDecisions: 0, activeTodos: 0, closedByOperator: false });

  led.openDecision({ kind: "decision", question: "q?", cause });
  const closed = led.openDecision({ kind: "decision", question: "q2?", cause });
  led.resolveDecision(closed, "yes");
  led.openDecision({ kind: "decision", question: "elsewhere" }); // not this thread
  const t1 = led.addTodo({ project: "p", folder: "/f", brief: "a", workClass: "interactive", createdBy: "operator", cause });
  led.addTodo({ project: "p", folder: "/f", brief: "b", workClass: "interactive", createdBy: "operator", cause });
  expect(led.threadFacts(root)).toEqual({ openDecisions: 1, activeTodos: 2, closedByOperator: false });

  led.updateTodo(t1.id, { status: "failed", endedAt: 100 });
  expect(led.threadFacts(root)).toMatchObject({ activeTodos: 1, lastEnd: "failed" });

  led.recordOrder({ id: "o9", source: "neo", folder: "/f", task: "t", chatId: 7, createdAt: 2 }, { cause });
  led.recordOutcome("o9", "done", "ok"); // outcome stamped Date.now() — newer than the todo end at 100
  expect(led.threadFacts(root).lastEnd).toBe("ok");
});

test("tool actions prune to toolActionsKeep in batches", () => {
  // 2000 single-row commits: on a disk-backed WAL file each one syncs (seconds in total), so use
  // tmpfs when the host has it. The 30s timeout is the backstop on a host without it.
  const base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const path = join(mkdtempSync(join(base, "neo-trace-")), "ledger.db");
  const led = openLedger(path, { toolActionsKeep: 1000 });
  for (let i = 0; i < 2000; i++)
    led.recordToolAction({ orderId: "o1", tool: "Bash", label: `ls ${i}`, verdict: "allow", at: i, cause: { msgId: 3, threadId: 2 }, folder: "/f" });
  const db = new Database(path, { readonly: true });
  const r = db.query(`SELECT count(*) AS n FROM tool_actions`).get() as { n: number };
  expect(r.n).toBeLessThanOrEqual(1000);
  expect(db.query(`SELECT label, msg_id, thread_id, folder, verdict FROM tool_actions ORDER BY id DESC LIMIT 1`).get()).toEqual({
    label: "ls 1999", msg_id: 3, thread_id: 2, folder: "/f", verdict: "allow",
  });
  expect(db.query(`SELECT count(*) AS n FROM tool_actions WHERE label = 'ls 0'`).get()).toEqual({ n: 0 });
  db.close();
  rmSync(dirname(path), { recursive: true, force: true });
}, 30_000);

test("EXPLAIN QUERY PLAN for messagesInThread uses idx_messages_thread", () => {
  const led = openLedger(":memory:");
  const plan = led._explain("messagesInThread"); // test-only seam returning the plan text
  expect(plan).toContain("idx_messages_thread");
});

test("migration reaches the newest user_version with the new tables", () => {
  const path = legacyDb([[7, "user", "hi", 1]]);
  openLedger(path);
  const db = new Database(path, { readonly: true });
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.at(-1)!.version);
  const names = (db.query(`SELECT name FROM sqlite_master`).all() as Array<{ name: string }>).map((r) => r.name);
  for (const n of ["meta", "threads", "messages_fts", "tool_actions", "plans", "idx_messages_thread", "idx_messages_channel", "idx_threads_project", "idx_threads_state", "idx_tool_actions_thread", "idx_orders_thread", "idx_project_todos_thread", "idx_decisions_thread", "idx_events_msg", "idx_threads_updated", "idx_plans_thread", "attention_items", "idx_attention_open", "engine_boots"])
    expect(names).toContain(n);
  db.close();
});

test("a ledger already at version 5 (P2 shipped) gets only the later versions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-v5-")), "ledger.db");
  const db = new Database(path);
  migrate(db, { path, migrations: MIGRATIONS.filter((m) => m.version <= 5) });
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
  expect(migrate(db, { path })).toMatchObject({ from: 5, to: MIGRATIONS.at(-1)!.version });
  const names = (db.query(`SELECT name FROM sqlite_master`).all() as Array<{ name: string }>).map((r) => r.name);
  expect(names).toContain("idx_threads_updated");
  db.close();
});

test("re-recording an order without a cause keeps its cause; a new cause replaces it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trace-")), "ledger.db");
  const led = openLedger(path);
  const order = { id: "o1", source: "neo" as const, folder: "/f", task: "t", chatId: 7, createdAt: 1 };
  led.recordOrder(order, { cause: { msgId: 11, threadId: 10 }, parentOrderId: "o0" });
  led.recordOrder({ ...order, task: "memory + t" }); // dispatch re-records after prepending memory
  const db = new Database(path, { readonly: true });
  const row = () => db.query(`SELECT task, cause_msg_id, thread_id, parent_order_id FROM orders WHERE id = 'o1'`).get();
  expect(row()).toEqual({ task: "memory + t", cause_msg_id: 11, thread_id: 10, parent_order_id: "o0" });
  led.recordOrder(order, { cause: { msgId: 21, threadId: 20 }, parentOrderId: "p1" });
  expect(row()).toEqual({ task: "t", cause_msg_id: 21, thread_id: 20, parent_order_id: "p1" });
  db.close();
});

test("re-remembering a route without a cause keeps its cause; a new cause replaces it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trace-")), "ledger.db");
  const led = openLedger(path);
  const target = { sessionId: "s", folder: "/f", project: "p" };
  led.rememberRoute(7, 500, target, { msgId: 21, threadId: 20 });
  led.rememberRoute(7, 500, { ...target, sessionId: "s2" });
  const db = new Database(path, { readonly: true });
  const row = () => db.query(`SELECT session_id, msg_id, thread_id FROM message_routes`).get();
  expect(row()).toEqual({ session_id: "s2", msg_id: 21, thread_id: 20 });
  led.rememberRoute(7, 500, target, { msgId: 31, threadId: 30 });
  expect(row()).toEqual({ session_id: "s", msg_id: 31, thread_id: 30 });
  db.close();
});
