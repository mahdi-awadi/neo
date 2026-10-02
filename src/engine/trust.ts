// Per-project trust: when a folder is trusted, the engine auto-approves every tool for that
// project (full auto-approve, operator-chosen). Durable (its own sqlite file) so the choice
// survives restarts. No AI; the engine just records the toggle.
//
// Each row is one folder the engine has SEEN, with its state: `on` (trusted) or `off` (seen, not
// trusted — an explicit `/trust off`, or a first sight while `trustNewProjects` was off). No row ⇒
// never seen ⇒ not trusted. Only `noteProject` (a project's first sight, at session start) may turn
// a never-seen folder on, and only when `trustNewProjects` is set — so an existing project, or one
// the operator turned off, is never silently re-trusted. Customer work never reaches this store:
// the customer path runs on `denyAllTrust()` (ingress.ts).
import { Database } from "bun:sqlite";
import type { Ledger } from "./ledger";
import type { Order } from "../types";

export interface TrustStore {
  /** Whether `folder` is trusted (auto-approve all). Never seen ⇒ false. Never writes. */
  isTrusted(folder: string): boolean;
  /** The operator's explicit choice (`/trust on|off`). `off` is remembered, so the folder is
   *  never trusted again by default. */
  setTrust(folder: string, on: boolean): void;
  /** Trusted folders, sorted. */
  list(): string[];
  /** A project's first sight (a session is starting for it). A never-seen folder is recorded —
   *  trusted when `trustNewProjects` is on, untrusted otherwise; a seen folder is left alone.
   *  Returns true only when this call trusted the folder. */
  noteProject(folder: string): boolean;
}

export interface TrustStoreOptions {
  /** OPERATOR CHOICE (`config.trustNewProjects`): a project seen for the first time starts
   *  trusted. Default false here, so a bare store keeps the original off-by-default behaviour. */
  trustNewProjects?: boolean;
  /** Folders that already exist as projects (the ledger's order history). Read ONCE, by the
   *  schema migration, and recorded as seen-untrusted, so turning the default on never trusts a
   *  project that predates it. */
  knownFolders?: () => Iterable<string>;
}

/** Schema version, kept in sqlite's `user_version`. 0 = the legacy `trust(folder)` table, where a
 *  row meant trusted; 1 = rows carry a `state`. */
const SCHEMA_VERSION = 1;

export function openTrustStore(path: string, opts: TrustStoreOptions = {}): TrustStore {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS trust (folder TEXT PRIMARY KEY)`);
  const version = (db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version;
  if (version < SCHEMA_VERSION) {
    db.transaction(() => {
      // Every legacy row was a trusted folder, so the new column defaults to `on` for them.
      db.run(`ALTER TABLE trust ADD COLUMN state TEXT NOT NULL DEFAULT 'on' CHECK (state IN ('on', 'off'))`);
      const seen = db.query(`INSERT OR IGNORE INTO trust (folder, state) VALUES (?, 'off')`);
      for (const folder of opts.knownFolders?.() ?? []) seen.run(folder);
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }
  const firstSight = opts.trustNewProjects ? "on" : "off";
  return {
    isTrusted: (folder) => db.query(`SELECT 1 FROM trust WHERE folder = ? AND state = 'on'`).get(folder) !== null,
    setTrust: (folder, on) => {
      db.query(
        `INSERT INTO trust (folder, state) VALUES (?, ?) ON CONFLICT (folder) DO UPDATE SET state = excluded.state`,
      ).run(folder, on ? "on" : "off");
    },
    list: () =>
      (db.query(`SELECT folder FROM trust WHERE state = 'on' ORDER BY folder`).all() as Array<{ folder: string }>).map(
        (r) => r.folder,
      ),
    noteProject: (folder) => {
      const res = db.query(`INSERT OR IGNORE INTO trust (folder, state) VALUES (?, ?)`).run(folder, firstSight);
      return res.changes > 0 && firstSight === "on";
    },
  };
}

/** The one call every operator-side session start makes before its worker runs: record the
 *  project's first sight and, when that trusted it by default, leave an audit event. A customer
 *  order never seeds trust (firewall). Never throws into the session path. */
export function noteProjectStart(deps: { trust: TrustStore; ledger: Ledger }, order: Order): void {
  if (order.source === "customer") return;
  try {
    if (deps.trust.noteProject(order.folder)) {
      deps.ledger.recordEvent("trust_default_on", { orderId: order.id, folder: order.folder });
    }
  } catch {
    // trust bookkeeping must never break a session start; the folder just stays untrusted
  }
}
