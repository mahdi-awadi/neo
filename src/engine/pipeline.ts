// Frontend-agnostic message pipeline: a raw message + chat id -> follow-up routing /
// parse / route (firewall) / budget gate / start-or-resume a live SDK session -> record.
// Frontends (Telegram, later email/WhatsApp) supply `reply` and `askApproval`; the engine
// owns the logic + the live-session registry + the budget meter, so it's all testable
// without any channel.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NeoConfig } from "../config";
import type { Order, OrderSource, SessionInfo } from "../types";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { Meter } from "./budget";
import type { UsageMeter } from "./usage";
import type { TrustStore } from "./trust";
import { parseOrder } from "./orders";
import { route } from "./provider-router";
import { startOrder, type RunHandlers, type SessionRun, type RunDeps } from "./session-runner";
import { neoMcpServers } from "./dispatch";
import { sessionContext, decideContext, runHandoff } from "./context-policy";

/** Start a live session. Injectable for tests; defaults to the real SDK-backed runner. */
type StartFn = (order: Order, handlers: RunHandlers, deps?: RunDeps) => SessionRun;

export interface PipelineDeps {
  cfg: NeoConfig;
  ledger: Ledger;
  /** Shared live-session registry (concurrent projects, /status, /kill, idle-close). */
  registry: Registry;
  /** Shared budget guard protecting interactive headroom. */
  meter: Meter;
  /** Usage meter — receives rate_limit_event info from runs (for /usage). */
  usage?: UsageMeter;
  /** Deliver a worker-produced file back to the channel (the `send_file` tool calls this). */
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
  /** Per-project trust — when a folder is trusted, risky tools auto-approve. */
  trust: TrustStore;
  /** Send a line to the channel. `project` (a session's short name) tags worker output so a
   *  multi-project feed can show which project each message came from. */
  reply: (chatId: number, text: string, project?: string) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
  start?: StartFn;
  /** Injectable clock (registry touch + budget window). Defaults to Date.now. */
  now?: () => number;
  /** Test seams for the context policy (default: real transcript measurement + handoff run). */
  signals?: typeof sessionContext;
  handoff?: typeof runHandoff;
}

/** Apply the context policy to a persisted resume id. Returns the id to actually resume with
 *  ("" = start fresh). Never throws (fail open = keep the id). */
async function applyContextPolicy(
  folder: string,
  sessionInfo: SessionInfo | undefined,
  resumeId: string,
  deps: PipelineDeps,
): Promise<string> {
  if (!resumeId) return "";
  try {
    const signals = deps.signals ?? sessionContext;
    const sig = signals(folder, resumeId);
    const verdict = decideContext(sig, deps.cfg.contextPolicy);
    if (verdict === "keep") return resumeId;
    if (verdict === "clear") {
      deps.ledger.clearSessionsFor(folder);
      deps.ledger.recordContextEvent(folder, "clear", sig.occupancy);
      return "";
    }
    // handoff: run it against the fat session (bounded), which clears; then fresh.
    const handoff = deps.handoff ?? runHandoff;
    const target: SessionInfo = sessionInfo ?? {
      id: "",
      name: "",
      sdkSessionId: resumeId,
      order: { id: "", source: "neo", folder, task: "", chatId: 0, createdAt: 0 },
      status: "idle",
      startedAt: 0,
      lastActivityAt: 0,
    };
    await handoff(target, deps.cfg.contextPolicy, { registry: deps.registry, ledger: deps.ledger });
    return "";
  } catch {
    return resumeId; // fail open
  }
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

  // Durable conversation log: capture the inbound line, then wrap reply/askApproval so every
  // outbound line and approval round-trip is recorded too. Done once here, the single choke
  // point both directions pass through, so the whole transcript persists (Telegram + web alike).
  ledger.recordMessage(chatId, "user", text);
  const rawReply = deps.reply;
  const rawAskApproval = deps.askApproval;
  deps = {
    ...deps,
    reply: (c, t, project) => {
      ledger.recordMessage(c, "assistant", t);
      return rawReply(c, t, project);
    },
    askApproval: async (c, reason) => {
      ledger.recordMessage(c, "assistant", `⚠ approve? ${reason}`);
      const decision = await rawAskApproval(c, reason);
      ledger.recordMessage(c, "user", `approval: ${decision}`);
      return decision;
    },
  };

  // 1. Plain-text follow-up into the session for this chat, or — when nothing is active — into the
  //    always-on default project ("the company"), which decides what to do with the order.
  const live = registry.findByChat(chatId) ?? registry.getDefault();
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
    const resumeId = live.sdkSessionId ? await applyContextPolicy(live.order.folder, live, live.sdkSessionId, deps) : "";
    return startSession(resumed, live.id, chatId, deps, now, start, runConfigFor(live.id, registry, deps, chatId, resumeId));
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
  const priorResume = ledger.lastSessionFor(parsed.folder, parsed.chatId);
  const resume = priorResume ? await applyContextPolicy(parsed.folder, undefined, priorResume, deps) : "";

  ledger.recordOrder(parsed);
  await deps.reply(chatId, `opening ${parsed.folder} (${decision.provider})${resume ? " — resuming" : ""}…`);

  // 6. Register the project and start its live session (control handle for follow-up/kill/idle).
  const session = registry.add(parsed, now());
  return startSession(parsed, session.id, chatId, deps, now, start, {
    resume: resume || undefined,
    mcpServers: neoMcpServers({ ...deps, dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs, contextPolicy: deps.cfg.contextPolicy }, chatId, { dispatch: false, folder: parsed.folder, stitch: true, stitchKey: deps.cfg.stitchApiKey, gitnexusBin: deps.cfg.gitnexusBin, codebaseMemoryBin: deps.cfg.codebaseMemoryBin }),
  });
}

/**
 * Build the SDK run-config for a session. Every project gets `send_file`. The default project
 * ("the company") also gets the `dispatch` tool and runs at "low" effort (fast routing/deciding).
 */
function runConfigFor(
  id: string,
  registry: Registry,
  deps: PipelineDeps,
  chatId: number,
  sdkSessionId: string,
): RunDeps {
  const folder = registry.get(id)?.order.folder ?? "/nonexistent-neo-session";
  const isCompany = registry.getDefault()?.id === id;
  const base: RunDeps = {
    resume: sdkSessionId || undefined,
    mcpServers: neoMcpServers({ ...deps, dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs, contextPolicy: deps.cfg.contextPolicy }, chatId, { dispatch: isCompany, folder, stitch: true, stitchKey: deps.cfg.stitchApiKey, gitnexusBin: deps.cfg.gitnexusBin, codebaseMemoryBin: deps.cfg.codebaseMemoryBin }),
  };
  return isCompany ? { ...base, effort: "low" } : base;
}

/**
 * Start a worker run, attach its control handle to the registry entry, and supervise it.
 * On completion the project is kept as IDLE (resumable/selectable) — only the live control
 * handle is dropped; the idle watchdog or /kill removes the entry later. This is what lets
 * opened projects stay visible in /list and the web dashboard after a task finishes.
 */
function startSession(
  initialOrder: Order,
  registryId: string,
  chatId: number,
  deps: PipelineDeps,
  now: () => number,
  start: StartFn,
  runDeps: RunDeps = {},
): SessionRun {
  const { registry, meter, ledger } = deps;
  const project = registry.get(registryId)?.name; // tag worker output with the project name
  let order = initialOrder;
  if (!runDeps.resume && existsSync(join(order.folder, "HANDOFF.md"))) {
    order = { ...order, task: `Read HANDOFF.md first — it is the previous session's state-of-work note.\n\n${order.task}` };
  }
  const run = start(
    order,
    {
      onMessage: (t) => {
        registry.touch(registryId, now());
        void deps.reply(chatId, t, project);
      },
      onEscalation: (reason) => deps.askApproval(chatId, reason),
      onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      autoApprove: () => deps.trust.isTrusted(order.folder),
      onAutoApprove: (reason) => {
        ledger.recordAutoApproval(order.id, reason);
        void deps.reply(chatId, `🔓 auto-approved: ${reason}`, project);
      },
      onActivity: (label) => {
        try {
          registry.noteActivity(registryId, label, now());
        } catch {
          // observer only — never break the worker path
        }
      },
    },
    runDeps,
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
    try {
      if (result.sessionId) {
        const signals = deps.signals ?? sessionContext;
        const sig = signals(order.folder, result.sessionId);
        if (decideContext(sig, deps.cfg.contextPolicy) !== "keep") {
          const handoff = deps.handoff ?? runHandoff;
          const info = registry.get(registryId);
          if (info) void handoff(info, deps.cfg.contextPolicy, { registry, ledger });
        }
      }
    } catch {
      // policy is an observer — never break the completion path
    }
    void deps.reply(chatId, result.ok ? `✓ ${result.summary}` : `✗ ${result.summary || "failed"}`, project);
  });

  return run;
}
