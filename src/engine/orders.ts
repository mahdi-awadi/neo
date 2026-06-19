// Turn an inbound channel message into a structured Order.
// Phase 1 (TDD): parse "/open <folder> <task>", validate the folder exists,
// stamp id + createdAt. Customer-channel intake (Gemini-read) lands in Phase 3.
import type { Order, OrderSource } from "../types";

export function parseOrder(
  _text: string,
  _source: OrderSource,
  _chatId: number,
): Order | { error: string } {
  throw new Error("not implemented (Phase 1)");
}
