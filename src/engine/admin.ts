// Trust-on-first-use admin enrollment. Neo is a personal engine with one operator: the
// first Telegram id to message the bot claims admin, and thereafter only that id is allowed
// — on both the Telegram bot and the web-console login. Durable (its own sqlite file) so the
// claim survives restarts. No AI, no config to hand-edit; the first message wins.
import { Database } from "bun:sqlite";

export interface AdminStore {
  /** Claim admin for `telegramId` if unclaimed. Returns whether this id is the admin. */
  claimAdmin(telegramId: number): boolean;
  /** The enrolled admin id, or undefined before anyone has claimed. */
  adminId(): number | undefined;
  isAdmin(telegramId: number): boolean;
}

export function openAdminStore(path: string): AdminStore {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  function adminId(): number | undefined {
    const row = db.query(`SELECT value FROM meta WHERE key = 'admin'`).get() as { value: string } | null;
    return row ? Number(row.value) : undefined;
  }

  return {
    adminId,
    claimAdmin(telegramId) {
      // INSERT OR IGNORE only writes when unclaimed, so the first caller wins atomically.
      db.query(`INSERT OR IGNORE INTO meta (key, value) VALUES ('admin', ?)`).run(String(telegramId));
      return adminId() === telegramId;
    },
    isAdmin: (telegramId) => adminId() === telegramId,
  };
}
