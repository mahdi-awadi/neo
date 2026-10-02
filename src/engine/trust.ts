// Per-project trust: when a folder is trusted, the engine auto-approves its escalations — except a
// fence escalation, which only the operator approves (ADR-0007). Durable (its own sqlite file) so
// the choice survives restarts. No AI; the engine just records the toggle.
//
// A trust record is explicit: trusted or untrusted. A folder with no record has not been seen yet;
// the first read records the trust default for it (`defaultForNewProjects`), so the default is
// fixed when the project is first seen and a later knob change never touches existing projects.
//
// Storage keeps `trust` exactly as before — a row means trusted — and records "untrusted" in a
// separate `trust_untrusted` table. Older code reads only `trust`, so rolling the engine back
// still sees every untrusted folder as untrusted (it fails closed, never open).
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

export interface TrustStore {
  /** Whether `folder` is trusted (auto-approve). First sight records the trust default. */
  isTrusted(folder: string): boolean;
  setTrust(folder: string, on: boolean): void;
  /** Trusted folders, sorted. */
  list(): string[];
}

export interface TrustStoreOptions {
  /** The trust a never-seen folder gets (config `trust.defaultForNewProjects`). Default false. */
  defaultForNewProjects?: boolean;
  /** Folders that already exist (from the ledger). Read once, by the migration, to freeze them at
   *  their current setting: any of them without a record is recorded untrusted. */
  knownFolders?: () => string[];
}

/** Schema version that added `trust_untrusted` (0 = only the presence-only `trust` table). */
const SCHEMA_VERSION = 2;

/** One key per folder: `/home/x/` and `/home/x` must never be two records. */
const key = (folder: string): string => resolve(folder);

export function openTrustStore(path: string, opts: TrustStoreOptions = {}): TrustStore {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS trust (folder TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS trust_untrusted (folder TEXT PRIMARY KEY)`);
  migrate(db, opts.knownFolders);

  const trusted = db.query(`SELECT 1 FROM trust WHERE folder = ?`);
  const untrusted = db.query(`SELECT 1 FROM trust_untrusted WHERE folder = ?`);
  const addTrusted = db.query(`INSERT OR IGNORE INTO trust (folder) VALUES (?)`);
  const delTrusted = db.query(`DELETE FROM trust WHERE folder = ?`);
  const addUntrusted = db.query(`INSERT OR IGNORE INTO trust_untrusted (folder) VALUES (?)`);
  const delUntrusted = db.query(`DELETE FROM trust_untrusted WHERE folder = ?`);
  const record = db.transaction((folder: string, on: boolean) => {
    if (on) {
      delUntrusted.run(folder);
      addTrusted.run(folder);
    } else {
      delTrusted.run(folder);
      addUntrusted.run(folder);
    }
  });

  return {
    isTrusted: (raw) => {
      const folder = key(raw);
      if (trusted.get(folder) !== null) return true;
      if (untrusted.get(folder) !== null) return false;
      const on = opts.defaultForNewProjects === true;
      record(folder, on); // first sight: the default becomes this folder's record
      return on;
    },
    setTrust: (raw, on) => record(key(raw), on),
    list: () =>
      (db.query(`SELECT folder FROM trust ORDER BY folder`).all() as Array<{ folder: string }>).map((r) => r.folder),
  };
}

/** Bring the db to SCHEMA_VERSION once: every folder the ledger already knows with no trust row
 *  was untrusted, so it is recorded untrusted — the default then reaches only new projects. */
function migrate(db: Database, knownFolders?: () => string[]): void {
  const { user_version } = db.query(`PRAGMA user_version`).get() as { user_version: number };
  if (user_version >= SCHEMA_VERSION) return;
  db.transaction(() => {
    const isTrusted = db.query(`SELECT 1 FROM trust WHERE folder = ?`);
    const freeze = db.query(`INSERT OR IGNORE INTO trust_untrusted (folder) VALUES (?)`);
    for (const folder of knownFolders?.() ?? []) {
      if (isTrusted.get(key(folder)) === null) freeze.run(key(folder));
    }
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}
