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
import type { UsageMeter } from "./usage";
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
  /** Usage meter — receives rate_limit_event info from runs (for /usage). */
  usage?: UsageMeter;
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

  // 1. Plain-text follow-up into the session for this chat (commands start with "/").
  const live = registry.findByChat(chatId);
  if (live && !text.trim().startsWith("/")) {
    const control = registry.getControl(live.id);
    if (control && live.status === "running") {
      // Live worker — push the follow-up into the running turn.
      control.followUp(text.trim());
      registry.touch(live.id, now());
      await deps.reply(chatId, `↩︎ added to ${live.name}`);
      return null;
    }
    // Idle/ended project — resume the SAME registry entry, carrying its sdk session id.
    const resumed: Order = { ...live.order, id: crypto.randomUUID(), task: text.trim(), createdAt: now() };
    ledger.recordOrder(resumed);
    registry.setStatus(live.id, "running");
    registry.touch(live.id, now());
    await deps.reply(chatId, `↩︎ resuming ${live.name}…`);
    return startSession(resumed, live.id, chatId, deps, now, start, live.sdkSessionId || undefined);
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

  // 6. Register the project and start its live session (control handle for follow-up/kill/idle).
  const session = registry.add(parsed, now());
  return startSession(parsed, session.id, chatId, deps, now, start, resume || undefined);
}

/**
 * Start a worker run, attach its control handle to the registry entry, and supervise it.
 * On completion the project is kept as IDLE (resumable/selectable) — only the live control
 * handle is dropped; the idle watchdog or /kill removes the entry later. This is what lets
 * opened projects stay visible in /list and the web dashboard after a task finishes.
 */
function startSession(
  order: Order,
  registryId: string,
  chatId: number,
  deps: PipelineDeps,
  now: () => number,
  start: StartFn,
  resume?: string,
): SessionRun {
  const { registry, meter, ledger } = deps;
  const run = start(
    order,
    {
      onMessage: (t) => void deps.reply(chatId, t),
      onEscalation: (reason) => deps.askApproval(chatId, reason),
      onRateLimit: (info) => deps.usage?.noteRateLimit(info),
    },
    resume ? { resume } : {},
  );
  registry.attachControl(registryId, run);

  void run.done.then((result) => {
    if (result.sessionId) {
      registry.setSdkSessionId(registryId, result.sessionId);
      ledger.recordSession(order.id, result.sessionId);
    }
    meter.note({ costUsd: result.costUsd }, now());
    ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary);
    // Keep the project listed as idle; drop the dead handle so the next follow-up resumes.
    registry.setStatus(registryId, "idle");
    registry.touch(registryId, now());
    registry.detachControl(registryId);
    void deps.reply(chatId, result.ok ? `✓ ${result.summary}` : `✗ ${result.summary || "failed"}`);
  });

  return run;
}
