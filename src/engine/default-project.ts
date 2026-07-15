// The default project — "the company" / chief-of-staff. It is the always-on fallback: when the
// operator sends a free-text order and no specific project is active, it routes here, and this
// project decides what to do (and, from Slice 2, dispatches to other projects). Rooted at the
// agent workspace so it loads its CLAUDE.md / memory via settingSources:["project"].
import { join } from "node:path";
import type { Order } from "../types";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import type { SessionInfo } from "../types";

export const DEFAULT_PROJECT = {
  /** Default company workspace: an `agent/` dir next to the running daemon. Override via the
   *  `companyFolder` config (COMPANY_FOLDER env) for a deployment that keeps it elsewhere. */
  folder: join(process.cwd(), "agent"),
  /** Reserved chat id: never a real Telegram/web chat, so findByChat() never returns the default. */
  chatId: -1,
  standby: "Company chief of staff — standing by for the operator's orders.",
} as const;

export function defaultOrder(now: number, folder: string = DEFAULT_PROJECT.folder): Order {
  return {
    id: crypto.randomUUID(),
    source: "neo",
    folder,
    task: DEFAULT_PROJECT.standby,
    chatId: DEFAULT_PROJECT.chatId,
    createdAt: now,
  };
}

/**
 * Register the always-on default project as an IDLE, pinned registry entry (no SDK run yet).
 * The first free-text order from a channel starts/resumes its session with THAT channel's reply,
 * so the worker's output goes back to whoever asked — not to a reply fixed at startup.
 */
export function registerDefaultProject(
  registry: Registry,
  ledger: Ledger,
  folder: string = DEFAULT_PROJECT.folder,
  now: () => number = Date.now,
): SessionInfo {
  const order = defaultOrder(now(), folder);
  ledger.recordOrder(order);
  const session = registry.add(order, now());
  registry.setStatus(session.id, "idle"); // idle = ready + resumable (no live worker until an order)
  registry.setDefault(session.id);
  return session;
}
