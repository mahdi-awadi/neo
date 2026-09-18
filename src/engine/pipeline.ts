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
import { neoMcpServers, raiseOperatorDecision, type DispatchDeps } from "./dispatch";
import { questionSummary } from "./structured-question";
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
import { canResumeWith } from "./sdk-choice";
import { describeSession } from "./session-status";
import type { Priority } from "./priority";
import {
  apiExhaustionWarning,
  apiFailureNotice,
  apiRetryFollowUp,
  apiRetryNotice,
  resolveApiRetryDelayMs,
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
   *  multi-project feed can show which project each message came from. `priority` (default
   *  PROGRESS) routes the line to a surface: DECISION/ALERT → the notified Decisions channel,
   *  PROGRESS/DONE → the muted firehose (see engine/priority.ts + the frontend). */
  reply: (chatId: number, text: string, project?: string, priority?: Priority) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
  /** Post a raised decision to the operator's Decisions channel (frontend-supplied; builds the
   *  inline keyboard). Threaded into neoMcpServers so the `ask_operator` tool can post — and its
   *  presence gates that tool (operator surfaces only; never the customer/ingress path). */
  postDecision?: DispatchDeps["postDecision"];
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
    const ttlMs = effectiveCacheTtlMs(deps.ledger.listCacheObservations(deps.cfg.contextPolicy.cacheObsWindow ?? CACHE_OBS_WINDOW), deps.cfg.contextPolicy);
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
    reply: (c, t, project, priority) => {
      ledger.recordMessage(c, "assistant", t);
      return rawReply(c, t, project, priority);
    },
    askApproval: async (c, reason) => {
      ledger.recordMessage(c, "assistant", `⚠ approve? ${reason}`);
      const decision = await rawAskApproval(c, reason);
      ledger.recordMessage(c, "user", `approval: ${decision}`);
      return decision;
    },
  };

  // Anthropic is actively REJECTING a window: say so, with its real reset, then carry on. This sits
  // ahead of every branch below because most operator messages are plain-text follow-ups that
  // return from branch 1 — warning only on `/open` would miss them. Advisory, never a refusal: the
  // engine does not gate the operator's own turn, it just stops them guessing why a turn failed
  // (ADR 0001). Default priority keeps it in their own chat — a rejected window lasts hours, and an
  // "alert" would repost this line into the unmuted Decisions channel on every message.
  const exhausted = apiExhaustionWarning(deps.usage?.rateLimits(), now());
  if (exhausted) await deps.reply(chatId, exhausted);

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
      // The operator's message IS the answer to whatever this session was blocked on (or replaces
      // the question) — keeping the block set would keep reporting awaiting-operator for a session
      // that is now working.
      registry.noteBlocked(live.id, undefined);
      if (oneShot) registry.clearFocus(chatId);
      await deps.reply(chatId, `↩︎ queued for ${live.name} — ${describeSession(registry, live, now(), deps.cfg.liveness)}`);
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
      // Resume only under the SDK that minted the id — after `/sdk claude` a Codex thread id (or
      // vice versa) is not a resume target, it is a dead session that kills the run.
      const resumable = live.sdkSessionId && canResumeWith(live.sdkProvider, deps.cfg.providers?.ownWork);
      const gate = resumable
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

  // 4. NO budget gate here — this is the operator's own interactive turn. The interactive reserve
  //    is a ceiling on BACKGROUND work (the scheduler and scheduler-fired dispatches read it), held
  //    FOR this turn; applying it here refused the very thing it protects (ADR 0001). The rate-limit
  //    warning that replaced it lives at the TOP of this function, because most operator messages
  //    are plain text and return from the follow-up branch long before reaching here.
  //    handleMessage is the operator's ONLY entry point (every caller uses the default source
  //    "neo"), so every worker it launches is classed `interactive` below — and the company's
  //    `dispatch` tool inherits that class, which is what keeps a conversational order from being
  //    held by a reserve that exists to serve it.

  // 5. Resume a prior session for this folder/chat, if one was recorded.
  const priorResume = ledger.lastSessionFor(parsed.folder, parsed.chatId, deps.cfg.providers?.ownWork);
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
      mcpServers: neoMcpServers({ ...deps, workRoot: deps.cfg.workRoot, dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs, dispatchTimeoutMaxMs: deps.cfg.dispatchTimeoutMaxMs, dispatchStallMs: deps.cfg.dispatchStallMs, dispatchGraceMs: deps.cfg.dispatchGraceMs, apiRetryLadderMs: deps.cfg.apiRetryLadderMs, apiRetryJitterFrac: deps.cfg.apiRetryJitterFrac, contextPolicy: deps.cfg.contextPolicy, workers: deps.cfg.workers, providers: deps.cfg.providers, workerEnv: deps.cfg.workerEnv, memory: deps.cfg.memory, companyFolder: deps.cfg.companyFolder }, chatId, { dispatch: false, workClass: "interactive", folder: parsed.folder, projectName: session.name, orderId: parsed.id, stitch: true, stitchKey: deps.cfg.stitchApiKey, codebaseMemoryBin: deps.cfg.codebaseMemoryBin, playwright: true }),
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
  const info = registry.get(id);
  const folder = info?.order.folder ?? "/nonexistent-neo-session";
  const isCompany = registry.getDefault()?.id === id;
  const base: RunDeps = {
    resume: sdkSessionId || undefined,
    mcpServers: neoMcpServers({ ...deps, workRoot: deps.cfg.workRoot, dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs, dispatchTimeoutMaxMs: deps.cfg.dispatchTimeoutMaxMs, dispatchStallMs: deps.cfg.dispatchStallMs, dispatchGraceMs: deps.cfg.dispatchGraceMs, apiRetryLadderMs: deps.cfg.apiRetryLadderMs, apiRetryJitterFrac: deps.cfg.apiRetryJitterFrac, contextPolicy: deps.cfg.contextPolicy, workers: deps.cfg.workers, providers: deps.cfg.providers, workerEnv: deps.cfg.workerEnv, memory: deps.cfg.memory, companyFolder: deps.cfg.companyFolder }, chatId, { dispatch: isCompany, workClass: "interactive", folder, projectName: info?.name, orderId: info?.order.id, stitch: true, stitchKey: deps.cfg.stitchApiKey, codebaseMemoryBin: deps.cfg.codebaseMemoryBin, playwright: true }),
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
        registry.noteOutput(registryId, now());
        void deps.reply(chatId, t, project);
      },
      // Liveness pulse on ANY streamed SDK event — the authoritative clock the watchdog, the idle
      // sweep and every status line read. Without it a worker mid-generation (a long turn writing
      // one huge file) reads as silent and is alerted on / swept as idle (docs/adr/0003-…).
      onHeartbeat: () => {
        try {
          registry.noteHeartbeat(registryId, now());
        } catch {
          // observer only — never break the worker path
        }
      },
      // An escalation suspends the worker mid-tool with no SDK events: mark it so it reads as
      // awaiting-operator rather than silent, and clear it the moment the operator answers.
      onEscalation: async (reason) => {
        try {
          registry.noteBlocked(registryId, { kind: "approval", label: reason, since: now() });
        } catch {
          /* observer only */
        }
        try {
          return await deps.askApproval(chatId, reason);
        } finally {
          try {
            registry.noteBlocked(registryId, undefined);
            registry.touch(registryId, now());
          } catch {
            /* observer only */
          }
        }
      },
      // Service the worker's native AskUserQuestion by raising a tracked structured decision. Gated on
      // postDecision (the operator surface wired it) — the same firewall gate as ask_operator.
      onStructuredQuestion: deps.postDecision
        ? async (ask) => {
            const question = questionSummary(ask);
            // The worker check-points and stops after raising this: awaiting the OPERATOR, not hung.
            try {
              registry.noteBlocked(registryId, { kind: "decision", label: question, since: now() });
            } catch {
              /* observer only */
            }
            await raiseOperatorDecision(
              { ledger, postDecision: deps.postDecision },
              { project, folder: order.folder, orderId: order.id, chatId, question, spec: ask },
            );
          }
        : undefined,
      onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      onEvent: (kind, data) => ledger.recordEvent(kind, { orderId: order.id, folder: order.folder, data }),
      autoApprove: () => deps.trust.isTrusted(order.folder),
      onAutoApprove: (reason) => {
        ledger.recordAutoApproval(order.id, reason);
        void deps.reply(chatId, `🔓 auto-approved: ${reason}`, project);
      },
      onActivity: (label) => {
        try {
          registry.noteActivity(registryId, label, now()); // advances the activity clock too
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
        const ladder = deps.cfg.apiRetryLadderMs;
        const maxRetries = ladder.length;
        const attempt = apiRetries + 1;
        // No `throttled` here: this is the operator's own turn being retried, and the background
        // reserve must not cut it short (ADR 0001). Only drain/interrupt/attempt-cap stop it.
        if (!shouldRetryApi({ kind, attempt, maxRetries, draining: deps.lifecycle?.draining() })) {
          ledger.recordEvent("api_giveup", { orderId: order.id, folder: order.folder, data: { scope: "interactive", project, kind, attempts: apiRetries } });
          void deps.reply(chatId, apiFailureNotice(project, kind, apiRetries), project, "alert");
          return;
        }
        apiRetries = attempt;
        const { delayMs, resetsAt, source } = resolveApiRetryDelayMs({
          attempt,
          rateLimits: deps.usage?.rateLimits(),
          now: now(),
          rand: deps.rand,
          ladder,
          jitterFrac: deps.cfg.apiRetryJitterFrac,
        });
        ledger.recordEvent("api_retry", { orderId: order.id, folder: order.folder, data: { scope: "interactive", project, kind, attempt, max: maxRetries, delayMs, source, resetsAt } });
        void deps.reply(chatId, apiRetryNotice(project, attempt, delayMs, resetsAt, maxRetries), project);
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
      // Tag the id with the SDK that minted it — a later resume under a different worker SDK must
      // start fresh instead of feeding it an id it has never heard of.
      registry.setSdkSessionId(registryId, result.sessionId, runDeps.provider);
      ledger.recordSession(order.id, result.sessionId, runDeps.provider);
    }
    meter.note({ costUsd: result.costUsd }, now());
    ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary);
    // Keep the project listed as idle; drop the dead handle so the next follow-up resumes.
    registry.setStatus(registryId, "idle");
    registry.touch(registryId, now());
    registry.noteBlocked(registryId, undefined); // the run is over — nothing is blocked
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
        const ttlMs = effectiveCacheTtlMs(ledger.listCacheObservations(deps.cfg.contextPolicy.cacheObsWindow ?? CACHE_OBS_WINDOW), deps.cfg.contextPolicy);
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
    // A completed interactive turn is DONE — it stays in the muted DM firehose (the operator is
    // already in this conversation; it is not a walked-away job, so it is NOT a `result` and must not
    // spam the group). A failed one is an ALERT the operator must see (Decisions). The frontend
    // prepends the single priority accent (🟢/🔴) — no per-call-site glyph here (Feature 2).
    void deps.reply(chatId, result.ok ? result.summary || "done" : result.summary || "failed", project, result.ok ? "done" : "alert");
  });

  return run;
}
