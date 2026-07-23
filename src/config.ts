// Configuration: .env (secrets) + config.json (structured settings). Env wins.
// Mirrors operant's precedence (env > config.json > defaults) but trimmed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./types";
import type { ContextPolicyCfg } from "./engine/context-policy";

/** Reasoning-effort levels accepted by the SDK. */
export type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Per-path worker launch profile. Unset fields inherit the CLI/SDK default (today's behavior). */
export interface WorkerProfile {
  model?: string;
  effort?: WorkerEffort;
  skills?: "all" | string[];
  maxTurns?: number;
}

export type WorkerPathName =
  | "company" | "project" | "dispatch" | "loop" | "judge" | "ingress" | "handoff";

export interface NeoConfig {
  telegramToken: string;
  telegramAllowFrom: number[];
  geminiApiKey: string;
  /** The bot's @username (no leading @) — required by the web console's Telegram Login Widget.
   *  From BOT_USERNAME env; when empty the daemon resolves it via getMe at startup. */
  botUsername: string;
  /** Interface the web operator console binds. Default 127.0.0.1 (localhost only — put a reverse
   *  proxy / TLS front door like Traefik in front). Set WEB_HOST to a bridge IP to expose it. */
  webHost: string;
  /** Port the web operator console listens on (WEB_PORT env). Default 3003. */
  webPort: number;
  /** Public HTTPS base URL the console is reached at (e.g. https://neo.example.com), used for the
   *  startup hint only. From PUBLIC_URL env; empty → no public URL is advertised. */
  publicUrl: string;
  /**
   * Provider routing, kept in config so a future Anthropic plan change is a flip,
   * not a code rewrite. Defaults encode the compliance firewall.
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
  /** Path to the gitnexus binary; when set, OPERATOR workers get the gitnexus git/code-intelligence
   *  MCP server (from GITNEXUS_BIN env). Empty → off. The customer/ingress path never gets it. */
  gitnexusBin: string;
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
  /** Default per-dispatch ceiling (ms) when the caller doesn't request one. Default 15 min. */
  dispatchTimeoutMs: number;
  /** Hard cap (ms) on any per-dispatch ceiling a caller may request. Default 2 h. */
  dispatchTimeoutMaxMs: number;
  /** Abort a dispatched sub-run that has produced NO activity for this long (ms). Default 5 min.
   *  A busy worker streaming output stays alive regardless of wall clock (up to the ceiling). */
  dispatchStallMs: number;
  /** Grace window (ms) after a limit fires: the worker is told to commit green work + write a
   *  WIP note before the hard abort. Default 75 s. */
  dispatchGraceMs: number;
  /** Alert when a running session has produced nothing for this long (ms). Default 10 min. */
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
  /** Per-launch-path worker profiles (model/effort/skills/maxTurns). See the context-efficiency
   *  design spec. Per-path objects REPLACE the default for that path when set in config.json. */
  workers: Record<WorkerPathName, WorkerProfile>;
  /** Extra env vars for every spawned worker (e.g. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
   *  MAX_MCP_OUTPUT_TOKENS, CLAUDE_CODE_SUBAGENT_MODEL), merged over process.env. */
  workerEnv: Record<string, string>;
}

const DEFAULTS = {
  providers: { ownWork: "subscription" as Provider, customerWork: "gemini" as Provider },
  subscriptionInteractiveReservePct: 0.2,
  workRoot: "/home",
  companyFolder: join(process.cwd(), "agent"),
  webHost: "127.0.0.1",
  webPort: 3003,
  budgetWindowUsd: 20,
  budgetWindowMs: 5 * 60 * 60 * 1000,
  idleCloseMs: 24 * 60 * 60 * 1000,
  codebaseMemoryIndexTimeoutMs: 5 * 60 * 1000,
  dispatchTimeoutMs: 15 * 60 * 1000,
  dispatchTimeoutMaxMs: 2 * 60 * 60 * 1000,
  dispatchStallMs: 5 * 60 * 1000,
  dispatchGraceMs: 75 * 1000,
  stuckAfterMs: 10 * 60 * 1000,
  longTurnAlertMs: 20 * 60 * 1000,
  alertRepeatMs: 15 * 60 * 1000,
  drainWindowMs: 90 * 1000,
  contextPolicy: {
    handoffPct: 0.65,
    emergencyPct: 0.85,
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
  },
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
  } satisfies Record<WorkerPathName, WorkerProfile>,
  workerEnv: {} as Record<string, string>,
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
    webHost: process.env.WEB_HOST ?? fileCfg.webHost ?? DEFAULTS.webHost,
    webPort: process.env.WEB_PORT ? Number(process.env.WEB_PORT) : (fileCfg.webPort ?? DEFAULTS.webPort),
    publicUrl: process.env.PUBLIC_URL ?? fileCfg.publicUrl ?? "",
    providers: fileCfg.providers ?? DEFAULTS.providers,
    subscriptionInteractiveReservePct:
      fileCfg.subscriptionInteractiveReservePct ?? DEFAULTS.subscriptionInteractiveReservePct,
    workRoot: process.env.WORK_ROOT ?? fileCfg.workRoot ?? DEFAULTS.workRoot,
    companyFolder: process.env.COMPANY_FOLDER ?? fileCfg.companyFolder ?? DEFAULTS.companyFolder,
    budgetWindowUsd: fileCfg.budgetWindowUsd ?? DEFAULTS.budgetWindowUsd,
    budgetWindowMs: fileCfg.budgetWindowMs ?? DEFAULTS.budgetWindowMs,
    agentIngressSecret: process.env.AGENT_INGRESS_SECRET ?? "",
    gatewaySendUrl: process.env.GATEWAY_SEND_URL ?? fileCfg.gatewaySendUrl ?? "",
    idleCloseMs: fileCfg.idleCloseMs ?? DEFAULTS.idleCloseMs,
    stitchApiKey: process.env.STITCH_API_KEY ?? "",
    gitnexusBin: process.env.GITNEXUS_BIN ?? fileCfg.gitnexusBin ?? "",
    codebaseMemoryBin: process.env.CODEBASE_MEMORY_BIN ?? fileCfg.codebaseMemoryBin ?? "",
    codebaseMemoryIndexTimeoutMs: fileCfg.codebaseMemoryIndexTimeoutMs ?? DEFAULTS.codebaseMemoryIndexTimeoutMs,
    meetingLink: process.env.MEETING_LINK ?? fileCfg.meetingLink ?? "",
    businessName: process.env.BUSINESS_NAME ?? fileCfg.businessName ?? "",
    loopSchedulerEnabled:
      process.env.NEO_LOOP_SCHEDULER === "0" ? false : (fileCfg.loopSchedulerEnabled ?? true),
    dispatchTimeoutMs: fileCfg.dispatchTimeoutMs ?? DEFAULTS.dispatchTimeoutMs,
    dispatchTimeoutMaxMs: fileCfg.dispatchTimeoutMaxMs ?? DEFAULTS.dispatchTimeoutMaxMs,
    dispatchStallMs: fileCfg.dispatchStallMs ?? DEFAULTS.dispatchStallMs,
    dispatchGraceMs: fileCfg.dispatchGraceMs ?? DEFAULTS.dispatchGraceMs,
    stuckAfterMs: fileCfg.stuckAfterMs ?? DEFAULTS.stuckAfterMs,
    longTurnAlertMs: fileCfg.longTurnAlertMs ?? DEFAULTS.longTurnAlertMs,
    alertRepeatMs: fileCfg.alertRepeatMs ?? DEFAULTS.alertRepeatMs,
    drainWindowMs: fileCfg.drainWindowMs ?? DEFAULTS.drainWindowMs,
    contextPolicy: { ...DEFAULTS.contextPolicy, ...(fileCfg.contextPolicy ?? {}) },
    workers: { ...DEFAULTS.workers, ...(fileCfg.workers ?? {}) },
    workerEnv: fileCfg.workerEnv ?? DEFAULTS.workerEnv,
  };
}
