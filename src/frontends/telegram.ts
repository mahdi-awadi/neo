// The channel you talk to projects through. Port/trim from operant's grammy bot.
// Phase 1: import { Bot } from "grammy"; on `/open <folder> <task>` build an Order,
// route it, run it via session-runner, stream messages back, render escalations as
// Allow/Deny inline buttons whose press resolves the blocked onEscalation promise.
import type { NeoConfig } from "../config";

export interface EngineHandlers {
  /** Handle a raw inbound message from an allowed user. */
  onMessage: (chatId: number, text: string) => Promise<void>;
}

export function startTelegram(_cfg: NeoConfig, _handlers: EngineHandlers): void {
  throw new Error("not implemented (Phase 1)");
}
