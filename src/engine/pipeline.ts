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
import type { CodebaseMemoryIndexer } from "./codebase-memory";
import { memorySnapshot, memoryEnabledFor } from "./memory";
import {
  sessionContext,
  decideContext,
  runHandoff,
  effectiveCacheTtlMs,
  transcriptLineCount,
  firstAssistantCacheReadAfter,
  CACHE_OBS_WINDOW,
} from "./context-policy";
import { profileDeps } from "./worker-profile";
import { describeSessionStatus } from "./session-status";
import {
  apiFailureNotice,
  apiRetryDelayMs,
  apiRetryFollowUp,
  apiRetryNotice,
  shouldRetryApi,
  type ApiCooldown,
} from "./api-retry";

/** Real backoff wait (tests inject deps.sleep instead). */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Start a live session. Injectable for tests; defaults to the real SDK-backed runner. */
type StartFn = (order: Order, handlers: RunHandlers, deps?: RunDeps) => SessionRun;

// Registry ids currently mid pre-resume-handoff (F3): the idle-resume branch sets
// status "running" up front but has no control handle attached until AFTER the (possibly
// minutes-wide) applyContextPolicy await settles and startSession runs. Without this guard,
// a second inbound message during that window sees status "running" + no control and takes
// the SAME idle-resume branch again, starting a second concurrent resume of the same entry.
const resuming = new Set<string>();

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
  /** Test seams for the LEARNED-cache-TTL observation helpers (default: real transcript reads). */
  lineCount?: typeof transcriptLineCount;
  cacheRead?: typeof firstAssistantCacheReadAfter;
  /** Graceful-reload gate: while draining, no new orders/follow-ups start (see engine/reload.ts). */
  lifecycle?: { draining(): boolean };
  /** Shared API-throttle gate: a session throttled here arms it, and background work reads it
   *  (see engine/api-retry.ts). Absent → retries still happen, they just don't hold sibling work. */
  cooldown?: ApiCooldown;
  /** Injectable wait for the retry backoff (tests pass a no-op). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source for the retry backoff. Defaults to Math.random. */
  rand?: () => number;
  /** Engine-side codebase-memory index guarantee, spread into the company `dispatch` tool's deps so
   *  a dispatched folder is indexed before its worker starts. */
  codebaseMemory?: CodebaseMemoryIndexer;
}

/** Apply the context policy to a persisted resume id. Returns the id to actually resume with
 *  ("" = start fresh), the idle gap measured at gate time (before the resume), and — on "keep" —
 *  the OLD transcript's line count at that same moment, so the caller can later scan only the
 *  lines a resume appends and find its first (not just its last) post-resume assistant turn (see
 *  firstAssistantCacheReadAfter). Never throws (fail open = keep the id, no preLines). */
async function applyContextPolicy(
  folder: string,
  sessionInfo: SessionInfo | undefined,
  resumeId: string,
  deps: PipelineDeps,
): Promise<{ resumeId: string; idleMs: number; preLines?: number }> {
  if (!resumeId) return { resumeId: "", idleMs: 0 };
  try {
    const signals = deps.signals ?? sessionContext;
    const sig = signals(folder, resumeId, { windowTokensByModel: deps.cfg.contextPolicy.windowTokensByModel });
    const ttlMs = effectiveCacheTtlMs(deps.ledger.listCacheObservations(CACHE_OBS_WINDOW), deps.cfg.contextPolicy);
    const verdict = decideContext(sig, deps.cfg.contextPolicy, ttlMs);
    if (verdict === "keep") {
      const lineCount = deps.lineCount ?? transcriptLineCount;
      const preLines = lineCount(folder, resumeId);
      return { resumeId, idleMs: sig.idleMs, preLines };
    }
    if (verdict === "clear") {
      deps.ledger.clearSessionsFor(folder);
      deps.ledger.recordContextEvent(folder, "clear", sig.occupancy);
      return { resumeId: "", idleMs: 0 };
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
    await handoff(target, deps.cfg.contextPolicy, {
      registry: deps.registry,
      ledger: deps.ledger,
      runDeps: profileDeps(deps.cfg, "handoff"),
      memoryFlush: memoryEnabledFor(deps.cfg.memory, folder, deps.cfg.companyFolder),
    });
    return { resumeId: "", idleMs: 0 };
  } catch {
    return { resumeId, idleMs: 0 }; // fail open
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

  // Graceful reload in progress — refuse up front so nothing new starts mid-drain.
  if (deps.lifecycle?.draining()) {
    await deps.reply(chatId, "♻️ Neo is reloading — open sessions are being saved; send that again in a moment.");
    return null;
  }

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

  // 1. Plain-text follow-up. The DEFAULT target is the always-on company (source:"neo"), which
  //    decides what to do with the order. A project is addressed EXPLICITLY and ONE-SHOT: a chat's
  //    focus (mode "once") reverts to the company after this one message, so a stray next message
  //    never sticks to a project. An explicit `/pin` (mode "pinned") holds focus across messages.
  const focus = registry.getFocus(chatId);
  const live = focus?.session ?? registry.getDefault();
  if (live && !text.trim().startsWith("/")) {
    const oneShot = focus?.mode === "once"; // consumed once we actually deliver this message
    const control = registry.getControl(live.id);
    if (control && live.status === "running") {
      // Live worker — the follow-up queues behind the in-flight turn. Report the REAL status, not a
      // bare "busy": what it's doing, for how long, and how deep the queue is.
      control.followUp(text.trim());
      registry.touch(live.id, now());
      if (oneShot) registry.clearFocus(chatId);
      const queued = control.queued?.() ?? 0;
      await deps.reply(chatId, `↩︎ queued for ${live.name} — ${describeSessionStatus(live, now(), { queued })}`);
      return null;
    }
    // Idle/ended project — resume the SAME registry entry, carrying its sdk session id.
    if (resuming.has(live.id)) {
      // Focus intentionally NOT consumed here — the re-send should still reach this project.
      await deps.reply(chatId, `⏳ ${live.name} is reopening — send that again in a moment`);
      return null;
    }
    const resumed: Order = { ...live.order, id: crypto.randomUUID(), task: text.trim(), createdAt: now() };
    ledger.recordOrder(resumed);
    registry.setStatus(live.id, "running");
    registry.touch(live.id, now());
    if (oneShot) registry.clearFocus(chatId);
    await deps.reply(chatId, `↩︎ resuming ${live.name}…`);
    resuming.add(live.id);
    try {
      const gate = live.sdkSessionId
        ? await applyContextPolicy(live.order.folder, live, live.sdkSessionId, deps)
        : { resumeId: "", idleMs: 0 };
      return startSession(
        resumed,
        live.id,
        chatId,
        deps,
        now,
        start,
        runConfigFor(live.id, registry, deps, chatId, gate.resumeId),
        gate.idleMs,
        gate.preLines,
      );
    } finally {
      resuming.delete(live.id);
    }
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
  const gate = priorResume ? await applyContextPolicy(parsed.folder, undefined, priorResume, deps) : { resumeId: "", idleMs: 0 };
  const resume = gate.resumeId;

  ledger.recordOrder(parsed);
  await deps.reply(chatId, `opening ${parsed.folder} (${decision.provider})${resume ? " — resuming" : ""}…`);

  // 6. Register the project and start its live session (control handle for follow-up/kill/idle).
  const session = registry.add(parsed, now());
  return startSession(
    parsed,
    session.id,
    chatId,
    deps,
    now,
    start,
    profileDeps(deps.cfg, "project", {
      resume: resume || undefined,
      mcpServers: neoMcpServers({ ...deps, workRoot: deps.cfg.workRoot, dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs, dispatchTimeoutMaxMs: deps.cfg.dispatchTimeoutMaxMs, dispatchStallMs: deps.cfg.dispatchStallMs, dispatchGraceMs: deps.cfg.dispatchGraceMs, contextPolicy: deps.cfg.contextPolicy, workers: deps.cfg.workers, workerEnv: deps.cfg.workerEnv, memory: deps.cfg.memory, companyFolder: deps.cfg.companyFolder }, chatId, { dispatch: false, folder: parsed.folder, stitch: true, stitchKey: deps.cfg.stitchApiKey, codebaseMemoryBin: deps.cfg.codebaseMemoryBin }),
    }),
    gate.idleMs,
    gate.preLines,
  );
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
    mcpServers: neoMcpServers({ ...deps, workRoot: deps.cfg.workRoot, dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs, dispatchTimeoutMaxMs: deps.cfg.dispatchTimeoutMaxMs, dispatchStallMs: deps.cfg.dispatchStallMs, dispatchGraceMs: deps.cfg.dispatchGraceMs, contextPolicy: deps.cfg.contextPolicy, workers: deps.cfg.workers, workerEnv: deps.cfg.workerEnv, memory: deps.cfg.memory, companyFolder: deps.cfg.companyFolder }, chatId, { dispatch: isCompany, folder, stitch: true, stitchKey: deps.cfg.stitchApiKey, codebaseMemoryBin: deps.cfg.codebaseMemoryBin }),
  };
  return profileDeps(deps.cfg, isCompany ? "company" : "project", base);
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
  /** The idle gap measured at the context-policy gate, BEFORE this resume (0 for a fresh start).
   *  Threaded through so the run.done handler below can record a LEARNED-cache-TTL observation
   *  against a real gapMs once the resumed turn actually completes. */
  resumeIdleMs = 0,
  /** The OLD transcript's line count at that same gate moment (undefined = unmeasured/fresh start).
   *  Lets the run.done handler scan only the lines THIS resume appended, so it finds the FIRST
   *  post-resume assistant turn rather than the run's last one (see firstAssistantCacheReadAfter). */
  resumePreLines?: number,
): SessionRun {
  const { registry, meter, ledger } = deps;
  const project = registry.get(registryId)?.name; // tag worker output with the project name
  let runRef: SessionRun | undefined; // set below — the retry pushes the brief back into this run
  let apiRetries = 0;
  let order = initialOrder;
  if (!runDeps.resume && existsSync(join(order.folder, "HANDOFF.md"))) {
    order = { ...order, task: `Read HANDOFF.md first — it is the previous session's state-of-work note.\n\n${order.task}` };
  }
  // Frozen memory snapshot: computed ONCE here, at worker start, gated the same way as the
  // HANDOFF.md note above (`!runDeps.resume` = an actual fresh SDK start, never a queued
  // follow-up into a live worker). Default `scopes: []` → memoryEnabledFor is always false.
  if (!runDeps.resume && memoryEnabledFor(deps.cfg.memory, order.folder, deps.cfg.companyFolder)) {
    const snap = memorySnapshot(order.folder, deps.cfg.memory);
    if (snap) order = { ...order, task: `${snap}\n\n${order.task}` };
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
          registry.touch(registryId, now());
        } catch {
          // observer only — never break the worker path
        }
      },
      // A turn the API refused is NOT a completed turn: the brief never ran. Wait out the throttle
      // and push the same brief back into the (still live) session instead of dropping the work.
      onTurnComplete: (result) => {
        const kind = result.apiError;
        if (!kind) return;
        deps.cooldown?.note(kind, now()); // hold sibling background work while the storm lasts
        const attempt = apiRetries + 1;
        if (!shouldRetryApi({ kind, attempt, draining: deps.lifecycle?.draining(), throttled: meter.shouldThrottle() })) {
          void deps.reply(chatId, apiFailureNotice(project, kind), project);
          return;
        }
        apiRetries = attempt;
        const delayMs = apiRetryDelayMs(attempt, deps.rand);
        void deps.reply(chatId, apiRetryNotice(project, attempt, delayMs), project);
        void (deps.sleep ?? realSleep)(delayMs).then(() => {
          registry.touch(registryId, now());
          runRef?.followUp(apiRetryFollowUp(order.task));
        });
      },
    },
    runDeps,
  );
  runRef = run;
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
    // LEARNED cache-TTL observation: this was a resume (runDeps.resume set) — was the prompt
    // cache still warm on the FIRST post-resume turn (not just some later turn in this run, which
    // would already hit the cache that first turn rewarmed)? If the SDK forked a new transcript
    // file for the resume (result.sessionId !== runDeps.resume — resume normally KEEPS the id,
    // per docs/sdk-notes.md), that new transcript's first turn is cold BY CONSTRUCTION (a fresh
    // file, not a real idle-gap miss) — recording it (even as a "skip if unreadable" best effort)
    // would poison the learner with data that doesn't reflect the idle gap being measured. Same
    // "skip, don't guess" rule as everywhere else here: a fork records NOTHING. Only the
    // non-forked path scans the lines appended after the pre-resume line count captured at gate
    // time — undefined (unmeasured) also means skip. Best-effort: a broken/unreadable transcript
    // must never misrecord a false miss, so it's skipped rather than recorded as 0.
    if (runDeps.resume && result.sessionId && result.sessionId === runDeps.resume && resumePreLines !== undefined) {
      try {
        const cacheReadFn = deps.cacheRead ?? firstAssistantCacheReadAfter;
        const cacheRead = cacheReadFn(order.folder, result.sessionId, resumePreLines);
        if (cacheRead !== undefined) ledger.recordCacheObservation(resumeIdleMs, cacheRead > 0);
      } catch {
        // best-effort — never affects the resume itself
      }
    }
    try {
      if (result.sessionId) {
        const signals = deps.signals ?? sessionContext;
        const sig = signals(order.folder, result.sessionId, { windowTokensByModel: deps.cfg.contextPolicy.windowTokensByModel });
        const ttlMs = effectiveCacheTtlMs(ledger.listCacheObservations(CACHE_OBS_WINDOW), deps.cfg.contextPolicy);
        if (decideContext(sig, deps.cfg.contextPolicy, ttlMs) !== "keep") {
          const handoff = deps.handoff ?? runHandoff;
          const info = registry.get(registryId);
          if (info) {
            void handoff(info, deps.cfg.contextPolicy, {
              registry,
              ledger,
              runDeps: profileDeps(deps.cfg, "handoff"),
              memoryFlush: memoryEnabledFor(deps.cfg.memory, order.folder, deps.cfg.companyFolder),
            });
          }
        }
      }
    } catch {
      // policy is an observer — never break the completion path
    }
    void deps.reply(chatId, result.ok ? `✓ ${result.summary}` : `✗ ${result.summary || "failed"}`, project);
  });

  return run;
}
