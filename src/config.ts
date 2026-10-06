// Configuration: .env (secrets) + config.json (structured settings). Env wins.
// Mirrors operant's precedence (env > config.json > defaults) but trimmed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./types";
import { type ContextPolicyCfg, CACHE_OBS_WINDOW } from "./engine/context-policy";
import { DEFAULT_LIVENESS_THRESHOLDS, type LivenessThresholds } from "./engine/liveness";
import { CLAUDE_TIER_MODELS } from "./engine/model-resolver";
import type { UpdatesCfg } from "./engine/updater";
import type { FaultCfg } from "./engine/fault";
import type { HealthCfg } from "./engine/health";
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from "./engine/sqlite";
import { DEFAULT_GOVERNOR_CFG, type GovernorCfg } from "./engine/governor";

/** What a bad end does to the rest of a project's todo queue (ADR-0008). */
export type TodoFailurePolicy = "continue" | "pause";
export const TODO_FAILURE_POLICIES: readonly TodoFailurePolicy[] = ["continue", "pause"];

/** Reasoning-effort levels accepted by the SDK. */
export type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Per-path worker launch profile. Unset fields inherit the CLI/SDK default (today's behavior).
 *  Fields are applied through the SDK compatibility table; Codex ignores Claude-only controls such
 *  as `skills` and `maxTurns`. */
export interface WorkerProfile {
  model?: string;
  effort?: WorkerEffort;
  skills?: "all" | string[];
  maxTurns?: number;
}

/** Which model workers run. OPERATOR CHOICE, stated once: before this existed no key set a model
 *  anywhere, so every worker silently took whatever the subscription defaulted to — a cost and
 *  capability change with no config edit and no record. See ADR-0005. */
export interface ModelsCfg {
  /** The model id every launch path gets unless its `WorkerProfile` names one. A real id, never a
   *  bare tier alias: an alias means "whatever that family points at now" and moves under us. */
  default: string;
  /** Tier word → pinned model id. Lets a profile or a brief keep writing `opus`, while the engine
   *  still sends an id. Per-tier entries merge over the built-in pins, so overriding one tier
   *  leaves the others alone. */
  aliases: Record<string, string>;
}

/** Memory system config (Phase 2: store/inject/recall). See `src/engine/memory.ts`. */
export interface MemoryCfg {
  /** OPERATOR CHOICE — which folders get the memory snapshot injected / the memory tools
   *  attached: the literal keyword `"company"` (matches `companyFolder`) and/or a project's
   *  absolute folder path. Empty = the feature is entirely off (default; opt-in only). */
  scopes: string[];
  /** RATIO of the session model's window (via `windowTokensFor`) — the memory-snapshot char cap.
   *  Fallback 0.004 (≈800 tokens on a 200k window) — Hermes measured default. */
  snapshotMaxPct: number;
  /** RATIO of the session model's window — the USER.md char cap. Fallback 0.0025 (≈500 tokens on
   *  a 200k window) — Hermes measured default. */
  userMaxPct: number;
  /** OPERATOR CHOICE (dream-loop budget) — max memory-file mutations (add/replace/remove) per
   *  nightly consolidation run. Fallback 3 — Hermes measured default. */
  dreamMaxMutations: number;
  /** OPERATOR CHOICE (dream-loop budget) — max NEW entries (`add`) per nightly consolidation run.
   *  Fallback 1 — Hermes measured default. */
  dreamMaxAdds: number;
  /** OPERATOR CHOICE (dream-loop budget) — max net character growth across memory files per
   *  nightly consolidation run. Fallback 250 — Hermes measured default. */
  dreamMaxNetChars: number;
  /** OPERATOR CHOICE — how many days of daily logs the dream loop reviews per run. Fallback 14 —
   *  Hermes measured default. */
  dreamLookbackDays: number;
}

export type WorkerPathName =
  | "company" | "project" | "dispatch" | "loop" | "judge" | "ingress" | "handoff" | "secretary";

export interface NeoConfig {
  telegramToken: string;
  telegramAllowFrom: number[];
  geminiApiKey: string;
  /** The bot's @username (no leading @) — required by the web console's Telegram Login Widget.
   *  From BOT_USERNAME env; when empty the daemon resolves it via getMe at startup. */
  botUsername: string;
  /** OPERATOR CHOICE — the high-priority "Decisions" Telegram chat/group the operator keeps
   *  UNMUTED. DECISION/ALERT lines (blocking questions, escalations, failures) route here while the
   *  normal DM stays a muted firehose for PROGRESS/DONE. From DECISIONS_CHAT_ID env, then config.json.
   *  Unset → decisions still get tagged, persisted, and reminded, but they post to the admin DM
   *  (today's behavior). See docs/superpowers/specs/2026-09-03-priority-decisions-secretary-design.md. */
  decisionsChatId?: number;
  /** Interface the web operator console binds. Default 127.0.0.1 (localhost only — put a reverse
   *  proxy / TLS front door like Traefik in front). Set WEB_HOST to a bridge IP to expose it. */
  webHost: string;
  /** Port the web operator console listens on (WEB_PORT env). Default 3003. */
  webPort: number;
  /** Public HTTPS base URL the console is reached at (e.g. https://neo.example.com), used for the
   *  startup hint only. From PUBLIC_URL env; empty → no public URL is advertised. */
  publicUrl: string;
  /**
   * Provider routing, kept in config so the operator can choose the worker SDK without
   * a code rewrite. Defaults encode the compliance firewall.
   */
  providers: { ownWork: Provider; customerWork: Provider };
  /** Fraction of the Claude subscription pool reserved for Neo's interactive use. */
  subscriptionInteractiveReservePct: number;
  /** Root directory that holds the operator's project repos — the New-project picker scans it, the
   *  company `dispatch` tool resolves project names under it, and custom loops are fenced to it.
   *  From WORK_ROOT env. Default "/home". */
  workRoot: string;
  /** The always-on "company" / chief-of-staff workspace (its own gitignored folder with a CLAUDE.md).
   *  From COMPANY_FOLDER env. Default "<repo>/agent" (i.e. an `agent/` dir next to the daemon). */
  companyFolder: string;
  /** OPERATOR CHOICE (2026-10-02): a project Neo sees for the first time starts trusted (full
   *  auto-approve), as if the operator had sent `/trust on` for it. Projects seen before the
   *  default existed keep their state, and `/trust off` is remembered — never re-trusted. Customer
   *  work never carries trust regardless. Default true. */
  trustNewProjects: boolean;
  /** Per-window USD budget for background SDK work (the budget guard). */
  budgetWindowUsd: number;
  /** Rolling budget window in ms (default 5h, matching the subscription's usage window). */
  budgetWindowMs: number;
  /** Shared secret for machine-to-machine POST /agent/ingress (from AGENT_INGRESS_SECRET env). */
  agentIngressSecret: string;
  /** Customer-reply gateway /send endpoint — Neo POSTs an approved inbox reply here to email it
   *  (Neo itself holds no email/Cloudflare creds). From GATEWAY_SEND_URL env; empty → sending off. */
  gatewaySendUrl: string;
  /** Idle-close threshold for NORMAL projects in ms (the company is exempt). Default 24h. */
  idleCloseMs: number;
  /** Google Stitch MCP API key (from STITCH_API_KEY env). When set, OPERATOR workers get the
   *  Stitch design-generation MCP server; the customer/ingress path never does (compliance). */
  stitchApiKey: string;
  /** Path to the codebase-memory MCP binary; when set, OPERATOR workers get the codebase-memory
   *  server (from CODEBASE_MEMORY_BIN env). Empty → off. Customer/ingress path never gets it. */
  codebaseMemoryBin: string;
  /** Bounded wait (ms) for an engine-side codebase-memory index_repository before a dispatch
   *  proceeds anyway (best-effort). Default 5 min. */
  codebaseMemoryIndexTimeoutMs: number;
  /** Booking link the customer-reply CTA points at, so customers pick a meeting time themselves
   *  (from MEETING_LINK env). Empty → the reply invites them to propose times instead. */
  meetingLink: string;
  /** Customer-facing business name the email replies sign off as (from BUSINESS_NAME env).
   *  Empty → the reply signs off generically as "the business"; never as "Neo". */
  businessName: string;
  /** When true (default), the daemon runs the loop scheduler. Disable with NEO_LOOP_SCHEDULER=0. */
  loopSchedulerEnabled: boolean;
  /** Abort a dispatched sub-run that has produced NO activity for this long (ms). Default 5 min.
   *  The only automatic abort: a dispatch has no wall-clock limit, so a busy worker streaming
   *  activity runs until it is done, however long that takes (ADR-0007). */
  dispatchStallMs: number;
  /** Grace window (ms) after the stall limit fires: the worker is told to commit green work + write
   *  a WIP note before the hard abort. Default 75 s. */
  dispatchGraceMs: number;
  /** Progress-digest interval (ms) for a running dispatch — one line to the operator and to the live
   *  dispatcher (the company), only when there was activity since the last one. 0 turns digests
   *  off. Default 10 min. */
  dispatchProgressMs: number;
  /** At boot, a dispatch started within this window (ms) that never recorded its end was cut short
   *  by the restart/crash: its end is recorded and the dispatcher gets a report with its stop
   *  point. Default 24 h. */
  dispatchRecoverWindowMs: number;
  /** What a project's todo queue does when a todo ends badly (failed, stall-aborted, killed, cut
   *  short by a reload or restart): `continue` with the next todo and report the failure, or `pause`
   *  the queue until it is resumed (ADR-0008). Default `continue`; any other value fails closed to it. */
  todoOnFailure: TodoFailurePolicy;
  /** Second-tier API-throttle backoff ladder (ms per attempt) — the wait before re-sending a
   *  rate-limited brief when the API gave no real reset time. The number of automatic retries is
   *  DERIVED from this array's length (not a separate knob). Default [30s, 2m, 8m]. */
  apiRetryLadderMs: number[];
  /** Jitter magnitude (0-1) applied to every retry wait so co-throttled workers don't sync up:
   *  ladder waits get ±frac, reset-based waits get +frac (upward only). Default 0.2 (±20%). */
  apiRetryJitterFrac: number;
  /** Engine-wide hold (ms) on NEW background work after a throttle report, so retries + the
   *  scheduler can't amplify a rate-limit storm. Default 60 s. */
  apiCooldownMs: number;
  /** Reply-route retention cap: max persisted message→project routes (oldest pruned). The ledger
   *  is the source of truth; this only bounds ancient rows. Default 20 000. */
  routeKeep: number;
  /** Diagnostic event-log retention cap: max rows kept in the events table (pruned in batches).
   *  Default 50 000. */
  eventsKeep: number;
  /** Pending-decisions retention cap: max RESOLVED (answered/dismissed) decision rows kept (open
   *  rows are never pruned). Pruned in amortised batches. Default 5 000. */
  decisionsKeep: number;
  /** Tool-action retention cap: max rows kept in the tool_actions table (pruned in batches, like
   *  events, but its own table so busy workers can't push events out). Default 100 000. */
  toolActionsKeep: number;
  /** Secretary digest loop cadence (5-field cron, server-local). The loop reviews the open-decisions
   *  queue and sends ONE consolidated digest to the Decisions channel; SILENT when the queue is empty
   *  (no worker run). Opt-in (disabled by default like other loops). Default every 2h, 08:00–22:00.
   *  From SECRETARY_CRON env, then config.json. */
  secretaryCron: string;
  /** A decision older than this many hours is flagged in the digest as STALE (an escalation the
   *  operator keeps being reminded about). Default 24. */
  secretaryStaleHours: number;
  /** Bounded wait (ms) for a codebase-memory list_projects op (the sibling of
   *  codebaseMemoryIndexTimeoutMs). Default 15 s. */
  codebaseMemoryListTimeoutMs: number;
  /** Default page size for the customer inbox list when a caller omits one (the operator-facing
   *  web console list). Default 100. */
  inboxListDefault: number;
  /** Replay window of the web console feed (ADR-0014): how many of the newest feed events the
   *  engine keeps for a console that opens or reconnects, and how many rows the page keeps.
   *  Older events drop out (the ledger and Telegram keep the record). Default 500. */
  webFeedWindow: number;
  /** In-memory reply-route cache bound (oldest evicted first). The ledger is the durable source of
   *  truth behind it, so this only sizes the fast front cache. Default 2000. */
  messageRoutesCacheCap: number;
  /** Send each worker tool step ("🔧 Tool: …", "↳ result", "🔓 auto-approved: …") to Telegram.
   *  Default false: those lines were ~86% of outbound volume and got the bot a ~9h 429 ban
   *  (2026-10-01). The ledger and the web console always get them. */
  telegramToolSteps: boolean;
  /** Longest Telegram 429 `retry_after` (ms) the flood gate waits out and retries; a longer one
   *  holds sends to that chat until it lifts (frontends/telegram-flood.ts). Default 30 s. */
  telegramFloodMaxWaitMs: number;
  /** Thresholds behind the DERIVED session state (working/quiet/idle/awaiting-operator/wedged) the
   *  operator and the company session are shown. See engine/liveness.ts + ADR 0003. Optional:
   *  absent ⇒ DEFAULT_LIVENESS_THRESHOLDS at the point of use, so no caller has to thread it. */
  liveness?: LivenessThresholds;
  /** Governor knobs: out-of-folder writes + approval reminders/timeout (ADR-0012). Optional like
   *  `liveness`: absent ⇒ writes "ask" (fail closed); `loadConfig` always fills the defaults. */
  governor?: GovernorCfg;
  /** Message refs (spec §4.3): `showRefs` "auto" puts ` · m4f2` on acks, a turn's first reply and
   *  result-like lines; "off" hides them. Optional like `governor`; `loadConfig` always fills it. */
  trace?: TraceCfg;
  /** Alert when a running session has produced NO ACTIVITY for this long (ms). Default 10 min. */
  stuckAfterMs: number;
  /** Alert when one activity label has run this long (ms). Default 20 min. */
  longTurnAlertMs: number;
  /** Re-alert about the same session only after this long (ms). Default 15 min. */
  alertRepeatMs: number;
  /** Graceful reload: bounded wait (ms) for running turns to wrap up before the hard interrupt.
   *  Default 90 s. */
  drainWindowMs: number;
  /** Context policy: signals, verdicts, and safe boundaries for session lifecycle management. */
  contextPolicy: ContextPolicyCfg;
  /** Which model workers run: one pinned default plus the tier→id alias map. From NEO_WORKER_MODEL
   *  env (default only), then config.json, then the pins in `CLAUDE_TIER_MODELS`. See ADR-0005. */
  models: ModelsCfg;
  /** Per-launch-path worker profiles (model/effort/skills/maxTurns). See the context-efficiency
   *  design spec. Per-path objects REPLACE the default for that path when set in config.json.
   *  A path that names no `model` takes `models.default`. */
  workers: Record<WorkerPathName, WorkerProfile>;
  /** Extra env vars for every spawned worker, merged over process.env after provider filtering.
   *  Claude Code knobs (e.g. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, MAX_MCP_OUTPUT_TOKENS,
   *  CLAUDE_CODE_SUBAGENT_MODEL) are applied only on the Claude adapter. */
  workerEnv: Record<string, string>;
  /** Memory system (Phase 2): scopes + ratio caps + dream-loop budgets. Default `scopes: []` — a
   *  total no-op until the operator opts a folder in. */
  memory: MemoryCfg;
  /** The toolchain updater (ADR-0009): schedule, per-category auto-apply, breaking-change hold, and
   *  where each managed item comes from. Per-key merge over `DEFAULT_UPDATES`. */
  updates: UpdatesCfg;
  /** Engine faults (ADR-0010): how a caught error is deduplicated, capped and handed to the company. */
  faults: FaultCfg;
  /** The self-health check (ADR-0010): event-loop lag, memory, ledger reachability. */
  health: HealthCfg;
  /** How long a SQLite store waits on a locked database before the write fails (ms). Default 5 s. */
  sqliteBusyTimeoutMs: number;
}

/** Shipped fault policy (ADR-0010): one alert per fault signature per 15 min, at most 6 distinct
 *  fault alerts an hour, and (deduplicated) faults queued for the company to investigate — at most 3
 *  an hour, so a fault the company's own reply re-triggers cannot loop. */
export interface TraceCfg {
  showRefs: "auto" | "off";
}

/** Shipped ref display (spec §4.3): refs on. */
export const DEFAULT_TRACE: TraceCfg = { showRefs: "auto" };

export const DEFAULT_FAULTS: FaultCfg = { dedupeMs: 15 * 60_000, maxAlertsPerHour: 6, companyHandoff: true, maxHandoffsPerHour: 3 };
/** Shipped health thresholds (ADR-0010): sample each minute; 2 s of timer drift or 2 GB resident
 *  memory is degraded. */
export const DEFAULT_HEALTH: HealthCfg = { everyMs: 60_000, lagWarnMs: 2_000, rssWarnMb: 2_048 };

/** The shipped updater policy (ADR-0009). OPERATOR CHOICES: check daily, apply what is safe, HOLD a
 *  release whose notes flag a breaking change until `/updates apply <item>`. The SDK bump only ever
 *  lands on `baseBranch` after tsc + tests are green; nothing restarts the daemon. */
export const DEFAULT_UPDATES: UpdatesCfg = {
  enabled: true,
  everyMs: 24 * 60 * 60 * 1000,
  autoApply: { sdk: true, plugins: true, mcp: true },
  holdBreaking: true,
  // A deferred item (a session was running) is retried this soon once the engine is idle.
  retryDeferredMs: 30 * 60 * 1000,
  baseBranch: "master",
  verifyTimeoutMs: 60_000,
  // The one npm-global MCP server Neo launches (dispatch.ts PLAYWRIGHT_MCP).
  npmGlobals: { "playwright-mcp": "@playwright/mcp" },
  codebaseMemory: { repo: "DeusData/codebase-memory-mcp", asset: "codebase-memory-mcp-linux-amd64.tar.gz" },
};

/** The shipped model pin (ADR-0005). Exported so anything building a `NeoConfig` — `DEFAULTS`
 *  below, and test fixtures — states the pin once instead of copying the ids around. */
export const DEFAULT_MODELS: ModelsCfg = {
  default: CLAUDE_TIER_MODELS.opus,
  aliases: { ...CLAUDE_TIER_MODELS },
};

/** Default web console replay window (ADR-0014). Exported so the console page can default to it. */
export const DEFAULT_WEB_FEED_WINDOW = 500;

const DEFAULTS = {
  providers: { ownWork: "subscription" as Provider, customerWork: "gemini" as Provider },
  subscriptionInteractiveReservePct: 0.2,
  workRoot: "/home",
  companyFolder: join(process.cwd(), "agent"),
  // Operator choice (2026-10-02): new projects start trusted. See NeoConfig.trustNewProjects.
  trustNewProjects: true,
  webHost: "127.0.0.1",
  webPort: 3003,
  budgetWindowUsd: 20,
  budgetWindowMs: 5 * 60 * 60 * 1000,
  idleCloseMs: 24 * 60 * 60 * 1000,
  codebaseMemoryIndexTimeoutMs: 5 * 60 * 1000,
  dispatchStallMs: 5 * 60 * 1000,
  dispatchGraceMs: 75 * 1000,
  dispatchProgressMs: 10 * 60 * 1000,
  dispatchRecoverWindowMs: 24 * 60 * 60 * 1000,
  todoOnFailure: "continue" as TodoFailurePolicy,
  // API-throttle recovery policy (see api-retry.ts). These reproduce the pre-config constants
  // exactly, so behavior is byte-identical until an operator overrides them.
  apiRetryLadderMs: [30_000, 120_000, 480_000],
  apiRetryJitterFrac: 0.2,
  apiCooldownMs: 60_000,
  // Ledger retention caps (see ledger.ts) — operator policy, not a fact; defaults preserve today's.
  routeKeep: 20_000,
  eventsKeep: 50_000,
  decisionsKeep: 5_000,
  toolActionsKeep: 100_000,
  // Secretary digest loop: opt-in (enabledByDefault:false on the LoopDef), so these are only the
  // cadence/staleness knobs. Every 2h during waking hours; a decision older than 24h reads as stale.
  secretaryCron: "0 8-22/2 * * *",
  secretaryStaleHours: 24,
  codebaseMemoryListTimeoutMs: 15_000,
  inboxListDefault: 100,
  webFeedWindow: DEFAULT_WEB_FEED_WINDOW,
  messageRoutesCacheCap: 2_000,
  telegramToolSteps: false,
  telegramFloodMaxWaitMs: 30_000,
  liveness: DEFAULT_LIVENESS_THRESHOLDS,
  // Operator order (2026-10-06): out-of-folder writes are always approved (ADR-0012).
  governor: DEFAULT_GOVERNOR_CFG,
  stuckAfterMs: 10 * 60 * 1000,
  longTurnAlertMs: 20 * 60 * 1000,
  alertRepeatMs: 15 * 60 * 1000,
  drainWindowMs: 90 * 1000,
  contextPolicy: {
    // ADR-0021: from 31,585 Opus turns. Quality is flat to ~65%; cost per turn is linear, and the
    // 19% of turns above 40% read 41% of all cache tokens. SDK auto-compaction fires at ~97%.
    sweetSpotPct: 0.4,
    checkpointPct: 0.6,
    emergencyPct: 0.9,
    handoffNoteMaxChars: 20_000,
    // p75 of measured orientation (model calls before the first edit/commit after a handoff).
    handoffOrientationMaxSteps: 70,
    maxTurns: 200,
    maxAgeMs: 7 * 24 * 3600 * 1000,
    handoffTimeoutMs: 180_000,
    // ratio: occupancy above which a resume idle past the effective cache TTL is stale enough to
    // hand off (see context-policy.ts ContextPolicyCfg.staleResumePct).
    staleResumePct: 0.35,
    // provider-fact fallback: the provider-documented prompt-cache TTL (1h), used only until
    // enough real observations exist to derive a learned TTL (effectiveCacheTtlMs).
    cacheTtlFallbackMs: 3_600_000,
    // operator choice: minimum observations before the learned TTL is trusted over the fallback.
    cacheTtlMinObservations: 5,
    // operator choice: rolling sample size for the learned-cache-TTL window (references the module
    // constant so the default can never drift from the code's own fallback).
    cacheObsWindow: CACHE_OBS_WINDOW,
  },
  // The pinned worker models (ADR-0005). The ids themselves live in model-resolver.ts so the SDK
  // compatibility table and these defaults can never disagree about what a tier currently means.
  models: DEFAULT_MODELS,
  // QUALITY INVARIANT: defaults reproduce today's behavior EXACTLY. The only non-empty entries
  // are the two effort:"low" cases that already live in code (pipeline.ts:250, ingress.ts:68/71),
  // relocated here. Economy overrides (cheaper models on handoff/judge/ingress ONLY) are opt-in
  // via config.json — see docs/CONFIG.md "Economy mode" — never defaults, never code-writing paths.
  workers: {
    company: { effort: "low" },
    project: {},
    dispatch: {},
    loop: {},
    judge: {},
    ingress: { effort: "low" },
    handoff: {},
    // The secretary reviews the queue on the LATEST model (a config.json override recommends the
    // newest model); the empty default keeps today's model until the operator sets one.
    secretary: {},
  } satisfies Record<WorkerPathName, WorkerProfile>,
  workerEnv: {} as Record<string, string>,
  // QUALITY INVARIANT: scopes:[] is the pin — the memory system is a total no-op until an
  // operator opts a folder in via config.json. The other fields are cold-start fallbacks
  // (Hermes measured defaults), documented on MemoryCfg above.
  memory: {
    scopes: [] as string[],
    snapshotMaxPct: 0.004,
    userMaxPct: 0.0025,
    dreamMaxMutations: 3,
    dreamMaxAdds: 1,
    dreamMaxNetChars: 250,
    dreamLookbackDays: 14,
  } satisfies MemoryCfg,
};

/** Minimal `.env` loader (KEY=VALUE lines). Values only fill gaps in process.env. */
function loadDotEnv(dir: string): void {
  const p = join(dir, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Lowercase every key of a record, so a case-insensitive lookup can never miss an operator's entry. */
function lowercaseKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
}

/** The context policy from config.json over the defaults. `handoffPct` is the pre-ADR-0021 name of
 *  `sweetSpotPct`: an operator who set it keeps their line, unless they also set the new name. */
function contextPolicyFrom(file: (Partial<ContextPolicyCfg> & { handoffPct?: number }) | undefined): ContextPolicyCfg {
  const { handoffPct, ...rest } = file ?? {};
  return { ...DEFAULTS.contextPolicy, ...(handoffPct !== undefined ? { sweetSpotPct: handoffPct } : {}), ...rest };
}

export function loadConfig(dir: string = process.cwd()): NeoConfig {
  loadDotEnv(dir);

  let fileCfg: Partial<NeoConfig> = {};
  const cfgPath = join(dir, "config.json");
  if (existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Partial<NeoConfig>;
    } catch {
      fileCfg = {};
    }
  }

  return {
    telegramToken: process.env.TELEGRAM_TOKEN ?? "",
    telegramAllowFrom: fileCfg.telegramAllowFrom ?? [],
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    botUsername: process.env.BOT_USERNAME ?? fileCfg.botUsername ?? "",
    decisionsChatId: process.env.DECISIONS_CHAT_ID ? Number(process.env.DECISIONS_CHAT_ID) : fileCfg.decisionsChatId,
    webHost: process.env.WEB_HOST ?? fileCfg.webHost ?? DEFAULTS.webHost,
    webPort: process.env.WEB_PORT ? Number(process.env.WEB_PORT) : (fileCfg.webPort ?? DEFAULTS.webPort),
    publicUrl: process.env.PUBLIC_URL ?? fileCfg.publicUrl ?? "",
    providers: fileCfg.providers ?? DEFAULTS.providers,
    subscriptionInteractiveReservePct:
      fileCfg.subscriptionInteractiveReservePct ?? DEFAULTS.subscriptionInteractiveReservePct,
    workRoot: process.env.WORK_ROOT ?? fileCfg.workRoot ?? DEFAULTS.workRoot,
    companyFolder: process.env.COMPANY_FOLDER ?? fileCfg.companyFolder ?? DEFAULTS.companyFolder,
    trustNewProjects: fileCfg.trustNewProjects ?? DEFAULTS.trustNewProjects,
    budgetWindowUsd: fileCfg.budgetWindowUsd ?? DEFAULTS.budgetWindowUsd,
    budgetWindowMs: fileCfg.budgetWindowMs ?? DEFAULTS.budgetWindowMs,
    agentIngressSecret: process.env.AGENT_INGRESS_SECRET ?? "",
    gatewaySendUrl: process.env.GATEWAY_SEND_URL ?? fileCfg.gatewaySendUrl ?? "",
    idleCloseMs: fileCfg.idleCloseMs ?? DEFAULTS.idleCloseMs,
    stitchApiKey: process.env.STITCH_API_KEY ?? "",
    codebaseMemoryBin: process.env.CODEBASE_MEMORY_BIN ?? fileCfg.codebaseMemoryBin ?? "",
    codebaseMemoryIndexTimeoutMs: fileCfg.codebaseMemoryIndexTimeoutMs ?? DEFAULTS.codebaseMemoryIndexTimeoutMs,
    meetingLink: process.env.MEETING_LINK ?? fileCfg.meetingLink ?? "",
    businessName: process.env.BUSINESS_NAME ?? fileCfg.businessName ?? "",
    loopSchedulerEnabled:
      process.env.NEO_LOOP_SCHEDULER === "0" ? false : (fileCfg.loopSchedulerEnabled ?? true),
    dispatchStallMs: fileCfg.dispatchStallMs ?? DEFAULTS.dispatchStallMs,
    dispatchGraceMs: fileCfg.dispatchGraceMs ?? DEFAULTS.dispatchGraceMs,
    dispatchProgressMs: fileCfg.dispatchProgressMs ?? DEFAULTS.dispatchProgressMs,
    dispatchRecoverWindowMs: fileCfg.dispatchRecoverWindowMs ?? DEFAULTS.dispatchRecoverWindowMs,
    todoOnFailure: TODO_FAILURE_POLICIES.includes(fileCfg.todoOnFailure as TodoFailurePolicy)
      ? (fileCfg.todoOnFailure as TodoFailurePolicy)
      : DEFAULTS.todoOnFailure,
    apiRetryLadderMs: fileCfg.apiRetryLadderMs ?? DEFAULTS.apiRetryLadderMs,
    apiRetryJitterFrac: fileCfg.apiRetryJitterFrac ?? DEFAULTS.apiRetryJitterFrac,
    apiCooldownMs: fileCfg.apiCooldownMs ?? DEFAULTS.apiCooldownMs,
    routeKeep: fileCfg.routeKeep ?? DEFAULTS.routeKeep,
    eventsKeep: fileCfg.eventsKeep ?? DEFAULTS.eventsKeep,
    decisionsKeep: fileCfg.decisionsKeep ?? DEFAULTS.decisionsKeep,
    toolActionsKeep: fileCfg.toolActionsKeep ?? DEFAULTS.toolActionsKeep,
    secretaryCron: process.env.SECRETARY_CRON ?? fileCfg.secretaryCron ?? DEFAULTS.secretaryCron,
    secretaryStaleHours: fileCfg.secretaryStaleHours ?? DEFAULTS.secretaryStaleHours,
    codebaseMemoryListTimeoutMs: fileCfg.codebaseMemoryListTimeoutMs ?? DEFAULTS.codebaseMemoryListTimeoutMs,
    inboxListDefault: fileCfg.inboxListDefault ?? DEFAULTS.inboxListDefault,
    webFeedWindow: fileCfg.webFeedWindow ?? DEFAULTS.webFeedWindow,
    messageRoutesCacheCap: fileCfg.messageRoutesCacheCap ?? DEFAULTS.messageRoutesCacheCap,
    telegramToolSteps: fileCfg.telegramToolSteps ?? DEFAULTS.telegramToolSteps,
    telegramFloodMaxWaitMs: fileCfg.telegramFloodMaxWaitMs ?? DEFAULTS.telegramFloodMaxWaitMs,
    liveness: { ...DEFAULTS.liveness, ...(fileCfg.liveness ?? {}) },
    governor: { ...DEFAULTS.governor, ...(fileCfg.governor ?? {}) },
    trace: { ...DEFAULT_TRACE, ...(fileCfg.trace ?? {}) },
    stuckAfterMs: fileCfg.stuckAfterMs ?? DEFAULTS.stuckAfterMs,
    longTurnAlertMs: fileCfg.longTurnAlertMs ?? DEFAULTS.longTurnAlertMs,
    alertRepeatMs: fileCfg.alertRepeatMs ?? DEFAULTS.alertRepeatMs,
    drainWindowMs: fileCfg.drainWindowMs ?? DEFAULTS.drainWindowMs,
    contextPolicy: contextPolicyFrom(fileCfg.contextPolicy),
    models: {
      default:
        process.env.NEO_WORKER_MODEL?.trim() || fileCfg.models?.default?.trim() || DEFAULTS.models.default,
      // Per-tier merge, not replace: overriding one tier must not drop the others. Keys are
      // lowercased because lookup is case-insensitive — `"Opus"` in config.json would otherwise
      // parse, typecheck, load, and silently never match.
      aliases: {
        ...DEFAULTS.models.aliases,
        ...lowercaseKeys(fileCfg.models?.aliases ?? {}),
      },
    },
    workers: { ...DEFAULTS.workers, ...(fileCfg.workers ?? {}) },
    workerEnv: fileCfg.workerEnv ?? DEFAULTS.workerEnv,
    memory: { ...DEFAULTS.memory, ...(fileCfg.memory ?? {}) },
    updates: {
      ...DEFAULT_UPDATES,
      ...(fileCfg.updates ?? {}),
      // Nested objects merge per key too: turning one category off must not drop the others.
      autoApply: { ...DEFAULT_UPDATES.autoApply, ...(fileCfg.updates?.autoApply ?? {}) },
      npmGlobals: { ...DEFAULT_UPDATES.npmGlobals, ...(fileCfg.updates?.npmGlobals ?? {}) },
      codebaseMemory: { ...DEFAULT_UPDATES.codebaseMemory, ...(fileCfg.updates?.codebaseMemory ?? {}) },
    },
    faults: { ...DEFAULT_FAULTS, ...(fileCfg.faults ?? {}) },
    health: { ...DEFAULT_HEALTH, ...(fileCfg.health ?? {}) },
    sqliteBusyTimeoutMs: fileCfg.sqliteBusyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  };
}
