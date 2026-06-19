// Turn an inbound channel message into a structured Order.
// MVP format: "/open <folder> <task...>". Customer-channel intake (Gemini-read)
// lands in Phase 3.
import { existsSync } from "node:fs";
import type { Order, OrderSource } from "../types";

export function parseOrder(
  text: string,
  source: OrderSource,
  chatId: number,
): Order | { error: string } {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/open\s+(\S+)\s+(.+)$/s);
  if (!m) {
    if (!trimmed.startsWith("/open")) {
      return { error: "not an order — use: /open <folder> <task>" };
    }
    return { error: "missing folder or task — use: /open <folder> <task>" };
  }

  const folder = m[1];
  const task = m[2].trim();
  if (!existsSync(folder)) return { error: `folder not found: ${folder}` };

  return {
    id: crypto.randomUUID(),
    source,
    folder,
    task,
    chatId,
    createdAt: Date.now(),
  };
}
