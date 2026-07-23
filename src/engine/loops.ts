// The /loop command: a registry of named loops the operator can fire and the scheduler can run.
// Each loop bundles a folder, a worker prompt, a Goal (verifiable command or LLM-judge), a Trigger
// (manual/interval/cron), and Bounds (iterations + budget). /loop lists them; /loop <name> starts
// one now; /loop <name> on|off toggles its schedule. Work runs through runProjectLoop, so it's
// governed and escalation-auto-denied (never pushes/deploys). See docs/loops.md.
import { basename, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { runProjectLoop, type Bounds } from "./project-loop";
import { makeGoalCheck, READONLY_DENY, type Goal, type GoalCheck } from "./goal";
import type { Trigger } from "./trigger";
import type { SchedulableLoop, LoopStateStore } from "./scheduler";
import type { LoopOutcome } from "./loop-runner";
import type { runOrder, RunDeps } from "./session-runner";
import { validateLoopInput, type LoopInput } from "./loop-validate";
import { profileDeps } from "./worker-profile";
import { sessionContext, decideContext, effectiveCacheTtlMs, CACHE_OBS_WINDOW, windowTokensFor } from "./context-policy";
import { memoryDir, memoryScopeEnabled } from "./memory";
import { memoryTools } from "./memory-tool";
import type { NeoConfig } from "../config";
import type { Ledger } from "./ledger";

/** Persistence of operator-authored (custom) loop defs — opaque JSON keyed by name. */
export interface LoopDefStore {
  listLoopDefs(): Array<{ name: string; json: string }>;
  saveLoopDef(name: string, json: string): void;
  deleteLoopDef(name: string): void;
}
/** The ledger satisfies all three halves; commands/UX take the combined store. `listCacheObservations`
 *  feeds the LEARNED-cache-TTL resume gate in loopRunExtras (see context-policy.ts). */
export type LoopStore = LoopDefStore & LoopStateStore & Pick<Ledger, "listCacheObservations">;

export interface LoopDef extends SchedulableLoop {
  name: string; // canonical key, e.g. "docs-sweep"
  usage: string; // "/loop docs-sweep"
  summary: string;
  folder: string; // where the worker opens
  prompt: string; // what the worker attempts each iteration
  goal: Goal; // verifiable command or LLM-judge
  trigger: Trigger; // manual / interval / cron
  bounds: Bounds; // maxIterations + optional budgetUsd
  enabledByDefault?: boolean; // for scheduled loops
  freshSession?: boolean; // never resume across iterations (judge/report loops)
  /** Marks the memory-dream consolidation loop (additive, optional — every other loop leaves this
   *  unset and is untouched). The static `folder`/`prompt` above are placeholders: the fire path
   *  (resolveDreamLoop) rewrites `folder` to `cfg.companyFolder` and interpolates `prompt`'s
   *  lookback-days placeholder from `cfg.memory.dreamLookbackDays`, because the real company path
   *  isn't known until cfg loads (unlike the other built-ins' fixed SELF_REPO/`/home/...` folders).
   *  loopRunExtras also attaches a dream-budgeted `memory` MCP server ONLY when this is set, and
   *  the fire path pre-checks `memoryScopeEnabled` so a company folder that isn't in
   *  `cfg.memory.scopes` no-ops instead of burning a worker run (dreamGateOutcome). */
  dreamMemory?: boolean;
}

export interface LoopDeps {
  reply: (chatId: number, text: string) => void | Promise<void>;
  /** Injectable worker runner (tests); defaults to the real session-runner. */
  run?: typeof runOrder;
  /** Injectable goal (tests); defaults to the loop's Goal. */
  check?: GoalCheck;
  /** Throttle / kill-switch wired in by the daemon (meter.shouldThrottle). */
  shouldStop?: () => boolean;
  /** Loop store (def CRUD + state) for /loop <name> on|off, custom-loop run, and schedule status. */
  store?: LoopStore;
  now?: () => number;
  /** Config for per-path worker profiles (loop/judge via profileDeps) + context-policy resume
   *  gating. Omitted (e.g. in tests that don't care) ⇒ today's behavior: no profile, no gate. */
  cfg?: NeoConfig;
}

// The built-in loops are generic, deployment-neutral examples of the trigger → action → goal model.
// They maintain the engine's OWN repo (the folder the daemon runs in), so they work out of the box
// on a fresh clone; operators author their own project loops from the web console (persisted as data,
// merged by effectiveLoops). All are escalation-auto-denied and never push/deploy.
const SELF_REPO = process.cwd();

const GREEN: LoopDef = {
  name: "green",
  usage: "/loop green",
  summary: "run the test suite + typecheck until green (never pushes)",
  folder: SELF_REPO,
  prompt:
    "Run `bun test` and `bunx tsc --noEmit`. Diagnose and fix any failures you find, then re-run. Do NOT push or deploy.",
  goal: { kind: "command", command: ["sh", "-c", "bun test && bunx tsc --noEmit"], timeoutMs: 300_000 },
  trigger: { kind: "manual" },
  bounds: { maxIterations: 5, budgetUsd: 5 },
};

const ERROR_SWEEP: LoopDef = {
  name: "error-sweep",
  usage: "/loop error-sweep",
  summary: "nightly: scan logs, root-cause + fix unaddressed errors (never pushes)",
  folder: SELF_REPO,
  prompt:
    "Scan `data/unaddressed-errors.log` and the app logs for errors. Root-cause and fix each one, committing per fix. Do NOT push or deploy.",
  goal: { kind: "command", command: ["sh", "-c", "test ! -s data/unaddressed-errors.log"], timeoutMs: 120_000 },
  trigger: { kind: "cron", expr: "30 3 * * *" },
  bounds: { maxIterations: 4, budgetUsd: 10 },
  enabledByDefault: false,
};

const DOCS_SWEEP: LoopDef = {
  name: "docs-sweep",
  usage: "/loop docs-sweep",
  summary: "nightly: sync docs to the day's diff — LLM-judge (never pushes)",
  folder: SELF_REPO,
  prompt: "Review today's `git diff` and update the docs to match it. Commit the doc updates. Do NOT push.",
  goal: {
    kind: "judge",
    criteria:
      "The repo's docs accurately reflect today's code changes: every changed command, config flag, or public behavior is documented, and no doc references a removed feature.",
    timeoutMs: 120_000,
  },
  trigger: { kind: "cron", expr: "45 3 * * *" },
  bounds: { maxIterations: 3, budgetUsd: 10 },
  enabledByDefault: false,
};

// An operator-specific built-in (unlike the deployment-neutral self-repo loops above): a daily
// morning wellbeing check-in for the operator's personal `/home/mywell-being` project (Type-2
// diabetes / sleep). It's DISABLED by default, so it's inert on any host that lacks that folder —
// the operator turns it on with `/loop mywellbeing-checkin on` where the project exists.
//
// Fire-once: the action isn't a "converge to a measurable state" loop — it's a single daily
// touch-point. runLoop checks the goal BEFORE iterating, so a met goal would skip the run; we use a
// goal that NEVER holds (`sh -c false`, exit 1) with maxIterations 1, which fires exactly one
// iteration (docs/loops.md gotcha; same shape as the reminder loop in tests).
//
// Schedule: `0 6 * * *` is 06:00 in the SERVER's LOCAL time (the cron matcher uses local hours —
// see trigger.ts), which lands ~09:00 Asia/Baghdad (UTC+3) when the server clock is UTC. If this
// daemon runs on Baghdad local time instead, change the expr to `0 9 * * *`.
//
// Only the worker's TEXT reaches the operator on a scheduled fire (no chrome), so the prompt makes
// the worker write its questions + proposals out as its text reply, or the check-in would be silent.
const MYWELLBEING_CHECKIN: LoopDef = {
  name: "mywellbeing-checkin",
  usage: "/loop mywellbeing-checkin",
  summary: "daily morning wellbeing check-in — diabetes/sleep questions + concrete next steps (never pushes)",
  folder: "/home/mywell-being",
  prompt:
    "Run today's wellbeing check-in for the operator (Neo), following this project's check-in protocol in CLAUDE.md. " +
    "Read `profile/about-me.md`, the latest entries in `data/glucose-log.md`, and `plan/wellbeing-plan.md` first. " +
    "Then write — as your TEXT reply, since only your text reaches the operator — a short, warm check-in with: " +
    "(a) the right small set of questions for today, prioritizing the missing high-value data (this morning's " +
    "fasting glucose, what time he slept, a recent HbA1c if he has one, meds taken, and weight on the weekly " +
    "weigh-in day); and (b) one or two concrete, Iraqi-food-realistic, no-hunger, prayer-anchored next steps. " +
    "Keep it to a few lines — a focused touch-point, not a survey. Do NOT push, deploy, or invent any readings.",
  goal: { kind: "command", command: ["sh", "-c", "false"] }, // never met → fire-once with maxIterations 1
  trigger: { kind: "cron", expr: "0 6 * * *" }, // 06:00 server-local ≈ 09:00 Asia/Baghdad under a UTC clock
  bounds: { maxIterations: 1, budgetUsd: 2 },
  enabledByDefault: false,
};

// Placeholder in MEMORY_DREAM.prompt, interpolated with cfg.memory.dreamLookbackDays at fire time
// (resolveDreamLoop) — the static def is built before cfg loads, so the real lookback window
// isn't known until then (same reason `folder` below is a sentinel — see resolveDreamLoop).
const DREAM_LOOKBACK_PLACEHOLDER = "{{DREAM_LOOKBACK_DAYS}}";

// Nightly memory consolidation ("dreaming"): reviews the company workspace's recent daily-log
// entries plus MEMORY.md/USER.md and proposes consolidations via the `memory` tool, running in
// DREAM MODE — engine-enforced mutation/add/net-chars budgets (cfg.memory.dreamMax*) attached
// ONLY to this loop's run (loopRunExtras + dreamMcpServers), never to any other worker.
//
// Folder: `folder` below is a SENTINEL, not a real path — the company workspace's actual path
// (cfg.companyFolder) isn't known until cfg loads, so resolveDreamLoop rewrites it at fire time
// (mirrors how `prompt`'s lookback-days placeholder is resolved). The daemon's scheduler tick
// resolves every loop's folder (via this exported resolveDreamLoop) BEFORE checking
// scheduler.ts's folderBusy, so the busy-guard sees the REAL company folder here, not the
// sentinel — and folderBusy is company-folder aware (only a RUNNING company session counts as
// busy; the always-registered IDLE default project never starves this loop). See scheduler.ts's
// folderBusy for the full reasoning.
//
// Fire-once, same "goal never met" shape as mywellbeing-checkin (docs/loops.md gotcha): runLoop
// checks the goal BEFORE each iteration, so a goal that can be met on the FIRST check (e.g. exit 0
// with zero iterations run) would skip the worker run entirely — the opposite of what this loop is
// for (the run itself, and its "zero changes is success" verdict, IS the point). `sh -c false`
// (exit 1, never met) with maxIterations 1 fires exactly one iteration, same as mywellbeing.
const MEMORY_DREAM: LoopDef = {
  name: "memory-dream",
  usage: "/loop memory-dream",
  summary: "nightly: consolidate memory/log/ + MEMORY.md/USER.md via dream-budgeted memory writes (never pushes)",
  folder: "company", // sentinel — see the comment above; resolveDreamLoop rewrites this at fire time
  prompt:
    `Review the last ${DREAM_LOOKBACK_PLACEHOLDER} days of \`memory/log/\` entries, plus MEMORY.md and USER.md, ` +
    "in this company workspace. Propose consolidations via the `memory` tool, in priority order: prefer " +
    "`replace` over `remove` over `add`. Supersede facts that have gone stale with an updated `replace`; " +
    "`remove` entries that no longer apply; only `add` a genuinely new, durable fact. If two entries " +
    "contradict each other and you can't tell which is current, do not guess — `add` a `CONFLICT: <summary>` " +
    "entry describing the contradiction for a human to resolve later. Every `memory` call is budget-enforced " +
    "by the engine (mutation/add/net-char caps) — a rejection just means this run's budget is spent, not an " +
    "error to retry. Making ZERO changes is a fully successful run when nothing needs consolidating — do not " +
    "force a change just to have something to show.",
  goal: { kind: "command", command: ["sh", "-c", "false"] }, // never met → fire-once with maxIterations 1
  trigger: { kind: "cron", expr: "0 3 * * *" },
  bounds: { maxIterations: 1, budgetUsd: 3 },
  enabledByDefault: false,
  freshSession: true,
  dreamMemory: true,
};

export const LOOPS: LoopDef[] = [GREEN, ERROR_SWEEP, DOCS_SWEEP, MYWELLBEING_CHECKIN, MEMORY_DREAM];

export function isBuiltin(name: string): boolean {
  return LOOPS.some((l) => l.name === name);
}

function isLoopDef(x: unknown): x is LoopDef {
  const d = x as Record<string, unknown> | null;
  return !!d && typeof d.name === "string" && typeof d.folder === "string" && !!d.goal && !!d.trigger && !!d.bounds;
}

/** Built-in loops (code) ∪ custom loops (store). Built-ins win on a name clash; bad rows are skipped. */
export function effectiveLoops(store?: LoopDefStore): LoopDef[] {
  const rows = typeof store?.listLoopDefs === "function" ? store.listLoopDefs() : [];
  const builtinNames = new Set(LOOPS.map((l) => l.name));
  const custom: LoopDef[] = [];
  for (const row of rows) {
    if (builtinNames.has(row.name)) continue;
    try {
      const d = JSON.parse(row.json);
      if (isLoopDef(d)) custom.push(d);
    } catch {
      // skip a corrupt/hand-edited row rather than crash a scheduler tick
    }
  }
  return [...LOOPS, ...custom];
}

export function matchLoop(args: string, store?: LoopDefStore): LoopDef | undefined {
  const key = args.trim().toLowerCase().replace(/\s+/g, "-");
  return effectiveLoops(store).find((l) => l.name === key);
}

export interface LoopInfo {
  name: string;
  usage: string;
  summary: string;
  scheduled: boolean;
  custom: boolean;
  triggerDesc: string;
  enabled?: boolean;
}

function triggerDesc(t: Trigger): string {
  return t.kind === "manual" ? "manual" : t.kind === "cron" ? `cron ${t.expr}` : `every ${Math.round(t.everyMs / 60_000)}m`;
}

/** The available loops as render-friendly rows. Pass the store to merge custom loops + show on/off. */
export function listLoops(store?: LoopStore): LoopInfo[] {
  return effectiveLoops(store).map((l) => ({
    name: l.name,
    usage: l.usage,
    summary: l.summary,
    scheduled: l.trigger.kind !== "manual",
    custom: !isBuiltin(l.name),
    triggerDesc: triggerDesc(l.trigger),
    enabled: store ? (store.isEnabled(l.name) ?? l.enabledByDefault ?? false) : undefined,
  }));
}

type CrudResult = { ok: true; def: LoopDef } | { ok: false; error: string };

export function createLoop(input: LoopInput, store: LoopDefStore, root?: string): CrudResult {
  const res = validateLoopInput(input, { existingNames: effectiveLoops(store).map((l) => l.name), root });
  if ("error" in res) return { ok: false, error: res.error };
  store.saveLoopDef(res.def.name, JSON.stringify(res.def));
  return { ok: true, def: res.def };
}

export function updateLoop(name: string, input: LoopInput, store: LoopDefStore, root?: string): CrudResult {
  if (isBuiltin(name)) return { ok: false, error: "built-in loops can't be edited" };
  if (!effectiveLoops(store).some((l) => l.name === name)) return { ok: false, error: `no custom loop "${name}"` };
  const existingNames = effectiveLoops(store)
    .map((l) => l.name)
    .filter((n) => n !== name);
  const res = validateLoopInput({ ...input, name }, { existingNames, root });
  if ("error" in res) return { ok: false, error: res.error };
  store.saveLoopDef(res.def.name, JSON.stringify(res.def));
  return { ok: true, def: res.def };
}

export function deleteLoop(name: string, store: LoopDefStore): { ok: true } | { ok: false; error: string } {
  if (isBuiltin(name)) return { ok: false, error: "built-in loops can't be deleted" };
  store.deleteLoopDef(name);
  return { ok: true };
}

function schedLabel(l: LoopDef, store?: LoopStore): string {
  if (l.trigger.kind === "manual") return "";
  const cadence = l.trigger.kind === "cron" ? l.trigger.expr : `every ${Math.round(l.trigger.everyMs / 60_000)}m`;
  const on = store?.isEnabled(l.name) ?? l.enabledByDefault ?? false;
  return ` [${cadence}: ${on ? "on" : "off"}]`;
}

function formatLoops(store?: LoopStore): string {
  return ["Available loops:", ...effectiveLoops(store).map((l) => `${l.usage} — ${l.summary}${schedLabel(l, store)}`)].join("\n");
}

/** Rewrites `loop`'s `folder` (sentinel "company" → cfg.companyFolder) and interpolates its
 *  `prompt`'s lookback-days placeholder from cfg — the ONE resolution step every dream-memory
 *  fire path (startLoop, startScheduledLoop) runs before doing anything else with the loop, so
 *  every downstream use (reply text, loopRunExtras, runProjectLoop, loopProjectTag,
 *  dreamGateOutcome) sees the real folder/prompt. A no-op for every other loop (dreamMemory unset)
 *  and for a dream loop fired with no cfg (falls back to the static placeholders — dreamGateOutcome
 *  refuses to run in that case anyway, so the placeholder folder is never actually opened). */
export function resolveDreamLoop(loop: LoopDef, cfg?: NeoConfig): LoopDef {
  if (!loop.dreamMemory) return loop;
  return {
    ...loop,
    folder: cfg ? cfg.companyFolder : loop.folder,
    prompt: cfg ? loop.prompt.replace(DREAM_LOOKBACK_PLACEHOLDER, String(cfg.memory.dreamLookbackDays)) : loop.prompt,
  };
}

/** Deterministic pre-check for a dream-memory loop (already folder-resolved via
 *  resolveDreamLoop): refuses to start a worker at all when there's no cfg, or the resolved
 *  company folder isn't in `cfg.memory.scopes` — the memory system is opt-in (default `scopes: []`
 *  is a total no-op elsewhere in the engine too, see memory.ts), so a dream loop must never spend a
 *  worker run on a folder the operator hasn't opted in. Returns a completed 0-iteration
 *  LoopOutcome when the gate trips, else undefined (proceed normally). A no-op for every other
 *  loop (dreamMemory unset). */
function dreamGateOutcome(loop: LoopDef, cfg?: NeoConfig): LoopOutcome | undefined {
  if (!loop.dreamMemory) return undefined;
  if (cfg && memoryScopeEnabled(cfg.memory, loop.folder, cfg.companyFolder)) return undefined;
  return { met: false, iterations: 0, reason: "stopped", lastDetail: "memory disabled (company not in memory.scopes)", spentUsd: 0 };
}

/** Builds the dream-mode `memory` MCP server for one dream-loop run: dream-budgeted
 *  `memory`/`memory_search` tools (memory-tool.ts) scoped to `folder`, with a diary callback that
 *  appends every mutation ATTEMPT (applied or rejected) to `<folder>/memory/DREAMS.md`, engine-side
 *  and deterministic (plain appendFileSync with a timestamp prefix — no AI in the engine). A fresh
 *  server (and so a fresh, zeroed budget closure) is built per call — callers must build one per
 *  run, never share/reuse across fires. */
function dreamMcpServers(folder: string, cfg: NeoConfig): Record<string, unknown> {
  const dir = memoryDir(folder);
  const diaryPath = join(dir, "DREAMS.md");
  const diary = (line: string): void => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(diaryPath, `[${new Date().toISOString()}] ${line}\n`, "utf-8");
    } catch {
      // best-effort — a diary write failure must never block or fail the dream run
    }
  };
  const windowTokens = windowTokensFor(undefined, cfg.contextPolicy.windowTokensByModel);
  const tools = memoryTools(folder, cfg.memory, windowTokens, {
    dream: {
      maxMutations: cfg.memory.dreamMaxMutations,
      maxAdds: cfg.memory.dreamMaxAdds,
      maxNetChars: cfg.memory.dreamMaxNetChars,
      diary,
    },
  });
  return { memory: createSdkMcpServer({ name: "memory", version: "1.0.0", tools }) };
}

/** cfg-derived extras for a loop run: per-path RunDeps profiles (loop worker + judge), the
 *  freshSession flag, and a context-policy gate on the carried resume id — plus the (possibly
 *  test-injected) GoalCheck, so every run site spreads exactly ONE object into runProjectLoop.
 *  cfg omitted ⇒ today's behavior (no profile, no gate). For the memory-dream loop ONLY
 *  (loop.dreamMemory), also attaches the dream-budgeted `memory` MCP server to runDeps.mcpServers —
 *  every other loop's runDeps is untouched (dreamMcpServers is never called for them). `loop` must
 *  already be folder-resolved (resolveDreamLoop) so the server + diary target the real folder. */
function loopRunExtras(
  loop: LoopDef,
  deps: { run?: typeof runOrder; check?: GoalCheck; cfg?: NeoConfig; store?: LoopStore },
): {
  runDeps?: RunDeps;
  freshSession?: boolean;
  gateResume?: (id: string) => Promise<string | undefined>;
  check: GoalCheck;
} {
  const cfg = deps.cfg;
  const runDeps = cfg ? profileDeps(cfg, "loop") : undefined;
  if (runDeps && cfg && loop.dreamMemory) runDeps.mcpServers = dreamMcpServers(loop.folder, cfg);
  return {
    runDeps,
    freshSession: loop.freshSession,
    gateResume: cfg
      ? async (id: string) => {
          const ctx = await sessionContext(loop.folder, id, { windowTokensByModel: cfg.contextPolicy.windowTokensByModel });
          const obs = deps.store?.listCacheObservations(CACHE_OBS_WINDOW) ?? [];
          const ttlMs = effectiveCacheTtlMs(obs, cfg.contextPolicy);
          return decideContext(ctx, cfg.contextPolicy, ttlMs) === "keep" ? id : undefined;
        }
      : undefined,
    check:
      deps.check ??
      makeGoalCheck(loop.goal, {
        cwd: loop.folder,
        run: deps.run,
        runDeps: cfg ? profileDeps(cfg, "judge", { disallowedTools: READONLY_DENY }) : undefined,
      }),
  };
}

/** Run a loop end to end, streaming progress and a final outcome line to the channel. */
export async function startLoop(loopIn: LoopDef, chatId: number, deps: LoopDeps): Promise<LoopOutcome> {
  const loop = resolveDreamLoop(loopIn, deps.cfg);
  const gated = dreamGateOutcome(loop, deps.cfg);
  if (gated) {
    await deps.reply(chatId, `🔁 ${loop.name}: ⚠️ ${gated.lastDetail}`);
    return gated;
  }
  await deps.reply(chatId, `🔁 ${loop.name}: starting on ${loop.folder}…`);
  const { check, ...extras } = loopRunExtras(loop, deps);
  const out = await runProjectLoop(
    {
      folder: loop.folder,
      prompt: loop.prompt,
      goal: loop.goal,
      bounds: loop.bounds,
      onProgress: (m) => void deps.reply(chatId, m.length > 220 ? `${m.slice(0, 220)}…` : m),
      shouldStop: deps.shouldStop,
      ...extras,
    },
    { run: deps.run, check },
  );
  await deps.reply(
    chatId,
    `🔁 ${loop.name}: ${out.met ? "✅ goal met" : `⚠️ ${out.reason}`} after ${out.iterations} iteration(s) — ${out.lastDetail}`,
  );
  return out;
}

/** Deliver a scheduled loop's worker output to the operator channel, tagged with the loop's project. */
export interface ScheduledLoopDeps {
  /** Operator-channel sink, same shape as dispatch's reply — `(chatId, text, project)`. */
  reply: (chatId: number, text: string, project?: string) => void | Promise<void>;
  /** Where to deliver (the operator's admin chat id). */
  chatId: number;
  /** Injectable worker runner (tests); defaults to the real session-runner. */
  run?: typeof runOrder;
  /** Injectable goal (tests); defaults to the loop's Goal. */
  check?: GoalCheck;
  /** Throttle / kill-switch wired in by the daemon (meter.shouldThrottle). */
  shouldStop?: () => boolean;
  /** Config for per-path worker profiles (loop/judge via profileDeps) + context-policy resume
   *  gating. Omitted (e.g. in tests that don't care) ⇒ today's behavior: no profile, no gate. */
  cfg?: NeoConfig;
  /** Loop store — only `listCacheObservations` is used here, to derive the LEARNED cache TTL for
   *  the resume gate. Omitted ⇒ the gate falls back to cacheTtlFallbackMs (no observations). */
  store?: LoopStore;
}

/** The project tag for a scheduled loop's worker lines — the folder's basename (e.g. /home/acme →
 *  "acme"), matching how dispatch attributes a project (registry uses basename too). */
export function loopProjectTag(loop: LoopDef): string {
  return basename(loop.folder);
}

/**
 * Run a SCHEDULED loop quietly, forwarding ONLY real worker text to the operator's channel tagged
 * with the loop's project — the same #project streaming style as dispatch. Unlike the interactive
 * startLoop, it emits no "starting" / per-iteration / outcome chrome: a loop that produces no worker
 * text sends nothing (silent success), so a reminder loop (e.g. a nightly hearings reminder) is quiet
 * when there's nothing to report. Escalations stay auto-denied (via runProjectLoop). Used by the
 * daemon's loop scheduler so scheduled-loop output reaches Telegram/web, not just daemon stdout.
 */
export async function startScheduledLoop(loopIn: LoopDef, deps: ScheduledLoopDeps): Promise<LoopOutcome> {
  const loop = resolveDreamLoop(loopIn, deps.cfg);
  const project = loopProjectTag(loop);
  const gated = dreamGateOutcome(loop, deps.cfg);
  if (gated) {
    await deps.reply(deps.chatId, gated.lastDetail, project);
    return gated;
  }
  const { check, ...extras } = loopRunExtras(loop, deps);
  return runProjectLoop(
    {
      folder: loop.folder,
      prompt: loop.prompt,
      goal: loop.goal,
      bounds: loop.bounds,
      onMessage: (t) => void deps.reply(deps.chatId, t, project), // worker text only — no engine chrome
      shouldStop: deps.shouldStop,
      ...extras,
    },
    { run: deps.run, check },
  );
}

/** Parse + dispatch a /loop command. Returns true if it was a /loop (handled), else false. */
export function handleLoop(text: string, chatId: number, deps: LoopDeps): boolean {
  const t = text.trim();
  if (t !== "/loop" && !t.startsWith("/loop ")) return false;
  const args = t.slice("/loop".length).trim();
  if (!args) {
    void deps.reply(chatId, formatLoops(deps.store));
    return true;
  }
  // "<name> on|off" — toggle a schedule.
  const toggle = args.match(/^(.*?)\s+(on|off)$/i);
  if (toggle) {
    const loop = matchLoop(toggle[1], deps.store);
    if (!loop) {
      void deps.reply(chatId, `No loop "${toggle[1]}".\n\n${formatLoops(deps.store)}`);
      return true;
    }
    if (!deps.store) {
      void deps.reply(chatId, "Schedule control is unavailable right now.");
      return true;
    }
    const on = toggle[2].toLowerCase() === "on";
    deps.store.setEnabled(loop.name, on);
    void deps.reply(chatId, `🔁 ${loop.name}: schedule ${on ? "on" : "off"}`);
    return true;
  }
  const loop = matchLoop(args, deps.store);
  if (!loop) {
    void deps.reply(chatId, `No loop "${args}".\n\n${formatLoops(deps.store)}`);
    return true;
  }
  void startLoop(loop, chatId, deps); // background; streams via deps.reply
  return true;
}
