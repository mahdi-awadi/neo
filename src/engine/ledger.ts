// Durable record of orders and their outcomes. Port/trim from operant's store.ts
// (SQLite via bun:sqlite). The deterministic bookkeeping layer — the part of operant
// that already was an "engine".
import type { Order } from "../types";

export interface Ledger {
  recordOrder(order: Order): void;
  recordOutcome(orderId: string, status: string, summary: string): void;
  listRecent(limit?: number): Order[];
}

export function openLedger(_path: string): Ledger {
  throw new Error("not implemented (Phase 1)");
}
