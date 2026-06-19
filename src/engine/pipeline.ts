// Frontend-agnostic message pipeline: a raw message + chat id -> follow-up routing /
// parse / route (firewall) / budget gate / start-or-resume a live SDK session -> record.
// Frontends (Telegram, later email/WhatsApp) supply `reply` and `askApproval`; the engine
// owns the logic + the live-session registry + the budget meter, so it's all testable
// without any channel.
import type { NeoConfig } from "../config";
import type { Order, OrderSource } from "../types";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { Meter } from "./budget";
import { parseOrder } from "./orders";
import { route } from "./provider-router";
import { startOrder, type RunHandlers, type SessionRun } from "./session-runner";

/** Start a live session. Injectable for tests; defaults to the real SDK-backed runner. */
type StartFn = (order: Order, handlers: RunHandlers, deps?: { resume?: string }) => SessionRun;

export interface PipelineDeps {
  cfg: NeoConfig;
  ledger: Ledger;
  /** Shared live-session registry (concurrent projects, /status, /kill, idle-close). */
  registry: Registry;
  /** Shared budget guard protecting interactive headroom. */
  meter: Meter;
  reply: (chatId: number, text: string) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
  start?: StartFn;
  /** Injectable clock (registry touch + budget window). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Handle one inbound message. Returns the live `SessionRun` when it started/resumed a
 * session, or `null` for a follow-up / error / refusal / throttle.
 */
export async function handleMessage(
  text: string,
  chatId: number,
  deps: PipelineDeps,
  source: OrderSource = "neo",
): Promise<SessionRun | null> {
  const { registry, meter, ledger } = deps;
  const now = deps.now ?? (() => Date.now());
  const start = deps.start ?? startOrder;

  // 1. Plain-text follow-up into the live session for this chat (commands start with "/").
  const live = registry.findByChat(chatId);
  if (live && !text.trim().startsWith("/")) {
    registry.getControl(live.id)?.followUp(text.trim());
    registry.touch(live.id, now());
    await deps.reply(chatId, `↩︎ added to ${live.name}`);
    return null;
  }

  // 2. Parse a new order.
  const parsed = parseOrder(text, source, chatId);
  if ("error" in parsed) {
    await deps.reply(chatId, parsed.error);
    return null;
  }

  // 3. Compliance firewall — customer work never reaches the subscription.
  const decision = route(parsed, deps.cfg);
  if ("refuse" in decision) {
    await deps.reply(chatId, `refused: ${decision.refuse}`);
    return null;
  }

  // 4. Budget guard — never drain the interactive headroom you use yourself.
  if (meter.shouldThrottle(now())) {
    await deps.reply(chatId, "throttled: protecting interactive headroom — try again shortly");
    return null;
  }

  // 5. Resume a prior session for this folder/chat, if one was recorded.
  const resume = ledger.lastSessionFor(parsed.folder, parsed.chatId);

  ledger.recordOrder(parsed);
  await deps.reply(chatId, `opening ${parsed.folder} (${decision.provider})${resume ? " — resuming" : ""}…`);

  // 6. Start the live session and register it (control handle for follow-up / kill / idle).
  const session = registry.add(parsed, now());
  const run = start(
    parsed,
    {
      onMessage: (t) => void deps.reply(chatId, t),
      onEscalation: (reason) => deps.askApproval(chatId, reason),
    },
    resume ? { resume } : {},
  );
  registry.attachControl(session.id, run);

  // 7. Supervise: when the session ends (completion / idle-close / kill), record + clean up.
  void run.done.then((result) => {
    if (result.sessionId) {
      registry.setSdkSessionId(session.id, result.sessionId);
      ledger.recordSession(parsed.id, result.sessionId);
    }
    meter.note({ costUsd: result.costUsd }, now());
    ledger.recordOutcome(parsed.id, result.ok ? "done" : "error", result.summary);
    registry.setStatus(session.id, result.ok ? "done" : "error");
    registry.remove(session.id);
    void deps.reply(chatId, result.ok ? `✓ ${result.summary}` : `✗ ${result.summary || "failed"}`);
  });

  return run;
}
