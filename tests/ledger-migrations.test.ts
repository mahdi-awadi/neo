import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, MIGRATIONS } from "../src/engine/ledger-migrations";
import { openLedger } from "../src/engine/ledger";

const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

test("a fresh db migrates to the newest version", () => {
  const db = new Database(":memory:");
  const r = migrate(db, { path: ":memory:" });
  expect(r.from).toBe(0);
  expect(r.to).toBe(MIGRATIONS.at(-1)!.version);
  expect(version(db)).toBe(r.to);
});

test("migrate is idempotent", () => {
  const db = new Database(":memory:");
  migrate(db, { path: ":memory:" });
  const again = migrate(db, { path: ":memory:" });
  expect(again.from).toBe(again.to);
});

test("a pre-migration ledger (user_version 0, legacy schema) keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const legacy = new Database(path);
  legacy.run(`CREATE TABLE messages (chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL)`);
  legacy.run(`INSERT INTO messages VALUES (7, 'user', 'hello', 1000), (7, 'assistant', 'hi', 1001)`);
  legacy.close();
  const led = openLedger(path);
  expect(led.conversation(7).map((m) => m.content)).toEqual(["hello", "hi"]);
});

test("a file db that has tables gets a backup before its first pending migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const seed = new Database(path);
  seed.run(`CREATE TABLE orders (id TEXT PRIMARY KEY)`);
  seed.close();
  const r = migrate(new Database(path), { path });
  expect(r.backup).toBe(`${path}.bak-v0`);
  expect(existsSync(r.backup!)).toBe(true);
});

test("an empty new file db needs no backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  expect(migrate(new Database(path), { path }).backup).toBeUndefined();
});

test("a failing migration rolls back and throws", () => {
  const db = new Database(":memory:");
  const bad = [...MIGRATIONS, { version: 999, name: "boom", up: () => { throw new Error("boom"); } }];
  expect(() => migrate(db, { path: ":memory:", migrations: bad })).toThrow("boom");
  expect(version(db)).toBe(MIGRATIONS.at(-1)!.version); // the good ones stayed, 999 did not
});

test("a failure names the backup when one was made", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const seed = new Database(path);
  seed.run(`CREATE TABLE orders (id TEXT PRIMARY KEY)`);
  const bad = [{ version: 1, name: "boom", up: () => { throw new Error("boom"); } }];
  expect(() => migrate(seed, { path, migrations: bad })).toThrow(`${path}.bak-v0`);
});

test("migration 6 runs on a ledger that already has its indexes (an intermediate branch build made them)", () => {
  const db = new Database(":memory:");
  migrate(db, { path: ":memory:", migrations: MIGRATIONS.filter((m) => m.version <= 5) });
  db.run(`CREATE INDEX idx_threads_updated ON threads (updated_at DESC, id DESC)`);
  db.run(`CREATE INDEX idx_plans_thread ON plans (thread_id)`);
  expect(() => migrate(db, { path: ":memory:" })).not.toThrow();
  expect(version(db)).toBe(MIGRATIONS.at(-1)!.version);
});

// ADR-0036: a card posted before migration 11 is still redrawn — its message is its decision's message.
test("migration 11 fills each plan's card message from its review decision", () => {
  const db = new Database(":memory:");
  migrate(db, { path: ":memory:", migrations: MIGRATIONS.filter((x) => x.version <= 10) });
  db.run(`INSERT INTO decisions (id, kind, status, question, created_at, decision_chat_id, decision_message_id) VALUES ('d1', 'decision', 'open', 'q', 1, -100, 55)`);
  db.run(`INSERT INTO plans (project, folder, path, title, sha256, status, created_at, updated_at, decision_id) VALUES ('g', '/f', 'p.md', 't', 's', 'sent', 1, 1, 'd1')`);
  db.run(`INSERT INTO plans (project, folder, path, title, sha256, status, created_at, updated_at) VALUES ('g', '/f', 'q.md', 't', 's', 'draft', 1, 1)`);
  migrate(db, { path: ":memory:" });
  expect(db.query(`SELECT path, card_chat_id, card_message_id FROM plans ORDER BY path`).all()).toEqual([
    { path: "p.md", card_chat_id: -100, card_message_id: 55 },
    { path: "q.md", card_chat_id: null, card_message_id: null },
  ]);
});

// ADR-0043: project notes ride on attention items — four nullable columns and a sender index.
test("migration 12 adds the project-note columns and keeps old attention rows", () => {
  const db = new Database(":memory:");
  migrate(db, { path: ":memory:", migrations: MIGRATIONS.filter((x) => x.version <= 11) });
  db.run(
    `INSERT INTO attention_items (project, folder, source, kind, key, title, severity, first_seen, last_seen) VALUES ('p', '/f', 'git', 'dirty', 'k', 't', 'normal', 1, 1)`,
  );
  migrate(db, { path: ":memory:" });
  expect(version(db)).toBeGreaterThanOrEqual(12);
  expect(db.query(`SELECT from_project, cause_msg_id, resolution, acked_at FROM attention_items`).get()).toEqual({
    from_project: null, cause_msg_id: null, resolution: null, acked_at: null,
  });
  const idx = db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_attention_from'`).get();
  expect(idx).toEqual({ name: "idx_attention_from" });
});

// ADR-0050 rev. 2: questions and live notes ride on attention items too — three nullable columns and
// an index for the live-delivery read. Checked v12 → v13 on a copy of a file ledger.
test("migration 13 adds answer, delivered_at and from_session, and the (source, delivered_at) index, on a copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const v12 = new Database(path);
  migrate(v12, { path, migrations: MIGRATIONS.filter((x) => x.version <= 12) });
  v12.run(
    `INSERT INTO attention_items (project, folder, source, kind, key, title, severity, first_seen, last_seen, from_project) VALUES ('p', '/f', 'note', 'note_fyi', 'q:D1', 't', 'normal', 1, 1, 'q')`,
  );
  v12.close();
  const copy = join(dir, "copy.db");
  copyFileSync(path, copy);
  const db = new Database(copy);
  const r = migrate(db, { path: copy });
  expect(r.from).toBe(12);
  expect(version(db)).toBeGreaterThanOrEqual(13);
  expect(db.query(`SELECT answer, delivered_at, from_session FROM attention_items`).get()).toEqual({ answer: null, delivered_at: null, from_session: null });
  const idx = db.query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_attention_delivery'`).get() as { sql: string } | null;
  expect(idx?.sql).toContain("(source, delivered_at)");
  db.close();
  const [row] = openLedger(copy).attentionRows("p", "note");
  expect(row).toBeDefined();
  expect(row!.answer).toBeUndefined();
  expect(row!.deliveredAt).toBeUndefined();
  expect(row!.fromSession).toBeUndefined();
});

// ADR-0057: side lanes — a todo's lane and kind; an old row reads as the main lane.
test("migration 14 adds lane and lane_kind to project_todos; old rows read as the main lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const v13 = new Database(path);
  migrate(v13, { path, migrations: MIGRATIONS.filter((x) => x.version <= 13) });
  v13.run(`INSERT INTO project_todos (project, folder, brief, work_class, created_by, created_at, status, position) VALUES ('p', '/f', 'b', 'interactive', 'operator', 1, 'queued', 1)`);
  const before = (v13.query(`SELECT count(*) AS n FROM project_todos`).get() as { n: number }).n;
  v13.close();
  const db = new Database(path);
  expect(migrate(db, { path }).from).toBe(13);
  expect((db.query(`SELECT count(*) AS n FROM project_todos`).get() as { n: number }).n).toBe(before);
  expect(db.query(`SELECT lane, lane_kind FROM project_todos`).get()).toEqual({ lane: "main", lane_kind: null });
  db.close();
  const [t] = openLedger(path).listTodos({});
  expect(t!.lane).toBe("main");
  expect(t!.laneKind).toBeUndefined();
});

test("migration 15 adds attention facts and todo summaries; old rows read without them (ADR-0059)", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const v14 = new Database(path);
  migrate(v14, { path, migrations: MIGRATIONS.filter((x) => x.version <= 14) });
  v14.run(`INSERT INTO project_todos (project, folder, brief, work_class, created_by, created_at, status, position) VALUES ('p', '/f', 'b', 'interactive', 'operator', 1, 'queued', 1)`);
  v14.run(`INSERT INTO attention_items (project, folder, source, kind, key, title, severity, first_seen, last_seen) VALUES ('p', '/f', 'git', 'stale_branch', 'feat/x', 'feat/x: no commit for 26 days, not merged into main', 'normal', 1, 1)`);
  v14.close();
  const db = new Database(path);
  expect(migrate(db, { path }).from).toBe(14);
  expect(db.query(`SELECT summary FROM project_todos`).get()).toEqual({ summary: null });
  expect(db.query(`SELECT facts FROM attention_items`).get()).toEqual({ facts: null });
  db.close();
  const led = openLedger(path);
  expect(led.listTodos({})[0]!.summary).toBeUndefined();
  const [row] = led.attentionRows("p", "git");
  expect(row!.facts).toBeUndefined();
  // New rows carry them; an upsert refreshes the facts; bad JSON reads as none, never a throw.
  const t = led.addTodo({ project: "p", folder: "/f", brief: "b", workClass: "interactive", createdBy: "operator", summary: "Review PR #31" }, 2);
  expect(led.todoById(t.id)!.summary).toBe("Review PR #31");
  led.updateTodo(t.id, { summary: "Merge PR #31" });
  expect(led.todoById(t.id)!.summary).toBe("Merge PR #31");
  const id = led.insertAttention({ project: "p", folder: "/f", source: "git", kind: "stale_branch", key: "feat/y", title: "t", severity: "normal", facts: { branch: "feat/y", days: 26, base: "main" } }, 3);
  expect(led.attentionById(id)!.facts).toEqual({ branch: "feat/y", days: 26, base: "main" });
  led.updateAttention(id, { facts: "{not json" });
  expect(led.attentionById(id)!.facts).toBeUndefined();
});

test("migration 16 adds the pins table; pins round-trip, unpin is kept, clear removes (ADR-0065)", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const v15 = new Database(path);
  migrate(v15, { path, migrations: MIGRATIONS.filter((x) => x.version <= 15) });
  v15.close();
  const db = new Database(path);
  expect(migrate(db, { path }).from).toBe(15);
  expect(version(db)).toBeGreaterThanOrEqual(16);
  db.close();
  const led = openLedger(path);
  expect(led.listPins()).toEqual([]);
  led.setPin("att:7", "pinned", 10);
  led.setPin("dec:abc", "unpinned", 11);
  led.setPin("att:7", "pinned", 12); // re-pin: one row, newest time
  expect(led.listPins()).toEqual([
    { ref: "att:7", state: "pinned", at: 12 },
    { ref: "dec:abc", state: "unpinned", at: 11 },
  ]);
  led.setPin("att:7", null, 13);
  expect(led.listPins()).toEqual([{ ref: "dec:abc", state: "unpinned", at: 11 }]);
});

// ADR-0066 Decision 4: the task history's change feed — a table and AFTER triggers on the source tables.
test("migration 17 adds the history feed and its triggers to a v16 ledger with rows; backup and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const v16 = new Database(path);
  migrate(v16, { path, migrations: MIGRATIONS.filter((x) => x.version <= 16) });
  v16.run(`INSERT INTO orders (id, source, folder, task, chat_id, created_at) VALUES ('o1', 'neo', '/f', 'build it', -2, 1)`);
  v16.run(`INSERT INTO outcomes (order_id, status, summary, at) VALUES ('o1', 'done', 'built', 2)`);
  v16.run(`INSERT INTO messages (chat_id, role, content, at, kind) VALUES (1, 'user', 'please build', 1, 'text'), (-2, 'assistant', 'working', 2, 'text')`);
  v16.run(`INSERT INTO project_todos (project, folder, brief, work_class, created_by, created_at, status, position) VALUES ('p', '/f', 'b', 'interactive', 'operator', 1, 'queued', 1)`);
  v16.run(`INSERT INTO decisions (id, kind, question, status, created_at) VALUES ('d1', 'decision', 'q', 'open', 1)`);
  const before = (db: Database) =>
    ["orders", "outcomes", "messages", "project_todos", "decisions"].map((t) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
  const rowsBefore = before(v16);
  v16.close();

  const db = new Database(path);
  const r = migrate(db, { path });
  expect(r.from).toBe(16);
  expect(r.to).toBe(17);
  expect(r.backup).toBe(`${path}.bak-v16`);
  expect(existsSync(`${path}.bak-v16`)).toBe(true);
  expect(before(db)).toEqual(rowsBefore);
  // The feed starts empty: the history backfill reads the existing rows, the migration copies none.
  expect(db.query(`SELECT count(*) AS n FROM history_feed`).get()).toEqual({ n: 0 });
  const cols = (db.query(`PRAGMA table_info(history_feed)`).all() as Array<{ name: string; notnull: number; pk: number }>).map((c) => [c.name, c.notnull, c.pk]);
  expect(cols).toEqual([["id", 0, 1], ["tbl", 1, 0], ["key", 1, 0], ["op", 1, 0], ["at", 1, 0]]);
  const triggers = (db.query(`SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'history_feed_%'`).all() as Array<{ tbl_name: string }>).map((t) => t.tbl_name);
  expect(new Set(triggers)).toEqual(new Set(["orders", "outcomes", "project_todos", "plans", "attention_items", "decisions", "messages"]));
  expect(triggers.length).toBe(17);
  db.close();

  // Reopening runs nothing again; the backup is not rewritten; writes now feed.
  const again = new Database(path);
  expect(migrate(again, { path })).toEqual({ from: 17, to: 17, backup: undefined });
  again.close();
  const led = openLedger(path);
  led.recordOrder({ id: "o2", source: "neo", folder: "/f", task: "t", chatId: -2, createdAt: 3 });
  expect(led.historyFeed(0, 10).map((f) => [f.tbl, f.key, f.op])).toEqual([["orders", "o2", "u"]]);
});
