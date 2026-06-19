// Durable record of orders and their outcomes. The deterministic bookkeeping layer —
// the part of operant that already was an "engine" (ported to bun:sqlite, trimmed).
import { Database } from "bun:sqlite";
import type { Order, OrderSource } from "../types";

export interface Ledger {
  recordOrder(order: Order): void;
  recordOutcome(orderId: string, status: string, summary: string): void;
  getOutcome(orderId: string): { status: string; summary: string } | undefined;
  /** Persist the worker's SDK session id against an order, so it can later be resumed. */
  recordSession(orderId: string, sdkSessionId: string): void;
  /** The most recently recorded SDK session id for a folder/chat (for resume), if any. */
  lastSessionFor(folder: string, chatId: number): string | undefined;
  listRecent(limit?: number): Order[];
}

export function openLedger(path: string): Ledger {
  const db = new Database(path);
  db.run(
    `CREATE TABLE IF NOT EXISTS orders (
       id TEXT PRIMARY KEY, source TEXT NOT NULL, folder TEXT NOT NULL,
       task TEXT NOT NULL, chat_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
       sdk_session_id TEXT
     )`,
  );
  // Migrate dbs created before sdk_session_id existed.
  const cols = db.query(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "sdk_session_id")) {
    db.run(`ALTER TABLE orders ADD COLUMN sdk_session_id TEXT`);
  }
  db.run(
    `CREATE TABLE IF NOT EXISTS outcomes (
       order_id TEXT PRIMARY KEY, status TEXT NOT NULL, summary TEXT, at INTEGER NOT NULL
     )`,
  );

  return {
    recordOrder(o) {
      db.query(
        `INSERT OR REPLACE INTO orders (id, source, folder, task, chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(o.id, o.source, o.folder, o.task, o.chatId, o.createdAt);
    },
    recordOutcome(orderId, status, summary) {
      db.query(
        `INSERT OR REPLACE INTO outcomes (order_id, status, summary, at) VALUES (?, ?, ?, ?)`,
      ).run(orderId, status, summary, Date.now());
    },
    getOutcome(orderId) {
      const row = db
        .query(`SELECT status, summary FROM outcomes WHERE order_id = ?`)
        .get(orderId) as { status: string; summary: string } | null;
      return row ?? undefined;
    },
    recordSession(orderId, sdkSessionId) {
      db.query(`UPDATE orders SET sdk_session_id = ? WHERE id = ?`).run(sdkSessionId, orderId);
    },
    lastSessionFor(folder, chatId) {
      const row = db
        .query(
          `SELECT sdk_session_id FROM orders
           WHERE folder = ? AND chat_id = ? AND sdk_session_id IS NOT NULL AND sdk_session_id != ''
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(folder, chatId) as { sdk_session_id: string } | null;
      return row?.sdk_session_id ?? undefined;
    },
    listRecent(limit = 20) {
      const rows = db
        .query(
          `SELECT id, source, folder, task, chat_id, created_at
           FROM orders ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        id: string;
        source: string;
        folder: string;
        task: string;
        chat_id: number;
        created_at: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        source: r.source as OrderSource,
        folder: r.folder,
        task: r.task,
        chatId: r.chat_id,
        createdAt: r.created_at,
      }));
    },
  };
}
