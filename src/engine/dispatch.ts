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
import type { Priority } from "./priority";
import { maturedAsk, questionSummary, MAX_OPTIONS, type StructuredAsk, type MaturedDecisionInput } from "./structured-question";
import { memorySnapshot, memoryEnabledFor } from "./memory";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import { budgetHoldMessage, heldByReserve, DEFAULT_WORK_CLASS, type Meter, type WorkClass } from "./budget";
import type { UsageMeter } from "./usage";
import { noteProjectStart, type TrustStore } from "./trust";
import { runOrder, startOrder, type RunResult } from "./session-runner";
import {
  dispatchResultText,
  formatStopPoint,
  lastCommitIn,
  liveCompanyLink,
  flushDispatcherInbox,
  progressDigest,
  type DispatcherLink,
  type StopPoint,
} from "./dispatch-report";
import { frontendBackend, teamLeadPreamble } from "./agent-teams";
import { DEFAULT_PROJECT } from "./default-project";
import { decideContext, sessionContext, contextWindows, runHandoff, effectiveCacheTtlMs, CACHE_OBS_WINDOW, windowTokensFor, type ContextPolicyCfg } from "./context-policy";
import { clearDecisionBlock, describeSession, sessionEvidence, sessionsReport, stateOf } from "./session-status";
import { DEFAULT_LIVENESS_THRESHOLDS, type LivenessThresholds } from "./liveness";
import type { CodebaseMemoryIndexer } from "./codebase-memory";
import type { TodoQueue } from "./todo-queue";
import { memoryTools } from "./memory-tool";
import { profileDeps } from "./worker-profile";
import { canResumeWith } from "./sdk-choice";
import { supportsRunConfigField } from "./model-resolver";
import {
  apiFailureNotice,
  apiHoldMessage,
  resolveApiRetryDelayMs,
  apiRetryFollowUp,
  apiRetryNotice,
  shouldRetryApi,
  API_RETRY_DELAYS_MS,
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
  reply: (chatId: number, text: string, project?: string, priority?: Priority) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
  /** Deliver a worker-produced file back to the operator's channel (Telegram/web). */
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
  /** Post a raised decision to the operator's high-priority Decisions channel and return the sent
   *  message id (so a reply/edit can find it). The frontend supplies this — it builds the inline
   *  keyboard from `options` (tappable answers) + an "other / type an answer" affordance. Its
   *  PRESENCE gates the `ask_operator` tool: only operator surfaces (Telegram/web) wire it, so the
   *  customer/ingress path never gets ask_operator — the firewall, by construction. */
  postDecision?: (
    rec: { id: string; project?: string; folder?: string },
    question: string,
    options?: string[],
    /** A structured multi-question / multi-select ask (Feature 1). When set, the frontend renders the
     *  richer tappable keyboard from it instead of the flat `options`. */
    spec?: StructuredAsk,
  ) => Promise<{ chatId: number; messageId: number } | undefined>;
  /** Abort a sub-run with NO activity for this long (ms) — the only automatic abort: a dispatch has
   *  no wall-clock limit, so a busy worker runs until it finishes (ADR-0007). Default
   *  DISPATCH_STALL_MS_DEFAULT (5m). */
  dispatchStallMs?: number;
  /** Progress-digest interval (ms) for a running dispatch, to the operator and the live dispatcher;
   *  sent only when there was activity since the last one. 0 turns digests off. Default
   *  DISPATCH_PROGRESS_MS_DEFAULT (10m). */
  dispatchProgressMs?: number;
  /** How a dispatch reaches its dispatcher (the company). The pipeline wires one that can also wake
   *  an idle company; absent → `liveCompanyLink` (follow-up into a live company only). */
  dispatcher?: DispatcherLink;
  /** Thresholds behind the derived session state reported to the operator (wedged/quiet).
   *  Absent → DEFAULT_LIVENESS_THRESHOLDS. */
  liveness?: LivenessThresholds;
  /** Grace window (ms): on a limit, tell the worker to commit green work + write a WIP note,
   *  then hard-abort. Default DISPATCH_GRACE_MS_DEFAULT (75s). */
  dispatchGraceMs?: number;
  /** API-throttle backoff ladder (ms/attempt) for a rate-limited sub-run — retry COUNT derives
   *  from its length. Absent → the built-in default (config `apiRetryLadderMs`). */
  apiRetryLadderMs?: number[];
  /** Jitter magnitude (0-1) for retry waits. Absent → the built-in default (config
   *  `apiRetryJitterFrac`). */
  apiRetryJitterFrac?: number;
  /** When set, gate dispatch's session reuse through the same context policy the interactive
   *  pipeline uses — a resumed sub-project session must not grow unbounded (see
   *  docs/superpowers/specs/2026-07-08-context-policy-design.md, Boundaries #3). */
  contextPolicy?: ContextPolicyCfg;
  /** Per-launch-path worker profiles (model/effort/skills/maxTurns) — routes the dispatched
   *  sub-run and its handoff turn through config.json's `workers.dispatch` / `workers.handoff`.
   *  Absent → every path inherits today's behavior (see worker-profile.ts). */
  workers?: Record<WorkerPathName, WorkerProfile>;
  /** The pinned worker model (config `models`) — routes the dispatched sub-run and its handoff turn
   *  through `models.default` / `models.aliases`. MUST be threaded: without it a dispatched worker
   *  silently inherits the SDK's own default, which is the whole defect ADR-0005 fixes, and dispatch
   *  is the path nearly all project work takes. */
  models?: NeoConfig["models"];
  /** Own-work provider choice, threaded into dispatched worker launches when present. */
  providers?: NeoConfig["providers"];
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
  /** The per-project todo queue (ADR-0008). When set, the company's `dispatch` tool hands every
   *  brief to it (a busy project queues it) and the company gets the `todo` tool. Absent → the
   *  legacy direct dispatch (tests, paths without the queue). */
  todo?: TodoQueue;
}

type RunFn = typeof runOrder;

/** The runs THIS module started (dispatch-owned). Only a brief delivered into one of them is
 *  covered by that run's progress digests and final report; a brief pushed into an operator-opened
 *  session is not, and the reply to the dispatcher must say so instead of promising a result. */
const dispatchRuns = new WeakSet<object>();

/** Liveness stall limit (ms) — 5 minutes of NO activity aborts a sub-run. */
export const DISPATCH_STALL_MS_DEFAULT = 300_000;
/** Wrap-up grace window (ms) — 75 seconds between the limit firing and the hard abort. */
export const DISPATCH_GRACE_MS_DEFAULT = 75_000;
/** Progress-digest interval (ms) — 10 minutes. */
export const DISPATCH_PROGRESS_MS_DEFAULT = 600_000;
/** Activity label for the window between "session registered" and "worker attached" (indexing +
 *  context gate). Makes the `starting` state self-explaining wherever it is rendered. */
export const PREPARING_LABEL = "preparing: indexing + context gate";

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
  return memoryEnabledFor(deps.memory, folder, deps.companyFolder) ? deps.memory : undefined;
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
 *  directly only for what the map doesn't cover, (3) works in two phases — DESIGN (sharpen the
 *  domain model with domain-modeling/codebase-design into a CONTEXT.md glossary + ADRs, then a
 *  spec) then BUILD (superpowers TDD → verify → code-review); the mattpocock design skills adopted
 *  2026-09-10 are model-invocable, the interactive-only ones (grill-with-docs/to-spec/to-tickets)
 *  are deliberately NOT told to workers — (4) meets the operator's **engineering baseline** (i18n
 *  catalogues, `.env`/dev-by-default, Docker, no hardcoding, reuse what exists — stated in this
 *  repo's CLAUDE.md, which a worker dispatched into ANOTHER folder never loads, so the preamble is
 *  the only place it can't be forgotten by whoever writes the brief:
 *  docs/adr/0002-engineering-baseline-lives-in-the-dispatch-preamble.md) — and (5) challenges itself BEFORE raising any operator question — root-cause the
 *  real issue, reach for the industry-standard fix (not a patch), self-critique its options, and
 *  only escalate a decision that is genuinely the operator's (mirrors the `ask_operator` precondition
 *  so a worker can't turn a solvable bug into a shallow patch-menu). (2) is made satisfiable by the
 *  engine: `ensureIndexed` (see codebase-memory.ts)
 *  indexes the folder before the worker starts, because the governor denies subagents the index
 *  tools so a worker can never self-index. The engine appends this automatically so the operator
 *  never has to and it can't be omitted. */
export function briefWithProjectDocs(task: string): string {
  return (
    "Before starting, read this project's rule and doc .md files so you work by its rules: " +
    "AGENTS.md, DESIGN.md, and any other root-level .md files (besides CLAUDE.md, already loaded), " +
    "plus the docs relevant to this task (e.g. under docs/). Follow them together with CLAUDE.md.\n\n" +
    "REQUIRED — use the `codebase-memory` MCP FIRST. The engine has already indexed this project for " +
    "you, so the structural map is ready to query. Call `list_projects` FIRST and pass the EXACT " +
    "project name it returns whose `root_path` matches (or contains) your working directory — do NOT " +
    "guess or construct the project name. Guessing yields \"project not found\": this repo may be " +
    "indexed under a path-derived name, and its code can live in a subfolder indexed as its own " +
    "project. Then get_architecture for the module layout with that name, then search_code / " +
    "query_graph to find the code that matters. Read source files directly ONLY for what the map " +
    "doesn't cover — never as your default way in.\n\n" +
    "REQUIRED — work in two phases: DESIGN, then BUILD.\n" +
    "  DESIGN — before writing code for any feature or non-trivial change, sharpen the domain model " +
    "with the `domain-modeling` and `codebase-design` skills: define the real terms precisely and " +
    "write/update this project's `CONTEXT.md` glossary, and record each genuine design decision as a " +
    "short ADR (rejected alternatives included). Then synthesize a concise spec for the change — its " +
    "acceptance criteria and edge cases — and design it as one clean seam (a lot of behavior behind a " +
    "small, testable interface). Use `superpowers:brainstorming` → `writing-plans` for the plan itself. " +
    "For a bug, `superpowers:systematic-debugging` to root-cause first. (Skip the CONTEXT.md/ADR step " +
    "only for a trivial mechanical edit, and say you did.)\n" +
    "  BUILD — implement against that spec with `superpowers:test-driven-development` (write the failing " +
    "test first, per acceptance criterion), then `superpowers:verification-before-completion` and " +
    "`requesting-code-review` before claiming done.\n\n" +
    "REQUIRED — engineering baseline (operator hard rule): code that is not industry-standard is a " +
    "failure, even when it works. (1) i18n through standard per-locale catalogues (react-i18next or " +
    "the stack's equivalent), namespaced keys, AR+EN complete — never literal user-facing strings in " +
    "components, never a bespoke translation mechanism. (2) `.env` + environments, dev by default, " +
    "failing closed to dev-safe behaviour and never to prod. (3) Everything runs in Docker. (4) No " +
    "hardcoding — values live in env/DB/config. (5) Read the existing code FIRST and REUSE it: extend " +
    "what is there, never a second implementation. Meet these in what you ship; a change that misses " +
    "one is not done.\n\n" +
    "REQUIRED — challenge yourself BEFORE you ask the operator anything. Trace the real root cause " +
    "in the code, not the symptom. Choose the correct industry-standard fix, not the quickest patch. " +
    "Criticize your own options and drop any that are only workarounds. Escalate to the operator " +
    "ONLY a decision that is genuinely theirs: product/UX policy, cost, an irreversible or external " +
    "action, or a real trade-off between two sound options. If there is one correct standard fix, " +
    "do it and report it — do not ask. When you must ask (via ask_operator), show your work: the " +
    "root cause you found, the standard fix you recommend, and why; every option you offer must be " +
    "defensible on its own — no patch-level options.\n\n" +
    "REQUIRED — stay alive; never park on a background wait. Neo watches your STREAMED tool/step " +
    "activity to tell a working worker from a hung one, and ABORTS a sub-run after ~5 minutes with no " +
    "such activity. A single step that blocks silently for minutes produces NO activity and is killed " +
    "even though it is not hung — this includes a background wait or Monitor, a long `sleep`, " +
    "`gh run watch`, tailing logs, or any \"wait for the CI/build/deploy to finish\" command. So NEVER " +
    "use a background wait or Monitor: when you must wait on CI, a build, or a deploy, POLL in short " +
    "FOREGROUND steps under 90 seconds each — check status (e.g. `gh run view`), a brief `sleep`, then " +
    "check again — so every check is a fresh activity heartbeat. And finish the job WITHIN this run: a " +
    "dispatched worker is single-shot and is NOT re-invoked when a background job later completes, so " +
    "poll to a terminal state here rather than \"standing by\" for a later event.\n\n" +
    task
  );
}

/** How the todo queue (ADR-0008) follows one dispatch. All optional; absent → today's behaviour. */
export interface DispatchHooks {
  /** The brief was accepted: `run` = a fresh dispatch run started (its end calls `onEnd`), `delivered`
   *  = pushed into an already-live session (no end the engine can observe). Called synchronously,
   *  before dispatchToProject's first await, so the project reads busy at once. */
  onLaunched?: (orderId: string, mode: "run" | "delivered") => void;
  /** The brief was NOT accepted (the same reason recorded on `dispatch_refused`). */
  onRefused?: (reason: string) => void;
  /** Extra line for the dispatcher's final result (e.g. what the queue does next). `ok` is false
   *  for any bad end: failure, stall abort, or a reload cut. */
  resultNote?: (ok: boolean) => string | undefined;
  /** The run is over and its result has reached the operator and the dispatcher inbox. */
  onEnd?: (end: { orderId: string; ok: boolean; summary: string }) => void | Promise<void>;
  /** Skip the "→ dispatching to …" line (the queue sends its own start line). */
  quietStart?: boolean;
}

/** dispatchToProject's options (test seams + per-call choices). */
export type DispatchOpts = NonNullable<Parameters<typeof dispatchToProject>[4]>;

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
    /** Test seam: read the folder's last commit for digests and stop points (default: git). */
    lastCommit?: (folder: string) => string | undefined;
    /** Injectable wait for the API-retry backoff (tests pass a no-op). Defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable jitter source for the API-retry backoff. Defaults to Math.random. */
    rand?: () => number;
    /** Opt-in team mode for SDKs that support `agents`: run this brief with a lead-orchestrated
     *  subagent team. Codex falls back to the normal single-worker brief. */
    team?: "frontend-backend";
    /** What TRIGGERED this dispatch — the operator's own turn (`interactive`) or the scheduler
     *  (`background`). The `dispatch` tool passes the class of the worker that called it, so a
     *  dispatch the company makes while servicing an operator message inherits `interactive` and is
     *  never held by the interactive reserve. Omitted ⇒ DEFAULT_WORK_CLASS (background). */
    workClass?: WorkClass;
    /** The todo queue's view of this dispatch (ADR-0008). */
    hooks?: DispatchHooks;
  } = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  const hooks = opts.hooks ?? {};
  const workClass = opts.workClass ?? DEFAULT_WORK_CLASS;
  // Worker-profile view (model/effort/skills/env by path) — absent deps.workers/workerEnv means
  // every profileDeps() call below is a no-op (empty profile ?? {}), preserving today's behavior.
  const workerCfg: Pick<NeoConfig, "workers" | "workerEnv"> = {
    workers: deps.workers ?? ({} as Record<WorkerPathName, WorkerProfile>),
    workerEnv: deps.workerEnv ?? {},
  };
  const providerCfg: Pick<NeoConfig, "workers" | "workerEnv"> &
    Partial<Pick<NeoConfig, "providers" | "models">> = {
    ...workerCfg,
    providers: deps.providers,
    models: deps.models,
  };
  // Opt-in team: only SDKs that support the `agents` run field get the subagent map + lead
  // preamble. Codex receives the original brief as a normal single-worker coding task.
  const teamAgents =
    opts.team === "frontend-backend" && supportsRunConfigField(providerCfg.providers?.ownWork, "agents")
      ? frontendBackend
      : undefined;
  if (deps.lifecycle?.draining()) {
    deps.ledger.recordEvent("dispatch_refused", { data: { project, workClass, reason: "draining" } });
    hooks.onRefused?.("draining");
    return "Neo is reloading — dispatch refused; retry after the restart (open sessions are preserved).";
  }
  // The API is throttling us — starting another worker now just earns another 429.
  if (deps.cooldown?.activeAt(now())) {
    deps.ledger.recordEvent("dispatch_refused", { data: { project, workClass, reason: "cooldown" } });
    hooks.onRefused?.("cooldown");
    return apiHoldMessage(deps.cooldown.remainingMs(now()));
  }
  const folder = resolveProject(project, opts.root, opts.desks);
  if (!folder) {
    deps.ledger.recordEvent("dispatch_refused", { data: { project, workClass, reason: "not_found" } });
    hooks.onRefused?.("not_found");
    return `No project or desk named "${project}" was found — check the name.`;
  }
  // The interactive reserve caps BACKGROUND work only, and a dispatch's class follows the trigger
  // that originated it, not the fact that it is a dispatch: scheduler-fired work is held here, while
  // a dispatch the operator asked for conversationally is their own turn continuing and runs (ADR
  // 0001 + its follow-up). AFTER resolveProject on purpose: a typo'd project name must still report
  // "not found" while over budget, not a hold that hides the real error.
  if (heldByReserve(workClass, deps.meter, now())) {
    deps.ledger.recordEvent("dispatch_refused", { data: { project, workClass, reason: "budget" } });
    hooks.onRefused?.("budget");
    return budgetHoldMessage(deps.meter.spent(now()), deps.meter.allowance());
  }

  // Build + record the order with its BASE task (project-docs preamble only — no memory snapshot
  // yet). This happens BEFORE the busy-guard check below (existing && wasRunning can still refuse
  // this dispatch with an early return), so a refused dispatch still leaves a plain intent record
  // in the ledger. The memory snapshot, when the folder is in scope, is injected later — INSIDE
  // the background continuation, once the resume id that will actually be used for this run is
  // settled (see the comment down there) — never here, so a resumed sub-session never gets a
  // repeated "authoritative ground truth" block stacked mid-conversation.
  const order: Order = {
    id: crypto.randomUUID(),
    source: "neo",
    folder,
    task: briefWithProjectDocs(teamAgents ? teamLeadPreamble(task) : task),
    chatId: SUB_CHAT,
    createdAt: now(),
  };
  deps.ledger.recordOrder(order);
  // A project's first sight: trusted by default when `trustNewProjects` is on (the customer path
  // passes denyAllTrust, whose noteProject never trusts).
  noteProjectStart(deps, order);
  // Reuse an already-open session for this folder (resume it) instead of duplicating it as
  // "<name>-2"; only register a fresh entry when nothing is open for the folder.
  const existing = deps.registry.findByFolder(folder);
  const wasRunning = existing?.status === "running";
  const session = existing ?? deps.registry.add(order, now());
  const name = session.name;
  // Reuse guard. A folder's session runs ONE turn at a time, so a second concurrent run must never
  // stack onto it. But "reuse" is NOT the same as "busy": a live session's registry status stays
  // "running" for its WHOLE lifetime (it flips back to "idle" only when the whole run ends), so
  // status alone can't tell a worker mid-turn from one sitting idle between turns. The real signal
  // is the control's active() — a turn genuinely in flight right now:
  //   • idle (no turn in flight) → deliver the brief NOW into the warm session; its input channel
  //     pulls it immediately, exactly like a fresh dispatch, so a free project is never parked
  //     behind a false "busy".
  //   • mid-turn → QUEUE behind the in-flight turn (like an operator's reply); the channel flushes
  //     it the moment that turn yields.
  //   • "running" but NO live control to accept a follow-up (a stale mark, e.g. control lost on a
  //     reload) → refuse rather than enqueue into the void or start a second concurrent run.
  if (existing && wasRunning) {
    const control = deps.registry.getControl(existing.id);
    // The SAME authoritative signal the operator's status line reads — state, both clocks, queue —
    // so a busy/queued reply can never disagree with what `sessions` says about the same project.
    const status = describeSession(deps.registry, existing, now(), deps.liveness);
    const state = stateOf(deps.registry, existing, now(), deps.liveness);
    // A control whose channel was already closed (the run is settling and about to end) would drop
    // the brief without a word — the 2026-10-04 lost-brief bug. Refuse it out loud instead.
    if (control?.followUp && control.closed?.() === true) {
      deps.ledger.recordEvent("dispatch_refused", { orderId: order.id, folder, data: { project: name, workClass, reason: "closing", state } });
      hooks.onRefused?.("closing");
      return (
        `${name} is finishing its current run (its session is closing) — I did NOT queue this brief, so ` +
        `nothing was lost. Retry in a moment; it will start a fresh run once the current one has ended.`
      );
    }
    if (control?.followUp) {
      const turnActive = control.active?.() === true; // the REAL "a turn is being processed" signal
      // What the dispatcher will hear back: a dispatch-owned run reports progress + its result; an
      // operator-opened session streams to the operator only.
      const reportBack = dispatchRuns.has(control)
        ? `its output streams to the operator as ${name}, and you get progress digests and the result when that run ends.`
        : `its output streams to the operator as ${name}. It is a session the operator opened, so its result is NOT ` +
          `sent back to you automatically — check it with \`sessions\` or ask the operator.`;
      control.followUp(order.task);
      hooks.onLaunched?.(order.id, "delivered");
      deps.registry.touch(existing.id, now());
      // A brief arriving answers (or supersedes) a raised DECISION; a pending approval is left
      // alone, since that one is still suspending the worker mid-tool.
      clearDecisionBlock(deps.registry, existing.id);
      if (turnActive) {
        deps.ledger.recordEvent("dispatch_queued", { orderId: order.id, folder, data: { project: name, workClass } });
        await deps.reply(replyChat, `→ queued for ${name} (busy): ${task}`, name);
        return (
          `${name} is ${state} — I queued this brief behind its current turn (${status}). It runs when the ` +
          `current work yields; ${reportBack} Unless that state is ` +
          `"wedged" this is NORMAL and needs nothing from you` +
          (state === "awaiting-operator" ? " EXCEPT the operator's answer to the question it raised." : ".")
        );
      }
      // Alive but IDLE between turns: the follow-up is pulled and run immediately.
      deps.ledger.recordEvent("dispatch_delivered", { orderId: order.id, folder, data: { project: name, workClass, reuse: "idle" } });
      await deps.reply(replyChat, `→ dispatching to ${name}: ${task}`, name);
      return (
        `dispatched to ${name} — it was idle, so this runs now; ${reportBack}`
      );
    }
    // No live handle. Usually NOT a fault: the previous dispatch marked the session running and is
    // still preparing it (ensureIndexed on a big repo takes minutes) — `stateOf` calls that
    // `starting`. Say which it is instead of implying the project is broken.
    deps.ledger.recordEvent("dispatch_refused", { orderId: order.id, folder, data: { project: name, workClass, reason: "stale_running_no_control", state } });
    hooks.onRefused?.("stale_running_no_control");
    return (
      `${name} is ${state} — ${status} — and has no live handle to queue behind yet` +
      (state === "starting"
        ? " (the engine is still preparing it: indexing + context gate)"
        : state === "awaiting-operator"
          ? " (it is waiting on the operator's answer)"
          : " (it may be mid-reload)") +
      `. I did NOT start a second run; retry shortly and it will deliver once the session settles.`
    );
  }
  if (existing) {
    deps.registry.setStatus(existing.id, "running");
    deps.registry.touch(existing.id, now());
  }
  // The entry is marked running here but its worker is attached only at the end of the background
  // continuation below, after ensureIndexed + the context gate. Label that gap so the gap explains
  // itself in `sessions`/`/list` instead of showing as an unexplained handle-less "running".
  deps.registry.noteActivity(session.id, PREPARING_LABEL, now());
  hooks.onLaunched?.(order.id, "run");
  if (!hooks.quietStart) await deps.reply(replyChat, `→ dispatching to ${name}: ${task}`, name);

  // Only ever resume an id this worker SDK minted — a Codex thread id fed to Claude (or vice
  // versa) is rejected outright, and before the ownership check that read as an API failure.
  const worker = providerCfg.providers?.ownWork;
  const resume =
    (canResumeWith(existing?.sdkProvider, worker) ? existing?.sdkSessionId : undefined) ||
    deps.ledger.lastSessionFor(folder, SUB_CHAT, worker) ||
    undefined;
  const start = opts.start ?? startOrder;
  // No wall-clock limit (ADR-0007): some tasks take hours. Only true silence (the stall limit) aborts.
  const stallMs = deps.dispatchStallMs ?? DISPATCH_STALL_MS_DEFAULT;
  const progressMs = deps.dispatchProgressMs ?? DISPATCH_PROGRESS_MS_DEFAULT;
  const readCommit = opts.lastCommit ?? lastCommitIn;
  const dispatcher = deps.dispatcher ?? liveCompanyLink(deps.registry, deps.lifecycle);
  const graceMs = deps.dispatchGraceMs ?? DISPATCH_GRACE_MS_DEFAULT;
  const retryLadder = deps.apiRetryLadderMs && deps.apiRetryLadderMs.length > 0 ? deps.apiRetryLadderMs : [...API_RETRY_DELAYS_MS];
  const maxRetries = retryLadder.length;

  // Background continuation: supervised await, then bookkeeping + report-back. NEVER awaited here —
  // the company's turn ends immediately (operator requirement: the main agent is always free).
  // The context-policy gate + start(...) + attachControl also live in here (not before it) so
  // the gate's occasional real await (the "handoff" verdict runs a bounded worker turn) never
  // delays the string this function returns to the calling company session.
  void (async () => {
    let gatedResume = resume;
    if (gatedResume && deps.contextPolicy) {
      try {
        const signals = opts.signals ?? sessionContext;
        const sig = signals(folder, gatedResume, { windowTokensByModel: contextWindows(deps.ledger, deps.contextPolicy.windowTokensByModel) });
        const ttlMs = effectiveCacheTtlMs(deps.ledger.listCacheObservations(deps.contextPolicy.cacheObsWindow ?? CACHE_OBS_WINDOW), deps.contextPolicy);
        const verdict = decideContext(sig, deps.contextPolicy, ttlMs).verdict;
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
            runDeps: profileDeps(providerCfg, "handoff"),
            memoryFlush: !!memoryGate(deps, folder),
          });
          gatedResume = undefined;
        }
        // "keep" leaves gatedResume unchanged.
      } catch {
        // context-policy is best-effort observer work — fail OPEN, keep the original resume id.
      }
    }

    // Frozen memory snapshot: injected ONLY on a genuine fresh start — i.e. once the resume id
    // that will ACTUALLY be used for this run is settled (gatedResume === undefined), which covers
    // both a plain fresh dispatch (no existing/ledger session to resume) and a resume the
    // context-policy gate just above cleared or handed off. Never inject onto a resume that's
    // being KEPT: prepending this "authoritative ground truth" block into an already-live
    // conversation on every repeat dispatch would stack a fresh copy mid-conversation each time,
    // breaking the snapshot's frozen semantics. Gated exactly like pipeline.ts's own fresh-start
    // injection (`!runDeps.resume`) and dispatch's own memory-tool attachment (memoryGate).
    if (gatedResume === undefined) {
      const memCfgForSnapshot = memoryGate(deps, folder);
      if (memCfgForSnapshot) {
        order.task = memorySnapshot(folder, memCfgForSnapshot) + order.task;
        deps.ledger.recordOrder(order); // keep the recorded task in sync with what the worker gets
      }
    }

    // Guarantee the structural map the brief now REQUIRES: the worker can't self-index (the governor
    // denies subagents the codebase-memory index tools), so the engine does it here before the worker
    // starts. Best-effort — a failure never blocks the dispatch; the worker falls back to file reads.
    // Placed before startedAt so a first-time index doesn't eat the dispatch stall budget.
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
    deps.ledger.recordEvent("dispatch_start", { orderId: order.id, folder, data: { project: name, workClass, resume: !!gatedResume, stallMs, progressMs } });
    // Every registry write below is pure observation: a failure in it must never surface into the
    // worker's own path (the same contract the activity tracker has always had).
    const noteRegistry = (fn: () => void) => {
      try {
        fn();
      } catch {
        /* observer only */
      }
    };
    let lastActivityAt = startedAt;
    let apiRetries = 0;
    let retryingUntil = 0; // while set in the future, the sub-run is waiting out an API throttle
    let pausedMs = 0; // total backoff time — reported, never counted as the worker's silence
    let retryPending = false; // an API retry will re-send the brief into this run — keep it open
    // What the dispatcher needs to follow (digests) or resume (stop point) this run.
    let lastNote: string | undefined; // the worker's latest prose line — never a tool line
    let lastActivity: string | undefined; // the worker's latest activity label
    let lastDigestAt = startedAt;
    const stopPoint = (): StopPoint => ({ lastCommit: readCommit(folder), lastNote, lastActivity });
    // A dispatch is single-brief: once the session is SETTLED with nothing queued, the sub-run IS
    // complete (the real SDK stream stays open waiting for input that will never come — awaiting
    // run.done alone would falsely "stall" out minutes after the worker already finished). Close
    // the channel gracefully so done resolves with the worker's own final result; the session
    // stays resumable (idle bookkeeping below is unchanged). Settled, not merely a turn boundary:
    // a worker running background agents emits a `result` and keeps working (ADR-0007).
    let runRef: ReturnType<typeof startOrder> | undefined;
    const run = start(
      order,
      {
        onMessage: (t, kind) => {
          lastActivityAt = now();
          if (kind !== "tool") lastNote = t;
          noteRegistry(() => deps.registry.noteOutput(session.id, now()));
          void deps.reply(replyChat, t, name);
        },
        // Liveness pulse on ANY streamed SDK event (partial deltas, tool_use/tool_result, system):
        // a worker mid-generation (e.g. writing a huge file — one long turn, no completed message)
        // keeps this clock fresh, so the stall abort fires only on TRUE silence (BUG 1). It goes to
        // the REGISTRY as well as the local clock — keeping the one true liveness signal private to
        // this function is what left `sessions`, the watchdog and the idle sweep judging a busy
        // worker from a coarser one (docs/adr/0003-…).
        onHeartbeat: () => {
          lastActivityAt = now();
          noteRegistry(() => deps.registry.noteHeartbeat(session.id, now()));
        },
        // An escalation SUSPENDS the worker mid-tool with no SDK events at all, so without marking
        // it the stall monitor would abort a worker that is doing exactly what it was told to do.
        onEscalation: async (reason) => {
          noteRegistry(() => deps.registry.noteBlocked(session.id, { kind: "approval", label: reason, since: now() }));
          try {
            return await deps.askApproval(replyChat, reason);
          } finally {
            lastActivityAt = now(); // the wait was the operator's, not the worker's
            noteRegistry(() => deps.registry.noteBlocked(session.id, undefined));
          }
        },
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
        // A dispatched worker's native AskUserQuestion is serviced the same way (gated on postDecision).
        onStructuredQuestion: deps.postDecision
          ? async (ask) => {
              // raiseOperatorDecision marks the session awaiting-operator (it is the one path
              // behind every blocking ask), so nothing to do here but raise it.
              await raiseOperatorDecision(deps, {
                project: name,
                folder,
                orderId: order.id,
                chatId: replyChat,
                question: questionSummary(ask),
                spec: ask,
                now,
              });
            }
          : undefined,
        onEvent: (kind, data) => deps.ledger.recordEvent(kind, { orderId: order.id, folder, data }),
        onContextWindow: (model, tokens) => deps.ledger.recordModelWindow(model, tokens),
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
            // Same rule as the gate above: the reserve may cut a BACKGROUND sub-run's retries
            // short, never an operator-originated one — that retry is their own turn still trying.
            if (shouldRetryApi({ kind, attempt, maxRetries, draining: deps.lifecycle?.draining(), throttled: heldByReserve(workClass, deps.meter, now()) })) {
              apiRetries = attempt;
              const { delayMs, resetsAt, source } = resolveApiRetryDelayMs({
                attempt,
                rateLimits: deps.usage?.rateLimits(),
                now: now(),
                rand: opts.rand,
                ladder: retryLadder,
                jitterFrac: deps.apiRetryJitterFrac,
              });
              deps.ledger.recordEvent("api_retry", {
                orderId: order.id,
                folder,
                data: { scope: "dispatch", project: name, kind, attempt, max: maxRetries, delayMs, source, resetsAt },
              });
              // The wait is engine-driven, not the worker hanging: hold off the stall clock for
              // exactly that long, then re-send the brief into the still-open run.
              retryingUntil = now() + delayMs;
              pausedMs += delayMs;
              retryPending = true;
              void deps.reply(replyChat, apiRetryNotice(name, attempt, delayMs, resetsAt, maxRetries), name);
              void (opts.sleep ?? realSleep)(delayMs).then(() => {
                lastActivityAt = now();
                retryPending = false;
                runRef?.followUp(apiRetryFollowUp(task));
              });
              return; // keep the sub-run open — it hasn't done the work yet
            }
            deps.ledger.recordEvent("api_giveup", { orderId: order.id, folder, data: { scope: "dispatch", project: name, kind, attempts: apiRetries } });
            void deps.reply(replyChat, apiFailureNotice(name, kind, apiRetries), name, "alert");
          }
        },
        // The brief is done only when the session is settled (no background work left) and nothing
        // is queued — and not while an API retry is about to re-send it.
        onSettled: () => {
          lastActivityAt = now();
          if (!retryPending && (runRef?.queued() ?? 1) === 0) runRef?.close?.();
        },
        onActivity: (label) => {
          lastActivityAt = now();
          if (label !== "waiting" && label !== "replying") lastActivity = label;
          noteRegistry(() => deps.registry.noteActivity(session.id, label, now()));
        },
      },
      profileDeps(providerCfg, "dispatch", {
        resume: gatedResume,
        // Attach the in-process "neo" MCP server so a dispatched sub-project worker gets the same
        // operator-facing tools a directly-opened project does: `send_file` and — when the frontend
        // wired `postDecision` — `ask_operator` (the ONE way it raises a blocking question). Without
        // this the sub-worker (the most common path — the operator dispatches project work) had no
        // way to ask the operator anything. `dispatch:false` (no recursive dispatch); memory tools
        // stay gated by memoryGate (off unless the folder is in scope). The sub-worker inherits THIS
        // dispatch's work class, so a sub-dispatch would follow the same originating trigger (inert
        // while recursive dispatch stays off — the invariant holds by construction, not by memory).
        mcpServers: neoMcpServers(deps, replyChat, { dispatch: false, workClass, folder, projectName: name, orderId: order.id }),
        ...(teamAgents ? { agents: teamAgents } : {}),
      }),
    );
    runRef = run;
    dispatchRuns.add(run);
    deps.registry.attachControl(session.id, run);

    // Liveness monitor: it protects against a HUNG worker, never a busy one. There is no wall-clock
    // limit (ADR-0007): a dispatch is aborted only when the sub-run has produced no activity for
    // stallMs. Every streamed SDK event counts — partial deltas, subagent messages, task progress,
    // the CLI's tool_progress heartbeat during a long tool — so a worker busy for hours stays alive.
    // The same tick sends the progress digest.
    const sleep = (ms: number) => new Promise<"tick">((res) => setTimeout(() => res("tick"), ms));
    const doneOrTick = (ms: number) => Promise.race([run.done.then((r) => ({ done: r })), sleep(ms)]);
    const checkMs = Math.max(1, Math.floor(Math.min(stallMs, progressMs > 0 ? progressMs : stallMs) / 4));
    let result: RunResult;
    let timedOut = false;
    try {
      let limit: "stall" | undefined;
      for (;;) {
        const settled = await doneOrTick(checkMs);
        if (settled !== "tick") {
          result = settled.done;
          break;
        }
        const t = now();
        // Progress digest: to the operator's project chat (default priority — the muted DM, never
        // the Decisions group) and into the LIVE dispatcher (never waking it). Only when the worker
        // did something since the last one, so a quiet run sends nothing.
        if (progressMs > 0 && t - lastDigestAt >= progressMs) {
          if (lastActivityAt > lastDigestAt) {
            const digest = progressDigest({ project: name, elapsedMs: t - startedAt, activity: lastActivity, lastNote, lastCommit: readCommit(folder) });
            void deps.reply(replyChat, digest, name);
            try {
              await dispatcher.deliver(digest, { wake: false });
            } catch {
              // best-effort: a digest that can't be delivered is simply skipped
            }
          }
          lastDigestAt = t;
        }
        // Waiting out an API throttle is a deliberate engine pause, not a hung worker — keep the
        // stall clock fresh through it.
        if (t < retryingUntil) {
          lastActivityAt = t;
          continue;
        }
        // Waiting for the OPERATOR (a permission escalation, a raised decision) is not the worker
        // being hung — it is the worker doing what it was told. Its clock is the operator's, so the
        // stall window never runs while the block is set.
        if (deps.registry.get(session.id)?.blockedOn) lastActivityAt = t;
        if (t - lastActivityAt >= stallMs) limit = "stall";
        if (!limit) continue;
        // State the evidence BEFORE acting on it, so a wrong abort is diagnosable from the log
        // alone — including the cheap "this looks like a command sitting on an interactive prompt"
        // read, which is how a `cp -i` hang becomes obvious instead of mysterious.
        // Judge the evidence on THIS decision's own window (the dispatch stall limit), not the
        // display thresholds — a recorded state that disagrees with the abort it explains is worse
        // than none. quietAfterMs keeps its display meaning.
        const evidence = sessionEvidence(deps.registry, session, t, {
          wedgedAfterMs: stallMs,
          quietAfterMs: deps.liveness?.quietAfterMs ?? DEFAULT_LIVENESS_THRESHOLDS.quietAfterMs,
        });
        deps.ledger.recordEvent("dispatch_stall_evidence", {
          orderId: order.id,
          folder,
          data: {
            project: name,
            limit,
            state: evidence.state,
            inTurn: evidence.inTurn,
            queued: evidence.queued,
            lastActivityMs: t - lastActivityAt,
            lastOutputMs: evidence.lastOutputMs,
            activity: evidence.activity ?? null,
            stdinWait: evidence.stdinWait,
            elapsedMs: t - startedAt,
            pausedMs,
            stallMs,
          },
        });
        // Graceful wrap-up: give the worker a short grace window to commit green work and leave
        // a WIP note (the commit-per-task recovery we used to do by hand), then hard-abort.
        run.followUp(
          `⏱ Neo dispatch stall limit reached (no activity for ${Math.round(stallMs / 60000)}m) — stop working now. ` +
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
        deps.ledger.recordEvent("dispatch_abort", { orderId: order.id, folder, data: { project: name, workClass, limit } });
        const detail = `no activity for ${Math.round(stallMs / 60000)}m (stall limit)`;
        result = { ok: false, sessionId: "", summary: `timed out: ${detail} — asked to wrap up, then aborted`, costUsd: 0 };
        break;
      }
    } catch (e) {
      result = { ok: false, sessionId: "", summary: e instanceof Error ? e.message : String(e), costUsd: 0 };
    }
    // The final report is built FIRST and queued in the dispatcher inbox in the same synchronous step
    // as `dispatch_end` — no await between them — so no crash or reload can leave a run that is
    // marked ended but never reported (boot recovery only covers runs with no `dispatch_end`).
    // An abnormal end (stall abort, error, crash, API give-up, interrupt) — or a run wrapped up early
    // for an engine reload — says where it stopped, so the dispatcher can resume.
    const reloading = deps.lifecycle?.draining() === true;
    const stop = timedOut || !result.ok || reloading ? stopPoint() : undefined;
    const summary = reloading
      ? `${result.summary || (result.ok ? "done" : "failed")} (wrapped up early for an engine reload — resume it after the restart)`
      : result.summary;
    const stopLine = stop ? formatStopPoint(stop) : "";
    const line =
      (result.ok ? `${name} finished: ${summary || "done"}` : `${name}: ${summary || "failed"}`) +
      (stopLine ? `\n${stopLine}` : "");
    try {
      if (result.sessionId) {
        deps.registry.setSdkSessionId(session.id, result.sessionId, worker);
        deps.ledger.recordSession(order.id, result.sessionId, worker);
      }
      deps.meter.note({ costUsd: result.costUsd }, now());
      deps.ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary);
    } catch {
      // observer/bookkeeping errors must not surface into the worker path
    }
    try {
      deps.ledger.recordEvent("dispatch_end", {
        orderId: order.id,
        sessionId: result.sessionId || undefined,
        folder,
        // workClass + costUsd together are what lets the meter report interactive vs background spend.
        data: { project: name, workClass, ok: result.ok, timedOut, costUsd: result.costUsd, apiError: result.apiError },
      });
      let note: string | undefined;
      try {
        note = hooks.resultNote?.(result.ok && !timedOut && !reloading);
      } catch {
        note = undefined; // the queue's note is extra — the result itself must still be queued
      }
      const report = dispatchResultText({ project: name, ok: result.ok, summary, stop });
      deps.ledger.queueDispatcherReport(name, note ? `${report}\n${note}` : report, now());
    } catch {
      // observer only — never surfaces into the worker path
    }
    try {
      if (timedOut || !result.ok) {
        // A dead run must not linger: an "error" session is invisible to findByFolder (never
        // reused) and to sweepIdle (never reaped), so it would sit as a zombie and force the next
        // dispatch to register "<name>-2", "-3", … Remove it; the ledger keeps the error outcome,
        // and any sdkSessionId was persisted above for resume.
        deps.registry.remove(session.id);
      } else {
        deps.registry.setStatus(session.id, "idle");
        deps.registry.touch(session.id, now());
        deps.registry.noteBlocked(session.id, undefined); // the run is over — nothing is blocked
        deps.registry.detachControl(session.id);
      }
    } catch {
      // observer/bookkeeping errors must not surface into the worker path
    }
    try {
      // A dispatched job's finish is a RESULT the operator wants notified (Decisions group); a failure
      // is an ALERT they must also see (Decisions). Both reach the unmuted group — never the muted DM.
      // The frontend prepends the single priority accent (✅/🔴) — no per-call-site glyph (Feature 2).
      await deps.reply(replyChat, line, name, result.ok ? "result" : "alert");
    } catch {
      // the operator line is best-effort; the dispatcher report below must still go out
    }
    // The dispatcher ALWAYS gets the final result: deliver the inbox now (waking an idle company);
    // whatever cannot be delivered yet stays queued for the next flush.
    try {
      await flushDispatcherInbox(deps.ledger, dispatcher, now());
    } catch {
      // observer only
    }
    // Last: the result is out, so the todo queue may release the project's next brief (ADR-0008).
    try {
      await hooks.onEnd?.({ orderId: order.id, ok: result.ok && !timedOut && !reloading, summary });
    } catch {
      // observer only
    }
  })().catch(async (e) => {
    // A throw BEFORE the run produced a result (start() failing to launch the worker, a ledger write
    // before the supervised wait). Every step after the result is guarded, so this runs at most once
    // and never after onEnd. Without it the session stays "running" with no handle and the todo stays
    // "running", so the project — and its whole queue — is wedged until a restart. Close it out as a
    // failed run through the same exits a normal end uses.
    const summary = `failed to start: ${e instanceof Error ? e.message : String(e)}`;
    try {
      deps.ledger.recordOutcome(order.id, "error", summary);
      deps.ledger.recordEvent("dispatch_end", { orderId: order.id, folder, data: { project: name, workClass, ok: false, timedOut: false, costUsd: 0 } });
      deps.ledger.queueDispatcherReport(name, dispatchResultText({ project: name, ok: false, summary }), now());
    } catch {
      // observer only
    }
    try {
      deps.registry.remove(session.id);
    } catch {
      // observer only
    }
    try {
      await deps.reply(replyChat, `${name}: ${summary}`, name, "alert");
      await flushDispatcherInbox(deps.ledger, dispatcher, now());
    } catch {
      // observer only
    }
    try {
      await hooks.onEnd?.({ orderId: order.id, ok: false, summary });
    } catch {
      // observer only
    }
  });

  return `dispatched to ${name} — running in the background with no time limit; its output streams to the operator, you get a progress digest every few minutes, and you will receive its result as a follow-up message when it ends.`;
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

/** Raise a blocking operator DECISION and post it to the Decisions channel, returning its id. The
 *  ONE path behind every blocking-question gesture — the `ask_operator` MCP tool AND the serviced
 *  native `AskUserQuestion` — so both enqueue a durable, tracked decision, post the tappable keyboard
 *  the same way, and record the sent message id (so a plain reply resolves the exact decision). Pass
 *  `spec` for a structured multi-question / multi-select ask, or `options` for a flat single choice.
 *  When no `postDecision` is wired (customer/ingress path — the firewall), the decision is still
 *  queued (surfaced by /decisions + the secretary digest), just not posted to a channel. */
export async function raiseOperatorDecision(
  deps: Pick<DispatchDeps, "ledger" | "postDecision"> & Partial<Pick<DispatchDeps, "registry">>,
  params: {
    project?: string;
    folder?: string;
    orderId?: string;
    chatId: number;
    question: string;
    options?: string[];
    spec?: StructuredAsk;
    /** Injectable clock for the blocked-since stamp (tests). */
    now?: () => number;
  },
): Promise<string> {
  const id = deps.ledger.openDecision({
    kind: "decision",
    project: params.project,
    folder: params.folder,
    orderId: params.orderId,
    chatId: params.chatId,
    question: params.question,
    options: params.options,
    spec: params.spec,
  });
  const posted = await deps.postDecision?.({ id, project: params.project, folder: params.folder }, params.question, params.options, params.spec);
  if (posted) deps.ledger.setDecisionMessage(id, posted.chatId, posted.messageId);
  deps.ledger.recordEvent("decision_raised", {
    orderId: params.orderId,
    folder: params.folder,
    data: { project: params.project, id, structured: !!params.spec, options: params.options?.length ?? 0, posted: !!posted },
  });
  // The worker that raised this check-points and STOPS: it is awaiting the OPERATOR, not hung.
  // Marked here — the one path behind every blocking-question gesture (`ask_operator` and the
  // serviced native AskUserQuestion alike) — so no caller can raise a decision without the session
  // reporting it. Cleared when a brief/answer is delivered back, or when the run ends.
  if (deps.registry && params.folder) {
    try {
      const session = deps.registry.findByFolder(params.folder);
      if (session) {
        deps.registry.noteBlocked(session.id, { kind: "decision", label: params.question, since: (params.now ?? Date.now)() });
      }
    } catch {
      // observer only — a registry hiccup must never break raising the decision
    }
  }
  return id;
}

/** Google Stitch MCP server (HTTP transport) — design generation for operator workers. */
export const STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";

/** The Playwright MCP launch every operator worker gets — one definition, also read by the toolchain
 *  updater (ADR-0009) so the server it verifies after an update is the one workers start. */
export const PLAYWRIGHT_MCP = { command: "playwright-mcp", args: ["--headless", "--isolated"] };

/** Build the project's in-process MCP tools: `send_file` always; `dispatch` only for the company.
 *  When `opts.stitch` is set AND a `opts.stitchKey` is configured, the operator's Stitch HTTP MCP
 *  server is attached too. Stitch is OFF by default so the customer/ingress path never gets it. */
export function neoMcpServers(
  deps: DispatchDeps,
  replyChat: number,
  opts: {
    dispatch: boolean;
    /** What TRIGGERED the worker these tools are built for — an operator turn (`interactive`) or
     *  the scheduler (`background`). Decided ONCE here, at launch, and captured in the `dispatch`
     *  tool's closure, so every dispatch this worker makes (and every sub-worker it spawns)
     *  inherits it. Omitted ⇒ DEFAULT_WORK_CLASS (background) — see budget.ts for why that default
     *  is the safe one. */
    workClass?: WorkClass;
    folder: string;
    /** The project name + raising order id, recorded on any decision this worker raises (so the
     *  digest/queue can show which project waits, and the answer can resume the right session). */
    projectName?: string;
    orderId?: string;
    stitch?: boolean;
    stitchKey?: string;
    /** Operator-only local stdio MCP servers; the customer/ingress path passes neither. */
    codebaseMemoryBin?: string;
    /** Operator-only: attach the Playwright browser-automation MCP (headless chromium) so every
     *  operator project worker can drive a real browser for web/UI testing. Never on the customer
     *  path (browser automation there would let customer-tainted work reach arbitrary URLs). */
    playwright?: boolean;
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
  // `ask_operator` — the ONE structured way a worker raises a BLOCKING question/decision to the
  // operator. Attached to ALL operator project workers (regardless of the dispatch flag), gated
  // ONLY on `deps.postDecision` being wired: that closure exists only on the operator surfaces
  // (Telegram/web), never on the customer/ingress path, so customer-tainted work can never raise a
  // decision. It enqueues ONE tracked, matured DECISION (title + root-cause context + options-with-
  // trade-offs + recommendation — the Zod schema makes a shapeless question impossible to raise),
  // posts it to the Decisions channel with tappable option buttons, captures the message id, and tells
  // the worker to check-point + stop — the operator's tap/reply resumes this session as a follow-up.
  if (deps.postDecision) {
    tools.push(
      tool(
        "ask_operator",
        "Raise ONE matured decision the operator must make before this work can proceed (e.g. \"Postgres or Mongo?\", \"which design?\", \"I need the prod API key\"). " +
          "BEFORE you call this, challenge yourself: (1) trace the real root cause in the code, not the symptom; (2) determine the correct industry-standard fix, not the quickest patch; (3) criticize your own options and drop any that are only workarounds. " +
          "Escalate ONLY a decision that is genuinely the operator's: product/UX policy, cost, an irreversible or external action, or a real trade-off between two sound options. If there is one correct standard fix, do it and report — do NOT ask. " +
          "Raise exactly one decision per call: each call carries a crisp `title`, the `context` (what happened + the root cause), 2–5 `options` that each state what they mean + their trade-off (no patch-level options), and your `recommendation` (which + why). If you have several independent decisions, call ask_operator once per decision — never bundle several into one. " +
          "It goes to the operator's high-priority Decisions channel and is tracked until they answer. Set `multiSelect: true` when the operator may pick SEVERAL of the options (they tap each, then Submit). After calling this, CHECK-POINT your work (commit green work / write a WIP note) and STOP — their answer will resume this session as a follow-up message. Do NOT guess a default and continue.",
        {
          title: z.string().describe("one-line title of the SINGLE decision"),
          context: z
            .string()
            .describe("1–3 plain lines: what happened + the ROOT CAUSE, so the operator sees WHY a decision is needed"),
          options: z
            .array(
              z.object({
                label: z.string().describe("short button label the operator taps"),
                detail: z
                  .string()
                  .describe("what this option concretely means + its trade-off (cost/risk/effort) — never a patch-level option"),
                recommended: z.boolean().optional().describe("set on the ONE option you recommend"),
              }),
            )
            .min(2)
            .max(MAX_OPTIONS)
            .describe("2–5 defensible options, each carrying its own trade-off detail"),
          recommendation: z
            .string()
            .describe("which option you advise + one line WHY (the decision still stays with the operator)"),
          multiSelect: z
            .boolean()
            .optional()
            .describe("set true when the operator may choose SEVERAL of the options (tap each, then Submit); default single choice"),
          question: z
            .string()
            .optional()
            .describe("optional crisp restatement of the question shown above the buttons; defaults to the title"),
        },
        async (args: MaturedDecisionInput) => {
          // The Zod schema already guarantees the matured shape; `maturedAsk` normalizes it into the
          // StructuredAsk that rides on the decision row (belt-and-suspenders: undefined on degenerate
          // input). The crisp title becomes the row's question; context/options+details/recommendation
          // live on the spec.
          const spec = maturedAsk(args);
          if (!spec) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "That decision was not well-formed — it needs a title, a root-cause context, 2+ options (each with a trade-off detail), " +
                    "and a recommendation. Re-raise it as one fully matured decision.",
                },
              ],
            };
          }
          const id = await raiseOperatorDecision(deps, {
            project: opts.projectName,
            folder: opts.folder,
            orderId: opts.orderId,
            chatId: replyChat,
            question: spec.title ?? args.title,
            spec,
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Raised with the operator (decision #${id.slice(0, 8)}). Check-point your work (commit green work / write a WIP note) and STOP — ` +
                  `the operator's answer will resume this session as a follow-up. Do not assume a default.`,
              },
            ],
          };
        },
      ),
    );
  }
  if (opts.dispatch) {
    tools.push(
      tool(
        "sessions",
        "List the operator's live project sessions and what each is doing RIGHT NOW. Each line gives a STATE plus two ages — `last activity` (any sign of life) and `last output` (what the operator can read). Read the state, not the ages: `idle` means healthy and free NO MATTER how old its ages are (a project can sit idle for days and still answer instantly), `working`/`quiet` mean it is busy, `starting` means the engine is still preparing it, `awaiting-operator` means it needs the OPERATOR's answer, and ONLY `wedged` means genuinely stuck. Never tell the operator a project is stuck, hung or in need of a restart unless its state is `wedged`. Use this to answer the operator about a project's status, or — when a dispatch reports a project busy — to decide whether to wait for it or report back. Returns text.",
        {},
        async () => ({ content: [{ type: "text" as const, text: sessionsReport(deps.registry, Date.now(), deps.liveness) }] }),
      ),
      tool(
        "dispatch",
        "Open one of the operator's projects and run a self-contained task in it. Use this for any order that belongs to a specific project (e.g. api-server, web-app). The target project does NOT see the operator's original message — only your `task` brief — so write `task` as a clear, complete prompt. " +
          "If the project is busy (mid-task), the brief is QUEUED in that project's todo queue and the reply says \"queued as #N for <project>, position P\": it starts by itself when the current task is done, so confirm the number and position to the operator and never re-send or forward it. " +
          "The run has NO time limit — it works until it is done, even for hours; only a worker that goes completely silent (hung) is stopped. While it runs you get a `[dispatch progress]` line every few minutes (FYI — no reply needed), and you ALWAYS get a `[dispatch result]` message when it ends — including when it was cut short, in which case the result says where it stopped (last commit / latest note) so you can dispatch a follow-up that resumes from there. " +
          "Set `team: \"frontend-backend\"` ONLY when the operator wants the work split across a lead-orchestrated backend + frontend subagent team; omit it for a normal single-worker run.",
        {
          project: z.string().describe('project folder name under the operator\'s project root, e.g. "eticket-v3"'),
          task: z.string().describe("a clear, self-contained brief/prompt for that project to execute"),
          team: z
            .enum(["frontend-backend"])
            .optional()
            .describe(
              "opt-in: run the brief with a lead-orchestrated backend + frontend subagent team (the lead delegates by domain, enforces file-ownership boundaries, and coordinates via a shared contract file). Omit for a normal single-worker dispatch.",
            ),
        },
        async (args: { project: string; task: string; team?: "frontend-backend" }) => {
          // The dispatch inherits the class of the worker calling the tool: the company session
          // servicing an operator message dispatches as `interactive`, a scheduler-fired one as
          // `background`. This is the whole of the "class follows the originating trigger" rule.
          const workClass = opts.workClass ?? DEFAULT_WORK_CLASS;
          const out = deps.todo
            ? await deps.todo.submit({ project: args.project, brief: args.task, team: args.team, workClass }, deps, replyChat)
            : await dispatchToProject(args.project, args.task, deps, replyChat, { root: deps.workRoot, team: args.team, workClass });
          return { content: [{ type: "text" as const, text: out }] };
        },
      ),
    );
    const todo = deps.todo;
    if (todo) {
      tools.push(
        tool(
          "todo",
          "The per-project todo queues. Every brief you `dispatch` is a todo (#N): it runs now when the project is free, else it waits in that project's queue and starts BY ITSELF when the current task is done — so never re-send or forward a queued brief, and never push a brief into a project mid-task. " +
            "Actions: `list` (all projects, or one with `project`), `add` (same as dispatch: needs `project` + `task`), `reorder` (`id` + 1-based `position`), `cancel` (`id`, queued todos only — a running one is stopped by the operator with /kill), `pause` / `resume` (`project`). Returns text.",
          {
            action: z.enum(["list", "add", "reorder", "cancel", "pause", "resume"]),
            project: z.string().optional().describe("project folder name, e.g. \"eticket-v3\""),
            id: z.number().int().optional().describe("todo number (#N)"),
            position: z.number().int().min(1).optional().describe("new 1-based queue position, for reorder"),
            task: z.string().optional().describe("the brief, for add — a clear, self-contained prompt"),
            team: z.enum(["frontend-backend"]).optional().describe("opt-in team mode, for add (as in dispatch)"),
          },
          async (args: { action: string; project?: string; id?: number; position?: number; task?: string; team?: "frontend-backend" }) => {
            const need = (what: string) => `todo ${args.action} needs ${what}.`;
            const text = await (async () => {
              switch (args.action) {
                case "list":
                  return todo.list(args.project);
                case "add":
                  if (!args.project || !args.task) return need("`project` and `task`");
                  return todo.submit({ project: args.project, brief: args.task, team: args.team, workClass: opts.workClass ?? DEFAULT_WORK_CLASS }, deps, replyChat);
                case "reorder":
                  if (args.id === undefined || args.position === undefined) return need("`id` and `position`");
                  return todo.move(args.id, args.position);
                case "cancel":
                  if (args.id === undefined) return need("`id`");
                  return todo.cancel(args.id);
                case "pause":
                  if (!args.project) return need("`project`");
                  return todo.pause(args.project);
                case "resume":
                  if (!args.project) return need("`project`");
                  return todo.resume(args.project);
                default:
                  return `unknown todo action: ${args.action}`;
              }
            })();
            return { content: [{ type: "text" as const, text }] };
          },
        ),
      );
    }
  }
  // Memory tools (`memory`, `memory_search`): attached ONLY through the same gate that guards the
  // frozen snapshot injection in dispatchToProject (memoryGate) — operator paths whose target
  // folder is in scope. The ingress/customer path passes neither deps.memory nor
  // deps.companyFolder, so memoryGate always returns undefined there — firewall by construction,
  // not by an extra flag that could drift out of sync.
  const memCfg = memoryGate(deps, opts.folder);
  if (memCfg) {
    // model:undefined — neoMcpServers builds the MCP tool set at worker-launch time, before the
    // SDK has reported which model this session is actually using (that only appears in the
    // transcript once the worker starts talking), so windowTokensFor has no model to look up and
    // falls back to its conservative default window (see context-policy.ts's MODEL_WINDOW_TOKENS).
    // Same reasoning context-policy.ts's other "no model yet" call sites document.
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
  // Operator-only: Playwright browser-automation MCP (headless chromium) for web/UI testing across
  // all operator projects. Lazy — the browser only launches when a tool is actually called, so the
  // per-worker cost is just a lightweight stdio process. Never attached on the customer/ingress path.
  if (opts.playwright) {
    servers.playwright = { type: "stdio", ...PLAYWRIGHT_MCP, env: {} };
  }
  return servers;
}
