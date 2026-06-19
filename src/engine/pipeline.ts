// Frontend-agnostic order pipeline: a raw message + chat id -> parse -> route (firewall)
// -> run via the SDK worker -> record. Frontends (Telegram, later email/WhatsApp) supply
// `reply` and `askApproval`; the pipeline owns the logic so it's testable without any channel.
import type { NeoConfig } from "../config";
import type { Order } from "../types";
import type { Ledger } from "./ledger";
import { parseOrder } from "./orders";
import { route } from "./provider-router";
import { runOrder, type RunHandlers, type RunResult } from "./session-runner";

type RunFn = (order: Order, handlers: RunHandlers) => Promise<RunResult>;

export interface PipelineDeps {
  cfg: NeoConfig;
  ledger: Ledger;
  reply: (chatId: number, text: string) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
  /** Injectable for tests; defaults to the real SDK-backed runner. */
  run?: RunFn;
}

export async function handleOrder(text: string, chatId: number, deps: PipelineDeps): Promise<void> {
  const run = deps.run ?? ((o, h) => runOrder(o, h));

  const parsed = parseOrder(text, "neo", chatId);
  if ("error" in parsed) {
    await deps.reply(chatId, parsed.error);
    return;
  }

  const decision = route(parsed, deps.cfg);
  if ("refuse" in decision) {
    await deps.reply(chatId, `refused: ${decision.refuse}`);
    return;
  }

  deps.ledger.recordOrder(parsed);
  await deps.reply(chatId, `opening ${parsed.folder} (${decision.provider})…`);

  const result = await run(parsed, {
    onMessage: (t) => void deps.reply(chatId, t),
    onEscalation: (reason) => deps.askApproval(chatId, reason),
  });

  deps.ledger.recordOutcome(parsed.id, result.ok ? "done" : "error", result.summary);
  await deps.reply(chatId, result.ok ? `✓ ${result.summary}` : `✗ ${result.summary || "failed"}`);
}
