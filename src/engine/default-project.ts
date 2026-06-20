// The default project — "the company" / chief-of-staff. It is the always-on fallback: when the
// operator sends a free-text order and no specific project is active, it routes here, and this
// project decides what to do (and, from Slice 2, dispatches to other projects). Rooted at the
// agent workspace so it loads its CLAUDE.md / memory via settingSources:["project"].
import type { Order } from "../types";

export const DEFAULT_PROJECT = {
  folder: "/home/neo/agent",
  /** Reserved chat id: never a real Telegram/web chat, so findByChat() never returns the default. */
  chatId: -1,
  /** First turn at startup — just confirms it's online; real orders arrive as follow-ups/resumes. */
  init: "You are now online as the company's chief of staff inside Neo. Reply with ONE short line confirming you're ready for the operator's orders.",
} as const;

export function defaultOrder(now: number): Order {
  return {
    id: crypto.randomUUID(),
    source: "neo",
    folder: DEFAULT_PROJECT.folder,
    task: DEFAULT_PROJECT.init,
    chatId: DEFAULT_PROJECT.chatId,
    createdAt: now,
  };
}
