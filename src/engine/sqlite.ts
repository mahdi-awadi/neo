// One way to open a SQLite store (ADR-0010). WAL lets readers run while one writer writes, and
// `busy_timeout` makes a locked database SQLite's own retry-and-wait instead of an immediate
// SQLITE_BUSY — which, thrown on a hot path, used to take the whole daemon down.
import { Database } from "bun:sqlite";

/** Default wait for a locked database. The daemon passes `cfg.sqliteBusyTimeoutMs`. */
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openSqlite(path: string, opts: { busyTimeoutMs?: number } = {}): Database {
  const db = new Database(path);
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS))}`);
  if (path !== ":memory:" && path !== "") db.run("PRAGMA journal_mode = WAL");
  return db;
}
