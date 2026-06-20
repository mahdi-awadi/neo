// Per-project trust: when a folder is trusted, the engine auto-approves every tool for that
// project (full auto-approve, operator-chosen). Off by default = no row. Durable (its own
// sqlite file) so the choice survives restarts. No AI; the engine just records the toggle.
import { Database } from "bun:sqlite";

export interface TrustStore {
  /** Whether `folder` is trusted (auto-approve all). Absent ⇒ false. */
  isTrusted(folder: string): boolean;
  setTrust(folder: string, on: boolean): void;
  /** Trusted folders, sorted. */
  list(): string[];
}

export function openTrustStore(path: string): TrustStore {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS trust (folder TEXT PRIMARY KEY)`);
  return {
    isTrusted: (folder) => db.query(`SELECT 1 FROM trust WHERE folder = ?`).get(folder) !== null,
    setTrust: (folder, on) => {
      if (on) db.query(`INSERT OR IGNORE INTO trust (folder) VALUES (?)`).run(folder);
      else db.query(`DELETE FROM trust WHERE folder = ?`).run(folder);
    },
    list: () =>
      (db.query(`SELECT folder FROM trust ORDER BY folder`).all() as Array<{ folder: string }>).map((r) => r.folder),
  };
}
