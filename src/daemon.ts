// Neo engine — entry point. Loads config, opens the ledger, owns the shared live-session
// registry + budget meter + idle watchdog + admin store, and starts the operator frontends:
// the Telegram bot and the web console (both drive the same source:"neo" SDK pipeline).
import { inboxSecretOf } from "./engine/bearer";
import { createToolNotices, DEFAULT_TOOL_CONTROL_CFG } from "./engine/tool-control";
import { DEFAULT_LANES_CFG } from "./engine/lanes";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DEFAULT_TOOLS_CFG, ledgerUsageSource, openCatalogue, relayKeyNames } from "./engine/tools-catalogue";
import { fsSkillSource } from "./engine/tool-skills";
import { loadConfig, loadedDotEnvKeys } from "./config";
import { reportableEngineKeys, type EnvScrubOptions } from "./engine/worker-env";
import { runOrder, setDefaultEnvScrub } from "./engine/session-runner";
import { contextPolicyWarnings, contextWindows, sessionContext } from "./engine/context-policy";
import { DEFAULT_ATTENTION_CFG, runEngineProducer, type EngineProducerDeps } from "./engine/producers/engine";
import { bootFacts, DEFAULT_RESTART_CFG, gatedText, integrationGap, restartDrafts, runningBuild, type IntegrationGap, type RestartDeps } from "./engine/producers/restart";
import { reconcileAll } from "./engine/attention";
import { skillifyTick } from "./engine/producers/skillify";
import { runScan } from "./engine/producers/scan";
import { attentionActions, runDigest, type AttentionAction } from "./engine/attention-actions";
import { createProjectNotes, DEFAULT_NOTES_CFG, noteNowText, notesWiring } from "./engine/project-notes";
import { createConsultRunner } from "./engine/consult";
import { SUB_CHAT } from "./engine/dispatch";
import { DEFAULT_GITHUB_CFG } from "./engine/producers/github";
import { createGitRead } from "./engine/git-read";
import { restartNeededSince } from "./engine/updater";
import type { BootRow } from "./engine/ledger";
import { openLedger, LEDGER_PATH } from "./engine/ledger";
import { openAdminStore } from "./engine/admin";
import { createRegistry } from "./engine/registry";
import { DEFAULT_GOVERNOR_CFG } from "./engine/governor";
import { createMeter, type Meter } from "./engine/budget";
import { createUsageMeter } from "./engine/usage";
import { openTrustStore } from "./engine/trust";
import { openInbox } from "./engine/inbox";
import { createSessionStore } from "./engine/web-session";
import { sweepIdle } from "./engine/idle";
import { createLifecycle, drainAndPersist, restoreSessions, shutdownFailsafeMs, stopFrontends } from "./engine/reload";
import { flushDispatcherInbox, liveCompanyLink, recoverInterruptedDispatches } from "./engine/dispatch-report";
import { nextRetry } from "./engine/todo-retry";
import { setDeployFacts, setNeoNotesDir } from "./engine/context-policy";
import { createApiCooldown, type ApiCooldown } from "./engine/api-retry";
import { createApiWaits } from "./engine/api-wait";
import { createTodoSummarizer } from "./engine/todo-summary";
import { DEFAULT_TODO_SUMMARY_CFG } from "./engine/todo-summary-cfg";
import { pinnedModel } from "./engine/worker-profile";
import { sweepStuck } from "./engine/watchdog";
import { effectiveLoops, startScheduledLoop, resolveDreamLoop, resolveSecretaryLoop, secretaryGateOutcome, type LoopDef } from "./engine/loops";
import { tickScheduler, folderBusy } from "./engine/scheduler";
import { CRON_RESOLUTION_MS, heartbeatMs, nextTickDelayMs, runHeartbeatTick, type HeartbeatLoop } from "./engine/heartbeat";
import { configureFaults, createFaultReporter, faults, installSafetyNet } from "./engine/fault";
import { createHealthMonitor, startHealthTimer } from "./engine/health";
import { startTelegram, sendOperatorLine, projectTagPrefix, createOperatorApi, createPlanPoster, createPlanEditor, attentionKeyboard } from "./frontends/telegram";
import { startWeb, type WebAppDeps } from "./frontends/web";
import { registerDefaultProject } from "./engine/default-project";
import { createOperatorBus } from "./engine/operator-bus";
import { makeLoopReply } from "./engine/loop-mirror";
import { createTodoQueue } from "./engine/todo-queue";
import { createTrace } from "./engine/trace";
import { planDepsFrom } from "./engine/plans";
import { createEngineUpdater, registryBusy } from "./engine/update-engine";

// Resolve the bot's @username (needed by the web Login Widget). An explicit BOT_USERNAME (cfg)
// wins so login never depends on a network call; otherwise ask getMe (read-only, no polling).
async function resolveBotUsername(token: string, configured: string): Promise<string> {
  if (configured) return configured;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = (await r.json()) as { result?: { username?: string } };
    if (j.result?.username) return j.result.username;
  } catch {
    // fall through to the warning below
  }
  console.log("  WARN: bot username unresolved (set BOT_USERNAME in .env) — web login will not work");
  return "";
}

async function main(): Promise<void> {
  // ADR-0010: an error nobody caught is reported and the engine keeps running. Installed first, so
  // nothing that starts below can take the process down; until configureFaults it logs to stderr.
  installSafetyNet(process);
  const cfg = loadConfig();
  for (const w of contextPolicyWarnings(cfg.contextPolicy)) console.log(`  WARN: ${w}`);
  mkdirSync("data", { recursive: true });
  const busyTimeoutMs = cfg.sqliteBusyTimeoutMs;
  const ledger = openLedger(LEDGER_PATH, { routeKeep: cfg.routeKeep, eventsKeep: cfg.eventsKeep, decisionsKeep: cfg.decisionsKeep, toolActionsKeep: cfg.toolActionsKeep, busyTimeoutMs });
  // A dispatch the previous daemon started but never finished (reload or crash) is reported to the
  // company with where it stopped. Runs FIRST — before any frontend or the scheduler can start a
  // new dispatch that would look unfinished. Queued in the dispatcher inbox, NOT delivered now: the
  // company is not woken at boot; the operator's next message to it carries them (ADR-0007).
  const bootAt = Date.now();
  // A todo run among them is kept and re-run by the queue (todo.recover below, ADR-0027): its report
  // says so instead of asking the company to resume it — or the same work would run twice.
  const todoNote = (orderId: string): string | undefined => {
    const t = ledger.todoByOrder(orderId);
    return t?.status === "running" && nextRetry(t.attempts, cfg.todoRetryBackoffMs, bootAt)
      ? `[todo] #${t.id} is kept and re-runs by itself after a backoff (it continues from what is done) — do NOT dispatch it again.`
      : undefined;
  };
  const interrupted = recoverInterruptedDispatches(ledger, { now: bootAt, windowMs: cfg.dispatchRecoverWindowMs, todoNote });
  console.log(`  dispatch  -> ${interrupted} interrupted dispatch(es) queued for the company; no wall-clock limit, digest every ${cfg.dispatchProgressMs / 60_000}m`);
  const admin = openAdminStore("data/admin.db", { busyTimeoutMs });
  const registry = createRegistry();
  // The cause seam (ADR-0015): ONE trace per daemon, shared by Telegram, the web console, the todo
  // queue (through the frontends' dispatch deps), scheduled loops and ingress — so every surface
  // files its lines in the same threads.
  const trace = createTrace({ ledger, registry, companyFolder: cfg.companyFolder, settleDecisions: () => cfg.decisionSettle?.enabled ?? true, settleCfg: () => cfg.decisionSettle });
  // The per-project todo queues (ADR-0008). A todo still "running" was cut short with the dispatch
  // above: keep it as `retry` with its stop point, or fail it once its retries are used up (ADR-0027). Queued todos stay queued; the
  // heartbeat tick releases them in order once the operator channel registers its launcher.
  // Neo's handoff notes live outside every project repo (ADR-0029).
  setNeoNotesDir(cfg.handoffNotesDir);
  // A done todo made from a project note resolves the note (ADR-0043); `notes` is built below and only
  // read when a todo ends.
  const todoSummaryCfg = cfg.todoSummary ?? DEFAULT_TODO_SUMMARY_CFG;
  /** The meter and the API cooldown, set once they exist (they are built after the queue). */
  const summaryGate: { meter?: Meter; cooldown?: ApiCooldown } = {};
  // Held API waits (ADR-0060): one registry for dispatch and the queue, so `todo retry` ends a limit wait now.
  const apiWaits = createApiWaits({ ledger });
  const todo = createTodoQueue({
    ledger, registry, onFailure: () => cfg.todoOnFailure, retryBackoffMs: () => cfg.todoRetryBackoffMs, apiWaits,
    // A short human summary for each new todo (ADR-0059): AI proposes, the engine accepts or keeps its own.
    // Claude only (a Codex own-work setup has no Claude model to ask); it waits while the reserve is held or the
    // API is throttled, and its cost goes on the meter (both built below, read when a todo is made).
    ...(cfg.providers?.ownWork === "codex"
      ? {}
      : { summarize: createTodoSummarizer({
          cfg: todoSummaryCfg, model: pinnedModel(cfg.models, todoSummaryCfg.model) ?? todoSummaryCfg.model,
          mayRun: () => !summaryGate.meter?.shouldThrottleBackground() && !summaryGate.cooldown?.activeAt(Date.now()),
          noteCost: (costUsd) => summaryGate.meter?.note({ costUsd }),
        }) }),
    lanes: () => cfg.lanes ?? DEFAULT_LANES_CFG,
    onDone: (t) => void notes.onTodoEnd(t, Date.now()).catch((e) => faults.report("notes.onTodoEnd", e, { todo: t.id })),
  });
  const cutTodos = todo.recover({ now: bootAt });
  // A todo parked on a decision that already closed is never left waiting (ADR-0054).
  faults.guard("boot.releaseOrphans", () => todo.releaseOrphans());
  const engineProducerDeps: EngineProducerDeps = {
    ledger,
    registry,
    cfg: { ...(cfg.attention ?? DEFAULT_ATTENTION_CFG), approvalRemindMs: (cfg.governor ?? DEFAULT_GOVERNOR_CFG).approvalRemindMs, companyFolder: cfg.companyFolder },
  };
  /** One engine-producer pass: the same context measure the gates and the console use, over the
   *  SDK-reported windows (ADR-0013), read once per tick. */
  const attentionEngineTick = (): void => {
    const windowTokensByModel = contextWindows(ledger, cfg.contextPolicy.windowTokensByModel);
    runEngineProducer({ ...engineProducerDeps, measure: (s) => sessionContext(s.order.folder, s.sdkSessionId, { windowTokensByModel }) }, Date.now());
  };
  // The running build (spec §8.4): recorded once at boot, so the restart producer and /gated can say
  // what is built but not running. The Neo repo is the daemon's working folder.
  const neoFolder = process.cwd();
  const configHashNow = (): string | undefined => {
    try {
      return createHash("sha256").update(readFileSync(join(neoFolder, "config.json"))).digest("hex");
    } catch {
      return undefined; // no config.json: nothing to compare
    }
  };
  // The previous daemon life's start, read before this boot is recorded (ADR-0054, below).
  const prevBoot = faults.guard("boot.previous", () => ledger.lastBoot());
  const thisBoot = faults.guard("boot.record", () => {
    const facts = bootFacts(neoFolder);
    if (!facts) return undefined;
    let sdkVersion: string | undefined;
    try {
      sdkVersion = (JSON.parse(readFileSync(join(neoFolder, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")) as { version?: string }).version;
    } catch {
      // not installed here: the boot record just has no SDK version
    }
    const boot: BootRow = { at: Date.now(), ...facts, ...(sdkVersion ? { sdkVersion } : {}), ...(configHashNow() ? { configHash: configHashNow() } : {}) };
    ledger.recordBoot(boot);
    return boot;
  });
  // Every order ends (ADR-0054): one silent through the whole previous daemon life was cut off. Its own
  // guard: a failure here never costs the boot record.
  if (prevBoot) {
    faults.guard("boot.interruptedOrders", () => {
      const n = ledger.endInterruptedOrders(prevBoot.at);
      if (n) ledger.recordEvent("orders_interrupted", { data: { count: n, since: prevBoot.at } });
    });
  }
  const restartDeps = (): RestartDeps => ({
    folder: neoFolder,
    boot: thisBoot,
    branchPrefixes: (cfg.restart ?? DEFAULT_RESTART_CFG).branchPrefixes,
    // Finished work that does not run is one loud item (ADR-0054).
    integrationBranch: (cfg.restart ?? DEFAULT_RESTART_CFG).integrationBranch,
    maxUndeployedDays: (cfg.restart ?? DEFAULT_RESTART_CFG).maxUndeployedDays,
    updates: thisBoot ? restartNeededSince(ledger, thisBoot.at) : [],
    configHash: configHashNow(),
  });
  const gated = (): string => gatedText(restartDeps());
  // The deploy gap for /list and the console header (ADR-0054). It reads git, and the console polls
  // every 15 s, so one read serves a minute.
  let gapMemo: { at: number; gap: IntegrationGap | undefined } | undefined;
  const deployGap = (): IntegrationGap | undefined => {
    const now = Date.now();
    if (!gapMemo || now - gapMemo.at > 60_000) {
      const g = faults.guard("restart.integrationGap", () => integrationGap(restartDeps()));
      gapMemo = { at: now, gap: g && g !== "error" ? g : undefined };
    }
    return gapMemo.gap;
  };
  // The build label under the console logo (ADR-0056): this boot's commit and the package version read
  // now, at the same moment, so it names what runs even after a later checkout or pull.
  const build = faults.guard("boot.build", () => {
    let pkgVersion: string | undefined;
    try {
      pkgVersion = (JSON.parse(readFileSync(join(neoFolder, "package.json"), "utf8")) as { version?: string }).version;
    } catch {
      // no readable package.json: the label shows the commit only
    }
    return runningBuild(thisBoot, pkgVersion);
  });
  // A handoff of the Neo repo says which finished work does not run (ADR-0054).
  setDeployFacts({ neoFolder, gap: deployGap });
  // The daily attention digest (AC5.5): a high item → the Decisions group, else the operator's DM.
  const sendDigest = async (text: string, priority: "result" | "progress", buttons: Array<{ id: number; actions: AttentionAction[] }>): Promise<{ chatId: number; messageId: number } | void> => {
    const target = priority === "result" ? (cfg.decisionsChatId ?? admin.adminId()) : admin.adminId();
    if (!operatorApi || target === undefined) return;
    const hours = (cfg.attention ?? DEFAULT_ATTENTION_CFG).snoozeHours;
    const m = await operatorApi.sendMessage(target, text, buttons.length ? { reply_markup: attentionKeyboard(buttons, hours) } : {});
    return { chatId: target, messageId: m.message_id };
  };
  // The tools catalogue (ADR-0044): its cards and the API relay behind `tool_api`. A load error is
  // recorded and the daemon goes on without the relay — it never crashes on a bad card.
  const relayKeys = new Set<string>();
  const toolsCfg = cfg.tools ?? DEFAULT_TOOLS_CFG;
  const toolsDir = isAbsolute(toolsCfg.catalogueDir) ? toolsCfg.catalogueDir : join(neoFolder, toolsCfg.catalogueDir);
  // Every card file's relay key stays in the engine whatever its status — also a card that fails to
  // load, so a broken card never leaks its key to a worker (ADR-0050 §7).
  faults.guard("tools.relayKeys", () => { for (const k of relayKeyNames(toolsDir)) relayKeys.add(k); }, {});
  const tools = faults.guard("tools.catalogue", () => {
    const catalogue = openCatalogue({
      dir: toolsDir,
      cfg: toolsCfg, skills: fsSkillSource(), ledger,
      // Ranking learns from what worked (ADR-0044 Phase 3): done orders that used a card, last 30 days.
      usage: (cards) => ledgerUsageSource({ ledger, cards, cfg: toolsCfg }),
    });
    const { cards, errors } = catalogue;
    for (const c of cards) if (c.relay?.envKey) relayKeys.add(c.relay.envKey);
    if (errors.length) {
      ledger.recordEvent("tools_catalogue_errors", { data: { count: errors.length, first: errors.slice(0, 5) } });
      console.error(`[tools] ${errors.length} card error(s); relay off: ${errors[0]}`);
      return undefined;
    }
    return catalogue;
  }, {});
  // A task the operator keeps giving a project, with no tool that fits, becomes one attention item, once a
  // day (ADR-0044 skillify). No catalogue (a card error): no suggestions.
  const skillify = tools
    ? skillifyTick({ ledger, catalogue: tools, cfg: toolsCfg, keepResolvedMs: (cfg.attention ?? DEFAULT_ATTENTION_CFG).keepResolvedDays * 86_400_000 })
    : undefined;
  // Scrub the worker env (ADR-0050 §7): relay keys never reach a worker; the engine's own file keys
  // are listed by name in `report` mode (the default) and removed only in `strip` mode.
  {
    const wcfg = (cfg.tools ?? DEFAULT_TOOLS_CFG).workerEnv;
    const scrub: EnvScrubOptions = { engineKeys: new Set(loadedDotEnvKeys()), relayKeys, inherit: new Set(wcfg.inherit), mode: wcfg.engineSecrets };
    setDefaultEnvScrub(scrub);
    const names = scrub.mode === "report" ? reportableEngineKeys(scrub) : [];
    if (names.length) ledger.recordEvent("worker_env_report", { data: { names } });
  }
  // The repo scan (spec §7): git + GitHub for every tracked repo, every github.scanEveryMs, one at a
  // time, in the background — a tick only starts it (single-flight).
  let scanning = false;
  let lastScanAt = 0;
  const attentionScanTick = (): void => {
    const gh = cfg.github ?? DEFAULT_GITHUB_CFG;
    if (scanning || Date.now() - lastScanAt < gh.scanEveryMs) return;
    scanning = true;
    lastScanAt = Date.now();
    const scan = runScan({
      ledger, registry, read: createGitRead({ timeoutMs: gh.callTimeoutMs }), workRoot: cfg.workRoot, neoFolder,
      attention: cfg.attention ?? DEFAULT_ATTENTION_CFG, projects: cfg.projects ?? {}, now: () => Date.now(),
      probeTimeoutMs: gh.callTimeoutMs,
    }).finally(() => void (scanning = false));
    faults.contain("attention.scan", scan);
  };
  console.log(`  boot      -> ${thisBoot ? `${thisBoot.headSha.slice(0, 7)} on ${thisBoot.branch}` : "not recorded (git unreadable)"} (/gated)`);
  console.log(`  updates   -> ${cfg.updates.enabled ? `every ${cfg.updates.everyMs / 3_600_000}h` : "OFF"} · hold breaking: ${cfg.updates.holdBreaking ? "on" : "off"} (/updates)`);
  console.log(`  todo      -> ${cutTodos} cut-short todo(s) kept to retry (or failed) with their stop point; on failure: ${cfg.todoOnFailure}`);
  // The operator-channel broadcast bus: Telegram + the web console each register a sink, so one
  // operator conversation mirrors across both surfaces (engine/operator-bus.ts).
  const bus = createOperatorBus();
  // Per-project trust. `knownFolders` (every folder the ledger has an order for) is read once, by
  // the trust schema migration, so the new-projects default never trusts an existing project.
  const trust = openTrustStore("data/trust.db", {
    trustNewProjects: cfg.trustNewProjects,
    knownFolders: () => ledger.folders(),
    busyTimeoutMs,
  });
  const inbox = openInbox("data/inbox.db", { busyTimeoutMs }); // customer messages — plain data, shown in the web
  const meter = createMeter({
    windowBudgetUsd: cfg.budgetWindowUsd,
    reservePct: cfg.subscriptionInteractiveReservePct,
    windowMs: cfg.budgetWindowMs,
  });
  summaryGate.meter = meter;
  // Project notes (ADR-0043): one project tells another. A request or a high finding is told to the
  // operator at once (through the flood gate, like the digest); the rest wait for the digest.
  // Questions (ADR-0050): a read-only consult run answers them; notes from main and late answers reach
  // a worker of the folder at its next step (notesWiring: steered into a live turn, never into an idle
  // session — the pipeline and dispatch prepend them to its next follow-up or resume).
  const ownWork = cfg.providers?.ownWork;
  const notes = createProjectNotes({
    ledger,
    cfg: cfg.notes ?? DEFAULT_NOTES_CFG,
    workRoot: cfg.workRoot,
    companyFolder: cfg.companyFolder,
    trace,
    notifyNow: (row) => {
      faults.contain("notes.notifyNow", () => void sendDigest(noteNowText(row), "result", [{ id: row.id, actions: attentionActions(row) }]).catch((e) => faults.report("notes.notifyNow", e, { id: row.id })));
    },
    consult: createConsultRunner({ runOrder, cfg, catalogue: tools, ledger, meter }),
    catalogue: tools,
    meter,
    ...notesWiring({
      registry,
      notes: () => notes,
      worker: ownWork,
      lastSessionFor: (folder) => ledger.lastSessionRow(folder, SUB_CHAT),
      occupancyPct: (folder, sid) => {
        const sig = sessionContext(folder, sid, { windowTokensByModel: contextWindows(ledger, cfg.contextPolicy.windowTokensByModel) });
        return sig.turns > 0 ? Math.round(sig.occupancy * 100) : undefined; // nothing measured → never forked
      },
    }),
  });
  // Questions a reload cut off get their "no answer: reload" now; held answers past the hold expire.
  faults.guard("notes.sweepQuestions", () => notes.sweepQuestions(Date.now()));
  // Measured subscription usage from Claude Code's own transcripts (for /usage).
  const usage = createUsageMeter({
    projectsDir: join(homedir(), ".claude", "projects"),
    claudeJsonPath: join(homedir(), ".claude.json"),
  });

  // Graceful reload: SIGTERM (supervisor) or /reload (operator) → stop accepting new work,
  // ask running workers to wrap up (commit green work + WIP note), wait a bounded drain window,
  // persist every open session's resume id, then exit 0 so the supervisor restarts us.
  const lifecycle = createLifecycle();
  // One shared API-throttle gate for the whole engine: any worker that gets rate-limited/overloaded
  // arms it, and NEW background work (dispatches, loop fires) waits it out instead of earning
  // another 429. The operator's own interactive messages are never held — that's the headroom.
  const cooldown = createApiCooldown({ cooldownMs: cfg.apiCooldownMs });
  summaryGate.cooldown = cooldown;
  // Frontend stop hooks, run FIRST on shutdown. Telegram long polling only confirms an update on
  // the *next* getUpdates (grammy does it in bot.stop()), so exiting straight after the /reload
  // handler left that update unconfirmed — Telegram redelivered it on boot and the daemon reloaded
  // again, forever. Stopping the poller up front also means the offset is already committed if
  // systemd SIGKILLs us mid-drain, and messages sent during the drain simply wait for the restart.
  const stopHooks: Array<() => Promise<unknown>> = [];
  let drainStarted = false;
  const shutdown = (why: string): void => {
    if (drainStarted) return;
    drainStarted = true;
    lifecycle.beginDrain(); // refuse new orders/dispatches immediately, before we stop polling
    // Own our shutdown deadline instead of leaning on a systemd stop timeout: force-exit after the
    // config-derived failsafe if any bounded phase overruns. Lets the unit use TimeoutStopSec=infinity
    // (defer to the engine) so systemd never SIGKILLs mid-drain — the cause of leaked workers.
    setTimeout(() => process.exit(1), shutdownFailsafeMs(cfg.drainWindowMs)).unref();
    console.log(`[reload] ${why}: draining running sessions (≤${cfg.drainWindowMs / 1000}s), saving open sessions…`);
    void stopFrontends(stopHooks)
      .then(() => drainAndPersist({ registry, ledger, lifecycle, drainMs: cfg.drainWindowMs, memory: cfg.memory, companyFolder: cfg.companyFolder }))
      .then((r) => console.log(`[reload] drained ${r.drained.length} · interrupted ${r.interrupted.length} · persisted ${r.persisted} — exiting for restart`))
      .catch((e) => console.log(`[reload] drain error: ${e instanceof Error ? e.message : e}`))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  const requestReload = (): void => shutdown("/reload");

  // Post an ALERT-priority engine line (watchdog stalls, loop-failure) straight to the operator over
  // the raw Bot API — these fire from the daemon tick, outside the pipeline/sink. Routes to the
  // unmuted Decisions chat when configured (so a stall/crash is never lost in the muted DM), else
  // the admin DM. A dropped line never throws (best-effort, must not crash the daemon).
  // Every engine-side Bot API call goes through the same flood gate as the bot (installFloodGate).
  const operatorApi = cfg.telegramToken ? createOperatorApi(cfg.telegramToken) : undefined;
  const toolNotices = createToolNotices();
  const postToolNotices = async (): Promise<void> => {
    const target = admin.adminId();
    if (!operatorApi || target === undefined) return;
    for (const n of toolNotices.due(registry, Date.now(), (cfg.toolControl ?? DEFAULT_TOOL_CONTROL_CFG).noticeAfterMs)) {
      const mins = Math.round((Date.now() - n.call.since) / 60_000);
      const buttons = [{ text: "⏹ Stop", callback_data: `tc:s:${n.key}` }, ...(n.provider === "claude" ? [{ text: "⏩ Background", callback_data: `tc:b:${n.key}` }] : [])];
      await operatorApi
        .sendMessage(target, `⏵ ${n.name} has run ${n.call.tool} for ${mins}m: ${n.call.summary}\nStop ends only this command (the session goes on); Background keeps it running with a log.`, { reply_markup: { inline_keyboard: [buttons] } })
        .catch((e: unknown) => faults.report("toolNotices.send", e, { session: n.sessionId }));
    }
  };
  const alertOperator = (text: string): void => {
    const target = cfg.decisionsChatId ?? admin.adminId();
    if (!operatorApi || target === undefined) return;
    // A failed alert is logged (the API logs a refused call; this logs a network error) — never a
    // fault of its own, because the fault reporter alerts through here.
    operatorApi.sendMessage(target, text).catch((e) => console.error(`[alert] not delivered: ${e instanceof Error ? e.message : String(e)}`));
  };
  // The one plan poster (ADR-0019): every plan a run writes — from Telegram, the web console, a
  // dispatch or a loop — reaches the operator as the same card, in the Decisions chat (else the DM).
  const postPlan = operatorApi ? createPlanPoster(operatorApi, () => cfg.decisionsChatId ?? admin.adminId()) : undefined;
  // ...and the one editor that redraws a card when its plan changes state (ADR-0036).
  const editPlan = operatorApi ? createPlanEditor(operatorApi) : undefined;

  // The engine-wide fault reporter (ADR-0010): log with the stack, an `engine_fault` event, a
  // deduplicated + capped operator alert, and a note queued for the company to investigate.
  configureFaults(
    createFaultReporter(
      {
        log: (line) => console.error(line),
        record: (data) => ledger.recordEvent("engine_fault", { folder: typeof data.folder === "string" ? data.folder : undefined, orderId: typeof data.orderId === "string" ? data.orderId : undefined, data }),
        alert: alertOperator,
        toCompany: (text) => ledger.queueDispatcherReport("neo-engine", text),
      },
      cfg.faults,
    ),
  );

  // The toolchain updater (ADR-0009): a deterministic engine job, not a loop. It never restarts the
  // daemon — an SDK bump lands on master behind green tests and waits for the operator's restart.
  // Plugin/MCP changes wait until no session is running (they replace files a session may read).
  const updater = createEngineUpdater({
    cfg: () => cfg,
    ledger,
    busy: () => registryBusy(registry),
    report: (text) => {
      console.log(`[updates] ${text}`);
      alertOperator(text); // job outcome → the Decisions channel (or the DM if unset)
    },
    repo: process.cwd(),
  });
  const runScheduledUpdate = (): void => {
    if (!updater.due(Date.now())) return;
    faults.contain("updates.scheduled", () => updater.run({ trigger: "schedule" }).catch((e) => {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`[updates] scheduled run failed: ${msg}`);
      alertOperator(`⚠️ toolchain update run failed: ${e instanceof Error ? e.message : msg}`);
    }));
  };

  console.log("Neo engine");
  console.log(`  providers -> own:${cfg.providers.ownWork}  customer:${cfg.providers.customerWork}`);
  console.log("  usage     -> measured from ~/.claude transcripts (/usage); throttling opt-in via caps later");
  console.log(`  ledger    -> ${LEDGER_PATH} (${ledger.listRecent().length} prior orders)`);
  console.log(`  admin     -> ${admin.adminId() ?? "unclaimed (first Telegram message becomes admin)"}`);

  // Loop scheduler — fire due cron/interval loops through the governed runProjectLoop. AI-free:
  // it only evaluates triggers + guards (busy folder / budget throttle) and starts the worker.
  // Scheduled-loop worker output streams to the operator's channel tagged with the loop's project
  // (same #project style as dispatch); if there's no admin/token yet, it falls back to daemon stdout.
  // Loops that emit no worker text send nothing (silent success) — see startScheduledLoop.
  // Scheduled-loop output → Telegram (or stdout before an admin claims), AND mirrored to the web
  // console via the bus so a web-only operator also sees loop activity (loop-mirror.ts).
  const loopReply = makeLoopReply({
    toTelegram: operatorApi
      ? (chatId, text, project) => faults.contain("loop.reply", () => sendOperatorLine(operatorApi, chatId, text, project, { toolSteps: cfg.telegramToolSteps }), { project })
      : undefined,
    toStdout: (text, project) => console.log(`[loop] ${projectTagPrefix(project)}${text}`),
    bus,
  });

  // The daemon's single derived heartbeat drives BOTH the idle/stuck sweep and the loop scheduler
  // tick — no fixed "poll every N seconds" knob (heartbeat.ts). It's re-derived every tick (via a
  // self-rescheduling setTimeout, not setInterval) from the loops enabled *right now*, so toggling
  // on a fast interval loop from the web console speeds the tick up with no daemon restart.
  // Resolve a loop's sentinel folder + trigger from cfg BEFORE the scheduler/heartbeat read them —
  // memory-dream's folder AND the secretary loop's folder + cadence (cfg.secretaryCron) come from
  // config, not the static def. No ledger here → NO queue interpolation / reminder stamping (that
  // happens once, at fire time, in the secretary branch of `start` below). A no-op for every other loop.
  const resolveLoop = (l: LoopDef): LoopDef => resolveSecretaryLoop(resolveDreamLoop(l, cfg), cfg);
  const currentHeartbeatLoops = (): HeartbeatLoop[] =>
    effectiveLoops(ledger).map((l) => ({
      enabled: ledger.isEnabled(l.name) ?? l.enabledByDefault ?? false, // same resolution as tickScheduler
      trigger: resolveLoop(l).trigger, // secretaryCron-aware so the derived heartbeat samples the real cadence
    }));
  const tickLoops = (): void => {
    tickScheduler({
      // built-in ∪ custom, re-read each tick (no restart for new loops) — folder-resolved
      // (resolveDreamLoop) BEFORE scheduling so the busy-guard below checks the memory-dream
      // loop's REAL company folder, not its unresolved "company" sentinel (a no-op for every
      // other loop). def.name is untouched by resolution, so lastRun/enabled bookkeeping and
      // the `start` callback both still key off the loop's real identity.
      loops: effectiveLoops(ledger).map(resolveLoop),
      store: ledger, // Ledger implements LoopStateStore
      // Company-folder aware: the always-on default project is registered IDLE forever, so a
      // plain presence check would starve any loop scheduled against the company folder — see
      // scheduler.ts's folderBusy for the full reasoning.
      isFolderBusy: (folder) => folderBusy(registry, folder, cfg.companyFolder),
      // Skip this tick when the budget meter OR a fresh API throttle says stop.
      throttled: () => meter.shouldThrottleBackground() || cooldown.activeAt(Date.now()),
      now: Date.now(),
      // Return the promise (NOT `void ...`) so tickScheduler can catch a rejecting loop run;
      // discarding it here is exactly what let a crashing loop take down the daemon (2026-07-24).
      start: (def) => {
        // The secretary digest: a quiet queue means a quiet secretary (no worker run), and its
        // digest routes to the unmuted Decisions channel (falls back to the DM when unset). The
        // full fire-time resolve reads the queue + stamps a reminder on each open decision — done
        // ONCE here (only when the loop actually fires), never in the folder/trigger pre-resolve.
        if (def.secretary) {
          const gate = secretaryGateOutcome(def, ledger);
          if (gate) return Promise.resolve(gate); // empty queue → silent, no worker, no stamping
          return startScheduledLoop(resolveSecretaryLoop(def, cfg, ledger), {
            chatId: cfg.decisionsChatId ?? admin.adminId() ?? -1, // digest → the Decisions channel
            reply: loopReply,
            shouldStop: () => meter.shouldThrottleBackground(),
            cfg,
            store: ledger,
            trace,
          });
        }
        return startScheduledLoop(def, {
          chatId: admin.adminId() ?? -1, // resolved at fire time — the TOFU admin may claim later
          reply: loopReply,
          shouldStop: () => meter.shouldThrottleBackground(),
          cfg,
          store: ledger, // feeds the LEARNED cache-TTL resume gate (Ledger satisfies LoopStore)
          trace,
          plans: postPlan ? planDepsFrom({ ledger, postPlan, editPlan, trace, todo }, cfg.plans) : undefined,
        });
      },
      // A loop crashing (e.g. its folder was deleted → Bun.spawn ENOENT) must never crash the
      // engine — log it and alert the operator, but keep the daemon and other loops alive.
      onError: (def, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[loop] "${def.name}" failed: ${msg}`);
        alertOperator(`⚠️ loop "${def.name}" failed and was skipped: ${msg}`); // ALERT → Decisions
      },
    });
  };
  const scheduleHeartbeat = (): void => {
    // Align the timer to the NEXT tick boundary, not "now + hb" — the tick body below (sweeps +
    // tickScheduler) takes real time, and re-arming from "after the body ran" would drift the chain
    // by body-duration + timer lag each cycle. A drifted tick can sample the wrong minute and
    // silently skip a `30 3 * * *` cron's one matching minute for the day (heartbeat.ts
    // nextTickDelayMs).
    // Deriving the tick reads the ledger; if that read fails the chain must still re-arm, at cron's
    // own resolution (ADR-0010) — a broken heartbeat would silently stop every sweep and loop.
    const hb = faults.guard("heartbeat.derive", () => heartbeatMs(currentHeartbeatLoops())) ?? CRON_RESOLUTION_MS;
    const delay = nextTickDelayMs(Date.now(), hb);
    setTimeout(() => {
      runHeartbeatTick(
        [
          ["idle", () => sweepIdle(registry, ledger, { idleMs: cfg.idleCloseMs, now: Date.now(), memory: cfg.memory, companyFolder: cfg.companyFolder })],
          // Retry dispatch results a busy moment turned away (company reopening/closing) — into a LIVE
          // company only; an idle one gets them with the operator's next message (ADR-0007).
          ["dispatcherInbox", () => flushDispatcherInbox(ledger, liveCompanyLink(registry, lifecycle), Date.now())],
          // Release todo queues a hold, a resume or the restart left waiting (ADR-0008). Completions
          // release their own project at once; this tick is the backstop.
          ["todo", () => todo.pump()],
          // A tool call running past toolControl.noticeAfterMs gets ONE Telegram notice with Stop /
          // Background buttons (ADR-0058) — the operator never has to /kill a session for one command.
          ["toolNotices", postToolNotices],
          // The daily toolchain check (and the retry of items a busy session deferred).
          ["updates", runScheduledUpdate],
          [
            "watchdog",
            () =>
              sweepStuck(registry, {
                now: Date.now(),
                stuckAfterMs: cfg.stuckAfterMs,
                longTurnAlertMs: cfg.longTurnAlertMs,
                alertRepeatMs: cfg.alertRepeatMs,
                alert: (_s, text) => {
                  console.log(`[watchdog] ${text}`);
                  alertOperator(text); // ALERT → the Decisions channel (or the DM if unset)
                },
                // The evidence goes to the log BEFORE the alert, so a wrong alert (or a missing one) can be
                // diagnosed from the ledger alone — ages, label, turn state, stdin-wait suspicion.
                record: (kind, data) => {
                  console.log(`[watchdog] ${kind} ${JSON.stringify(data)}`);
                  ledger.recordEvent(kind, { folder: typeof data.folder === "string" ? data.folder : undefined, data });
                },
              }),
          ],
          // What the engine itself sees needs the operator (ADR-0018): stuck approvals, paused queues,
          // failed/waiting threads, stale decisions, an impossible ctx%. Ledger + registry only.
          ["attention.engine", attentionEngineTick],
          ["attention.scan", attentionScanTick],
          ["attention.digest", () => runDigest({ ledger, trace, digestAt: (cfg.attention ?? DEFAULT_ATTENTION_CFG).digestAt, maxLines: (cfg.attention ?? DEFAULT_ATTENTION_CFG).listLines, consoleUrl: cfg.publicUrl || undefined, send: sendDigest }, Date.now())],
          // What is built but not running (spec §8.4): git + the boot record + the updater.
          ["notes.prune", () => notes.prune(Date.now())],
          ["notes.sweepQuestions", () => notes.sweepQuestions(Date.now())],
          ["attention.restart", () => reconcileAll(ledger, "restart", restartDrafts(restartDeps()), Date.now(), { keepResolvedMs: (cfg.attention ?? DEFAULT_ATTENTION_CFG).keepResolvedDays * 86_400_000 })],
          ["attention.skillify", () => skillify?.(Date.now())],
          ["scheduler", () => cfg.loopSchedulerEnabled && tickLoops()],
        ],
        scheduleHeartbeat, // re-derive next tick's interval from the loops enabled right now — always re-armed
        faults,
      );
    }, delay);
  };
  scheduleHeartbeat();
  // Same computed value for both lines below — the tick is one shared clock, not two independent
  // ones, and this heartbeat derives from enabled loops' triggers regardless of loopSchedulerEnabled
  // (that flag only gates whether the tick's body actually fires tickScheduler; idle/stuck still
  // ride the same derived clock either way).
  const initialHeartbeatMs = heartbeatMs(currentHeartbeatLoops());
  console.log(
    `  idle      -> close normal projects after ${cfg.idleCloseMs / 3_600_000}h quiet, sweep every derived heartbeat tick (${initialHeartbeatMs / 1000}s now, company exempt)`,
  );
  console.log(
    cfg.loopSchedulerEnabled
      ? `  loops     -> scheduler on, tick derived from enabled triggers — ${initialHeartbeatMs / 1000}s now (${effectiveLoops(ledger).length} loops)`
      : "  loops     -> scheduler OFF (NEO_LOOP_SCHEDULER=0)",
  );

  const gatewaySendUrl = cfg.gatewaySendUrl;
  if (cfg.telegramToken) {
    const bot = startTelegram(cfg, ledger, admin, registry, meter, trust, usage, inbox, gatewaySendUrl, { lifecycle, requestReload, cooldown, apiWaits, todo, updates: updater, gated, deployGap, trace, postPlan, editPlan, neoFolder, notes, tools, toolNotices }, bus);
    // bot.stop() confirms the last handled update's offset with Telegram — without it a /reload
    // update is redelivered after the restart and reloads again (an endless restart loop).
    stopHooks.push(() => bot.stop());
    console.log("  telegram  -> started. /open · /list · /use · /recent · /usage · /kill · /help");

    // Web console shares the same engine + admin; auth is Telegram-login (TOFU admin).
    const sessions = createSessionStore({
      secret: createHash("sha256").update(`${cfg.telegramToken}:web-session`).digest("hex"),
    });
    const botUsername = await resolveBotUsername(cfg.telegramToken, cfg.botUsername);
    const webDeps: WebAppDeps = { engine: { cfg, ledger, registry, meter, trust, lifecycle, cooldown, apiWaits, todo, trace, postPlan, editPlan, notes, tools }, requestReload, updates: updater, gated, deployGap, ...(build ? { build } : {}), usage, botToken: cfg.telegramToken, botUsername, sessions, admin, ingressSecret: cfg.agentIngressSecret, inboxSecret: inboxSecretOf(cfg), inbox, gatewaySendUrl, bus, neoFolder };
    const publicHint = cfg.publicUrl ? ` · ${cfg.publicUrl}` : "";
    const webAt = `http://${cfg.webHost}:${cfg.webPort}`;
    // A failed bind (e.g. the WEB_HOST bridge IP missing until Docker is up) must not take the daemon
    // down: report it, keep Telegram running, and retry until the address exists.
    let webFailed = false;
    const web = startWeb(webDeps, cfg.webPort, cfg.webHost, {
      retryMs: cfg.webBindRetryMs,
      onFail: (e) => {
        if (!webFailed) console.log(`  web       -> ${webAt} NOT bound yet; retrying every ${cfg.webBindRetryMs / 1000}s`);
        webFailed = true;
        faults.report("web.bind", e, { webHost: cfg.webHost, webPort: cfg.webPort });
      },
      onBound: () => console.log(`  web       -> ${webAt} (sign in as @${botUsername})${publicHint}${webFailed ? " — bound after retry" : ""}`),
    });
    stopHooks.push(async () => web.stop());
  } else {
    console.log("  telegram  -> NOT configured (set TELEGRAM_TOKEN in .env). Web console disabled (needs the bot for login).");
  }

  // The always-on default project ("the company"): a pinned, idle fallback for free-text orders
  // with no active project. No SDK turn at startup — the first order starts/resumes its session
  // with the calling channel's reply, so the worker's output goes back to whoever asked.
  registerDefaultProject(registry, ledger, cfg.companyFolder);
  console.log(`  company   -> default project registered at ${cfg.companyFolder} (always-on, idle)`);

  // Re-register the sessions that were open at the last graceful shutdown as idle+resumable
  // entries — a follow-up or dispatch to their folder resumes them (fresh CLAUDE.md injection).
  const restored = restoreSessions(registry, ledger);
  console.log(`  sessions  -> restored ${restored.length} open session(s) from the last shutdown (idle, resumable)`);

  // The self-health check (ADR-0010): event-loop lag, memory, ledger reachability — reported once on
  // a change, never every minute.
  startHealthTimer(
    createHealthMonitor({
      cfg: () => cfg.health,
      rssBytes: () => process.memoryUsage.rss(),
      dbPing: () => ledger.ping(),
      report: (text) => {
        console.error(`[health] ${text}`);
        alertOperator(text);
      },
    }),
    cfg.health.everyMs,
  );
  console.log(`  health    -> ${cfg.health.everyMs > 0 ? `every ${cfg.health.everyMs / 1000}s (lag ${cfg.health.lagWarnMs}ms · rss ${cfg.health.rssWarnMb}MB · ledger)` : "OFF"}; faults -> log + engine_fault + alert + company`);
}

// Startup is the one place an error is an UNRECOVERABLE STATE (ADR-0010): the ledger cannot open or
// the web port cannot bind. Running on half-started would be worse — log it and exit 1 so the
// supervisor restarts us. After startup, every failure is contained and reported instead.
main().catch((e) => {
  console.error(`[startup] Neo could not start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
