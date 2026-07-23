// The `dispatch` tool — given ONLY to the default project ("the company"). It lets the
// chief-of-staff open one of the operator's projects and run a self-contained brief in it, as a
// tracked, governed Neo sub-project (registry → dashboard, escalations → operator, metered),
// then returns that project's result for the company to summarise. The company writes the brief
// (a tailored prompt), so the sub-project gets a clear order, not the operator's raw message.
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Order, SessionInfo } from "../types";
import type { NeoConfig, WorkerPathName, WorkerProfile, MemoryCfg } from "../config";
import { memorySnapshot, memoryScopeEnabled } from "./memory";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { Meter } from "./budget";
import type { UsageMeter } from "./usage";
import type { TrustStore } from "./trust";
import { runOrder, startOrder, type RunResult } from "./session-runner";
import { DEFAULT_PROJECT } from "./default-project";
import { decideContext, sessionContext, runHandoff, effectiveCacheTtlMs, CACHE_OBS_WINDOW, windowTokensFor, type ContextPolicyCfg } from "./context-policy";
import { describeSessionStatus, sessionsReport } from "./session-status";
import type { CodebaseMemoryIndexer } from "./codebase-memory";
import { memoryTools } from "./memory-tool";
import { profileDeps } from "./worker-profile";
import {
  apiFailureNotice,
  apiHoldMessage,
  apiRetryDelayMs,
  apiRetryFollowUp,
  apiRetryNotice,
  shouldRetryApi,
  type ApiCooldown,
} from "./api-retry";

/** Real backoff wait (tests inject opts.sleep instead). */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reserved chat id for dispatched sub-projects, so they never hijack the operator's free-text
 *  routing (which always falls back to the default project). */
export const SUB_CHAT = -2;

/** Function-scoped scratch workspaces (research, dev, marketing, …) for work with no project home. */
export const DESKS_DIR = join(DEFAULT_PROJECT.folder, "desks");

/** Everything dispatch needs — a structural subset of the pipeline's deps. */
export interface DispatchDeps {
  ledger: Ledger;
  registry: Registry;
  meter: Meter;
  usage?: UsageMeter;
  trust: TrustStore;
  reply: (chatId: number, text: string, project?: string) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
  /** Deliver a worker-produced file back to the operator's channel (Telegram/web). */
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
  /** Default per-dispatch ceiling (ms) when the caller doesn't request one. Default DISPATCH_TIMEOUT_MS_DEFAULT. */
  dispatchTimeoutMs?: number;
  /** Hard cap (ms) on any caller-requested ceiling. Default DISPATCH_TIMEOUT_MAX_MS_DEFAULT (2h). */
  dispatchTimeoutMaxMs?: number;
  /** Abort a sub-run with NO activity for this long (ms) — a busy worker stays alive up to the
   *  ceiling. Default DISPATCH_STALL_MS_DEFAULT (5m). */
  dispatchStallMs?: number;
  /** Grace window (ms): on a limit, tell the worker to commit green work + write a WIP note,
   *  then hard-abort. Default DISPATCH_GRACE_MS_DEFAULT (75s). */
  dispatchGraceMs?: number;
  /** When set, gate dispatch's session reuse through the same context policy the interactive
   *  pipeline uses — a resumed sub-project session must not grow unbounded (see
   *  docs/superpowers/specs/2026-07-08-context-policy-design.md, Boundaries #3). */
  contextPolicy?: ContextPolicyCfg;
  /** Per-launch-path worker profiles (model/effort/skills/maxTurns) — routes the dispatched
   *  sub-run and its handoff turn through config.json's `workers.dispatch` / `workers.handoff`.
   *  Absent → every path inherits today's behavior (see worker-profile.ts). */
  workers?: Record<WorkerPathName, WorkerProfile>;
  /** Extra env vars merged into every spawned worker (see NeoConfig.workerEnv). */
  workerEnv?: Record<string, string>;
  /** Graceful-reload gate: while draining, dispatch refuses new sub-runs (see engine/reload.ts). */
  lifecycle?: { draining(): boolean };
  /** Shared API-throttle gate (engine/api-retry.ts): while a throttle is fresh, a NEW sub-run is
   *  held rather than started, so retries + the loop scheduler can't amplify the storm. */
  cooldown?: ApiCooldown;
  /** Root under which the company `dispatch` tool resolves project names (config workRoot). Default "/home". */
  workRoot?: string;
  /** Ensure the target folder is indexed in codebase-memory BEFORE the worker starts (engine side;
   *  the governor denies subagents the index tools, so the worker can't self-index). Best-effort —
   *  a failure here never blocks the dispatch. Absent → the step is skipped. */
  codebaseMemory?: CodebaseMemoryIndexer;
  /** Memory system config (Phase 2). Presence alone does NOT mean injection — the target
   *  folder's frozen ground-truth snapshot is only prepended before `briefWithProjectDocs` when
   *  BOTH this and `companyFolder` are set AND `memoryScopeEnabled` says the folder is in scope
   *  (same gate `pipeline.ts` uses). Absent → no injection (e.g. the customer/ingress path, which
   *  never passes this field — firewall). */
  memory?: MemoryCfg;
  /** The always-on company folder (config `companyFolder`) — needed alongside `memory` to
   *  evaluate the `"company"` scope keyword. Absent ⇒ fail-closed: no injection even if `memory`
   *  is set (mirrors `memoryScopeEnabled`'s folder-vs-companyFolder comparison). */
  companyFolder?: string;
}

type RunFn = typeof runOrder;

/** Default per-dispatch ceiling (ms) — 15 minutes. */
export const DISPATCH_TIMEOUT_MS_DEFAULT = 900_000;
/** Hard cap on any caller-requested ceiling (ms) — 2 hours. */
export const DISPATCH_TIMEOUT_MAX_MS_DEFAULT = 7_200_000;
/** Liveness stall limit (ms) — 5 minutes of NO activity aborts a sub-run. */
export const DISPATCH_STALL_MS_DEFAULT = 300_000;
/** Wrap-up grace window (ms) — 75 seconds between the limit firing and the hard abort. */
export const DISPATCH_GRACE_MS_DEFAULT = 75_000;

/**
 * Resolve a project reference to a folder: an absolute path, else a repo under `root` (/home),
 * else a desk under `desks` (the agent's function workspaces). A real project wins over a
 * same-named desk.
 */
/** True when `folder` resolves to (or inside) one of the allowed roots. The deterministic guard
 *  that keeps a dispatch target under /home (+ the agent's desks) — never an out-of-tree absolute
 *  path (/etc, /root, …) or a `..` traversal that escapes the project root. */
function containedInAny(folder: string, roots: string[]): boolean {
  const f = resolve(folder);
  return roots.some((r) => {
    const rr = resolve(r);
    return f === rr || f.startsWith(rr + sep);
  });
}

/** Shared memory gate: returns `deps.memory` when BOTH it and `deps.companyFolder` are set AND
 *  `memoryScopeEnabled` says `folder` is in scope — undefined otherwise (feature off, folder out
 *  of scope, or the customer/ingress path which never passes these deps). `dispatchToProject`'s
 *  snapshot injection and `neoMcpServers`' memory-tool attachment both call this ONE function so
 *  the two checks can never drift apart. */
function memoryGate(deps: DispatchDeps, folder: string): MemoryCfg | undefined {
  if (deps.memory === undefined || deps.companyFolder === undefined) return undefined;
  return memoryScopeEnabled(deps.memory, folder, deps.companyFolder) ? deps.memory : undefined;
}

export function resolveProject(project: string, root = "/home", desks = DESKS_DIR): string | undefined {
  const candidates = project.startsWith("/") ? [project] : [join(root, project), join(desks, project)];
  for (const c of candidates) {
    try {
      // Must be a real directory AND contained under an allowed root — so the company can only
      // dispatch into the operator's projects/desks, never an arbitrary absolute path.
      if (existsSync(c) && statSync(c).isDirectory() && containedInAny(c, [root, desks])) return c;
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined;
}

/** Only CLAUDE.md auto-loads into a worker (verified 2026-07-08) — AGENTS.md, DESIGN.md and the
 *  rest of a project's rule/docs .md files never reach it unless the brief says so. Every
 *  dispatched brief gets this preamble so the worker (1) reads its own rules, (2) uses the
 *  codebase-memory MCP FIRST for a structural map — REQUIRED, not optional — reading source files
 *  directly only for what the map doesn't cover, and (3) uses the superpowers skills for the shape
 *  of work at hand. (2) is made satisfiable by the engine: `ensureIndexed` (see codebase-memory.ts)
 *  indexes the folder before the worker starts, because the governor denies subagents the index
 *  tools so a worker can never self-index. The engine appends this automatically so the operator
 *  never has to and it can't be omitted. */
export function briefWithProjectDocs(task: string): string {
  return (
    "Before starting, read this project's rule and doc .md files so you work by its rules: " +
    "AGENTS.md, DESIGN.md, and any other root-level .md files (besides CLAUDE.md, already loaded), " +
    "plus the docs relevant to this task (e.g. under docs/). Follow them together with CLAUDE.md.\n\n" +
    "REQUIRED — use the `codebase-memory` MCP FIRST. The engine has already indexed this project for " +
    "you, so the structural map is ready to query. Start every investigation there: get_architecture " +
    "for the module layout, then search_code / query_graph to find the code that matters. Read source " +
    "files directly ONLY for what the map doesn't cover — never as your default way in.\n\n" +
    "REQUIRED — use the superpowers skills for the shape of work at hand: brainstorming → " +
    "writing-plans for design, systematic-debugging to root-cause any bug, and test-driven-development " +
    "for implementation (write the failing test first).\n\n" +
    task
  );
}

/**
 * Open `project` as a tracked Neo sub-project, run `task` to completion (single-shot), streaming
 * its output to the operator tagged with the project name and escalating risky tools to them, then
 * return the project's final result text. Kept as an idle entry afterwards (resumable; the idle
 * watchdog or /kill removes it).
 */
export async function dispatchToProject(
  project: string,
  task: string,
  deps: DispatchDeps,
  replyChat: number,
  opts: {
    start?: typeof startOrder;
    run?: RunFn;
    now?: () => number;
    root?: string;
    desks?: string;
    /** Test seams for the context policy (default: real transcript measurement + handoff run). */
    signals?: typeof sessionContext;
    handoff?: typeof runHandoff;
    /** Caller-requested per-dispatch ceiling (ms) — clamped to dispatchTimeoutMaxMs. */
    timeoutMs?: number;
    /** Injectable wait for the API-retry backoff (tests pass a no-op). Defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable jitter source for the API-retry backoff. Defaults to Math.random. */
    rand?: () => number;
  } = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  // Worker-profile view (model/effort/skills/env by path) — absent deps.workers/workerEnv means
  // every profileDeps() call below is a no-op (empty profile ?? {}), preserving today's behavior.
  const workerCfg: Pick<NeoConfig, "workers" | "workerEnv"> = {
    workers: deps.workers ?? ({} as Record<WorkerPathName, WorkerProfile>),
    workerEnv: deps.workerEnv ?? {},
  };
  if (deps.lifecycle?.draining()) {
    return "Neo is reloading — dispatch refused; retry after the restart (open sessions are preserved).";
  }
  // The API is throttling us — starting another worker now just earns another 429.
  if (deps.cooldown?.activeAt(now())) return apiHoldMessage(deps.cooldown.remainingMs(now()));
  const folder = resolveProject(project, opts.root, opts.desks);
  if (!folder) return `No project or desk named "${project}" was found — check the name.`;

  // Frozen memory snapshot, computed ONCE here at dispatch start (never on a busy-guard reuse
  // above, which returns early without building a new order). Gated exactly like pipeline.ts's
  // injection: absent deps.memory/deps.companyFolder (e.g. the customer/ingress path), or the
  // folder simply not in scope (default `scopes: []`) → "" → briefWithProjectDocs(task) is
  // untouched, byte-identical. Fail-closed: no companyFolder ⇒ no injection, even with memory set.
  const memCfgForSnapshot = memoryGate(deps, folder);
  const memSnap = memCfgForSnapshot ? memorySnapshot(folder, memCfgForSnapshot) : "";
  const order: Order = {
    id: crypto.randomUUID(),
    source: "neo",
    folder,
    task: memSnap + briefWithProjectDocs(task),
    chatId: SUB_CHAT,
    createdAt: now(),
  };
  deps.ledger.recordOrder(order);
  // Reuse an already-open session for this folder (resume it) instead of duplicating it as
  // "<name>-2"; only register a fresh entry when nothing is open for the folder.
  const existing = deps.registry.findByFolder(folder);
  const wasRunning = existing?.status === "running";
  const session = existing ?? deps.registry.add(order, now());
  const name = session.name;
  // Busy guard: never stack a second run onto a folder whose session is mid-turn. Report the REAL
  // status (what it's doing, for how long, queue depth) — not an opaque "busy" — so the company can
  // tell the operator what's happening and decide to wait or report back, instead of a blind refusal.
  if (existing && wasRunning) {
    const queued = deps.registry.getControl(existing.id)?.queued?.() ?? 0;
    const status = describeSessionStatus(existing, now(), { queued });
    return (
      `${name} is busy — ${status}. I did NOT start this dispatch; its current work must finish first. ` +
      `Its result will arrive as a follow-up when it's done — tell the operator what ${name} is doing, or retry shortly.`
    );
  }
  if (existing) {
    deps.registry.setStatus(existing.id, "running");
    deps.registry.touch(existing.id, now());
  }
  await deps.reply(replyChat, `→ dispatching to ${name}: ${task}`, name);

  const resume = existing?.sdkSessionId || deps.ledger.lastSessionFor(folder, SUB_CHAT) || undefined;
  const start = opts.start ?? startOrder;
  // Per-dispatch ceiling: the caller (the company knows if this is a 2-minute lookup or a
  // 2-hour build) may request one, hard-capped so a dispatch can never run unbounded.
  const maxMs = deps.dispatchTimeoutMaxMs ?? DISPATCH_TIMEOUT_MAX_MS_DEFAULT;
  const ceilingMs = Math.min(opts.timeoutMs ?? deps.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS_DEFAULT, maxMs);
  const stallMs = deps.dispatchStallMs ?? DISPATCH_STALL_MS_DEFAULT;
  const graceMs = deps.dispatchGraceMs ?? DISPATCH_GRACE_MS_DEFAULT;

  // Background continuation: bounded await, then bookkeeping + report-back. NEVER awaited here —
  // the company's turn ends immediately (operator requirement: the main agent is always free).
  // The context-policy gate + start(...) + attachControl also live in here (not before it) so
  // the gate's occasional real await (the "handoff" verdict runs a bounded worker turn) never
  // delays the string this function returns to the calling company session.
  void (async () => {
    let gatedResume = resume;
    if (gatedResume && deps.contextPolicy) {
      try {
        const signals = opts.signals ?? sessionContext;
        const sig = signals(folder, gatedResume, { windowTokensByModel: deps.contextPolicy.windowTokensByModel });
        const ttlMs = effectiveCacheTtlMs(deps.ledger.listCacheObservations(CACHE_OBS_WINDOW), deps.contextPolicy);
        const verdict = decideContext(sig, deps.contextPolicy, ttlMs);
        if (verdict === "clear") {
          gatedResume = undefined;
          deps.ledger.clearSessionsFor(folder);
          deps.ledger.recordContextEvent(folder, "clear", sig.occupancy);
        } else if (verdict === "handoff") {
          const handoff = opts.handoff ?? runHandoff;
          const target: SessionInfo = { ...session, sdkSessionId: session.sdkSessionId || gatedResume };
          await handoff(target, deps.contextPolicy, {
            registry: deps.registry,
            ledger: deps.ledger,
            runDeps: profileDeps(workerCfg, "handoff"),
          });
          gatedResume = undefined;
        }
        // "keep" leaves gatedResume unchanged.
      } catch {
        // context-policy is best-effort observer work — fail OPEN, keep the original resume id.
      }
    }

    // Guarantee the structural map the brief now REQUIRES: the worker can't self-index (the governor
    // denies subagents the codebase-memory index tools), so the engine does it here before the worker
    // starts. Best-effort — a failure never blocks the dispatch; the worker falls back to file reads.
    // Placed before startedAt so a first-time index doesn't eat the dispatch stall/ceiling budget.
    if (deps.codebaseMemory) {
      try {
        await deps.codebaseMemory.ensureIndexed(folder, () =>
          deps.reply(replyChat, `indexing ${name} into codebase-memory…`, name),
        );
      } catch {
        // ensureIndexed is itself best-effort; this guard belts-and-braces the dispatch path.
      }
    }

    const startedAt = now();
    let lastActivityAt = startedAt;
    let apiRetries = 0;
    let retryingUntil = 0; // while set in the future, the sub-run is waiting out an API throttle
    let pausedMs = 0; // total backoff time — not the worker's time, so it doesn't eat the ceiling
    // A dispatch is single-brief: a turn boundary with no queued follow-ups means the sub-run IS
    // complete (the real SDK stream stays open waiting for input that will never come — awaiting
    // run.done alone would falsely "stall" out minutes after the worker already finished). Close
    // the channel gracefully so done resolves with the worker's own final result; the session
    // stays resumable (idle bookkeeping below is unchanged).
    let runRef: ReturnType<typeof startOrder> | undefined;
    const run = start(
      order,
      {
        onMessage: (t) => {
          lastActivityAt = now();
          void deps.reply(replyChat, t, name);
        },
        // Liveness pulse on ANY streamed SDK event (partial deltas, tool_use/tool_result, system):
        // a worker mid-generation (e.g. writing a huge file — one long turn, no completed message)
        // keeps this clock fresh, so the stall abort fires only on TRUE silence (BUG 1).
        onHeartbeat: () => {
          lastActivityAt = now();
        },
        onEscalation: (reason) => deps.askApproval(replyChat, reason),
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
        autoApprove: () => deps.trust.isTrusted(folder),
        onAutoApprove: (reason) => {
          deps.ledger.recordAutoApproval(order.id, reason);
          void deps.reply(replyChat, `🔓 auto-approved: ${reason}`, name);
        },
        onTurnComplete: (result) => {
          lastActivityAt = now();
          const kind = result.apiError;
          if (kind) {
            deps.cooldown?.note(kind, now()); // sibling dispatches/loops back off too
            const attempt = apiRetries + 1;
            if (shouldRetryApi({ kind, attempt, draining: deps.lifecycle?.draining(), throttled: deps.meter.shouldThrottle() })) {
              apiRetries = attempt;
              const delayMs = apiRetryDelayMs(attempt, opts.rand);
              // The wait is engine-driven, not the worker hanging: hold off the stall/ceiling
              // clocks for exactly that long, then re-send the brief into the still-open run.
              retryingUntil = now() + delayMs;
              pausedMs += delayMs;
              void deps.reply(replyChat, apiRetryNotice(name, attempt, delayMs), name);
              void (opts.sleep ?? realSleep)(delayMs).then(() => {
                lastActivityAt = now();
                runRef?.followUp(apiRetryFollowUp(task));
              });
              return; // keep the sub-run open — it hasn't done the work yet
            }
            void deps.reply(replyChat, apiFailureNotice(name, kind), name);
          }
          if ((runRef?.queued() ?? 1) === 0) runRef?.close?.();
        },
        onActivity: (label) => {
          lastActivityAt = now();
          try {
            deps.registry.noteActivity(session.id, label, now());
            deps.registry.touch(session.id, now());
          } catch {
            /* observer only */
          }
        },
      },
      profileDeps(workerCfg, "dispatch", { resume: gatedResume }),
    );
    runRef = run;
    deps.registry.attachControl(session.id, run);

    // Liveness monitor: the timeout protects against a HUNG worker, not a busy one. A dispatch
    // is aborted when the sub-run has produced no activity for stallMs, OR when the per-dispatch
    // ceiling is hit — a worker streaming output for 90 minutes stays alive (up to the ceiling).
    const sleep = (ms: number) => new Promise<"tick">((res) => setTimeout(() => res("tick"), ms));
    const doneOrTick = (ms: number) => Promise.race([run.done.then((r) => ({ done: r })), sleep(ms)]);
    const checkMs = Math.max(1, Math.floor(Math.min(stallMs, ceilingMs) / 4));
    let result: RunResult;
    let timedOut = false;
    try {
      let limit: "stall" | "ceiling" | undefined;
      for (;;) {
        const settled = await doneOrTick(checkMs);
        if (settled !== "tick") {
          result = settled.done;
          break;
        }
        const t = now();
        // Waiting out an API throttle is a deliberate engine pause, not a hung worker — keep the
        // stall clock fresh through it, and don't charge the wait against the dispatch ceiling.
        if (t < retryingUntil) {
          lastActivityAt = t;
          continue;
        }
        if (t - startedAt - pausedMs >= ceilingMs) limit = "ceiling";
        else if (t - lastActivityAt >= stallMs) limit = "stall";
        if (!limit) continue;
        // Graceful wrap-up: give the worker a short grace window to commit green work and leave
        // a WIP note (the commit-per-task recovery we used to do by hand), then hard-abort.
        run.followUp(
          `⏱ Neo dispatch ${limit === "stall" ? "stall" : "time"} limit reached — stop working now. ` +
            `Commit any green work and write a brief WIP note (plan doc or WIP.md) so a follow-up run can resume. ` +
            `You have ~${Math.round(graceMs / 1000)}s before this session is aborted.`,
        );
        const graced = await doneOrTick(graceMs);
        if (graced !== "tick") {
          result = graced.done; // wrapped up in time — keep the worker's own result
          break;
        }
        timedOut = true;
        await run.interrupt();
        const detail =
          limit === "stall"
            ? `no activity for ${Math.round(stallMs / 60000)}m (stall limit)`
            : `hit the ${Math.round(ceilingMs / 60000)}m dispatch ceiling`;
        result = { ok: false, sessionId: "", summary: `timed out: ${detail} — asked to wrap up, then aborted`, costUsd: 0 };
        break;
      }
    } catch (e) {
      result = { ok: false, sessionId: "", summary: e instanceof Error ? e.message : String(e), costUsd: 0 };
    }
    try {
      if (result.sessionId) {
        deps.registry.setSdkSessionId(session.id, result.sessionId);
        deps.ledger.recordSession(order.id, result.sessionId);
      }
      deps.meter.note({ costUsd: result.costUsd }, now());
      deps.ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary);
      if (timedOut || !result.ok) {
        // A dead run must not linger: an "error" session is invisible to findByFolder (never
        // reused) and to sweepIdle (never reaped), so it would sit as a zombie and force the next
        // dispatch to register "<name>-2", "-3", … Remove it; the ledger keeps the error outcome,
        // and any sdkSessionId was persisted above for resume.
        deps.registry.remove(session.id);
      } else {
        deps.registry.setStatus(session.id, "idle");
        deps.registry.touch(session.id, now());
        deps.registry.detachControl(session.id);
      }
      const line = result.ok ? `✅ ${name} finished: ${result.summary || "done"}` : `⛔ ${name}: ${result.summary || "failed"}`;
      await deps.reply(replyChat, line, name);
      // Feed the result back into the live company session so it can act on it next turn.
      const company = deps.registry.getDefault();
      const control = company && company.id !== session.id ? deps.registry.getControl(company.id) : undefined;
      control?.followUp(`[dispatch result] ${name}: ${result.summary || (result.ok ? "done" : "failed")}`);
    } catch {
      // observer/bookkeeping errors must not surface into the worker path
    }
  })();

  return `dispatched to ${name} — running in the background; its output streams to the operator and you will receive its result as a follow-up message when it finishes.`;
}

/** Send a file the worker produced, but only if `path` is inside `folder`. Returns a status string. */
export async function sendProjectFile(
  deps: { sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void> },
  chatId: number,
  folder: string,
  path: string,
  caption?: string,
): Promise<string> {
  let root: string;
  try {
    root = realpathSync(resolve(folder));
  } catch {
    return `refused: project folder does not exist`;
  }
  // Lexical pre-check: reject obvious traversal before touching the filesystem.
  const lexAbs = resolve(folder, path);
  if (lexAbs === root || !lexAbs.startsWith(root + sep)) return `refused: ${path} is outside project`;
  // Symlink-safe check: resolve symlinks for existing paths and re-verify confinement.
  let abs: string;
  try {
    abs = realpathSync(lexAbs);
  } catch {
    return `not found: ${path}`;
  }
  if (abs === root || !abs.startsWith(root + sep)) return `refused: ${path} is outside project`;
  if (!statSync(abs).isFile()) return `refused: ${path} is not a regular file`;
  await deps.sendFile?.(chatId, abs, caption);
  return `sent ${path}`;
}

/** Google Stitch MCP server (HTTP transport) — design generation for operator workers. */
export const STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";

/** Build the project's in-process MCP tools: `send_file` always; `dispatch` only for the company.
 *  When `opts.stitch` is set AND a `opts.stitchKey` is configured, the operator's Stitch HTTP MCP
 *  server is attached too. Stitch is OFF by default so the customer/ingress path never gets it. */
export function neoMcpServers(
  deps: DispatchDeps,
  replyChat: number,
  opts: {
    dispatch: boolean;
    folder: string;
    stitch?: boolean;
    stitchKey?: string;
    /** Operator-only local stdio MCP servers; the customer/ingress path passes neither. */
    codebaseMemoryBin?: string;
  },
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      "send_file",
      "Send a file you produced in THIS project back to the operator (Telegram/web). `path` must be inside the project folder.",
      {
        path: z.string().describe("path to the file to send, inside the project folder"),
        caption: z.string().optional().describe("optional caption / note"),
      },
      async (args: { path: string; caption?: string }) => {
        const out = await sendProjectFile(deps, replyChat, opts.folder, args.path, args.caption);
        return { content: [{ type: "text" as const, text: out }] };
      },
    ),
  ];
  if (opts.dispatch) {
    tools.push(
      tool(
        "sessions",
        "List the operator's live project sessions and what each is doing RIGHT NOW (idle / running-what / how long / how many follow-ups queued). Use this to answer the operator about a project's status, or — when a dispatch reports a project busy — to decide whether to wait for it or report back. Returns text.",
        {},
        async () => ({ content: [{ type: "text" as const, text: sessionsReport(deps.registry, Date.now()) }] }),
      ),
      tool(
        "dispatch",
        "Open one of the operator's projects and run a self-contained task in it, then return its result. Use this for any order that belongs to a specific project (e.g. api-server, web-app). The target project does NOT see the operator's original message — only your `task` brief — so write `task` as a clear, complete prompt.",
        {
          project: z.string().describe('project folder name under the operator\'s project root, e.g. "eticket-v3"'),
          task: z.string().describe("a clear, self-contained brief/prompt for that project to execute"),
          timeoutMinutes: z
            .number()
            .positive()
            .optional()
            .describe(
              "expected ceiling for this task in minutes — size it to the task (2 for a quick lookup, 60–120 for a real build). Capped by the engine; a hung (silent) worker is still aborted early regardless.",
            ),
        },
        async (args: { project: string; task: string; timeoutMinutes?: number }) => {
          const out = await dispatchToProject(args.project, args.task, deps, replyChat, {
            root: deps.workRoot,
            timeoutMs: args.timeoutMinutes ? Math.round(args.timeoutMinutes * 60_000) : undefined,
          });
          return { content: [{ type: "text" as const, text: out }] };
        },
      ),
    );
  }
  // Memory tools (`memory`, `memory_search`): attached ONLY through the same gate that guards the
  // frozen snapshot injection in dispatchToProject (memoryGate) — operator paths whose target
  // folder is in scope. The ingress/customer path passes neither deps.memory nor
  // deps.companyFolder, so memoryGate always returns undefined there — firewall by construction,
  // not by an extra flag that could drift out of sync.
  const memCfg = memoryGate(deps, opts.folder);
  if (memCfg) {
    const windowTokens = windowTokensFor(undefined, deps.contextPolicy?.windowTokensByModel);
    tools.push(...memoryTools(opts.folder, memCfg, windowTokens));
  }
  const server = createSdkMcpServer({ name: "neo", version: "1.0.0", tools });
  const servers: Record<string, unknown> = { neo: server };
  // Operator-only: attach the Google Stitch HTTP MCP server when enabled and a key is configured.
  // (SDK McpHttpServerConfig shape: { type: "http", url, headers? }.) Never on the customer path.
  if (opts.stitch && opts.stitchKey) {
    servers.stitch = { type: "http", url: STITCH_MCP_URL, headers: { "X-Goog-Api-Key": opts.stitchKey } };
  }
  // Operator-only local stdio MCP server: codebase-memory (the ONE code-intel MCP — see the
  // 2026-07-23 context-efficiency design's measured verdict). Attached only when a bin path is
  // configured; the customer/ingress path passes none → never gets it.
  if (opts.codebaseMemoryBin) {
    servers["codebase-memory"] = { type: "stdio", command: opts.codebaseMemoryBin, args: [], env: {} };
  }
  return servers;
}
