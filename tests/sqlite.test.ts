import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqlite, DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from "../src/engine/sqlite";
import { openLedger } from "../src/engine/ledger";
import { Database } from "bun:sqlite";

const file = () => join(mkdtempSync(join(tmpdir(), "neo-sqlite-")), "t.db");

test("every store opens in WAL mode with a busy timeout", () => {
  const db = openSqlite(file(), { busyTimeoutMs: 1234 });
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(1234);
  expect((openSqlite(":memory:").query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
});

test("a locked database is waited on (SQLite's own retry), not failed at once", () => {
  const path = file();
  const a = openSqlite(path);
  a.run("CREATE TABLE t (x INTEGER)");
  const b = openSqlite(path, { busyTimeoutMs: 300 });
  a.run("BEGIN IMMEDIATE");
  a.run("INSERT INTO t VALUES (1)");
  const t0 = performance.now();
  expect(() => b.run("INSERT INTO t VALUES (2)")).toThrow(/locked|busy/i);
  expect(performance.now() - t0).toBeGreaterThanOrEqual(250); // it waited for the lock
  a.run("COMMIT");
  b.run("INSERT INTO t VALUES (2)"); // and the lock gone, the write goes through
  expect((b.query("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(2);
});

test("the ledger opens through it", () => {
  const path = file();
  openLedger(path, { busyTimeoutMs: 4321 });
  const db = new Database(path); // a raw handle: WAL is a property of the file, set by the ledger
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
});
