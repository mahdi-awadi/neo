// The task history's ledger change feed (migration v17, ADR-0066 Decision 4) and the history reads.
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/engine/ledger-migrations";
import { openLedger, DECISIONS_PRUNE_INTERVAL, TODOS_KEEP, type Ledger, type NewTodo, type HistoryFeedRow } from "../src/engine/ledger";
import { CUSTOMER_CHAT, SUB_CHAT, SIDE_CHAT } from "../src/engine/chats";
import * as dispatch from "../src/engine/dispatch";
import type { Order } from "../src/types";

const order = (over: Partial<Order> = {}): Order => ({ id: "o1", source: "neo", folder: "/p", task: "t", chatId: SUB_CHAT, createdAt: 1000, ...over });
const todo = (over: Partial<NewTodo> = {}): NewTodo => ({ project: "p", folder: "/p", brief: "b", workClass: "interactive", createdBy: "operator", ...over });

/** A file ledger and a raw handle on the same file (for the columns no ledger method writes). */
function fileLedger(opts: Parameters<typeof openLedger>[1] = {}): { led: Ledger; raw: Database } {
  const path = join(mkdtempSync(join(tmpdir(), "neo-feed-")), "ledger.db");
  const led = openLedger(path, opts);
  return { led, raw: new Database(path) };
}

/** The feed rows written by `fn`, without their id and time. */
function fed(led: Ledger, fn: () => void): Array<{ tbl: string; key: string; op: string }> {
  const after = led.historyFeedBounds().newest;
  fn();
  return led.historyFeed(after, 1000).map(({ tbl, key, op }) => ({ tbl, key, op }));
}

describe("the reserved chat ids", () => {
  test("live in chats.ts and dispatch.ts re-exports the same values", () => {
    expect([SUB_CHAT, CUSTOMER_CHAT, SIDE_CHAT]).toEqual([-2, -3, -5]);
    expect([dispatch.SUB_CHAT, dispatch.CUSTOMER_CHAT, dispatch.SIDE_CHAT]).toEqual([SUB_CHAT, CUSTOMER_CHAT, SIDE_CHAT]);
  });
});

describe("writes that give a feed row", () => {
  test("recordOrder: the insert and a re-record that changes the task", () => {
    const led = openLedger(":memory:");
    expect(fed(led, () => led.recordOrder(order({ id: "a" })))).toEqual([{ tbl: "orders", key: "a", op: "u" }]);
    expect(fed(led, () => led.recordOrder(order({ id: "a", task: "memory\n\nt" })))).toEqual([{ tbl: "orders", key: "a", op: "u" }]);
  });

  test("recordOutcome: the insert and the replace", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "a" }));
    expect(fed(led, () => led.recordOutcome("a", "running", "", 1))).toEqual([{ tbl: "outcomes", key: "a", op: "u" }]);
    expect(fed(led, () => led.recordOutcome("a", "done", "shipped", 2))).toEqual([{ tbl: "outcomes", key: "a", op: "u" }]);
  });

  test("addTodo and updateTodo of each watched column", () => {
    const { led, raw } = fileLedger();
    let id = 0;
    expect(fed(led, () => void (id = led.addTodo(todo()).id))).toEqual([{ tbl: "project_todos", key: String(id), op: "u" }]);
    const one = [{ tbl: "project_todos", key: String(id), op: "u" }];
    expect(fed(led, () => led.updateTodo(id, { brief: "b2" }))).toEqual(one);
    expect(fed(led, () => led.updateTodo(id, { summary: "s" }))).toEqual(one);
    expect(fed(led, () => led.updateTodo(id, { result: "r" }))).toEqual(one);
    expect(fed(led, () => led.updateTodo(id, { status: "running" }))).toEqual(one);
    expect(fed(led, () => led.updateTodo(id, { orderId: "o9" }))).toEqual(one);
    // No ledger method moves a todo's thread or project; a direct write is still seen.
    expect(fed(led, () => raw.query(`UPDATE project_todos SET thread_id = ? WHERE id = ?`).run(7, id))).toEqual(one);
    expect(fed(led, () => raw.query(`UPDATE project_todos SET project = ? WHERE id = ?`).run("q", id))).toEqual(one);
  });

  test("the todo prune gives a delete", () => {
    const led = openLedger(":memory:");
    const first = led.addTodo(todo()).id;
    led.updateTodo(first, { status: "done" });
    led.transaction(() => {
      for (let i = 0; i < TODOS_KEEP - 1; i++) led.updateTodo(led.addTodo(todo()).id, { status: "cancelled" });
    });
    const last = led.addTodo(todo()).id;
    const rows = fed(led, () => led.updateTodo(last, { status: "done" }));
    expect(rows).toContainEqual({ tbl: "project_todos", key: String(first), op: "d" });
    expect(led.todoById(first)).toBeUndefined();
  });

  test("upsertPlan: the insert and a changed status", () => {
    const led = openLedger(":memory:");
    const draft = { project: "p", folder: "/p", path: "docs/plan.md", title: "Plan", sha256: "s1", status: "draft" as const, stepsTotal: 2, stepsDone: 0 };
    let id = 0;
    expect(fed(led, () => void (id = led.upsertPlan(draft).id))).toEqual([{ tbl: "plans", key: String(id), op: "u" }]);
    expect(fed(led, () => led.upsertPlan({ ...draft, status: "sent" }))).toEqual([{ tbl: "plans", key: String(id), op: "u" }]);
  });

  test("insertAttention and updateAttention for note, github and git; pruneAttention gives a delete", () => {
    const led = openLedger(":memory:");
    for (const source of ["note", "github", "git"] as const) {
      let id = 0;
      const draft = { project: "p", folder: "/p", source, kind: "k", key: `k-${source}`, title: "t", severity: "normal" as const };
      expect(fed(led, () => void (id = led.insertAttention(draft, 1)))).toEqual([{ tbl: "attention_items", key: String(id), op: "u" }]);
      const one = [{ tbl: "attention_items", key: String(id), op: "u" }];
      expect(fed(led, () => led.updateAttention(id, { title: "t2" }))).toEqual(one);
      expect(fed(led, () => led.updateAttention(id, { detail: "d" }))).toEqual(one);
      expect(fed(led, () => led.updateAttention(id, { facts: JSON.stringify({ pr: 3 }) }))).toEqual(one);
      expect(fed(led, () => led.updateAttention(id, { resolution: "{}" }))).toEqual(one);
      expect(fed(led, () => led.updateAttention(id, { answer: "yes" }))).toEqual(one);
      expect(fed(led, () => led.updateAttention(id, { dismissed: true }))).toEqual(one);
      expect(fed(led, () => led.updateAttention(id, { dismissed: false, resolvedAt: 5 }))).toEqual(one);
      expect(fed(led, () => led.pruneAttention(source, 10))).toEqual([{ tbl: "attention_items", key: String(id), op: "d" }]);
    }
  });

  test("openDecision, resolveDecision, supersedeDecision", () => {
    const led = openLedger(":memory:");
    let a = "";
    expect(fed(led, () => void (a = led.openDecision({ kind: "decision", question: "q?" }, 1)))).toEqual([{ tbl: "decisions", key: a, op: "u" }]);
    expect(fed(led, () => led.resolveDecision(a, "yes", 2))).toEqual([{ tbl: "decisions", key: a, op: "u" }]);
    const b = led.openDecision({ kind: "decision", question: "q2?" }, 3);
    expect(fed(led, () => led.supersedeDecision(b, "moved on", 4))).toEqual([{ tbl: "decisions", key: b, op: "u" }]);
  });

  test("the decision prune gives a delete", () => {
    const led = openLedger(":memory:", { decisionsKeep: 1 });
    const ids: string[] = [];
    for (let i = 0; i < DECISIONS_PRUNE_INTERVAL; i++) ids.push(led.openDecision({ kind: "decision", question: `q${i}` }, i));
    const rows = fed(led, () => ids.forEach((id, i) => led.resolveDecision(id, "a", 1000 + i)));
    const deleted = rows.filter((r) => r.op === "d").map((r) => r.key);
    expect(deleted.length).toBe(DECISIONS_PRUNE_INTERVAL - 1);
    expect(deleted).not.toContain(ids.at(-1));
  });

  test("insertMessage for an operator line and a digest; setMessageThread on an operator line", () => {
    const led = openLedger(":memory:");
    let op = 0;
    let dg = 0;
    expect(fed(led, () => void (op = led.insertMessage({ chatId: 1, role: "user", content: "fix it", at: 1, surface: "telegram" })))).toEqual([{ tbl: "messages", key: String(op), op: "u" }]);
    expect(fed(led, () => void (dg = led.insertMessage({ chatId: 1, role: "assistant", content: "digest", at: 2, kind: "digest" })))).toEqual([{ tbl: "messages", key: String(dg), op: "u" }]);
    expect(fed(led, () => led.setMessageThread(op, 99))).toEqual([{ tbl: "messages", key: String(op), op: "u" }]);
  });
});

describe("writes that give no feed row", () => {
  test("a todo position move", () => {
    const led = openLedger(":memory:");
    led.addTodo(todo());
    const b = led.addTodo(todo()).id;
    expect(fed(led, () => led.moveTodo(b, 1))).toEqual([]);
    expect(led.todoById(b)!.position).toBe(1);
  });

  test("an engine attention item, and a last_seen-only update", () => {
    const led = openLedger(":memory:");
    expect(fed(led, () => {
      const e = led.insertAttention({ project: "p", folder: "/p", source: "engine", kind: "k", key: "e", title: "t", severity: "normal" }, 1);
      led.updateAttention(e, { title: "t2", resolvedAt: 2 });
      led.pruneAttention("engine", 10);
    })).toEqual([]);
    const g = led.insertAttention({ project: "p", folder: "/p", source: "git", kind: "k", key: "g", title: "t", severity: "normal" }, 1);
    expect(fed(led, () => led.updateAttention(g, { lastSeen: 9 }))).toEqual([]);
  });

  test("an unchanged rewrite of a watched column (a scan refreshing the same title and facts)", () => {
    const led = openLedger(":memory:");
    const g = led.insertAttention({ project: "p", folder: "/p", source: "github", kind: "k", key: "g", title: "t", severity: "normal", facts: { pr: 1 } }, 1);
    expect(fed(led, () => led.updateAttention(g, { title: "t", facts: JSON.stringify({ pr: 1 }), lastSeen: 5 }))).toEqual([]);
  });

  test("an engine-surface user line, and worker text and progress lines (the hot path)", () => {
    const led = openLedger(":memory:");
    expect(fed(led, () => {
      const e = led.insertMessage({ chatId: 1, role: "user", content: "engine said", at: 1, surface: "engine" });
      const t = led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "working", at: 2, kind: "text" });
      led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "50%", at: 3, kind: "progress" });
      led.recordMessage(SUB_CHAT, "assistant", "plain line");
      led.setMessageThread(e, 5);
      led.setMessageThread(t, 5);
    })).toEqual([]);
  });

  test("the hot-path triggers carry their condition in WHEN, so a worker line runs no feed insert", () => {
    const db = new Database(":memory:");
    migrate(db, { path: ":memory:" });
    const rows = db.query(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'history_feed_%' ORDER BY name`).all() as Array<{ name: string; tbl_name: string; sql: string }>;
    const sql = Object.fromEntries(rows.map((r) => [r.name, r.sql]));
    expect(Object.keys(sql)).toEqual([
      "history_feed_attention_ad", "history_feed_attention_ai", "history_feed_attention_au",
      "history_feed_decisions_ad", "history_feed_decisions_ai", "history_feed_decisions_au",
      "history_feed_messages_ai", "history_feed_messages_au",
      "history_feed_orders_ai", "history_feed_orders_au",
      "history_feed_outcomes_ai", "history_feed_outcomes_au",
      "history_feed_plans_ai", "history_feed_plans_au",
      "history_feed_todos_ad", "history_feed_todos_ai", "history_feed_todos_au",
    ]);
    const oneLine = (s: string) => s.replace(/\s+/g, " ");
    expect(oneLine(sql.history_feed_messages_ai!)).toContain("AFTER INSERT ON messages WHEN (new.role = 'user' AND coalesce(new.surface, '') <> 'engine') OR new.kind = 'digest' BEGIN");
    expect(oneLine(sql.history_feed_messages_au!)).toContain("AFTER UPDATE OF thread_id ON messages WHEN ((new.role = 'user' AND coalesce(new.surface, '') <> 'engine') OR new.kind = 'digest') AND (old.thread_id IS NOT new.thread_id) BEGIN");
    expect(oneLine(sql.history_feed_attention_ai!)).toContain("WHEN new.source IN ('note', 'github', 'git') BEGIN");
    // Each trigger body is one INSERT into the feed and nothing else.
    for (const body of Object.values(sql)) expect(body.match(/INSERT INTO history_feed/g)?.length).toBe(1);
    for (const body of Object.values(sql)) expect(body.match(/;/g)?.length).toBe(1);
  });
});

describe("the feed leaves ledger writes as they were", () => {
  /** The same writes through the real API; returns every id, count and read a caller sees. */
  function writeAll(led: Ledger): unknown[] {
    const out: unknown[] = [];
    led.recordOrder(order({ id: "a" }));
    led.recordOrder(order({ id: "a", task: "again" }));
    led.recordOutcome("a", "done", "s", 5);
    out.push(led.insertMessage({ chatId: 1, role: "user", content: "hi", at: 1 }));
    out.push(led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "w", at: 2 }));
    out.push(led.insertMessage({ chatId: 1, role: "assistant", content: "d", at: 3, kind: "digest" }));
    const t = led.addTodo(todo());
    out.push(t.id);
    led.updateTodo(t.id, { status: "done", result: "r" });
    out.push(led.insertAttention({ project: "p", folder: "/p", source: "git", kind: "k", key: "x", title: "t", severity: "normal" }, 1));
    out.push(led.upsertPlan({ project: "p", folder: "/p", path: "a.md", title: "A", sha256: "s", status: "draft", stepsTotal: 0, stepsDone: 0 }).id);
    const d = led.openDecision({ kind: "decision", question: "q" }, 1);
    led.resolveDecision(d, "yes", 2);
    led.recordOrder(order({ id: "b", createdAt: 1 }));
    out.push(led.endInterruptedOrders(10));
    out.push(led.searchMessages("hi", { limit: 10 }).map((h) => h.id));
    out.push(led.getOutcome("a"), led.todoById(t.id)?.status, led.decisionById(d)?.answer);
    return out;
  }

  function counts(path: string): Record<string, number> {
    const db = new Database(path, { readonly: true });
    const out: Record<string, number> = {};
    for (const t of ["orders", "outcomes", "messages", "project_todos", "attention_items", "plans", "decisions", "messages_fts"]) {
      out[t] = (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    db.close();
    return out;
  }

  test("ids, counts, changes and row counts match the same ledger with the feed triggers dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-feed-"));
    const bare = join(dir, "bare.db");
    const withFeed = join(dir, "feed.db");
    openLedger(bare);
    const raw = new Database(bare);
    for (const { name } of raw.query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'history_feed_%'`).all() as Array<{ name: string }>) raw.run(`DROP TRIGGER ${name}`);
    raw.close();
    const a = writeAll(openLedger(bare));
    const b = writeAll(openLedger(withFeed));
    expect(b).toEqual(a);
    expect(counts(withFeed)).toEqual(counts(bare));
    expect(openLedger(bare).historyFeed(0, 100)).toEqual([]);
  });

  test("a feed row per write and nothing else", () => {
    const led = openLedger(":memory:");
    writeAll(led);
    const feed = led.historyFeed(0, 1000);
    expect(feed.map((r) => `${r.tbl}:${r.key}`)).toEqual([
      "orders:a", "orders:a", "outcomes:a", "messages:1", "messages:3", "project_todos:1", "project_todos:1",
      "attention_items:1", "plans:1", "decisions:" + feed.find((r) => r.tbl === "decisions")!.key, "decisions:" + feed.find((r) => r.tbl === "decisions")!.key,
      "orders:b", "outcomes:b",
    ]);
    expect(feed.every((r) => r.op === "u" && Number.isInteger(r.at) && r.at > 1_700_000_000_000)).toBe(true);
  });
});

describe("feed reads", () => {
  test("historyFeed pages in id order; historyFeedBounds; pruneHistoryFeed keeps the newest", () => {
    const led = openLedger(":memory:");
    expect(led.historyFeedBounds()).toEqual({ newest: 0 });
    for (let i = 0; i < 5; i++) led.recordOrder(order({ id: `o${i}` }));
    const p1 = led.historyFeed(0, 2);
    expect(p1.map((r) => r.key)).toEqual(["o0", "o1"]);
    const p2 = led.historyFeed(p1.at(-1)!.id, 2);
    expect(p2.map((r) => r.key)).toEqual(["o2", "o3"]);
    expect(led.historyFeed(p2.at(-1)!.id, 2).map((r) => r.key)).toEqual(["o4"]);
    expect(led.historyFeedBounds()).toEqual({ oldest: 1, newest: 5 });
    expect(led.pruneHistoryFeed(2)).toBe(3);
    expect(led.historyFeedBounds()).toEqual({ oldest: 4, newest: 5 });
    expect(led.pruneHistoryFeed(2)).toBe(0);
    expect(led.pruneHistoryFeed(0)).toBe(2);
    // An empty feed still knows its newest id, so a cursor behind it is a gap, not "up to date".
    expect(led.historyFeedBounds()).toEqual({ newest: 5 });
    led.recordOrder(order({ id: "o9" }));
    expect(led.historyFeed(0, 10).map((r) => r.id)).toEqual([6]);
  });

  test("a bad page size or keep is bounded, never a throw or a wipe", () => {
    const led = openLedger(":memory:");
    for (let i = 0; i < 3; i++) led.recordOrder(order({ id: `o${i}` }));
    expect(led.historyFeed(0, Number.NaN).length).toBe(3);
    expect(led.historyFeed(0, -4).length).toBe(1);
    expect(led.pruneHistoryFeed(Number.NaN)).toBe(0);
    expect(led.pruneHistoryFeed(-1)).toBe(0);
    expect(led.historyFeed(0, 10).length).toBe(3);
  });

  test("EXPLAIN QUERY PLAN of the feed read uses the primary key", () => {
    const led = openLedger(":memory:");
    expect(led._explain("historyFeed")).toMatch(/SEARCH history_feed USING INTEGER PRIMARY KEY \(rowid>\?\)/);
  });
});

describe("historyRows and historyScan", () => {
  function seeded(): { led: Ledger; ids: Record<string, number | string> } {
    const led = openLedger(":memory:");
    const t = led.insertMessage({ chatId: 1, role: "user", content: "build it", at: 1, surface: "telegram", project: "p" });
    led.insertThread({ id: t, origin: "operator", title: "build it", state: "open", createdAt: 1, project: "p", folder: "/p" });
    led.recordOrder(order({ id: "o1", task: "do the thing" }), { cause: { msgId: t, threadId: t } });
    led.recordOrder(order({ id: "o2" }), { parentOrderId: "o1" });
    led.recordOutcome("o1", "done", "did it", 50);
    const todoRow = led.addTodo(todo({ brief: "the brief", cause: { msgId: t, threadId: t } }), 3);
    led.updateTodo(todoRow.id, { orderId: "o2" });
    const plan = led.upsertPlan({ project: "p", folder: "/p", path: "p.md", title: "Plan", sha256: "s", status: "draft", stepsTotal: 1, stepsDone: 0, threadId: t });
    const att = led.insertAttention({ project: "p", folder: "/p", source: "github", kind: "pr", key: "31", title: "PR 31", severity: "normal", facts: { pr: 31 } }, 4);
    const eng = led.insertAttention({ project: "p", folder: "/p", source: "engine", kind: "k", key: "e", title: "t", severity: "normal" }, 4);
    const dec = led.openDecision({ kind: "decision", question: "ship?", options: ["yes", "no"], project: "p", orderId: "o1", cause: { msgId: t, threadId: t } }, 5);
    const worker = led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "working", at: 6, kind: "text" });
    const digest = led.insertMessage({ chatId: 1, role: "assistant", content: "the digest", at: 7, kind: "digest" });
    return { led, ids: { t, todo: todoRow.id, plan: plan.id, att, eng, dec, worker, digest } };
  }

  test("each table gives the columns the sources need", () => {
    const { led, ids } = seeded();
    const [o1] = led.historyRows("orders", ["o1"]);
    expect(o1).toEqual({ key: "o1", row: { id: "o1", source: "neo", folder: "/p", task: "do the thing", chatId: SUB_CHAT, createdAt: 1000, threadId: ids.t as number, causeMsgId: ids.t as number } });
    const [o2] = led.historyRows("orders", ["o2"]);
    expect(o2!.row).toMatchObject({ parentOrderId: "o1", todoId: ids.todo });
    expect(led.historyRows("outcomes", ["o1"])).toEqual([{ key: "o1", row: { orderId: "o1", status: "done", summary: "did it", at: 50 } }]);
    const [t] = led.historyRows("project_todos", [String(ids.todo)]);
    expect(t!.row).toMatchObject({ id: ids.todo, brief: "the brief", project: "p", orderId: "o2", createdAt: 3, cause: { msgId: ids.t, threadId: ids.t } });
    expect(led.historyRows("plans", [String(ids.plan)])[0]!.row).toMatchObject({ title: "Plan", path: "p.md", threadId: ids.t });
    expect(led.historyRows("attention_items", [String(ids.att)])[0]!.row).toMatchObject({ source: "github", title: "PR 31", facts: { pr: 31 } });
    expect(led.historyRows("decisions", [String(ids.dec)])[0]!.row).toMatchObject({ question: "ship?", options: ["yes", "no"], status: "open" });
    expect(led.historyRows("messages", [String(ids.digest)])[0]!.row).toMatchObject({ content: "the digest", kind: "digest" });
  });

  test("rows that are not sources, unknown keys and bad keys give nothing", () => {
    const { led, ids } = seeded();
    expect(led.historyRows("attention_items", [String(ids.eng)])).toEqual([]);
    expect(led.historyRows("messages", [String(ids.worker)])).toEqual([]);
    expect(led.historyRows("orders", ["nope"])).toEqual([]);
    expect(led.historyRows("project_todos", ["x'; DROP TABLE orders; --", "1.5"])).toEqual([]);
    expect(led.historyRows("orders", [])).toEqual([]);
    expect(led.historyRows("orders", ["o1", "o2", "o1"]).map((r) => r.key)).toEqual(["o1", "o2"]);
  });

  test("historyScan pages each table in key order and skips non-sources", () => {
    const { led, ids } = seeded();
    const keys = (rows: Array<{ key: string }>) => rows.map((r) => r.key);
    expect(keys(led.historyScan("orders", undefined, 1))).toEqual(["o1"]);
    expect(keys(led.historyScan("orders", "o1", 10))).toEqual(["o2"]);
    expect(keys(led.historyScan("orders", "o2", 10))).toEqual([]);
    expect(keys(led.historyScan("messages", undefined, 10))).toEqual([String(ids.t), String(ids.digest)]);
    expect(keys(led.historyScan("messages", String(ids.t), 10))).toEqual([String(ids.digest)]);
    expect(keys(led.historyScan("attention_items", undefined, 10))).toEqual([String(ids.att)]);
    expect(keys(led.historyScan("outcomes", undefined, 10))).toEqual(["o1"]);
    expect(keys(led.historyScan("decisions", undefined, 10))).toEqual([String(ids.dec)]);
    expect(keys(led.historyScan("plans", undefined, 10))).toEqual([String(ids.plan)]);
    expect(keys(led.historyScan("project_todos", "0", 10))).toEqual([String(ids.todo)]);
  });

  test("the integer key order is numeric, not text", () => {
    const led = openLedger(":memory:");
    for (let i = 0; i < 12; i++) led.addTodo(todo());
    expect(led.historyScan("project_todos", "9", 2).map((r) => r.key)).toEqual(["10", "11"]);
  });
});

describe("historyLineage", () => {
  test("a chain of three orders, root first-seen last, with each node's thread origin", () => {
    const led = openLedger(":memory:");
    const t = led.insertMessage({ chatId: 1, role: "user", content: "go", at: 1 });
    led.insertThread({ id: t, origin: "operator", title: "go", state: "open", createdAt: 1 });
    led.recordOrder(order({ id: "root", chatId: 1 }), { cause: { msgId: t, threadId: t } });
    led.recordOrder(order({ id: "child" }), { parentOrderId: "root" });
    led.recordOrder(order({ id: "grand" }), { parentOrderId: "child" });
    const l = led.historyLineage(["grand"], { maxDepth: 8 }).get("grand")!;
    expect(l.chain.map((n) => n.id)).toEqual(["grand", "child", "root"]);
    expect(l.chain[2]).toEqual({ id: "root", chatId: 1, source: "neo", threadId: t, threadOrigin: "operator" });
    expect(l.complete).toBe(true);
    expect(l.missing).toBeUndefined();
    expect(l.tooDeep).toBe(false);
  });

  test("a CUSTOMER_CHAT root and an ingress thread are reported as facts", () => {
    const led = openLedger(":memory:");
    const t = led.insertMessage({ chatId: 1, role: "user", content: "mail", at: 1 });
    led.insertThread({ id: t, origin: "ingress", title: "mail", state: "open", createdAt: 1 });
    led.recordOrder(order({ id: "c", chatId: CUSTOMER_CHAT }), { cause: { msgId: t, threadId: t } });
    led.recordOrder(order({ id: "k" }), { parentOrderId: "c" });
    const l = led.historyLineage(["k"], { maxDepth: 8 }).get("k")!;
    expect(l.chain.at(-1)).toMatchObject({ id: "c", chatId: CUSTOMER_CHAT, threadOrigin: "ingress" });
    expect(l.complete).toBe(true);
  });

  test("a missing parent and an unknown order are not complete", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "orphan" }), { parentOrderId: "gone" });
    const m = led.historyLineage(["orphan", "unknown"], { maxDepth: 8 });
    expect(m.get("orphan")).toMatchObject({ complete: false, missing: "gone" });
    expect(m.get("orphan")!.chain.map((n) => n.id)).toEqual(["orphan"]);
    expect(m.get("unknown")).toEqual({ orderId: "unknown", chain: [], complete: false, missing: "unknown", tooDeep: false });
  });

  test("the depth cap: a chain longer than maxDepth is not complete; a cycle ends", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "n0" }));
    for (let i = 1; i <= 10; i++) led.recordOrder(order({ id: `n${i}` }), { parentOrderId: `n${i - 1}` });
    const deep = led.historyLineage(["n10", "n8"], { maxDepth: 8 });
    expect(deep.get("n10")).toMatchObject({ complete: false, tooDeep: true });
    expect(deep.get("n10")!.chain.length).toBe(9); // itself and 8 ancestors
    expect(deep.get("n8")).toMatchObject({ complete: true, tooDeep: false });
    led.recordOrder(order({ id: "x" }), { parentOrderId: "y" });
    led.recordOrder(order({ id: "y" }), { parentOrderId: "x" });
    expect(led.historyLineage(["x"], { maxDepth: 8 }).get("x")).toMatchObject({ complete: false, tooDeep: true });
  });

  test("no ids gives an empty map", () => {
    expect(openLedger(":memory:").historyLineage([], { maxDepth: 8 }).size).toBe(0);
  });
});

describe("searchWorkerLines", () => {
  function seeded(): Ledger {
    const led = openLedger(":memory:");
    const ing = led.insertMessage({ chatId: 1, role: "user", content: "customer mail", at: 1 });
    led.insertThread({ id: ing, origin: "ingress", title: "mail", state: "open", createdAt: 1 });
    led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "deploy failed on alpha", at: 10, kind: "text", project: "p" });
    led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "deploy progress alpha", at: 20, kind: "progress", project: "q" });
    led.insertMessage({ chatId: CUSTOMER_CHAT, role: "assistant", content: "deploy alpha for the customer", at: 30, kind: "text", project: "p" });
    led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "deploy alpha on an ingress thread", at: 40, kind: "text", project: "p", threadId: ing });
    led.insertMessage({ chatId: 1, role: "user", content: "deploy alpha please", at: 50, project: "p" });
    led.insertMessage({ chatId: 1, role: "assistant", content: "deploy alpha digest", at: 60, kind: "digest", project: "p" });
    led.insertMessage({ chatId: SUB_CHAT, role: "assistant", content: "deploy alpha result", at: 70, kind: "result", project: "p" });
    return led;
  }

  test("only worker text and progress lines, never CUSTOMER_CHAT or an ingress thread, newest first", () => {
    const hits = seeded().searchWorkerLines("deploy alpha", { limit: 50 });
    expect(hits.map((h) => h.at)).toEqual([20, 10]);
    expect(hits[0]!.snippet).toContain("alpha");
  });

  test("the project and date filters", () => {
    const led = seeded();
    expect(led.searchWorkerLines("deploy", { project: "p", limit: 50 }).map((h) => h.at)).toEqual([10]);
    expect(led.searchWorkerLines("deploy", { since: 15, limit: 50 }).map((h) => h.at)).toEqual([20]);
    expect(led.searchWorkerLines("deploy", { until: 15, limit: 50 }).map((h) => h.at)).toEqual([10]);
  });

  test("a malformed query gives no lines, never a throw", () => {
    const led = seeded();
    for (const q of ['"', "AND OR", "NEAR(", "*", "", "   "]) expect(led.searchWorkerLines(q, { limit: 50 })).toEqual([]);
  });
});
