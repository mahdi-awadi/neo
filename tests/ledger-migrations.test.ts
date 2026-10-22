import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync } from "node:fs";
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
