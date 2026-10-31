// The `dispatch` tool — given ONLY to the default project ("the company"). It lets the
// chief-of-staff open one of the operator's projects and run a self-contained brief in it, as a
// tracked, governed Neo sub-project (registry → dashboard, escalations → operator, metered),
// then returns that project's result for the company to summarise. The company writes the brief
// (a tailored prompt), so the sub-project gets a clear order, not the operator's raw message.
import { controlByProject, DEFAULT_TOOL_CONTROL_CFG, type ToolControlCfg } from "./tool-control";
import { DEFAULT_LANES_CFG, LANE_GUIDE, LANE_KINDS, laneArgError, lanePreamble, type LaneKind, type LanesCfg } from "./lanes";
import { createLaneWorktree, endLaneWorktree, type LaneWorktree, type LaneWorktreeEnd } from "./lane-worktree";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FollowUpTiming, Order, SessionInfo } from "../types";
import type { NeoConfig, WorkerPathName, WorkerProfile, MemoryCfg } from "../config";
import type { Priority } from "./priority";
import { checkDecision, decisionBody, DECISION_LIMITS, MAX_OPTIONS, type StructuredAsk, type DecisionInput } from "./structured-question";
import { memorySnapshot, memoryEnabledFor } from "./memory";
import { PAGE_MAX, type Cause, type Ledger, type MessageKind } from "./ledger";
import type { Trace } from "./trace";
import type { Registry } from "./registry";
import { budgetHoldMessage, heldByReserve, DEFAULT_WORK_CLASS, type Meter, type WorkClass } from "./budget";
import type { UsageMeter } from "./usage";
import { noteProjectStart, type TrustStore } from "./trust";
import { runOrder, startOrder, type RunResult } from "./session-runner";
import { createHash } from "node:crypto";
import {
  dispatchResultText,
  formatStopPoint,
  lastCommitIn,
  liveCompanyLink,
  flushDispatcherInbox,
  progressDigest,
  digestFingerprint,
  createSpinWatch,
  DISPATCH_SPIN_DIGESTS_DEFAULT,
  TOOL_LOOP_LIMIT_DEFAULT,
  TOOL_LOOP_EXEMPT_DEFAULT,
  type DispatcherLink,
  type StopPoint,
} from "./dispatch-report";
import { frontendBackend, teamLeadPreamble } from "./agent-teams";
import { DEFAULT_PROJECT } from "./default-project";
import {
  decideContext,
  sessionContext,
  contextWindows,
  runHandoff,
  completeHandoff,
  effectiveCacheTtlMs,
  CACHE_OBS_WINDOW,
  windowTokensFor,
  awaitHandoff,
  trackHandoff,
  handoffHoldMs,
  handoffPreamble,
  handoffDeferred,
  continuationBrief,
  describeContextReset,
  noteStamp,
  nextAfterHandoff,
  type ContextPolicyCfg,
  type HandoffNext,
} from "./context-policy";
import { faults } from "./fault";
import { todoTitle } from "./todo-title";
import { createCheckpointWatch, createResumeProbe, type ResumeProbe } from "./context-checkpoint";
import { clearDecisionBlock, describeSession, sessionEvidence, sessionsReport, stateOf } from "./session-status";
import { knownProjects, projectDeps, projectSummaries, summaryLine } from "./project-view";
import { DEFAULT_LIVENESS_THRESHOLDS, type LivenessThresholds } from "./liveness";
import type { CodebaseMemoryIndexer, IndexResult } from "./codebase-memory";
import type { TodoQueue } from "./todo-queue";
import { memoryTools } from "./memory-tool";
import { profileDeps } from "./worker-profile";
import { patientApproval } from "./escalation";
import { DEFAULT_GOVERNOR_CFG } from "./governor";
import { canResumeWith } from "./sdk-choice";
import { createPlanWatch } from "./plan-watch";
import { commitFinishLine, createCommitFinish, readRunBaseline, realCommitFinishGit, type BaselineRead, type CommitFinishCfg, type RunBaseline } from "./commit-finish";
import { applyPlanAction, offerPlanFile, onRunEndPlans, headSha, planDepsFrom, planState, DEFAULT_PLANS_CFG, type PlanDeps, type PlanRun, type PlansCfg, type PostPlan, type EditPlanCard } from "./plans";
import { supportsRunConfigField } from "./model-resolver";
import { formatToolsReply, type Catalogue } from "./tools-catalogue";
import type { TaskHistory } from "./history/index";
import { HISTORY_SEARCH_DESCRIPTION, historyRefusedInCustomerSession, historySearchTool, REMEMBER_DESCRIPTION, rememberTool, TOOL_LIMIT_MAX, type RememberCaller } from "./history/tool-text";
import { repliedContextBrief } from "./reply-routing";
import { answerable, textAnswerRefusal } from "./decision-settle";
import { NOTES_TOOL_DESCRIPTION, runNoteAction, type NoteToolArgs, type NoteToolSender, type ProjectNotes } from "./project-notes";
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
import { heldLine, type ApiWaits, type WaitEndReason } from "./api-wait";
import { FINISH_RULE, PLAN_RULE, PUSH_RULE, QUALITY_RULE, STOP_RULE, TECH_RULE } from "./standing-rules";
import { DEFAULT_SIZES_CFG, ORDER_SIZES, PLAN_WAITS_TEXT, SIZE_GUIDE, operatorUpLine, parseSizeOverride, resolveSize, sizeReason, sizeTag, type OrderSize, type SizesCfg, type SizeUp } from "./order-size";
import { createSizeGuard, type SizeEnd, type SizeGuard } from "./size-guard";
import { SUB_CHAT, CUSTOMER_CHAT, SIDE_CHAT } from "./chats";

/** Real backoff wait (tests inject opts.sleep instead). */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** ADR-0060: the most a woken limit hold waits, so several held runs do not all re-send at once. */
export const API_LIMIT_WAKE_JITTER_MS_DEFAULT = 30_000;

/** The reserved chat ids live in the leaf module `chats.ts` (ADR-0067), re-exported here for the callers
 *  that already import them from dispatch. */
export { SUB_CHAT, CUSTOMER_CHAT, SIDE_CHAT };

/** Function-scoped scratch workspaces (research, dev, marketing, …) for work with no project home. */
export const DESKS_DIR = join(DEFAULT_PROJECT.folder, "desks");

/** Extra facts about one outbound line, for the trace (ADR-0015). Frontends ignore it. */
export interface ReplyMeta {
  /** What the line is. Absent → derived from the priority (progress by default). */
  kind?: MessageKind;
  /** The registry id of the session the line belongs to: its cause files the line. */
  session?: string;
  /** File the line under this cause (the run's final line, once the session may be gone). The
   *  recording wrapper sets it to the cause it filed the line under. */
  cause?: Cause;
  /** The recorded row of this line, set by the recording wrapper: the channel binds its own id to it. */
  msgId?: number;
  /** The project folder the line worked in (default: the named project's live session's folder). */
  folder?: string;
}

/** Everything dispatch needs — a structural subset of the pipeline's deps. */
export interface DispatchDeps {
  ledger: Ledger;
  registry: Registry;
  meter: Meter;
  usage?: UsageMeter;
  trust: TrustStore;
  /** `meta` files the line in the trace (the pipeline's recording reply reads it; frontends ignore it). */
  reply: (chatId: number, text: string, project?: string, priority?: Priority, meta?: ReplyMeta) => void | Promise<void>;
  /** `signal` aborts when the engine gives up waiting (approval timeout): drop the prompt. `cause`
   *  files the prompt and the verdict in the thread of the run that asked. */
  askApproval: (chatId: number, reason: string, signal?: AbortSignal, cause?: Cause) => Promise<"allow" | "deny">;
  /** Deliver a worker-produced file back to the operator's channel (Telegram/web). */
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
  /** Post a plan card (ADR-0019; frontend-supplied, operator surfaces only). Absent → no plan
   *  detection at all (nothing is registered), and `send_file` of a plan is a plain file. */
  postPlan?: PostPlan;
  /** Redraw a posted plan card when its plan changes state (ADR-0036). */
  editPlan?: EditPlanCard;
  /** Config `plans` (paths, send, size cap, Execute brief). Absent → the shipped defaults. */
  plans?: PlansCfg;
  /** Config `commitFinish` (ADR-0037): a run that settles with its own changes uncommitted is asked
   *  once, in the same session, to commit them. Absent → off. */
  commitFinish?: CommitFinishCfg;
  /** Post a raised decision to the operator's high-priority Decisions channel and return the sent
   *  message id (so a reply/edit can find it). The frontend supplies this — it builds the inline
   *  keyboard from `options` (tappable answers) + an "other / type an answer" affordance. Its
   *  PRESENCE gates the `ask_operator` tool: only operator surfaces (Telegram/web) wire it, so the
   *  customer/ingress path never gets ask_operator — the firewall, by construction. */
  /** Project notes (ADR-0043). Its PRESENCE gates the `project_notes` tool: the daemon wires it on the
   *  operator surfaces only, and the ingress path strips it explicitly (it spreads these deps). */
  notes?: ProjectNotes;
  /** The tools catalogue (ADR-0044). Its PRESENCE gates the `tool_api` relay tool: operator surfaces wire
   *  it, the ingress path strips it, like `notes`. */
  tools?: Catalogue;
  /** The task history (ADR-0067). Its PRESENCE gates the `history_search` and `remember` tools: the daemon
   *  wires it on the operator surfaces only (absent while history is off), and the ingress path strips it. */
  history?: TaskHistory;
  postDecision?: (
    /** `ref`: the ref of the decision's thread (trace only) — the card ends with it (spec §4.3). */
    rec: { id: string; project?: string; folder?: string; ref?: string },
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
  /** Spinning dispatch (spec §8.1): this many digests in a row with the same fingerprint (label,
   *  note, HEAD) alert the operator and the dispatcher once. Default DISPATCH_SPIN_DIGESTS_DEFAULT. */
  dispatchSpinDigests?: number;
  /** On a spin: "alert" only, or "wrapup" — also send the stall limit's wrap-up follow-up. */
  dispatchSpinPolicy?: "alert" | "wrapup";
  /** The same (tool, input) this many times in a row inside one turn → the same alert. Default
   *  TOOL_LOOP_LIMIT_DEFAULT. */
  toolLoopLimit?: number;
  /** Tools whose repeats are waiting, not looping (polling a background job). Default
   *  TOOL_LOOP_EXEMPT_DEFAULT. */
  toolLoopExempt?: string[];
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
  /** Governor knobs (ADR-0012): the out-of-folder write answer for the dispatched worker and the
   *  approval reminder/timeout. Absent ⇒ writes "ask" (so the customer ingress path, which does not
   *  thread it, keeps the fence) and the default approval patience. */
  governor?: NeoConfig["governor"];
  /** Side lanes (ADR-0057): where a `code` lane's worktree goes. Absent = DEFAULT_LANES_CFG. */
  lanes?: LanesCfg;
  /** Stop/background one running tool call (ADR-0058). Absent = DEFAULT_TOOL_CONTROL_CFG. */
  toolControl?: ToolControlCfg;
  /** Order sizes (ADR-0072): the preambles, the upgrade guard's rules and limits, the quick result's
   *  clamp. Absent = DEFAULT_SIZES_CFG. */
  sizes?: SizesCfg;
  /** Extra env vars merged into every spawned worker (see NeoConfig.workerEnv). */
  workerEnv?: Record<string, string>;
  /** Graceful-reload gate: while draining, dispatch refuses new sub-runs (see engine/reload.ts). */
  lifecycle?: { draining(): boolean };
  /** Shared API-throttle gate (engine/api-retry.ts): while a throttle is fresh, a NEW sub-run is
   *  held rather than started, so retries + the loop scheduler can't amplify the storm. */
  cooldown?: ApiCooldown;
  /** Held API waits (ADR-0060): `todo retry` ends one now, a run that goes on by itself drops its own,
   *  and a successful turn wakes the account's other limit holds. Absent → a plain timer (tests). */
  apiWaits?: ApiWaits;
  /** ADR-0060: a successful turn wakes the same provider's other limit holds early (config
   *  `apiLimitWakeEarly`, default true), each after a random wait up to `apiLimitWakeJitterMs`. */
  apiLimitWakeEarly?: boolean;
  apiLimitWakeJitterMs?: number;
  /** ADR-0061: deliver the chief of staff's message into a project's open session, like the operator's own.
   *  Its PRESENCE gates the `project_message` tool; operator-only — the ingress strips it. */
  projectMessage?: (a: { project: string; text: string; replyChat: number; cause?: Cause }) => Promise<{ ok: boolean; outcome?: string; text: string }>;
  /** Root under which the company `dispatch` tool resolves project names (config workRoot). Default "/home". */
  workRoot?: string;
  /** Config `projects` (healthUrl etc.) — the `sessions` tool's project summaries read it (P6). */
  projects?: NeoConfig["projects"];
  /** Config `github` — the summaries judge a health probe stale against its scanEveryMs (P6). */
  github?: NeoConfig["github"];
  /** Neo's own repo, for the project summaries. Absent → the daemon's working folder. */
  neoFolder?: string;
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
  /** The cause seam (ADR-0015): thread state refreshes, `send_file` lines, tool actions and the
   *  ref on the dispatcher's result. Absent → none of these, exactly as before. */
  trace?: Trace;
}

/** Re-derive a thread's state; best-effort (ADR-0010). */
function refreshThread(deps: Pick<DispatchDeps, "trace">, threadId: number | undefined): void {
  if (deps.trace && threadId !== undefined) faults.guard("dispatch.refreshThread", () => deps.trace!.refreshThread(threadId), { threadId });
}

type RunFn = typeof runOrder;

/** The runs THIS module started (dispatch-owned). Only a brief delivered into one of them is
 *  covered by that run's progress digests and final report; a brief pushed into an operator-opened
 *  session is not, and the reply to the dispatcher must say so instead of promising a result. */
const dispatchRuns = new WeakSet<object>();

/** How a dispatch run ended, as the todo queue hears it. `failure` is WHY a bad end happened, when the
 *  engine knows it as a fact (ADR-0027): `stall` (the liveness limit aborted it), `reload` (wrapped up
 *  for an engine reload), `checkpoint` (a context checkpoint could not complete), `launch` (the worker
 *  failed to start) or `api:<kind>` (the SDK's error kind). Absent on a bad end = the worker reported
 *  failure, or the operator stopped it. */
export interface TodoEnd {
  orderId: string;
  ok: boolean;
  summary: string;
  continuation?: string;
  failure?: string;
  /** A `code` side lane's worktree end (ADR-0057): the queue merges or raises it. */
  lane?: LaneWorktreeEnd;
  /** A guarded run's end (ADR-0072): its final size, `requeue` (it ended in plan first with no plan of
   *  its own awaiting approval: the todo runs again, as big — the queue does so only after a good or a
   *  passing end), any `late` move, and `planWaits`. A big run's guard only measures. Absent = no guard
   *  (Codex, sizes off, a guard that could not be made). */
  size?: SizeEnd;
}

/** Liveness stall limit (ms) — 5 minutes of NO activity aborts a sub-run. */
export const DISPATCH_STALL_MS_DEFAULT = 300_000;
/** Wrap-up grace window (ms) — 75 seconds between the limit firing and the hard abort. */
export const DISPATCH_GRACE_MS_DEFAULT = 75_000;

/** The wrap-up follow-up: stop, commit green work, leave a WIP note. Used by the stall limit and by
 *  the "wrapup" spin policy. */
export function wrapUpBrief(why: string, graceMs: number): string {
  return (
    `⏱ Neo ${why} — stop working now. ` +
    `Commit any green work and write a brief WIP note (plan doc or WIP.md) so a follow-up run can resume. ` +
    `You have ~${Math.round(graceMs / 1000)}s before this session is aborted.`
  );
}
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
 *  directly only for what the map doesn't cover (that line, codebaseMemoryLine, is prepended after
 *  the engine indexed the folder, so it carries the exact project name — ADR-0028), (3) works in two phases — DESIGN (sharpen the
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
 *  so a worker can't turn a solvable bug into a shallow patch-menu), and (6) fixes what the security
 *  scans block instead of getting past them (ADR-0024). (2) is made satisfiable by the
 *  engine: `ensureIndexed` (see codebase-memory.ts) indexes the folder (or refreshes a stale index)
 *  before the worker starts and returns its project name, because the governor denies subagents the index
 *  tools so a worker can never self-index. The engine appends this automatically so the operator
 *  never has to and it can't be omitted. */
/** The codebase-memory instruction, built once the engine has indexed the folder (ADR-0028): the
 *  EXACT project name, so the worker never lists, checks or indexes. No name → the engine could not
 *  make an index; the worker reads files and does not try to index it itself. */
export function codebaseMemoryLine(index: { project?: string }): string {
  if (!index.project) {
    return "codebase-memory: no index is available for this project right now — read the files directly; do not try to index it yourself.";
  }
  return (
    `REQUIRED — use the \`codebase-memory\` MCP FIRST. The engine has indexed this project as \`${index.project}\` (fresh at its HEAD). ` +
    `Pass project="${index.project}" to get_architecture for the module layout, then search_code / query_graph to find the code that matters. ` +
    "Do NOT call `list_projects`, `index_status` or `index_repository`. A git worktree of this repo uses the same index for structure; " +
    "read the files you changed directly. Read source files directly ONLY for what the map doesn't cover — never as your default way in."
  );
}

/** The notice tail for a run that ended on a plan card (ADR-0029): its Execute tap queues the work. */
export function planWaitTail(d: { id: string; question: string }): string {
  return `paused: waiting on plan approval #${d.id.slice(0, 8)} — ${d.question} (its Execute tap queues the work)`;
}

// The preamble's paragraphs (ADR-0072): the big preamble is built from them exactly as before, and the quick and
// standard preambles reuse the ones they share, so a shared rule has one wording. Each ends with its blank line.

/** The operator's engineering baseline (2026-09-18) with the quality and technology rules (big and standard). */
const BASELINE_PARAGRAPH =
  "REQUIRED — engineering baseline (operator hard rule): code that is not industry-standard is a " +
  `failure, even when it works. ${QUALITY_RULE} (1) i18n via standard per-locale catalogues (react-i18next or ` +
  "equivalent), namespaced keys, AR+EN complete — never literal UI strings or a bespoke " +
  "mechanism; numbers stay LTR in RTL (+964 left of the phone). (2) `.env` + environments, " +
  "dev by default, failing closed to dev-safe behaviour and never to prod. (3) Everything runs in Docker. (4) No " +
  "hardcoding — values live in env/DB/config. (5) Read the existing code FIRST and REUSE it, never " +
  `a second implementation. (6) ${TECH_RULE} A change that misses one is not done.\n\n`;

/** The security kit's rules (ADR-0024; every size). */
const SECURITY_PARAGRAPH =
  "REQUIRED — security: a NEW high or critical scan finding (edit/commit/push) blocks; fix " +
  "the code. Never `--no-verify`, edit `.security/baseline.json` or disable a hook; report a false " +
  "positive instead. Never read or print secret files; you may write an operator-supplied dev secret into " +
  "`.env` (chmod 600). `/security-review` before finishing auth, " +
  "payment, upload or input-handling work.\n\n";

/** The project fence (ADR-0030), the notes, the tools and the task history (every size). */
const FENCE_PARAGRAPH =
  "REQUIRED — stay in this project: never write, branch or commit in another project under /home, nor " +
  "may your helper agents. Work for another project: send it there with `project_notes`. " +
  "Missing a fact, tool or key? `project_notes ask` and `tools_for` (`neo-tool-*` skills, `tool_api`) — never wait silently, never paste keys. " +
  "Done before? `history_search` first.\n\n";

/** Challenge yourself before an operator question (big and standard). */
const CHALLENGE_PARAGRAPH =
  "REQUIRED — challenge yourself BEFORE you ask the operator anything. Trace the real root cause " +
  "in the code, not the symptom. Choose the correct industry-standard fix, not the quickest patch " +
  "or a workaround. Escalate ONLY what is genuinely the operator's: " +
  "product/UX policy, cost, an irreversible, prod or external action, or a real trade-off between two sound " +
  `options. If there is one correct standard fix, do it and report it — do not ask. ${STOP_RULE} ` +
  "When you must ask (ask_operator): for a non-technical reader, in the operator's language — the situation, " +
  "each option and its effect, your pick and why. One decision per card; no jargon.\n\n";

/** The stall monitor's facts, said once (every size's stay-alive paragraph). */
const ABORT_SENTENCE = "Neo ABORTS a run after ~5 min with no streamed step.";
const NO_TIMEOUT = "never wrap a real test in `timeout`";

/** Stay alive (big and standard). */
const ALIVE_PARAGRAPH =
  `REQUIRED — stay alive, never blocked. ${ABORT_SENTENCE} Start ` +
  "long checks (vet/test/lint loops, builds, image pulls, CI waits) in the background (background Bash " +
  `or a subagent), each module its own log; ${NO_TIMEOUT}. Keep working and read each ` +
  "result when ready; with nothing left, POLL in FOREGROUND steps under 90 s. No Monitor. Single-shot: never end your turn while a " +
  "check runs or its result is unread.\n\n";

/** The dispatch preamble: the standing rules every dispatched worker gets (operator rules 2026-09-18 and
 *  2026-10-29, ADR-0063). Concise — every brief pays for it; the rule sentences live in standing-rules.ts.
 *  This is a BIG order's preamble (ADR-0072: `briefForSize("big", t)`). */
export function briefWithProjectDocs(task: string): string {
  return (
    "First read this project's rule and doc .md files (AGENTS.md, DESIGN.md, other root .md files, " +
    "docs this task touches); follow them with CLAUDE.md.\n\n" +
    "REQUIRED — work in two phases: DESIGN, then BUILD.\n" +
    "  DESIGN — think deeply; hand it to the `planner` subagent (strongest model, highest effort). With the " +
    "`domain-modeling` and `codebase-design` skills: the real terms in `CONTEXT.md`, a short ADR per genuine " +
    "decision (with rejected options); a spec (acceptance criteria, edge cases) as one clean seam " +
    "behind a small, testable interface; a plan via `superpowers:brainstorming` → `writing-plans`. " +
    `${PLAN_RULE} For a bug, \`superpowers:systematic-debugging\` to root-cause first. (Skip CONTEXT.md/ADR ` +
    "only for a trivial edit; say so.)\n" +
    "  BUILD — implement against that spec with `superpowers:test-driven-development` (failing test first, " +
    "per acceptance criterion), then `superpowers:verification-before-completion`, a final `planner` " +
    `review and \`requesting-code-review\` before claiming done. ${FINISH_RULE} ${PUSH_RULE}\n\n` +
    BASELINE_PARAGRAPH +
    SECURITY_PARAGRAPH +
    FENCE_PARAGRAPH +
    CHALLENGE_PARAGRAPH +
    ALIVE_PARAGRAPH +
    "Write any plan or spec under `docs/superpowers/plans/` or `docs/superpowers/specs/`; Neo " +
    "sends it to the operator. A small plan: build on. A BIG plan (many tasks; migrations, auth, " +
    "money, deploy, deletes; or `approval: required`) waits: when a call is denied with " +
    "STOP, end your turn — Approve & build resumes you.\n\n" +
    task
  );
}

/** A QUICK order's preamble (ADR-0072, spec §7): read, fix, check, commit once — no planner, spec, ADR or plan
 *  file. It keeps the security, fence and push rules, AR+EN and LTR numbers; the size guard moves it up. */
function quickBrief(task: string): string {
  return (
    "QUICK order — Neo's rules for a small fix: read the code, fix it, check it, commit once. No planner, spec, ADR or plan file: just fix.\n" +
    "First read the rule .md files of this project that the fix touches (AGENTS.md, DESIGN.md); follow them with CLAUDE.md.\n\n" +
    "REQUIRED — fix it:\n" +
    "  FIND — the root cause in the code, not the symptom (`superpowers:systematic-debugging` for a bug). Change the fewest lines " +
    "that fix it the standard way; reuse what exists; never reformat files you did not change.\n" +
    "  CHECK — a test only when you change logic (failing first); run the typecheck and the tests near the change. A UI change: " +
    "one screenshot in Arabic (RTL) and one in English; numbers stay LTR.\n" +
    `  COMMIT — one commit. ${PUSH_RULE}\n` +
    "  SIZE — Neo moves this order up a size, and tells you, when it grows (more than a few files or lines, or a second service) " +
    "or touches auth, money, migrations, secrets, deploy/CI or prod. Then follow the rules it gives you.\n" +
    "  RESULT — end with 2–3 lines: the cause, the fix (files), the commit.\n\n" +
    `REQUIRED — engineering baseline: ${QUALITY_RULE} (1) i18n through the project's per-locale catalogues, AR+EN complete — ` +
    "never literal UI strings; numbers stay LTR in RTL. (2) `.env`, dev by default. (3) Docker. (4) No hardcoding. " +
    "(5) Reuse the existing code, never a second implementation.\n\n" +
    SECURITY_PARAGRAPH +
    FENCE_PARAGRAPH +
    "REQUIRED — ask the operator (ask_operator) only for a real decision (product/UX policy, cost, an irreversible, prod or " +
    "external action): for a non-technical reader, in the operator's language, one decision per card. Otherwise do the " +
    "standard fix and report it.\n\n" +
    `REQUIRED — stay alive: ${ABORT_SENTENCE} Run long checks in the background (background Bash or a subagent) and read ` +
    `each result before you end; ${NO_TIMEOUT}.\n\n` +
    "The order:\n" +
    task
  );
}

/** A STANDARD order's preamble (ADR-0072, spec §7): a short plan in the task list, test-first, checkpoints — no
 *  plan file, spec or planner. The baseline, security, fence, challenge and stay-alive paragraphs are big's. */
function standardBrief(task: string): string {
  return (
    "STANDARD order — Neo's rules for a change of a few files: plan briefly, build test-first, commit in checkpoints.\n" +
    "First read this project's rule and doc .md files (AGENTS.md, DESIGN.md, docs this change touches); follow them with CLAUDE.md.\n\n" +
    "REQUIRED — plan briefly, then build:\n" +
    "  PLAN — a short plan (the steps and their tests) in your task list (TodoWrite): no plan file, no spec, no planner subagent. " +
    "For a bug, `superpowers:systematic-debugging` to root-cause first. New domain words go in CONTEXT.md; an ADR only for a " +
    "real decision between sound options, with the rejected ones.\n" +
    "  BUILD — `superpowers:test-driven-development`: a failing test first for each behaviour you change, then the code; " +
    `\`superpowers:verification-before-completion\` before you say done. ${FINISH_RULE} ${PUSH_RULE}\n` +
    "  SIZE — Neo moves this order up to big, and tells you, when it grows (many files, lines or services) or touches auth, " +
    "money, migrations, secrets, deploy/CI or prod: then it needs a plan the operator approves.\n" +
    "  RESULT — end with a short result: what changed (files), the tests, the commits.\n\n" +
    BASELINE_PARAGRAPH +
    SECURITY_PARAGRAPH +
    FENCE_PARAGRAPH +
    CHALLENGE_PARAGRAPH +
    ALIVE_PARAGRAPH +
    "The order:\n" +
    task
  );
}

/** The dispatch preamble of an order's size (ADR-0072). Big is `briefWithProjectDocs`, byte for byte. */
export function briefForSize(size: OrderSize, task: string): string {
  if (size === "quick") return quickBrief(task);
  if (size === "standard") return standardBrief(task);
  return briefWithProjectDocs(task);
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
  resultNote?: (ok: boolean, failure?: string, size?: SizeEnd) => string | undefined;
  /** The run is over and its result has reached the operator and the dispatcher inbox. A
   *  `continuation` means the run was handed off at a safe checkpoint (ADR-0021): the task is NOT
   *  finished, and this brief continues it in a fresh session. */
  onEnd?: (end: TodoEnd) => void | Promise<void>;
  /** After a handoff at the "task done" boundary (ADR-0029): act on what happens next — queue the
   *  continuation, or park it on the decision this run raised — and return the notice's tail
   *  ("continuing as #12"). Absent (no queue): dispatch says it itself. */
  onHandoff?: (h: { orderId: string; next: HandoffNext; note: string; size?: SizeEnd }) => string | undefined;
  /** Skip the "→ dispatching to …" line (the queue sends its own start line). */
  quietStart?: boolean;
  /** The upgrade guard moved the order up a size (ADR-0072): the queue updates the todo's row. */
  onSizeUp?: (up: SizeUp) => void;
  /** A quick or standard order went out BIG, not at its size (ADR-0072, fail closed): it was delivered into a
   *  live session, where no guard of its own can attach, or its guard could not be made. The queue records it. */
  onSizeForced?: (why: string) => void;
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
    /** The operator message (and thread) this dispatch answers (ADR-0015): the sub-order, its todo,
     *  its events, digests, final result and dispatcher-inbox row are all filed under it. */
    cause?: Cause;
    /** The company order that dispatched this one (`orders.parent_order_id`). */
    parentOrderId?: string;
    /** Run as a side lane beside the project's main task (ADR-0057): its own fresh session, governed
     *  by its kind; `todoId` names it (and a `code` lane's branch). Absent = the main lane. */
    lane?: { kind: LaneKind; todoId?: number };
    /** The order's size (ADR-0072). Absent = big (today's flow). Codex own work, a team order and
     *  `sizes.enabled: false` always run big, with no guard. */
    size?: OrderSize;
    /** The todo this dispatch runs (its lines name `#id`). A side lane's `lane.todoId` also counts. */
    todoId?: number;
  } = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  const hooks = opts.hooks ?? {};
  const cause = opts.cause;
  // Every event this dispatch writes carries its cause (events.msg_id); none → NULL, as before.
  const event = (kind: string, input: { orderId?: string; sessionId?: string; folder?: string; data?: Record<string, unknown> } = {}) =>
    deps.ledger.recordEvent(kind, { ...input, cause });
  const workClass = opts.workClass ?? DEFAULT_WORK_CLASS;
  // Worker-profile view (model/effort/skills/env by path) — absent deps.workers/workerEnv means
  // every profileDeps() call below is a no-op (empty profile ?? {}), preserving today's behavior.
  const workerCfg: Pick<NeoConfig, "workers" | "workerEnv"> = {
    workers: deps.workers ?? ({} as Record<WorkerPathName, WorkerProfile>),
    workerEnv: deps.workerEnv ?? {},
  };
  const providerCfg: Pick<NeoConfig, "workers" | "workerEnv"> &
    Partial<Pick<NeoConfig, "providers" | "models" | "governor">> = {
    ...workerCfg,
    providers: deps.providers,
    models: deps.models,
    governor: deps.governor,
  };
  // The worker SDK, read ONCE (ADR-0072): the size, the preamble, the guard and the run must all see the same
  // value, so a config flip during this dispatch can never give a quick preamble with no guard.
  const ownWork = providerCfg.providers?.ownWork;
  /** Whose account this run spends: a usage limit is one provider's (ADR-0060). */
  const runProvider: string = ownWork ?? "claude";
  // Opt-in team: only SDKs that support the `agents` run field get the subagent map + lead
  // preamble. Codex receives the original brief as a normal single-worker coding task.
  const teamAgents =
    opts.team === "frontend-backend" && supportsRunConfigField(ownWork, "agents")
      ? frontendBackend
      : undefined;
  if (deps.lifecycle?.draining()) {
    event("dispatch_refused", { data: { project, workClass, reason: "draining" } });
    hooks.onRefused?.("draining");
    return "Neo is reloading — dispatch refused; retry after the restart (open sessions are preserved).";
  }
  // The API is throttling us — starting another worker now just earns another 429.
  if (deps.cooldown?.activeAt(now())) {
    event("dispatch_refused", { data: { project, workClass, reason: "cooldown" } });
    hooks.onRefused?.("cooldown");
    return apiHoldMessage(deps.cooldown.remainingMs(now()));
  }
  const folder = resolveProject(project, opts.root, opts.desks);
  if (!folder) {
    event("dispatch_refused", { data: { project, workClass, reason: "not_found" } });
    hooks.onRefused?.("not_found");
    return `No project or desk named "${project}" was found — check the name.`;
  }
  // The interactive reserve caps BACKGROUND work only, and a dispatch's class follows the trigger
  // that originated it, not the fact that it is a dispatch: scheduler-fired work is held here, while
  // a dispatch the operator asked for conversationally is their own turn continuing and runs (ADR
  // 0001 + its follow-up). AFTER resolveProject on purpose: a typo'd project name must still report
  // "not found" while over budget, not a hold that hides the real error.
  if (heldByReserve(workClass, deps.meter, now())) {
    event("dispatch_refused", { data: { project, workClass, reason: "budget" } });
    hooks.onRefused?.("budget");
    return budgetHoldMessage(deps.meter.spent(now()), deps.meter.allowance());
  }

  // A side lane (ADR-0057) is enforced by the Claude governor hook; the Codex SDK has no such hook.
  const sideKind = opts.lane?.kind;
  if (sideKind && ownWork === "codex") {
    event("dispatch_refused", { data: { project, workClass, reason: "lane_unsupported", kind: sideKind } });
    hooks.onRefused?.("lane_unsupported");
    return `Side lanes need the Claude worker SDK (its governor hook enforces the lane); the worker SDK is Codex, so this brief was not run as a side lane. Queue it instead (lane "queue").`;
  }
  const orderId = crypto.randomUUID();
  // A `code` side lane works in its own temporary worktree on `side/<key>` — never in the main folder.
  let laneWt: LaneWorktree | undefined;
  if (sideKind === "code") {
    const wt = createLaneWorktree(folder, String(opts.lane?.todoId ?? orderId.slice(0, 8)), (deps.lanes ?? DEFAULT_LANES_CFG).worktreeRoot);
    if ("error" in wt) {
      event("dispatch_refused", { data: { project, workClass, reason: "lane_worktree", error: wt.error } });
      hooks.onRefused?.("lane_worktree");
      return `I could not make a worktree for this code side lane (${wt.error}), so it did not run. Queue it in the main lane instead (lane "queue").`;
    }
    laneWt = wt;
  }
  // Reuse an already-open session for this folder (resume it) instead of duplicating it as
  // "<name>-2"; only register a fresh entry when nothing is open for the folder.
  // A side lane never reuses the main session: it is a fresh, single-brief session of its own.
  const existing = sideKind ? undefined : deps.registry.findByFolder(folder);
  const wasRunning = existing?.status === "running";
  // The order's size (ADR-0072). Only a Claude worker can be guarded (the PreToolUse hook), and a team
  // order is big by rule: those, and sizes turned off, run big with no guard — today's flow. A brief for a
  // live session is delivered into that session's run, where no guard of its own can attach: big too.
  const sizesCfg = deps.sizes ?? DEFAULT_SIZES_CFG;
  const asked: OrderSize = opts.size ?? "big";
  const codexWorker = ownWork === "codex";
  const size: OrderSize = !sizesCfg.enabled || codexWorker || teamAgents || wasRunning ? "big" : asked;
  const todoId = opts.todoId ?? opts.lane?.todoId;
  /** The start line's size tag: only when the caller sized the order, so an unsized dispatch reads as before. */
  const startTag = opts.size ? ` ${sizeTag({ size })}` : "";
  /** A smaller order goes out big (fail closed): the event, and the queue records it. Called only once the
   *  brief is accepted, so a refused dispatch never changes its todo's size. */
  const forceBig = (why: string, name: string): void => {
    event("size_forced", { orderId, folder, data: { project: name, from: asked, to: "big", why } });
    faults.guard("dispatch.onSizeForced", () => hooks.onSizeForced?.(why), { folder });
  };
  const forcedWhy =
    asked === "big" || size !== "big"
      ? undefined
      : wasRunning
        ? "delivered into a live session, where no size guard can attach"
        : !sizesCfg.enabled
          ? "sizes are off"
          : codexWorker
            ? "the worker SDK is Codex"
            : "a team order";
  const sessionLane = sideKind ? { kind: sideKind, projectFolder: folder, ...(opts.lane?.todoId !== undefined ? { todoId: opts.lane.todoId } : {}) } : undefined;

  // Build + record the order with its BASE task (project-docs preamble only — no memory snapshot
  // yet). This happens BEFORE the busy-guard check below (existing && wasRunning can still refuse
  // this dispatch with an early return), so a refused dispatch still leaves a plain intent record
  // in the ledger. The memory snapshot, when the folder is in scope, is injected later — INSIDE
  // the background continuation, once the resume id that will actually be used for this run is
  // settled (see the comment down there) — never here, so a resumed sub-session never gets a
  // repeated "authoritative ground truth" block stacked mid-conversation.
  const laneTask = sideKind ? `${lanePreamble(sideKind, project, laneWt)}\n\n${task}` : task;
  const workerTask = teamAgents ? teamLeadPreamble(laneTask) : laneTask;
  /** The brief at its size; the run swaps it for the big one if its guard cannot be made (fail closed). */
  const sizedBrief = briefForSize(size, workerTask);
  const order: Order = {
    id: orderId,
    source: "neo",
    folder: laneWt?.path ?? folder,
    task: sizedBrief,
    chatId: sideKind ? SIDE_CHAT : SUB_CHAT,
    createdAt: now(),
  };
  deps.ledger.recordOrder(order, { cause, parentOrderId: opts.parentOrderId });
  // A project's first sight: trusted by default when `trustNewProjects` is on (the customer path
  // passes denyAllTrust, whose noteProject never trusts).
  noteProjectStart(deps, order);
  const session = existing ?? deps.registry.add(order, now(), sessionLane ? { lane: sessionLane } : undefined);
  // A dispatch a customer-driven company run made (ingress) marks its session for good: it runs fenced,
  // and the operator's own tools (project_message, ADR-0061) never speak into it.
  if (replyChat === CUSTOMER_CHAT) deps.registry.markCustomerDriven(session.id);
  const name = session.name;
  // The cause a line of this run is filed under: the newest brief delivered into the session (a
  // later brief pushed into it brings its own), else this dispatch's own.
  const liveCause = (): Cause | undefined => deps.registry.causeOf(session.id) ?? cause;
  /** A line about this dispatch. With a cause it is filed in the trace under it, as `kind`; without
   *  one the call is exactly what it was before. */
  const say = (text: string, priority?: Priority, meta?: { kind?: MessageKind; cause?: Cause }) =>
    meta?.cause
      ? deps.reply(replyChat, text, name, priority, { cause: meta.cause, folder, ...(meta.kind ? { kind: meta.kind } : {}) })
      : deps.reply(replyChat, text, name, priority);
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
      event("dispatch_refused", { orderId: order.id, folder, data: { project: name, workClass, reason: "closing", state } });
      hooks.onRefused?.("closing");
      return (
        `${name} is finishing its current run (its session is closing) — I did NOT queue this brief, so ` +
        `nothing was lost. Retry in a moment; it will start a fresh run once the current one has ended.`
      );
    }
    // A worker held at a big plan (ADR-0036) denies every tool but reads until the operator acts, so a
    // brief pushed into it could only be answered with STOP — and would read as delivered (ADR-0052).
    const heldAt = control?.held?.();
    if (control?.followUp && heldAt !== undefined) {
      event("dispatch_refused", { orderId: order.id, folder, data: { project: name, workClass, reason: "plan_held", plan: heldAt } });
      hooks.onRefused?.("plan_held");
      return (
        `${name} is held at its big plan ${heldAt} until the operator taps Approve & build (or Changes / Drop) — ` +
        `I did NOT deliver this brief, because the worker could not act on it. Through the todo queue it waits ` +
        `and starts by itself once the hold lifts.`
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
      // The brief carries its cause into the session, so the turn that runs it is filed under it.
      // After the turn, never mid-turn: an engine brief must not steer the operator's in-flight work.
      // Notes from main and answers held for this session go in front of it (ADR-0050 §4).
      const brief = withLiveNotes(deps, existing.id, folder, order.task, now());
      if (cause) control.followUp(brief, "after-turn", cause);
      else control.followUp(brief, "after-turn");
      if (forcedWhy) forceBig(forcedWhy, name);
      hooks.onLaunched?.(order.id, "delivered");
      deps.registry.touch(existing.id, now());
      // A brief arriving answers (or supersedes) a raised DECISION; a pending approval is left
      // alone, since that one is still suspending the worker mid-tool.
      clearDecisionBlock(deps.registry, existing.id);
      if (turnActive) {
        event("dispatch_queued", { orderId: order.id, folder, data: { project: name, workClass } });
        await say(`→ queued for ${name} (busy): ${task}`, undefined, { kind: "ack", cause });
        return (
          `${name} is ${state} — I queued this brief behind its current turn (${status}). It runs when the ` +
          `current work yields; ${reportBack} Unless that state is ` +
          `"wedged" this is NORMAL and needs nothing from you` +
          (state === "awaiting-operator" ? " EXCEPT the operator's answer to the question it raised." : ".")
        );
      }
      // Alive but IDLE between turns: the follow-up is pulled and run immediately.
      event("dispatch_delivered", { orderId: order.id, folder, data: { project: name, workClass, reuse: "idle" } });
      await say(`→ dispatching to ${name}${startTag}: ${task}`, undefined, { kind: "ack", cause });
      return (
        `dispatched to ${name} — it was idle, so this runs now; ${reportBack}`
      );
    }
    // No live handle. Usually NOT a fault: the previous dispatch marked the session running and is
    // still preparing it (ensureIndexed on a big repo takes minutes) — `stateOf` calls that
    // `starting`. Say which it is instead of implying the project is broken.
    event("dispatch_refused", { orderId: order.id, folder, data: { project: name, workClass, reason: "stale_running_no_control", state } });
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
  // The run's first input carries this dispatch's cause: its thread reads as active work until the
  // run ends (spec §5), and later briefs delivered into the run bring their own.
  if (cause) deps.registry.setCause(session.id, cause);
  if (forcedWhy) forceBig(forcedWhy, name);
  hooks.onLaunched?.(order.id, "run");
  refreshThread(deps, cause?.threadId);
  if (!hooks.quietStart) await say(`→ dispatching to ${name}${startTag}: ${task}`, undefined, { kind: "ack", cause });

  // Only ever resume an id this worker SDK minted — a Codex thread id fed to Claude (or vice
  // versa) is rejected outright, and before the ownership check that read as an API failure.
  const worker = ownWork;
  const resume = sideKind
    ? undefined // a side lane always starts fresh — never the main session's context
    : (canResumeWith(existing?.sdkProvider, worker) ? existing?.sdkSessionId : undefined) ||
      deps.ledger.lastSessionFor(folder, SUB_CHAT, worker) ||
      undefined;
  const start = opts.start ?? startOrder;
  // No wall-clock limit (ADR-0007): some tasks take hours. Only true silence (the stall limit) aborts.
  const stallMs = deps.dispatchStallMs ?? DISPATCH_STALL_MS_DEFAULT;
  const progressMs = deps.dispatchProgressMs ?? DISPATCH_PROGRESS_MS_DEFAULT;
  const readCommit = opts.lastCommit ?? lastCommitIn;
  // The HEAD this run starts from: at its end, plan files changed since then are sent (ADR-0019).
  const planStart = deps.postPlan ? headSha(folder) : undefined;
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
    // A side lane is a short, single brief: no context gate, checkpoint or end-of-run handoff.
    const policy = sideKind ? undefined : deps.contextPolicy;
    const notify = (t: string, pr?: "alert") => void say(t, pr, { cause: liveCause() });
    // Never measure (or resume) a folder another gate is handing off — e.g. the previous dispatch's
    // end-of-run handoff. Its resume id is read again AFTER the wait: the handoff clears it.
    let gatedResume = resume;
    if (gatedResume && policy) {
      // A handoff that outlived its hold may still own the session: start fresh, touch nothing.
      const waited = await awaitHandoff(folder);
      const current =
        (canResumeWith(session.sdkProvider, worker) ? deps.registry.get(session.id)?.sdkSessionId : undefined) ||
        deps.ledger.lastSessionFor(folder, SUB_CHAT, worker) ||
        undefined;
      gatedResume = waited === "timed-out" ? undefined : current;
    }
    if (gatedResume && policy) {
      try {
        const signals = opts.signals ?? sessionContext;
        const sig = signals(folder, gatedResume, { windowTokensByModel: contextWindows(deps.ledger, policy.windowTokensByModel) });
        const ttlMs = effectiveCacheTtlMs(deps.ledger.listCacheObservations(policy.cacheObsWindow ?? CACHE_OBS_WINDOW), policy);
        const decision = decideContext(sig, policy, ttlMs, { boundary: "resume" });
        const deferred = decision.verdict !== "keep" && handoffDeferred(folder, decision, { ledger: deps.ledger, boundary: "resume", occupancy: sig.occupancy, sessionId: gatedResume });
        if (deferred) {
          // uncommitted work: keep resuming (ADR-0021)
        } else if (decision.verdict === "clear") {
          deps.ledger.clearSessionsFor(folder);
          deps.ledger.recordContextEvent(folder, "clear", sig.occupancy, undefined, { reason: decision.reason, boundary: "resume", sessionId: gatedResume });
          notify(describeContextReset("clear", sig.occupancy, policy, decision.reason, "resume"), "alert");
          gatedResume = undefined;
        } else if (decision.verdict === "handoff") {
          const handoff = opts.handoff ?? runHandoff;
          const target: SessionInfo = { ...session, sdkSessionId: session.sdkSessionId || gatedResume };
          await handoff(target, policy, {
            registry: deps.registry,
            ledger: deps.ledger,
            runDeps: profileDeps(providerCfg, "handoff"),
            memoryFlush: !!memoryGate(deps, folder),
            decision,
            boundary: "resume",
            notify,
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
      // The notes block (ADR-0043): the target's open notes and the state of the ones it sent, on a
      // genuine fresh start only — like the snapshot. No deps.notes (ingress) → none.
      const notesBlock = deps.notes && !sideKind ? faults.guard("dispatch.notesBlock", () => deps.notes!.block(name, now(), folder), { project: name }) : undefined;
      if (notesBlock) {
        order.task = notesBlock + order.task;
        deps.ledger.recordOrder(order);
      }
      // The tools hint (ADR-0044): up to a few catalogue lines that match the raw brief, only on the worker
      // paths in `hintPaths`. No deps.tools (ingress) → none. Recorded so the ledger equals what the worker gets.
      const toolsHint =
        deps.tools && deps.tools.cfg.hintPaths.includes("dispatch")
          ? faults.guard("dispatch.toolsHint", () => deps.tools!.hint(task, { project: name, folder }), { project: name })
          : undefined;
      if (toolsHint) {
        order.task = toolsHint + order.task;
        deps.ledger.recordOrder(order);
      }
    } else {
      // A kept resume is a delivery point (ADR-0050 §4): notes from main and answers held while the
      // session sat idle go in front of the brief. (A fresh start lists them in the notes block.)
      const withHeld = withLiveNotes(deps, session.id, folder, order.task, now());
      if (withHeld !== order.task) {
        order.task = withHeld;
        deps.ledger.recordOrder(order);
      }
    }

    // A fresh start after a context handoff begins FROM the note, inline (ADR-0021), and the probe
    // measures how quickly it got going.
    let probe: ResumeProbe | undefined;
    if (gatedResume === undefined && policy) {
      const pre = handoffPreamble(folder, deps.ledger, policy, now());
      if (pre) {
        order.task = `${pre.text}\n\n${order.task}`;
        deps.ledger.recordOrder(order);
        probe = createResumeProbe((r) => deps.ledger.updateContextEventDetail(pre.eventId, { ...r, success: r.steps <= policy.handoffOrientationMaxSteps }));
      }
    }
    // Safe checkpoints (ADR-0021) need somewhere to continue: only a todo-queue dispatch has one
    // (onEnd), and only a Claude worker can be steered (the PreToolUse hook).
    let noteAtArm: string | undefined;
    const watch =
      policy && hooks.onEnd && worker !== "codex"
        ? createCheckpointWatch({
            folder,
            cfg: policy,
            windows: () => contextWindows(deps.ledger, policy.windowTokensByModel),
            now,
            onArm: (a) => {
              noteAtArm = noteStamp(folder);
              event("context_checkpoint_armed", { orderId: order.id, folder, data: { project: name, occupancy: a.occupancy, reason: a.decision.reason } });
            },
          })
        : undefined;
    // The upgrade guard (ADR-0072), created below with the run's baseline. A quick or standard order is
    // guarded; a big one (today's flow) gets a guard with no opinion that only measures at the end, for the
    // record. None for Codex (no governor hook) or with sizes off.
    let guard: SizeGuard | undefined;
    /** Moved up to big by the guard: each new plan version waits for the operator (forceApproval). */
    const movedToBig = (): boolean => size !== "big" && guard?.size() === "big";
    // The plan gate (ADR-0036): a big plan this worker writes holds it until Approve & build. Only
    // where a card can be posted, and only a Claude worker can be steered (the PreToolUse hook).
    // A quick run's watch sends a plan but never holds; a standard run held by its own plan is big now.
    const planWatch =
      deps.postPlan && (deps.plans ?? DEFAULT_PLANS_CFG).send && worker !== "codex" && !sideKind
        ? createPlanWatch(planDepsFrom(deps, deps.plans), () => ({ project: name, folder, startSha: planStart, cause: liveCause(), orderId: order.id, chatId: replyChat, ...(movedToBig() ? { forceApproval: true } : {}) }), {
            onHold: (p) => {
              deps.registry.noteBlocked(session.id, { kind: "decision", label: `plan approval: ${p.title}`, since: now() });
              guard?.raise("big", { rule: "plan" });
            },
            mayHold: () => guard?.size() !== "quick",
          })
        : undefined;
    let lastSessionId = gatedResume ?? "";

    // Guarantee the structural map the brief now REQUIRES: the worker can't self-index (the governor
    // denies subagents the codebase-memory index tools), so the engine does it here before the worker
    // starts. Best-effort — a failure never blocks the dispatch; the worker falls back to file reads.
    // Placed before startedAt so a first-time index doesn't eat the dispatch stall budget.
    // A side lane never (re)indexes: it uses the project's existing index read-only.
    if (deps.codebaseMemory && !sideKind) {
      let index: IndexResult = {};
      try {
        index = await deps.codebaseMemory.ensureIndexed(folder, () =>
          say(`indexing ${name} into codebase-memory…`, undefined, { cause: liveCause() }),
        );
      } catch {
        // ensureIndexed is itself best-effort; this guard belts-and-braces the dispatch path.
      }
      // The worker gets the exact project name, so it never lists, checks or indexes (ADR-0028).
      order.task = `${codebaseMemoryLine(index)}\n\n${order.task}`;
      faults.guard("dispatch.recordOrder", () => deps.ledger.recordOrder(order));
    }

    // The commit finish (ADR-0037) records the folder's dirty paths NOW, before the worker starts, so
    // only the run's own changes count at its end. Best-effort: a git fault costs only the check.
    // One baseline for the run (ADR-0072), shared by the commit finish and the size guard.
    const finishOn = !!deps.commitFinish?.enabled && !sideKind;
    const guardOn = sizesCfg.enabled && worker !== "codex";
    // A side lane that works in the main folder (read-only, ops, test) would count the main lane's edits as its
    // own: its guard has no baseline — estimates and command rules only. A `code` lane has its own worktree.
    const sharesFolder = !!sideKind && sideKind !== "code";
    const read: BaselineRead | undefined =
      finishOn || (guardOn && !sharesFolder)
        ? faults.guard("dispatch.runBaseline", () => readRunBaseline(order.folder), { folder: order.folder }) ?? { kind: "failed", error: "an engine fault, reported" }
        : undefined;
    const baseline: RunBaseline | undefined = read?.kind === "ok" ? read.baseline : undefined;
    const commitFinish = finishOn ? faults.guard("dispatch.commitFinish", () => createCommitFinish(folder, deps.commitFinish!, realCommitFinishGit, baseline), { folder }) : undefined;
    /** A smaller order runs big after all (fail closed): the big preamble in place of the small one. */
    const runBig = (why: string): void => {
      const big = briefForSize("big", workerTask);
      const at = order.task.lastIndexOf(sizedBrief);
      order.task = at >= 0 ? order.task.slice(0, at) + big + order.task.slice(at + sizedBrief.length) : big;
      faults.guard("dispatch.recordOrder", () => deps.ledger.recordOrder(order));
      forceBig(why, name);
    };
    // git failed on the repository at the start (ADR-0072, fail closed): a smaller order could never be
    // measured, so it runs big — its size is not checked, so it gets the full flow — and the failure is recorded.
    const failedRead = guardOn && !sharesFolder && read?.kind === "failed" ? read : undefined;
    if (failedRead) {
      event("size_measure_failed", { orderId: order.id, folder, data: { project: name, size, at: "start", error: failedRead.error } });
      if (size !== "big") runBig(`Neo could not read git at the start (${failedRead.error}), so its size cannot be measured`);
    }
    if (guardOn && !(failedRead && size !== "big")) {
      guard = faults.guard("dispatch.sizeGuard", () => createSizeGuard({
        size,
        folder: order.folder,
        project: name,
        ...(sideKind ? { side: sideKind } : {}),
        cfg: sizesCfg,
        planPaths: (deps.plans ?? DEFAULT_PLANS_CFG).paths,
        ...(sharesFolder ? {} : { baseline }),
        startSha: headSha(order.folder),
        planApproved: () => planWatch?.approvedHeld() ?? false,
        onUp: (up) => sizeUp(up),
        now,
      }), { folder: order.folder });
      // Fail closed (ADR-0072): a quick or standard brief never runs without its guard. The fault is
      // reported (faults.guard above); the order runs big — the big preamble in place of the small one.
      if (!guard && size !== "big") runBig("its size guard could not be made (an engine fault, reported)");
    }
    /** The guard as a steer: a quick or standard order's only. */
    const steering = size !== "big" ? guard : undefined;
    /** One move up: the event, one line to the operator under the cause, a quiet note to the dispatcher, the queue's row. */
    const sizeUp = (up: SizeUp): void => {
      event("size_up", { orderId: order.id, folder, data: { project: name, from: up.from, to: up.to, rule: up.rule, path: up.path, command: up.command, value: up.value, max: up.max, late: up.late } });
      void say(operatorUpLine({ project: name, todoId, up, side: !!sideKind }), undefined, { cause: liveCause() });
      const note = `[size] ${name}${todoId !== undefined ? ` #${todoId}` : ""} moved up ${up.from} → ${up.to}: ${sizeReason(up)}.`;
      void Promise.resolve()
        .then(() => dispatcher.deliver(note, cause ? { wake: false, cause } : { wake: false }))
        .catch(() => {}); // best-effort, like a spin alert
      faults.guard("dispatch.onSizeUp", () => hooks.onSizeUp?.(up), { folder });
    };
    let lastTurn: RunResult | undefined; // the latest turn's end — the commit finish needs a good one
    let firstEnd: RunResult | undefined; // the run's end before the commit-finish follow-up
    let wrappingUp = false; // a stall or spin wrap-up was sent: that end is not a settled finish
    let commitBrief: string | undefined; // the commit-finish follow-up, once sent (an API retry re-sends it)

    /** A plan this run's watch registered still waits for the operator (ADR-0072: no re-queue then). */
    const planAwaiting = (): boolean =>
      (planWatch?.plans() ?? []).some((id) => {
        const p = deps.ledger.planById(id);
        return !!p && p.gate === "approval" && (planState(p) === "awaiting" || p.status === "draft");
      });
    const startedAt = now();
    event("dispatch_start", { orderId: order.id, folder, data: { project: name, workClass, resume: !!gatedResume, stallMs, progressMs } });
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
    // Spinning (spec §8.1): active, but nothing changes — counted, never judged by AI.
    const spinDigests = Math.max(2, deps.dispatchSpinDigests ?? DISPATCH_SPIN_DIGESTS_DEFAULT);
    const loopLimit = Math.max(2, deps.toolLoopLimit ?? TOOL_LOOP_LIMIT_DEFAULT);
    const loopExempt = new Set(deps.toolLoopExempt ?? TOOL_LOOP_EXEMPT_DEFAULT);
    const spin = createSpinWatch({ digests: spinDigests, toolLoopLimit: loopLimit });
    // A digest counts toward a spin only when the worker did real work since the last one (a tool
    // call or a message) — heartbeats of one long tool call, or a wait on the operator or an API
    // retry, refresh the activity clock but are not the worker repeating itself.
    let workSinceDigest = false;
    let spinMark: "digest" | "tool_loop" | undefined;
    const clearSpin = (): void => {
      spinMark = undefined;
      noteRegistry(() => deps.registry.noteSpinning(session.id, undefined));
    };
    /** One spin: an event, the registry mark (the engine producer raises the attention item), one
     *  alert to the operator and the dispatcher, and with policy "wrapup" the stall's wrap-up. */
    const spinning = (text: string, label: string, data: { reason: "digest" | "tool_loop" } & Record<string, unknown>): void =>
      void faults.guard("dispatch.spinning", () => spinAlert(text, label, data), { folder });
    const spinAlert = (text: string, label: string, data: { reason: "digest" | "tool_loop" } & Record<string, unknown>): void => {
      spinMark = data.reason;
      event("dispatch_spinning", { orderId: order.id, folder, data: { project: name, label, ...data } });
      noteRegistry(() => deps.registry.noteSpinning(session.id, { label, since: now() }));
      void say(`🌀 ${text}`, "alert", { cause: liveCause() });
      void Promise.resolve()
        .then(() => dispatcher.deliver(`🌀 ${text}`, cause ? { wake: false, cause } : { wake: false }))
        .catch(() => {}); // best-effort, like a digest
      if (deps.dispatchSpinPolicy === "wrapup") {
        wrappingUp = true;
        runRef?.followUp(wrapUpBrief(`noticed this dispatch is repeating itself (${label})`, graceMs), "after-turn");
      }
    };
    // A dispatch is single-brief: once the session is SETTLED with nothing queued, the sub-run IS
    // complete (the real SDK stream stays open waiting for input that will never come — awaiting
    // run.done alone would falsely "stall" out minutes after the worker already finished). Close
    // the channel gracefully so done resolves with the worker's own final result; the session
    // stays resumable (idle bookkeeping below is unchanged). Settled, not merely a turn boundary:
    // a worker running background agents emits a `result` and keeps working (ADR-0007).
    let runRef: ReturnType<typeof startOrder> | undefined;
    /** At a settled end: send the commit-finish follow-up when this run's own changes are uncommitted
     *  and the end was a real finish (ADR-0037 §3). True when it was sent — the run stays open. */
    const commitFinishNow = (): boolean =>
      faults.guard("dispatch.commitFinish", () => {
        if (!commitFinish || commitFinish.nudged() || wrappingUp || !lastTurn?.ok || lastTurn.apiError) return false;
        if (deps.lifecycle?.draining() || watch?.armed() || deps.registry.get(session.id)?.blockedOn) return false;
        const ask = commitFinish.atSettle();
        if (!ask || !runRef) return false;
        firstEnd = lastTurn;
        const { brief, files } = ask;
        commitBrief = brief;
        event("commit_finish_sent", { orderId: order.id, folder, data: { project: name, files } });
        void say(`📝 ${name} ended with uncommitted changes — asked it once to commit them`, undefined, { cause: liveCause() });
        lastActivityAt = now();
        runRef.followUp(brief, "after-turn");
        return true;
      }, { folder }) === true;
    const run = start(
      order,
      {
        onMessage: (t, kind) => {
          lastActivityAt = now();
          workSinceDigest = true;
          if (kind !== "tool") lastNote = t;
          noteRegistry(() => deps.registry.noteOutput(session.id, now()));
          void say(t, undefined, { cause: liveCause() });
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
        onEscalation: async (reason, signal) => {
          noteRegistry(() => deps.registry.noteBlocked(session.id, { kind: "approval", label: reason, since: now() }));
          try {
            const asking = liveCause();
            return await patientApproval((signal) => deps.askApproval(replyChat, reason, signal, asking), reason, {
              patience: deps.governor ?? DEFAULT_GOVERNOR_CFG,
              say: (text, priority) => void say(text, priority, { cause: asking }),
              record: (kind, data) => event(kind, { orderId: order.id, folder, data: { project: name, ...data } }),
              signal,
            });
          } finally {
            lastActivityAt = now(); // the wait was the operator's, not the worker's
            noteRegistry(() => deps.registry.noteBlocked(session.id, undefined));
          }
        },
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
        // ask_operator is attached exactly when postDecision is wired; the native ask is redirected to it (ADR-0049).
        askOperator: !!deps.postDecision,
        onEvent: (kind, data) => event(kind, { orderId: order.id, folder, data }),
        onContextWindow: (model, tokens) => deps.ledger.recordModelWindow(model, tokens),
        autoApprove: () => deps.trust.isTrusted(folder),
        onAutoApprove: (reason) => {
          deps.ledger.recordAutoApproval(order.id, reason);
          void say(`🔓 auto-approved: ${reason}`, undefined, { cause: liveCause() });
        },
        // One row per governed tool call, under the order and the cause (spec §3.4). Trace only.
        onToolVerdict: deps.trace
          ? (tool, label, verdict) =>
              void faults.guard("dispatch.toolAction", () =>
                deps.ledger.recordToolAction({ orderId: order.id, folder, tool, label, verdict, cause: liveCause(), at: now() }),
              )
          : undefined,
        onUsage: (model, usage) => {
          watch?.onUsage(model, usage);
          probe?.onUsage();
        },
        onToolUse: (id, toolName, input) => {
          workSinceDigest = true;
          // Polling a background job with the same input is waiting, not looping.
          if (!loopExempt.has(toolName) && spin.tool(toolName, createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex"))) {
            spinning(`${name} ran the same ${toolName} call ${loopLimit} times in a row in one turn`, toolName, { reason: "tool_loop", tool: toolName });
          }
          watch?.onToolUse(id, toolName, input);
          planWatch?.onToolUse(id, toolName, input);
          guard?.onToolUse(id, toolName, input);
          probe?.onToolUse(id, toolName, input);
        },
        onToolResult: (id, isError) => {
          watch?.onToolResult(id, isError);
          planWatch?.onToolResult(id, isError);
          guard?.onToolResult(id, isError);
        },
        // A held plan speaks first (ADR-0036), then the size guard (ADR-0072), then an armed context
        // checkpoint (ADR-0021). The commit finish's turn is the task's tail: a checkpoint that arms in it
        // never steers (ADR-0037); the guard still does (its commit point measures the change).
        // A big run's guard has no opinion (it only measures at the end): it is not a steer.
        contextSteer:
          watch || planWatch || steering
            ? (tool, input) => planWatch?.steer(tool, input) ?? steering?.steer(tool, input) ?? (commitBrief ? undefined : watch?.steer(tool, input))
            : undefined,
        onTurnComplete: (result) => {
          lastActivityAt = now();
          spin.turnEnd();
          if (spinMark === "tool_loop") clearSpin(); // a tool loop is one turn's
          if (result.sessionId) lastSessionId = result.sessionId;
          lastTurn = result;
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
              event("api_retry", {
                orderId: order.id,
                folder,
                data: { scope: "dispatch", project: name, kind, attempt, max: maxRetries, delayMs, source, resetsAt },
              });
              // The wait is engine-driven, not the worker hanging: hold off the stall clock for
              // exactly that long, then re-send the brief into the still-open run.
              retryingUntil = now() + delayMs;
              pausedMs += delayMs;
              retryPending = true;
              void say(apiRetryNotice(name, attempt, delayMs, resetsAt, maxRetries), undefined, { cause: liveCause() });
              const resend = (reason: WaitEndReason = "timer"): void => {
                // An early end (ADR-0060) gives back the rest of the wait: the stall clock and the spin
                // count work again at once, and the wait is not counted as paused time it never was.
                pausedMs -= Math.max(0, retryingUntil - now());
                retryingUntil = now();
                // A wake that came early (todo retry, the limit cleared, the run went on) is not a fresh
                // try at the API: it does not use up one of the run's API retries.
                if (reason !== "timer") apiRetries = Math.max(0, apiRetries - 1);
                lastActivityAt = now();
                retryPending = false;
                // Inside the commit finish, the retry re-sends the commit request — never the whole task.
                runRef?.followUp(commitBrief ?? apiRetryFollowUp(task), "after-turn");
              };
              const delay = (opts.sleep ?? realSleep)(delayMs);
              // ADR-0060: the wait has a handle — `todo retry` ends it now; the re-send happens once.
              if (deps.apiWaits) deps.apiWaits.hold({ orderId: order.id, kind, provider: runProvider, until: now() + delayMs }, delay, resend);
              else void delay.then(() => resend());
              return; // keep the sub-run open — it hasn't done the work yet
            }
            event("api_giveup", { orderId: order.id, folder, data: { scope: "dispatch", project: name, kind, attempts: apiRetries } });
            void say(apiFailureNotice(name, kind, apiRetries), "alert", { cause: liveCause() });
          } else if (result.ok && deps.apiWaits) {
            // A turn went through (ADR-0060). If this run was held, something else moved it on (the
            // operator's own message, or another brief delivered into it): its re-send goes now, right
            // after this turn — the retry follow-up asks the worker to check what is already done — and
            // never days later. And the account is not limited any more: its other limit holds wake
            // early, each after its own jitter.
            deps.apiWaits.wake(order.id, "went_on");
            if (deps.apiLimitWakeEarly ?? true) {
              const jitterMs = deps.apiLimitWakeJitterMs ?? API_LIMIT_WAKE_JITTER_MS_DEFAULT;
              deps.apiWaits.limitCleared(runProvider, order.id, () => Math.floor((opts.rand ?? Math.random)() * jitterMs));
            }
          }
        },
        // The brief is done only when the session is settled (no background work left) and nothing
        // is queued — and not while an API retry is about to re-send it.
        onSettled: () => {
          lastActivityAt = now();
          if (retryPending || (runRef?.queued() ?? 1) !== 0) return;
          if (commitFinishNow()) return; // one follow-up into this same run (ADR-0037); the next settle closes it
          runRef?.close?.();
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
        mcpServers: neoMcpServers(deps, replyChat, { dispatch: false, workClass, folder, projectName: name, sessionId: session.id, orderId: order.id, cause: liveCause }),
        ...(teamAgents ? { agents: teamAgents } : {}),
        // The governor denies what this side lane's kind may not do (ADR-0057).
        ...(sessionLane ? { lane: sessionLane } : {}),
      }),
    );
    runRef = run;
    // The registry's handle delivers a brief's cause with it (spec §4.2), like the pipeline's own.
    const control = {
      ...run,
      followUp: (text: string, timing: FollowUpTiming, c?: Cause) => {
        if (c) {
          deps.registry.deliver(session.id, c);
          refreshThread(deps, c.threadId);
        }
        run.followUp(text, timing);
      },
      held: () => planWatch?.held(),
    };
    dispatchRuns.add(control);
    deps.registry.attachControl(session.id, control);

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
            const lastCommit = readCommit(folder);
            const counts = workSinceDigest && !deps.registry.get(session.id)?.blockedOn && t >= retryingUntil;
            workSinceDigest = false;
            const fp = counts ? spin.digest(digestFingerprint(lastActivity, lastNote, lastCommit)) : { changed: false, spinning: false };
            if (fp.changed && spinMark === "digest") clearSpin();
            if (fp.spinning) {
              const mins = Math.max(1, Math.round((spinDigests * progressMs) / 60_000));
              spinning(`${name} has repeated «${lastActivity ?? "the same step"}» for ${mins} min with no new commit or note`, lastActivity ?? "", { reason: "digest", digests: spinDigests });
            }
            const digest = progressDigest({ project: name, elapsedMs: t - startedAt, activity: lastActivity, lastNote, lastCommit });
            void say(digest, undefined, { kind: "digest", cause });
            try {
              // Under the dispatch's cause: the company turn reading it is filed in this thread.
              await dispatcher.deliver(digest, cause ? { wake: false, cause } : { wake: false });
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
        event("dispatch_stall_evidence", {
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
        wrappingUp = true;
        run.followUp(wrapUpBrief(`dispatch stall limit reached (no activity for ${Math.round(stallMs / 60000)}m)`, graceMs), "after-turn");
        const graced = await doneOrTick(graceMs);
        if (graced !== "tick") {
          result = graced.done; // wrapped up in time — keep the worker's own result
          break;
        }
        timedOut = true;
        await run.interrupt();
        event("dispatch_abort", { orderId: order.id, folder, data: { project: name, workClass, limit } });
        const detail = `no activity for ${Math.round(stallMs / 60000)}m (stall limit)`;
        result = { ok: false, sessionId: "", summary: `timed out: ${detail} — asked to wrap up, then aborted`, costUsd: 0 };
        break;
      }
    } catch (e) {
      result = { ok: false, sessionId: "", summary: e instanceof Error ? e.message : String(e), costUsd: 0 };
    }
    // The run is over: a hold it still has can never re-send into it (ADR-0060).
    deps.apiWaits?.drop(order.id);
    // The commit finish's outcome (ADR-0037 §5): the run's end is its FIRST end — the follow-up only
    // adds one line, and a stall or failure inside the follow-up never turns the finished task bad.
    const finished = commitFinish ? faults.guard("dispatch.commitFinish", () => commitFinish.end(), { folder }) : undefined;
    if (finished && firstEnd) {
      result = { ...firstEnd, sessionId: result.sessionId || firstEnd.sessionId, costUsd: result.costUsd, summary: `${firstEnd.summary}\n${commitFinishLine(finished)}` };
      timedOut = false;
    }
    // The guard's end (ADR-0072): the final measure (a late move goes out through sizeUp), and whether the
    // todo runs again as big — it ended in plan first with no plan of its own awaiting the operator.
    const sizeEnd = guard ? faults.guard("dispatch.sizeEnd", () => guard!.end({ planAwaiting: planAwaiting() }), { folder }) : undefined;
    if (sizeEnd?.measured) {
      const m = sizeEnd.measured;
      event("size_measured", { orderId: order.id, folder, data: { project: name, size: sizeEnd.size, files: m.files.size, lines: m.lines, services: [...m.services] } });
    } else if (guard && baseline && !sharesFolder) {
      event("size_measure_failed", { orderId: order.id, folder, data: { project: name, size: guard.size() } });
    }
    // The final report is built FIRST and queued in the dispatcher inbox in the same synchronous step
    // as `dispatch_end` — no await between them — so no crash or reload can leave a run that is
    // marked ended but never reported (boot recovery only covers runs with no `dispatch_end`).
    // An abnormal end (stall abort, error, crash, API give-up, interrupt) — or a run wrapped up early
    // for an engine reload — says where it stopped, so the dispatcher can resume.
    // A reload that starts inside the commit finish does not cut the task: its first end was a finish.
    const reloading = deps.lifecycle?.draining() === true && !finished;
    // Handed off at a safe checkpoint (ADR-0021)? Then the task is not done — it continues fresh.
    const armed = finished ? undefined : watch?.armed(); // armed in the commit finish's turn: not this task's checkpoint
    const atCheckpoint =
      !!armed && result.ok && !timedOut && !reloading &&
      !handoffDeferred(folder, armed.decision, { ledger: deps.ledger, boundary: "checkpoint", occupancy: armed.occupancy, sessionId: result.sessionId || lastSessionId });
    // Armed, but the checkpoint could not complete (work appeared after it): the worker was told to
    // stop part-way, so this is NOT a finished task — it ends as a failure that says why.
    const checkpointLost = !!armed && !atCheckpoint && result.ok && !timedOut && !reloading;
    const ok = result.ok && !checkpointLost;
    const stop = timedOut || !ok || reloading ? stopPoint() : undefined;
    // Why it ended badly, from facts only (ADR-0027) — the todo queue decides retry vs failed from this.
    const good = ok && !timedOut && !reloading;
    const failure = good
      ? undefined
      : reloading ? "reload" : timedOut ? "stall" : checkpointLost ? "checkpoint" : !result.ok && result.apiError ? `api:${result.apiError}` : undefined;
    const sized = (text: string): string => (good && sizeEnd?.planWaits ? `${text}\n${PLAN_WAITS_TEXT}` : text);
    const summary = atCheckpoint
      ? `handed off at a safe checkpoint (${Math.round(armed!.occupancy * 100)}% of the context window) — the task continues in a fresh session`
      : checkpointLost
        ? `stopped at a context checkpoint (${Math.round(armed!.occupancy * 100)}%) that could not complete — uncommitted changes appeared after it; Neo's handoff note may be partial, dispatch it again to continue`
        : reloading
        ? `${result.summary || (result.ok ? "done" : "failed")} (wrapped up early for an engine reload — ${hooks.onEnd ? "its todo queue re-runs it" : "resume it after the restart"})`
        : sized(result.summary);
    const stopLine = stop ? formatStopPoint(stop) : "";
    const line =
      (ok ? `${name} finished: ${summary || "done"}` : `${name}: ${summary || "failed"}`) +
      (stopLine ? `\n${stopLine}` : "");
    // A quick order that ended well tells the operator 2–3 lines (ADR-0072); the dispatcher report and
    // the ledger keep the full text, and a failure is never cut.
    const operatorLine = good && guard?.size() === "quick" ? clampResult(line, sizesCfg.quick.resultMaxLines, resultRef(deps, cause)) : line;
    // The run is over: every brief delivered into it is answered (spec §5). Read before the entry
    // may be removed below.
    const answered = new Set<number>(cause ? [cause.threadId] : []);
    faults.guard("dispatch.endTurn", () => deps.registry.endTurn(session.id, { all: true }).forEach((c) => answered.add(c.threadId)));
    clearSpin(); // the run is over: nothing is spinning any more
    try {
      if (result.sessionId) {
        deps.registry.setSdkSessionId(session.id, result.sessionId, worker);
        deps.ledger.recordSession(order.id, result.sessionId, worker);
      }
      deps.meter.note({ costUsd: result.costUsd }, now());
      deps.ledger.recordOutcome(order.id, ok ? "done" : "error", ok ? result.summary : summary);
    } catch {
      // observer/bookkeeping errors must not surface into the worker path
    }
    try {
      event("dispatch_end", {
        orderId: order.id,
        sessionId: result.sessionId || undefined,
        folder,
        // workClass + costUsd together are what lets the meter report interactive vs background spend.
        data: { project: name, workClass, ok, timedOut, costUsd: result.costUsd, apiError: result.apiError, ...(checkpointLost ? { checkpointLost: true } : {}) },
      });
      let note: string | undefined;
      try {
        note = hooks.resultNote?.(good, failure, sizeEnd);
      } catch {
        note = undefined; // the queue's note is extra — the result itself must still be queued
      }
      const report = dispatchResultText({ project: name, ok, summary, stop, ref: resultRef(deps, cause) });
      deps.ledger.queueDispatcherReport(name, note ? `${report}\n${note}` : report, now(), cause);
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
        // A side lane is single-brief: it closes with its run and frees its name (ADR-0057).
        if (sideKind) deps.registry.remove(session.id);
        else deps.registry.setStatus(session.id, "idle");
        deps.registry.touch(session.id, now());
        deps.registry.noteBlocked(session.id, undefined); // the run is over — nothing is blocked
        deps.registry.detachControl(session.id);
      }
    } catch {
      // observer/bookkeeping errors must not surface into the worker path
    }
    // The run ended at a task boundary: hand the session off now, while its cache is warm, if it is
    // above the sweet spot — tracked, so the todo queue's next release waits for it (ADR-0021).
    let continuation: string | undefined;
    if (policy && !reloading && !timedOut) {
      try {
        const entry = deps.registry.get(session.id);
        const sid = result.sessionId || lastSessionId;
        const handoff = opts.handoff ?? runHandoff;
        const handoffDeps = { registry: deps.registry, ledger: deps.ledger, runDeps: profileDeps(providerCfg, "handoff"), memoryFlush: !!memoryGate(deps, folder), notify };
        let work: Promise<unknown> | undefined;
        if (atCheckpoint && armed) {
          const target: SessionInfo = { ...(entry ?? session), sdkSessionId: sid };
          const at = { ...handoffDeps, decision: armed.decision, boundary: "checkpoint" as const, next: () => "the task continues in a fresh session" };
          // The worker wrote its note in its own context — no extra handoff turn, unless it did not.
          work = noteStamp(folder) !== noteAtArm ? Promise.resolve(completeHandoff(target, policy, at, { before: noteAtArm, occupancy: armed.occupancy })) : handoff(target, policy, at);
          continuation = continuationBrief(task);
        } else if (entry && result.ok && sid) {
          const signals = opts.signals ?? sessionContext;
          const sig = signals(folder, sid, { windowTokensByModel: contextWindows(deps.ledger, policy.windowTokensByModel) });
          const ttlMs = effectiveCacheTtlMs(deps.ledger.listCacheObservations(policy.cacheObsWindow ?? CACHE_OBS_WINDOW), policy);
          const decision = decideContext(sig, policy, ttlMs, { boundary: "settled" });
          if (decision.verdict !== "keep" && !handoffDeferred(folder, decision, { ledger: deps.ledger, boundary: "settled", occupancy: sig.occupancy, sessionId: sid })) {
            // The task is done: say — and do — what happens next, from the note and this run's open
            // decisions (ADR-0029). Never a bare "the next session starts from the note".
            const next = (note: string): string | undefined => {
              const n = nextAfterHandoff({ note, openDecisions: deps.ledger.openDecisionsForOrder(order.id) });
              const told = hooks.onHandoff?.({ orderId: order.id, next: n, note, ...(sizeEnd ? { size: sizeEnd } : {}) });
              if (told) return told;
              return n.kind === "continue"
                ? "the next dispatch to this project starts from Neo's note"
                : n.kind === "blocked"
                  ? `paused: waiting on decision #${n.decision.id.slice(0, 8)} — ${n.decision.question} (answering it resumes the project)`
                  : n.kind === "plan"
                    ? planWaitTail(n.decision)
                    : "done, idle";
            };
            work = handoff({ ...entry, sdkSessionId: sid }, policy, { ...handoffDeps, decision, boundary: "settled", next });
          }
        }
        if (work) {
          // Tracked, not awaited: the operator's result goes out now; the next dispatch's gate waits.
          trackHandoff(folder, work, handoffHoldMs(policy));
          faults.contain("dispatch.handoff", work, { project: name, orderId: order.id, folder });
        }
      } catch {
        // observer only — the report below must still go out
      }
    }
    // Plans the run wrote go to the operator (ADR-0019) — their own detached unit, so a slow card
    // post never holds up the result below.
    if (deps.postPlan) {
      const run = { project: name, folder, startSha: planStart, cause, orderId: order.id, chatId: replyChat, ...(movedToBig() ? { forceApproval: true } : {}) };
      // After the cards the run already started posting (ADR-0036), so a run end never races them.
      faults.contain("dispatch.plans", async () => {
        await planWatch?.settled();
        await onRunEndPlans(planDepsFrom(deps, deps.plans), run);
      }, { project: name, orderId: order.id, folder });
    }
    try {
      // A dispatched job's finish is a RESULT the operator wants notified (Decisions group); a failure
      // is an ALERT they must also see (Decisions). Both reach the unmuted group — never the muted DM.
      // The frontend prepends the single priority accent (✅/🔴) — no per-call-site glyph (Feature 2).
      await say(operatorLine, ok ? "result" : "alert", { kind: "result", cause });
      // Still uncommitted after the one follow-up: the operator must see it (the queue also raises it).
      if (finished?.kind === "still") await say(`⚠️ ${name}: ${commitFinishLine(finished)}`, "alert", { cause });
    } catch {
      // the operator line is best-effort; the dispatcher report below must still go out
    }
    for (const threadId of answered) refreshThread(deps, threadId);
    // The dispatcher ALWAYS gets the final result: deliver the inbox now (waking an idle company);
    // whatever cannot be delivered yet stays queued for the next flush.
    try {
      await flushDispatcherInbox(deps.ledger, dispatcher, now());
    } catch {
      // observer only
    }
    // A `code` side lane's worktree goes now (kept when dirty); the queue merges or raises the branch.
    const laneEnd = laneWt ? faults.guard("dispatch.laneWorktree", () => endLaneWorktree(folder, laneWt!), { folder }) : undefined;
    // Last: the result is out, so the todo queue may release the project's next brief (ADR-0008).
    try {
      await hooks.onEnd?.({ orderId: order.id, ok: good, summary, ...(continuation ? { continuation } : {}), ...(failure ? { failure } : {}), ...(laneEnd ? { lane: laneEnd } : {}), ...(sizeEnd ? { size: sizeEnd } : {}) });
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
      event("dispatch_end", { orderId: order.id, folder, data: { project: name, workClass, ok: false, timedOut: false, costUsd: 0 } });
      deps.ledger.queueDispatcherReport(name, dispatchResultText({ project: name, ok: false, summary, ref: resultRef(deps, cause) }), now(), cause);
    } catch {
      // observer only
    }
    const answered = new Set<number>(cause ? [cause.threadId] : []);
    try {
      deps.registry.endTurn(session.id, { all: true }).forEach((c) => answered.add(c.threadId));
      deps.registry.remove(session.id);
    } catch {
      // observer only
    }
    try {
      await say(`${name}: ${summary}`, "alert", { kind: "result", cause });
      await flushDispatcherInbox(deps.ledger, dispatcher, now());
    } catch {
      // observer only
    }
    for (const threadId of answered) refreshThread(deps, threadId);
    const laneEnd = laneWt ? faults.guard("dispatch.laneWorktree", () => endLaneWorktree(folder, laneWt!), { folder }) : undefined;
    try {
      await hooks.onEnd?.({ orderId: order.id, ok: false, summary, failure: "launch", ...(laneEnd ? { lane: laneEnd } : {}) });
    } catch {
      // observer only
    }
  });

  if (sideKind) {
    return (
      `started as a side lane (${sideKind}) of ${project}, named ${name}, beside its main task — ` +
      `it runs now in its own session; its output streams to the operator and you get its result when it ends.`
    );
  }
  return `dispatched to ${name} — running in the background with no time limit; its output streams to the operator, you get a progress digest every few minutes, and you will receive its result as a follow-up message when it ends.`;
}

/** The `lane` / `kind` arguments of the `dispatch` and `todo` tools (ADR-0057). */
const LANE_ARG = z.enum(["side", "queue"]).optional().describe('"side" = run beside a busy project\'s main task (needs `kind`); "queue" (default) = wait in its main queue');
const KIND_ARG = z.enum(LANE_KINDS).optional().describe("what a side lane does: ops | test | read-only | code — the engine enforces it");
/** The `size` argument of the `dispatch` and `todo` tools (ADR-0072). */
const SIZE_ARG = z.enum(ORDER_SIZES).optional().describe("quick | standard | big — how much process the worker runs (see Size in the dispatch description); no size = big");
/** The lane fields the todo queue takes from a tool call: only a side lane with its kind. */
function laneArgs(a: { lane?: "side" | "queue"; kind?: LaneKind }): { lane?: "side"; kind?: LaneKind } {
  return a.lane === "side" && a.kind ? { lane: "side", kind: a.kind } : {};
}

/** The ref of a result's thread, for the dispatcher's `[dispatch result · m4g2]` (trace only). */
/** A quick result for the operator (ADR-0072 §8): at most `max` lines, then a pointer to the full text. */
export function clampResult(text: string, max: number, ref?: string): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n… (the full result is in ${ref ? `thread ${ref}` : "the dispatcher's report"})`;
}

function resultRef(deps: Pick<DispatchDeps, "trace">, cause: Cause | undefined): string | undefined {
  return cause && deps.trace ? deps.trace.ref(cause.threadId) : undefined;
}

/** Send a file the worker produced, but only if `path` is inside `folder`. Returns a status string. */
export async function sendProjectFile(
  deps: { sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void> },
  chatId: number,
  folder: string,
  path: string,
  caption?: string,
  /** Called once the file was handed to the channel (the trace's `file` line). */
  onSent?: () => void,
  /** The plan registry (ADR-0019): a plan path is sent as its plan card, once per content version. */
  plan?: { deps: PlanDeps; run: PlanRun },
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
  if (plan) {
    const offered = await offerPlanFile(plan.deps, { ...plan.run, path: relative(root, abs) });
    if (offered.handled) return offered.text;
  }
  await deps.sendFile?.(chatId, abs, caption);
  onSent?.();
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
  deps: Pick<DispatchDeps, "ledger" | "postDecision"> & Partial<Pick<DispatchDeps, "registry" | "trace">>,
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
    /** The operator message (and thread) the raising work answers: the decision lands in that
     *  thread, which then reads "waiting" (spec §5). */
    cause?: Cause;
    /** The raising session, when known: it is the one marked blocked (a side lane is never the folder's
     *  main session, ADR-0057). Absent → the folder's main session. */
    sessionId?: string;
  },
): Promise<string> {
  const id = deps.ledger.openDecision({
    cause: params.cause,
    kind: "decision",
    project: params.project,
    folder: params.folder,
    orderId: params.orderId,
    chatId: params.chatId,
    question: params.question,
    options: params.options,
    spec: params.spec,
  });
  // The decision is a line of its thread (spec §4.3): recorded, its card carries the thread's ref, and
  // the posted card is bound to the line so a reply to it joins the thread. Best-effort (ADR-0010).
  const trace = deps.trace;
  const cause = params.cause;
  const lineId =
    trace && cause
      ? faults.guard("dispatch.decisionLine", () =>
          trace.outbound({ chatId: params.chatId, text: params.spec ? decisionBody(params.spec) : params.question, cause, kind: "decision", project: params.project, folder: params.folder, orderId: params.orderId }),
        )
      : undefined;
  const ref = trace && cause ? trace.ref(cause.threadId) : undefined;
  const posted = await deps.postDecision?.({ id, project: params.project, folder: params.folder, ...(ref ? { ref } : {}) }, params.question, params.options, params.spec);
  if (posted) deps.ledger.setDecisionMessage(id, posted.chatId, posted.messageId);
  if (posted && trace && lineId !== undefined) faults.guard("dispatch.decisionBind", () => trace.bindChannel(lineId, posted.chatId, posted.messageId));
  deps.ledger.recordEvent("decision_raised", {
    orderId: params.orderId,
    folder: params.folder,
    cause: params.cause,
    data: { project: params.project, id, structured: !!params.spec, options: params.options?.length ?? 0, posted: !!posted },
  });
  // The worker that raised this check-points and STOPS: it is awaiting the OPERATOR, not hung.
  // Marked here — the one path behind every blocking-question gesture (`ask_operator` and the
  // serviced native AskUserQuestion alike) — so no caller can raise a decision without the session
  // reporting it. Cleared when a brief/answer is delivered back, or when the run ends.
  if (deps.registry && params.folder) {
    try {
      const session = (params.sessionId ? deps.registry.get(params.sessionId) : undefined) ?? deps.registry.findByFolder(params.folder);
      if (session) {
        deps.registry.noteBlocked(session.id, { kind: "decision", label: params.question, since: (params.now ?? Date.now)() });
      }
    } catch {
      // observer only — a registry hiccup must never break raising the decision
    }
  }
  refreshThread(deps, params.cause?.threadId);
  return id;
}

/** `text` with the folder's held live notes in front (ADR-0050 §4): notes from main and answers the
 *  session took no delivery of while it sat idle. "" held, or no `deps.notes` (ingress) → `text`. */
export function withLiveNotes(deps: Pick<DispatchDeps, "notes">, sessionId: string, folder: string, text: string, at: number): string {
  const notes = deps.notes;
  if (!notes) return text;
  const held = faults.guard("notes.takeLive", () => notes.takeLive(sessionId, folder, at), { folder });
  return held ? `${held}\n\n${text}` : text;
}

/** Google Stitch MCP server (HTTP transport) — design generation for operator workers. */
export const STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";
/** The env var that holds the Stitch key (config.ts reads the same name). A worker's MCP config names it as
 *  `${STITCH_API_KEY}` and the Claude CLI expands it from the worker env: the key never sits in argv (ADR-0062). */
export const STITCH_KEY_ENV = "STITCH_API_KEY";

/** The Playwright MCP launch every operator worker gets — one definition, also read by the toolchain
 *  updater (ADR-0009) so the server it verifies after an update is the one workers start. */
export const PLAYWRIGHT_MCP = { command: "playwright-mcp", args: ["--headless", "--isolated"] };

/** The options of `neoMcpServers`: who the tools are built for (folder, project, session, order,
 *  work class, cause) and which extra servers attach. */
export interface NeoToolOpts {
  dispatch: boolean;
  /** `consult` (ADR-0050 §6, ruling R4): a read-only consult run gets ONLY `tools_for` and the memory
   *  read tool (`memory_search`) — no send_file, ask_operator, project_notes, tool_api, dispatch or
   *  todo, and no stitch/playwright/codebase-memory. Absent = the full operator tool set. */
  profile?: "consult";
  /** The registry session the tools act for — the asker a late answer goes back to (ADR-0050). The
   *  `project_notes` tool is attached only when this and `orderId` are known. */
  sessionId?: string;
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
  /** The cause of the turn calling a tool (ADR-0015), read at CALL time — never captured at
   *  launch — so a dispatch, todo, decision or file is filed under the operator message the
   *  worker is answering now, not its session's first order. Absent → no cause, as before. */
  cause?: () => Cause | undefined;
  /** The cause NEW work (a dispatch, a todo, a decision) is filed under (ADR-0053): only a live one —
   *  the input the session works on now, or a dispatch run's own order — never an ended turn's. Absent
   *  → `cause`. With none, the work roots its own thread (origin `dispatcher`). */
  workCause?: () => Cause | undefined;
  stitch?: boolean;
  stitchKey?: string;
  /** Operator-only local stdio MCP servers; the customer/ingress path passes neither. */
  codebaseMemoryBin?: string;
  /** Operator-only: attach the Playwright browser-automation MCP (headless chromium) so every
   *  operator project worker can drive a real browser for web/UI testing. Never on the customer
   *  path (browser automation there would let customer-tainted work reach arbitrary URLs). */
  playwright?: boolean;
}

/** The deps a consult tool set reads: the catalogue, the memory gate's inputs and the task history (search
 *  only), nothing else. */
export type ConsultToolDeps = Pick<DispatchDeps, "tools" | "memory" | "companyFolder" | "contextPolicy" | "history">;

/** Build the project's in-process MCP tools: `send_file` always; `dispatch` only for the company.
 *  When `opts.stitch` is set AND a `opts.stitchKey` is configured, the operator's Stitch HTTP MCP
 *  server is attached too. Stitch is OFF by default so the customer/ingress path never gets it.
 *  `profile: "consult"` builds the read-only consult set from the same code (ADR-0050 ruling R4). */
export function neoMcpServers(deps: DispatchDeps, replyChat: number, opts: NeoToolOpts): Record<string, unknown>;
export function neoMcpServers(deps: ConsultToolDeps, replyChat: number, opts: NeoToolOpts & { profile: "consult" }): Record<string, unknown>;
export function neoMcpServers(given: DispatchDeps | ConsultToolDeps, replyChat: number, opts: NeoToolOpts): Record<string, unknown> {
  const consult = opts.profile === "consult";
  // The consult set reads only the ConsultToolDeps fields (every other branch below is `!consult`).
  const deps = given as DispatchDeps;
  /** Where new work is filed (ADR-0053): under the thread the dispatcher names, else the live cause,
   *  else its own new thread (origin `dispatcher`). A string is the refusal for an unknown ref. */
  const workCauseFor = (thread: string | undefined, title: string, project?: string): Cause | string | undefined => {
    const trace = deps.trace;
    if (thread !== undefined) {
      const msgId = trace?.parseRef(thread);
      const threadId = msgId === undefined ? undefined : deps.ledger.messageById(msgId)?.threadId;
      if (msgId === undefined || threadId === undefined) return `unknown thread "${thread}" — nothing was done. Use a thread ref you were given (m…), or leave \`thread\` out.`;
      return { msgId, threadId };
    }
    const live = (opts.workCause ?? opts.cause)?.();
    if (live) return live;
    return trace ? faults.guard("dispatch.workRoot", () => trace.root({ origin: "dispatcher", title: todoTitle(title), ...(project ? { project } : {}) })) : undefined;
  };
  /** The operator's size override (ADR-0072 §2.3), read in code from their own message — never from a tool
   *  argument: first the live message the company answers now, then the root of the thread the work is
   *  filed under. Only a line the operator wrote (role user, on Telegram or the web) counts, so a turn that a
   *  schedule fired or an engine-written root gives none. A turn the engine started under that message (a
   *  dispatch result, marked `engine` on its cause) is not the operator's turn: an old `/quick` never carries
   *  over to the work the chief of staff files then. */
  const operatorSizeFor = (work: Cause | undefined): OrderSize | undefined =>
    faults.guard("dispatch.operatorSize", () => {
      const cfg = deps.sizes ?? DEFAULT_SIZES_CFG;
      const live = (opts.workCause ?? opts.cause)?.();
      if (live?.engine) return undefined;
      for (const id of [live?.msgId, work?.threadId]) {
        const m = id === undefined ? undefined : deps.ledger.messageById(id);
        if (!m || m.role !== "user" || (m.surface !== "telegram" && m.surface !== "web")) continue;
        const o = parseSizeOverride(m.content, cfg);
        if (o) return o.size;
      }
      return undefined;
    });
  /** The size fields a tool call hands to the todo queue: the chief of staff's and the operator's. */
  const sizeArgs = (size: OrderSize | undefined, work: Cause | undefined): { size?: OrderSize; operatorSize?: OrderSize } => {
    const operatorSize = operatorSizeFor(work);
    return { size, ...(operatorSize ? { operatorSize } : {}) };
  };
  const THREAD_ARG = z
    .string()
    .optional()
    .describe(
      "the thread ref (m…) this work belongs to — the ref on the result, note or message you are acting on. Set it whenever that is not the operator message you are answering now; omit it otherwise.",
    );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = consult ? [] : [
    tool(
      "send_file",
      "Send a file you produced in THIS project back to the operator (Telegram/web). `path` must be inside the project folder.",
      {
        path: z.string().describe("path to the file to send, inside the project folder"),
        caption: z.string().optional().describe("optional caption / note"),
      },
      async (args: { path: string; caption?: string }) => {
        // A plan path goes through the registry (ADR-0019) — only where a plan card can be posted.
        const plan = deps.postPlan
          ? { deps: planDepsFrom(deps, deps.plans), run: { project: opts.projectName ?? basename(opts.folder), folder: opts.folder, cause: opts.cause?.(), orderId: opts.orderId, chatId: replyChat } }
          : undefined;
        const out = await sendProjectFile(deps, replyChat, opts.folder, args.path, args.caption, () => {
          // The thread shows a file went out: its caption or name, never its bytes (trace only).
          const trace = deps.trace;
          if (!trace) return;
          faults.guard("dispatch.sendFileLine", () =>
            trace.outbound({ chatId: replyChat, text: args.caption || basename(args.path), cause: opts.cause?.(), kind: "file", project: opts.projectName, folder: opts.folder, orderId: opts.orderId }),
          );
        }, plan);
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
  if (!consult && deps.postDecision) {
    tools.push(
      tool(
        "ask_operator",
        "Raise ONE decision the operator must make before this work can proceed (e.g. \"Postgres or Mongo?\", \"which design?\", \"I need the prod API key\"). " +
          "BEFORE you call this, challenge yourself: (1) trace the real root cause in the code, not the symptom; (2) determine the correct industry-standard fix, not the quickest patch; (3) criticize your own options and drop any that are only workarounds. " +
          "Escalate ONLY a decision that is genuinely the operator's: product/UX policy, cost, an irreversible or external action, or a real trade-off between two sound options. If there is one correct standard fix, do it and report — do NOT ask. " +
          "Raise exactly one decision per call — never bundle several; call ask_operator once per decision. " +
          "WRITE THE CARD FOR A NON-TECHNICAL READER who has not seen your work, in the operator's language when you know it: a plain `title` (the question), a `context` that says what is happening and why a choice is needed, 2–5 `options` each with a short plain `label` (it is a button) and an `explanation` of what happens if it is picked — its effect and its risk or cost — and `recommended` (one of the labels + a one-line reason). " +
          "No ADR numbers, code names, file paths or abbreviations unless you explain them in brackets right after; labels must be plain words. The engine rejects a card that breaks these rules and tells you what to rewrite. " +
          "It goes to the operator's Decisions channel and is tracked until they answer. Set `multiSelect: true` when the operator may pick SEVERAL options (they tap each, then Submit). After calling this, CHECK-POINT your work (commit green work / write a WIP note) and STOP — their answer will resume this session as a follow-up message. Do NOT guess a default and continue.",
        {
          title: z.string().describe(`the question, in plain words (at most ${DECISION_LIMITS.title} characters)`),
          context: z
            .string()
            .describe(`what is happening and why a decision is needed, for someone who has not seen your work (at most ${DECISION_LIMITS.context} characters)`),
          options: z
            .array(
              z.object({
                label: z.string().describe(`short plain button text (at most ${DECISION_LIMITS.label} characters, no code names)`),
                explanation: z
                  .string()
                  .describe(`what happens if the operator picks this: its effect, and its risk or cost (at most ${DECISION_LIMITS.explanation} characters)`),
              }),
            )
            .describe(`2–${MAX_OPTIONS} defensible options, each explained`),
          recommended: z
            .object({
              option: z.string().describe("exactly one of the option labels"),
              reason: z.string().describe(`one line: why you recommend it (at most ${DECISION_LIMITS.reason} characters)`),
            })
            .describe("the option you advise; the decision still stays with the operator"),
          multiSelect: z
            .boolean()
            .optional()
            .describe("set true when the operator may choose SEVERAL of the options (tap each, then Submit); default single choice"),
          // Only the dispatcher serves many threads at once, so only it names one (ADR-0053).
          ...(opts.dispatch ? { thread: THREAD_ARG } : {}),
        },
        async (args: DecisionInput & { thread?: string }) => {
          // The engine's gate (ADR-0049): a card the operator could not understand is bounced back with
          // every problem named, so the worker rewrites it — nothing is raised or posted.
          const checked = checkDecision(args);
          if (!checked.ok) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    "Not raised — the operator could not decide from this card. Rewrite it for a non-technical reader and call ask_operator again:\n" +
                    checked.problems.map((p) => `- ${p}`).join("\n"),
                },
              ],
            };
          }
          const spec = checked.ask;
          const cause = workCauseFor(opts.dispatch ? args.thread : undefined, spec.title ?? args.title, opts.projectName);
          if (typeof cause === "string") return { isError: true, content: [{ type: "text" as const, text: cause }] };
          const id = await raiseOperatorDecision(deps, {
            project: opts.projectName,
            folder: opts.folder,
            ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
            orderId: opts.orderId,
            chatId: replyChat,
            question: spec.title ?? args.title,
            spec,
            cause,
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
  // `project_notes` (ADR-0043, ADR-0050): one project tells or asks another. Gated on `deps.notes`, which
  // only operator surfaces wire (ingress strips it), and never on a consult run. The sender — project,
  // folder, session, order, work class, cause — is this session's, from the closure: never a tool
  // argument. Without a known session and order the tool is not attached (fail closed).
  const notes = deps.notes;
  const sessionId = opts.sessionId;
  const orderId = opts.orderId;
  if (!consult && notes && sessionId && orderId) {
    tools.push(
      tool(
        "project_notes",
        NOTES_TOOL_DESCRIPTION,
        {
          action: z.enum(["send", "ask", "list", "show", "ack", "resolve", "withdraw"]),
          to: z.string().optional().describe('target: a project folder name, e.g. "eticket-v3", or "main" (the main agent)'),
          question: z.string().optional().describe("ask: the question, in plain words — facts, tools or how-to, never work"),
          need: z.enum(["info", "resource", "help"]).optional().describe("ask: info = a fact, resource = a shared tool or key, help = how to do something (default info)"),
          kind: z.enum(["finding", "fyi", "request"]).optional(),
          severity: z.enum(["high", "normal", "low"]).optional(),
          title: z.string().optional().describe("one line"),
          body: z.string().optional().describe("the facts: what, where, how you know"),
          refs: z.array(z.string()).optional().describe("files, URLs, ids the target can check"),
          ref: z.string().optional().describe('your own id for the note, e.g. "D16"; the same ref again updates the same note'),
          id: z.number().int().optional().describe("note number (#N), for show/ack/resolve/withdraw"),
          box: z.enum(["to", "from"]).optional().describe("list: `to` = notes for this project (default), `from` = notes it sent"),
          how: z.enum(["fixed", "not_needed", "duplicate"]).optional().describe("resolve: how the note closed"),
          commit: z.string().optional().describe("resolve fixed: the commit sha that fixed it (on a branch)"),
          reason: z.string().optional().describe("resolve not_needed/duplicate: why"),
        },
        async (args: NoteToolArgs) => {
          const from: NoteToolSender = {
            project: opts.projectName ?? basename(opts.folder), folder: opts.folder, chatId: replyChat, cause: opts.cause?.(),
            sessionId, orderId, workClass: opts.workClass ?? DEFAULT_WORK_CLASS,
          };
          return { content: [{ type: "text" as const, text: await runNoteAction(notes, from, args, Date.now()) }] };
        },
      ),
    );
  }
  // `tool_api` (ADR-0044): an API call with a key the engine holds. Gated on `deps.tools`; the caller is
  // this session's project and folder — never a tool argument. All guards live in `relayCall`.
  const catalogue = deps.tools;
  if (!consult && catalogue) {
    tools.push(
      tool(
        "tool_api",
        "Call a shared API tool through the engine, which adds the API key (you never see it). `card` is the tool card id, `operation` one of the operations the card lists, `body` the JSON payload. Refusals name the check that failed; nothing is sent then. Returns the HTTP status and body.",
        {
          card: z.string().describe("tool card id, e.g. from your neo-tool-* skill"),
          operation: z.string().describe("an operation name declared on the card"),
          body: z.unknown().optional().describe("JSON payload (POST operations)"),
        },
        async (args: { card: string; operation: string; body?: unknown }) => {
          const caller = { project: opts.projectName ?? basename(opts.folder), folder: opts.folder };
          return { content: [{ type: "text" as const, text: await catalogue.relay(args.card, args.operation, args.body, caller) }] };
        },
      ),
    );
  }
  if (catalogue) {
    tools.push(
      tool(
        "tools_for",
        "Find the shared tool, CLI, API, recipe or skill for a task. Describe the task in plain words; the reply lists the best matches with why they match, how to call them, and their cost and limits. Only for tools that Neo's catalogue knows.",
        {
          task: z.string().describe("what you need to do, in plain words"),
          limit: z.number().int().min(1).max(10).optional().describe("how many matches to return (default from config)"),
        },
        async (args: { task: string; limit?: number }) => {
          const caller = { project: opts.projectName ?? basename(opts.folder), folder: opts.folder };
          const matches = catalogue.find(args.task, { ...caller, ...(args.limit !== undefined ? { limit: args.limit } : {}) });
          return { content: [{ type: "text" as const, text: formatToolsReply(matches, catalogue.cfg) }] };
        },
      ),
    );
  }
  // `history_search` and `remember` (ADR-0067): gated on `deps.history`, which only operator surfaces wire
  // (ingress strips it; a tainted run has no MCP at all). A consult run searches but never saves. `by`, the
  // cause and the rate limit's session are this session's, from the closure: never a tool argument.
  const history = deps.history;
  if (history) {
    const session = opts.sessionId ?? opts.folder;
    // A customer-driven brief delivered into this session marks it for good (markCustomerDriven): from then
    // on it neither reads the operator's history nor writes to it. Checked at each call, not at build time.
    const customerDriven = (): boolean => opts.sessionId !== undefined && deps.registry?.get(opts.sessionId)?.customerDriven === true;
    tools.push(
      tool(
        "history_search",
        HISTORY_SEARCH_DESCRIPTION,
        {
          query: z.string().describe("what you look for, in plain words (Arabic or English) or ids; 1–500 characters"),
          project: z.string().optional().describe('only this project, e.g. "eticket-v3"'),
          since: z.string().optional().describe("from this UTC date, YYYY-MM-DD"),
          until: z.string().optional().describe("to this UTC date, YYYY-MM-DD (inclusive)"),
          kinds: z.array(z.string()).optional().describe("only these kinds: todo, order, result, digest, message, plan, note, attention, decision, remembered, line"),
          limit: z.number().int().optional().describe(`how many hits, 1–${TOOL_LIMIT_MAX} (default from config)`),
        },
        async (args: unknown) => (customerDriven() ? historyRefusedInCustomerSession("History search") : historySearchTool(history, args, session)),
      ),
    );
    if (!consult) {
      const caller: RememberCaller = {
        by: opts.dispatch ? "company" : "worker",
        session,
        ...(opts.projectName ? { project: opts.projectName } : {}),
      };
      tools.push(
        tool(
          "remember",
          REMEMBER_DESCRIPTION,
          {
            text: z.string().describe("the fact, in plain words, with where it applies; never a secret"),
            project: z.string().optional().describe("the project it belongs to (default: this session's project)"),
          },
          async (args: unknown) => {
            if (customerDriven()) return historyRefusedInCustomerSession("Not saved");
            const cause = opts.cause?.();
            return rememberTool(history, args, { ...caller, ...(cause ? { cause } : {}) });
          },
        ),
      );
    }
  }
  if (!consult && opts.dispatch) {
    tools.push(
      tool(
        "sessions",
        "List the operator's live project sessions and what each is doing RIGHT NOW. Each line gives a STATE plus two ages — `last activity` (any sign of life) and `last output` (what the operator can read). Read the state, not the ages: `idle` means healthy and free NO MATTER how old its ages are (a project can sit idle for days and still answer instantly), `working`/`quiet` mean it is busy, `starting` means the engine is still preparing it, `awaiting-operator` means it needs the OPERATOR's answer, and ONLY `wedged` means genuinely stuck. Never tell the operator a project is stuck, hung or in need of a restart unless its state is `wedged`. Use this to answer the operator about a project's status, or — when a dispatch reports a project busy — to decide whether to wait for it or report back. Returns text.",
        {},
        async () => {
          const at = Date.now();
          // Only a run the registry still holds: a killed or ended session shows no stale hold.
          const held = (orderId: string) => (deps.apiWaits?.held(orderId) ? heldLine(deps.ledger, orderId, at) : undefined);
          return { content: [{ type: "text" as const, text: sessionsReport(deps.registry, at, deps.liveness, companyProjectLines(deps, at), held) }] };
        },
      ),
      ...(deps.projectMessage
        ? [
            tool(
              "project_message",
              "Speak to a project's OPEN session the way the operator does when they switch to it and type: the text goes into that session — a working one sees it at its next step, an idle one wakes with it, one held in a limit wait (`sessions`/`todo list` show \"held: limit wait\") starts a turn now. Use it for short words to a session that is already there: \"resume\", \"status?\", \"continue\". NOT for an answer to a decision the project raised with ask_operator — that is the operator's. NOT for new work — that is `dispatch` (it queues behind the running task); NOT for information to another project — that is `project_notes`. It never replaces the running task. Refused in code: an empty or long text, a project with no open session (use dispatch), a customer-driven session, one still starting or closing, one held at a big plan or waiting for the operator's decision, too many messages to one project in an hour. The operator sees every message in that project's stream, marked as from you; the session's replies go there too, not back to you. Never tell the operator to /kill a session for something this tool can do. Returns what happened: delivered (and how) or refused (and why).",
              {
                project: z.string().describe('project folder name, e.g. "waselni"'),
                text: z.string().describe("the short message, as the operator would type it"),
              },
              async (args: { project: string; text: string }) => {
                const r = await deps.projectMessage!({ project: args.project, text: args.text, replyChat, cause: opts.cause?.() });
                return { content: [{ type: "text" as const, text: r.text }] };
              },
            ),
          ]
        : []),
      tool(
        "dispatch",
        "Open one of the operator's projects and run a self-contained task in it. Use this for any order that belongs to a specific project (e.g. api-server, web-app). The target project does NOT see the operator's original message — only your `task` brief — so write `task` as a clear, complete prompt. " +
          "If the project is busy (mid-task), the brief is QUEUED in that project's todo queue and the reply says \"queued as #N for <project>, position P\": it starts by itself when the current task is done, so confirm the number and position to the operator and never re-send or forward it. " +
          "The run has NO time limit — it works until it is done, even for hours; only a worker that goes completely silent (hung) is stopped. While it runs you get a `[dispatch progress]` line every few minutes (FYI — no reply needed), and you ALWAYS get a `[dispatch result]` message when it ends — including when it was cut short, in which case the result says where it stopped (last commit / latest note) so you can dispatch a follow-up that resumes from there. " +
          "Set `team: \"frontend-backend\"` ONLY when the operator wants the work split across a lead-orchestrated backend + frontend subagent team; omit it for a normal single-worker run. " +
          LANE_GUIDE +
          " " +
          SIZE_GUIDE,
        {
          project: z.string().describe('project folder name under the operator\'s project root, e.g. "eticket-v3"'),
          task: z.string().describe("a clear, self-contained brief/prompt for that project to execute"),
          team: z
            .enum(["frontend-backend"])
            .optional()
            .describe(
              "opt-in: run the brief with a lead-orchestrated backend + frontend subagent team (the lead delegates by domain, enforces file-ownership boundaries, and coordinates via a shared contract file). Omit for a normal single-worker dispatch.",
            ),
          lane: LANE_ARG,
          kind: KIND_ARG,
          size: SIZE_ARG,
          thread: THREAD_ARG,
        },
        async (args: { project: string; task: string; team?: "frontend-backend"; lane?: "side" | "queue"; kind?: LaneKind; size?: OrderSize; thread?: string }) => {
          const laneError = laneArgError(args.lane, args.kind);
          if (laneError) return { content: [{ type: "text" as const, text: laneError }] };
          // The dispatch inherits the class of the worker calling the tool: the company session
          // servicing an operator message dispatches as `interactive`, a scheduler-fired one as
          // `background`. This is the whole of the "class follows the originating trigger" rule.
          const workClass = opts.workClass ?? DEFAULT_WORK_CLASS;
          // The thread this work belongs to (ADR-0053), and the order of the session making it.
          const cause = workCauseFor(args.thread, args.task, args.project);
          if (typeof cause === "string") return { content: [{ type: "text" as const, text: cause }] };
          const sized = sizeArgs(args.size, cause);
          // Without the queue, dispatch runs it at once at the resolved size (a customer chat is always big).
          const direct = () =>
            resolveSize({ chosen: sized.size, override: sized.operatorSize, ...(replyChat === CUSTOMER_CHAT ? { forced: "customer" as const } : {}) }, deps.sizes ?? DEFAULT_SIZES_CFG).size;
          const out = deps.todo
            ? await deps.todo.submit({ project: args.project, brief: args.task, team: args.team, workClass, cause, parentOrderId: opts.orderId, ...laneArgs(args), ...sized }, deps, replyChat)
            : await dispatchToProject(args.project, args.task, deps, replyChat, { root: deps.workRoot, team: args.team, workClass, cause, parentOrderId: opts.orderId, size: direct() });
          return { content: [{ type: "text" as const, text: out }] };
        },
      ),
      // ADR-0058: the chief of staff stops or backgrounds ONE command of a project's worker when the
      // operator asks — through the engine (SDK stop + that call's process tree), never ps/kill.
      tool(
        "tool_control",
        "Stop, or move to the background, the command a project's worker is running right now — only that command; the worker's session goes on. Use this instead of ps/kill when the operator asks to stop or background something a project is running (for example a long `git push` scan or a test loop). " +
          "`stop`: the command and its child processes end, including what it started inside containers; the worker is told not to run it again. `background`: it keeps running with its output in a log file, and the worker goes on at once. " +
          "With several running commands the reply lists them numbered; call again with `pick`. Codex workers: stop ends the whole turn, background is not possible.",
        {
          action: z.enum(["stop", "background"]),
          project: z.string().describe('the project (session) name, e.g. "eticket-v3"'),
          pick: z.number().int().min(1).optional().describe("which running command, from the numbered list"),
        },
        async (args: { action: "stop" | "background"; project: string; pick?: number }) => {
          const r = await controlByProject(
            { registry: deps.registry, ledger: deps.ledger, cfg: deps.toolControl ?? DEFAULT_TOOL_CONTROL_CFG, reply: (text, project) => void deps.reply(replyChat, text, project) },
            { project: args.project, ...(args.pick !== undefined ? { pick: args.pick } : {}), action: args.action, by: { kind: "company" } },
          );
          return { content: [{ type: "text" as const, text: r.text }] };
        },
      ),
    );
    const todo = deps.todo;
    if (todo) {
      tools.push(
        tool(
          "todo",
          "The per-project todo queues. Every brief you `dispatch` is a todo (#N): it runs now when the project is free, else it waits in that project's queue and starts BY ITSELF when the current task is done — so never re-send or forward a queued brief, and never push a brief into a project mid-task. " +
            "Actions: `list` (all projects, or one with `project`), `add` (same as dispatch: needs `project` + `task`), `reorder` (`id` + 1-based `position`), `cancel` (`id`, queued or retry todos only), `retry` (`id`: re-run a failed todo, or a waiting retry now — the SAME todo; never dispatch a new brief to redo a failed one; on a RUNNING todo held in a usage-limit wait or an API retry wait — `list` and `sessions` show \"held: limit wait\" or \"held: API retry\" — it resumes that run NOW: the brief goes back into the same session, no second run. Never tell the operator to /kill a held todo: `retry` it), `pause` / `resume` (`project`). " +
            "A todo that stopped for a passing reason (stall, restart, API or account error) is kept as `retry` and re-runs by itself. " +
            "For `add`, " + LANE_GUIDE + " `size`: as in `dispatch` (quick | standard | big; none = big). Returns text.",
          {
            action: z.enum(["list", "add", "reorder", "cancel", "retry", "pause", "resume"]),
            project: z.string().optional().describe("project folder name, e.g. \"eticket-v3\""),
            id: z.number().int().optional().describe("todo number (#N)"),
            position: z.number().int().min(1).optional().describe("new 1-based queue position, for reorder"),
            task: z.string().optional().describe("the brief, for add — a clear, self-contained prompt"),
            team: z.enum(["frontend-backend"]).optional().describe("opt-in team mode, for add (as in dispatch)"),
            lane: LANE_ARG,
            kind: KIND_ARG,
            size: SIZE_ARG,
            thread: THREAD_ARG,
          },
          async (args: { action: string; project?: string; id?: number; position?: number; task?: string; team?: "frontend-backend"; lane?: "side" | "queue"; kind?: LaneKind; size?: OrderSize; thread?: string }) => {
            const need = (what: string) => `todo ${args.action} needs ${what}.`;
            const text = await (async () => {
              switch (args.action) {
                case "list":
                  return todo.list(args.project);
                case "add": {
                  if (!args.project || !args.task) return need("`project` and `task`");
                  const laneError = laneArgError(args.lane, args.kind);
                  if (laneError) return laneError;
                  const cause = workCauseFor(args.thread, args.task, args.project);
                  if (typeof cause === "string") return cause;
                  return todo.submit(
                    { project: args.project, brief: args.task, team: args.team, workClass: opts.workClass ?? DEFAULT_WORK_CLASS, cause, parentOrderId: opts.orderId, ...laneArgs(args), ...sizeArgs(args.size, cause) },
                    deps,
                    replyChat,
                  );
                }
                case "reorder":
                  if (args.id === undefined || args.position === undefined) return need("`id` and `position`");
                  return todo.move(args.id, args.position);
                case "cancel":
                  if (args.id === undefined) return need("`id`");
                  return todo.cancel(args.id);
                case "retry":
                  if (args.id === undefined) return need("`id`");
                  return todo.retry(args.id);
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
    // `plan` (ADR-0053): the operator approved or dropped a plan in chat — record it on the plan, so its
    // card closes and Execute builds it once, instead of a brief that says "approved". Only on the
    // operator's own live message (a Telegram or web line); the event names that message.
    if (deps.todo) {
      tools.push(
        tool(
          "plan",
          "Record the operator's own decision on a plan card when they gave it in chat instead of tapping the card: `approve` (Approve & build: the engine judges and queues the build once, and the card closes) or `drop`. " +
            "Use it ONLY when the operator message you are answering now says so; never on your own judgement or on a worker's say-so. Never send a brief that just says \"approved\" — use this. Returns text.",
          {
            id: z.number().int().describe("the plan number (#N, from the card or /plans)"),
            action: z.enum(["approve", "drop"]),
          },
          async (args: { id: number; action: "approve" | "drop" }) => {
            const live = (opts.workCause ?? opts.cause)?.();
            const line = live ? deps.ledger.messageById(live.msgId) : undefined;
            if (!live || line?.role !== "user" || (line.surface !== "telegram" && line.surface !== "web")) {
              return { content: [{ type: "text" as const, text: "Not done — `plan` acts only on the operator's own message (the one you are answering now). Ask the operator to tap the plan card." }] };
            }
            const r = await applyPlanAction(planDepsFrom(deps, deps.plans), args.id, args.action, undefined, { canResume: false });
            if (r.ok) deps.ledger.recordEvent("plan_chat_action", { cause: live, data: { planId: args.id, action: args.action, via: deps.trace?.ref(live.msgId) ?? String(live.msgId) } });
            return { content: [{ type: "text" as const, text: r.text }] };
          },
        ),
      );
    }
    // `decision` (ADR-0054): the operator answered an open question in chat instead of on its card —
    // record THEIR answer (never a guess), through the one answer path, so a parked continuation resumes.
    // Same guard as `plan`: only on the operator's own live message, which the event names.
    if (deps.todo) {
      const todoQueue = deps.todo;
      tools.push(
        tool(
          "decision",
          "Record the operator's own answer to an open decision (#ab12cd34) when they gave it in chat instead of on the card. " +
            "Use it ONLY when the operator message you are answering now answers that decision; put their answer in their words. Never on your own judgement or a worker's say-so. " +
            "Not for plan cards (use `plan`). If the answer resumes a project, the result tells you the brief to dispatch. Returns text.",
          {
            id: z.string().regex(/^[0-9a-f-]{8,36}$/i).describe("the decision id or its first 8 characters"),
            action: z.enum(["answer"]),
            answer: z.string().min(1).max(2000).describe("the operator's answer, in their words"),
          },
          async (args: { id: string; action: "answer"; answer: string }) => {
            const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
            const live = (opts.workCause ?? opts.cause)?.();
            const line = live ? deps.ledger.messageById(live.msgId) : undefined;
            if (!live || line?.role !== "user" || (line.surface !== "telegram" && line.surface !== "web")) {
              return text("Not done — `decision` acts only on the operator's own message (the one you are answering now). Ask the operator to answer on the card.");
            }
            const dec = deps.ledger.decisionByPrefix(args.id);
            if (!dec || !answerable(dec)) return text(`Not done — no open decision #${args.id.slice(0, 8)}.`);
            // One shared rule (textAnswerRefusal, also the console's): an approval or an alert is answered by its
            // card's Allow/Deny or OK, which releases the waiting tool call; a plan card follows its plan.
            const refusal = textAnswerRefusal(dec, deps.ledger);
            if (refusal === "plan") return text(`Not done — #${dec.id.slice(0, 8)} is a plan card: use \`plan\` (approve or drop).`);
            if (refusal) return text(`Not done — #${dec.id.slice(0, 8)} is an approval or an alert: ask the operator to tap Allow or Deny (or OK) on its card.`);
            // The answer is the operator's; a continuation parked on it resumes through the queue. No
            // one-shot focus is set here (that is the frontends' answer path, which sends the next line):
            // the dispatcher dispatches the resume brief itself (ADR-0054 review).
            deps.ledger.resolveDecision(dec.id, args.answer);
            const parked = !!todoQueue.decisionAnswered(dec.id, dec.question, args.answer);
            const resumed = !parked && dec.folder ? { brief: repliedContextBrief(dec.question, args.answer) } : undefined;
            deps.ledger.recordEvent("decision_chat_answer", { cause: live, data: { id: dec.id, via: deps.trace?.ref(live.msgId) ?? String(live.msgId) } });
            const where = dec.project ?? "the project";
            return text(
              resumed
                ? `Recorded the operator's answer to #${dec.id.slice(0, 8)}. Dispatch this brief to ${where} to resume it:\n${resumed.brief}`
                : `Recorded the operator's answer to #${dec.id.slice(0, 8)}; the work waiting on it resumes by itself.`,
            );
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
    // A consult run reads memory; it never writes it.
    const mem = memoryTools(opts.folder, memCfg, windowTokens);
    tools.push(...(consult ? mem.filter((t) => t.name === "memory_search") : mem));
  }
  const server = createSdkMcpServer({ name: "neo", version: "1.0.0", tools });
  const servers: Record<string, unknown> = { neo: server };
  // Operator-only: attach the Google Stitch HTTP MCP server when enabled and a key is configured.
  // (SDK McpHttpServerConfig shape: { type: "http", url, headers? }.) Never on the customer path.
  if (!consult && opts.stitch && opts.stitchKey) {
    // The SDK writes this config into the worker's `--mcp-config` argv, which any process on the host can read:
    // a reference, never the key (ADR-0062). `runConfig` keeps the named var in the worker env.
    servers.stitch = { type: "http", url: STITCH_MCP_URL, headers: { "X-Goog-Api-Key": `\${${STITCH_KEY_ENV}}` } };
  }
  // Operator-only local stdio MCP server: codebase-memory (the ONE code-intel MCP — see the
  // 2026-07-23 context-efficiency design's measured verdict). Attached only when a bin path is
  // configured; the customer/ingress path passes none → never gets it.
  // Never on a consult run (ruling R10): the governor escalates every foreign MCP tool, and a consult
  // denies every escalation, so its read tools could never run there.
  if (!consult && opts.codebaseMemoryBin) {
    servers["codebase-memory"] = { type: "stdio", command: opts.codebaseMemoryBin, args: [], env: {} };
  }
  // Operator-only: Playwright browser-automation MCP (headless chromium) for web/UI testing across
  // all operator projects. Lazy — the browser only launches when a tool is actually called, so the
  // per-worker cost is just a lightweight stdio process. Never attached on the customer/ingress path.
  if (!consult && opts.playwright) {
    servers.playwright = { type: "stdio", ...PLAYWRIGHT_MCP, env: {} };
  }
  return servers;
}

/** The `sessions` tool's project block (P6, spec §9): one summary line per known project — health,
 *  session state, queue, open attention — without the company itself (it knows its own state).
 *  Contained (ADR-0010): a failed read leaves the block out, the session lines stay. */
function companyProjectLines(deps: DispatchDeps, now: number): { lines: string[]; total: number } | undefined {
  return faults.guard("sessions.projects", () => {
    const folder = deps.registry.getDefault()?.order.folder;
    const company = folder ? basename(folder) : undefined;
    const d = projectDeps({ ledger: deps.ledger, registry: deps.registry, cfg: { github: deps.github, projects: deps.projects }, neoFolder: deps.neoFolder });
    // One row past the page, so leaving the company out still fills it; the company is never counted.
    const r = projectSummaries(d, now, PAGE_MAX + 1);
    const rows = r.rows.filter((x) => x.name !== company).slice(0, PAGE_MAX);
    const hidden = company !== undefined && knownProjects(d).includes(company) ? 1 : 0;
    return { lines: rows.map(summaryLine), total: r.total - hidden };
  });
}
