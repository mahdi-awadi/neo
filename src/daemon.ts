// Neo engine — entry point. Loads config, opens the ledger, owns the shared live-session
// registry + budget meter + idle watchdog + admin store, and starts the operator frontends:
// the Telegram bot and the web console (both drive the same source:"neo" SDK pipeline).
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { openLedger, LEDGER_PATH } from "./engine/ledger";
import { openAdminStore } from "./engine/admin";
import { createRegistry } from "./engine/registry";
import { createMeter } from "./engine/budget";
import { createUsageMeter } from "./engine/usage";
import { openTrustStore } from "./engine/trust";
import { openInbox } from "./engine/inbox";
import { createSessionStore } from "./engine/web-session";
import { sweepIdle } from "./engine/idle";
import { createLifecycle, drainAndPersist, restoreSessions, shutdownFailsafeMs, stopFrontends } from "./engine/reload";
import { flushDispatcherInbox, liveCompanyLink, recoverInterruptedDispatches } from "./engine/dispatch-report";
import { createApiCooldown } from "./engine/api-retry";
import { sweepStuck } from "./engine/watchdog";
import { effectiveLoops, startScheduledLoop, resolveDreamLoop, resolveSecretaryLoop, secretaryGateOutcome, type LoopDef } from "./engine/loops";
import { tickScheduler, folderBusy } from "./engine/scheduler";
import { heartbeatMs, nextTickDelayMs, type HeartbeatLoop } from "./engine/heartbeat";
import { startTelegram, sendOperatorLine, projectTagPrefix } from "./frontends/telegram";
import { startWeb } from "./frontends/web";
import { registerDefaultProject } from "./engine/default-project";
import { createOperatorBus } from "./engine/operator-bus";
import { makeLoopReply } from "./engine/loop-mirror";
import { createTodoQueue } from "./engine/todo-queue";
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
  const cfg = loadConfig();
  mkdirSync("data", { recursive: true });
  const ledger = openLedger(LEDGER_PATH, { routeKeep: cfg.routeKeep, eventsKeep: cfg.eventsKeep, decisionsKeep: cfg.decisionsKeep });
  // A dispatch the previous daemon started but never finished (reload or crash) is reported to the
  // company with where it stopped. Runs FIRST — before any frontend or the scheduler can start a
  // new dispatch that would look unfinished. Queued in the dispatcher inbox, NOT delivered now: the
  // company is not woken at boot; the operator's next message to it carries them (ADR-0007).
  const interrupted = recoverInterruptedDispatches(ledger, { now: Date.now(), windowMs: cfg.dispatchRecoverWindowMs });
  console.log(`  dispatch  -> ${interrupted} interrupted dispatch(es) queued for the company; no wall-clock limit, digest every ${cfg.dispatchProgressMs / 60_000}m`);
  const admin = openAdminStore("data/admin.db");
  const registry = createRegistry();
  // The per-project todo queues (ADR-0008). A todo still "running" was cut short with the dispatch
  // above: fail it with its stop point (failure policy applies). Queued todos stay queued; the
  // heartbeat tick releases them in order once the operator channel registers its launcher.
  const todo = createTodoQueue({ ledger, registry, onFailure: () => cfg.todoOnFailure });
  const cutTodos = todo.recover({ now: Date.now() });
  console.log(`  updates   -> ${cfg.updates.enabled ? `every ${cfg.updates.everyMs / 3_600_000}h` : "OFF"} · hold breaking: ${cfg.updates.holdBreaking ? "on" : "off"} (/updates)`);
  console.log(`  todo      -> ${cutTodos} cut-short todo(s) failed with their stop point; on failure: ${cfg.todoOnFailure}`);
  // The operator-channel broadcast bus: Telegram + the web console each register a sink, so one
  // operator conversation mirrors across both surfaces (engine/operator-bus.ts).
  const bus = createOperatorBus();
  // Per-project trust. `knownFolders` (every folder the ledger has an order for) is read once, by
  // the trust schema migration, so the new-projects default never trusts an existing project.
  const trust = openTrustStore("data/trust.db", {
    trustNewProjects: cfg.trustNewProjects,
    knownFolders: () => ledger.folders(),
  });
  const inbox = openInbox("data/inbox.db"); // customer messages — plain data, shown in the web
  const meter = createMeter({
    windowBudgetUsd: cfg.budgetWindowUsd,
    reservePct: cfg.subscriptionInteractiveReservePct,
    windowMs: cfg.budgetWindowMs,
  });
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
  const alertOperator = (text: string): void => {
    const target = cfg.decisionsChatId ?? admin.adminId();
    if (!cfg.telegramToken || target === undefined) return;
    void fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, text }),
    }).catch(() => {});
  };

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
    void updater.run({ trigger: "schedule" }).catch((e) => {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`[updates] scheduled run failed: ${msg}`);
      alertOperator(`⚠️ toolchain update run failed: ${e instanceof Error ? e.message : msg}`);
    });
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
    toTelegram: cfg.telegramToken
      ? (chatId, text, project) =>
          void sendOperatorLine(cfg.telegramToken, chatId, text, project, { toolSteps: cfg.telegramToolSteps })
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
  const scheduleHeartbeat = (): void => {
    // Align the timer to the NEXT tick boundary, not "now + hb" — the tick body below (sweeps +
    // tickScheduler) takes real time, and re-arming from "after the body ran" would drift the chain
    // by body-duration + timer lag each cycle. A drifted tick can sample the wrong minute and
    // silently skip a `30 3 * * *` cron's one matching minute for the day (heartbeat.ts
    // nextTickDelayMs).
    const hb = heartbeatMs(currentHeartbeatLoops());
    const delay = nextTickDelayMs(Date.now(), hb);
    setTimeout(() => {
      sweepIdle(registry, ledger, { idleMs: cfg.idleCloseMs, now: Date.now(), memory: cfg.memory, companyFolder: cfg.companyFolder });
      // Retry dispatch results a busy moment turned away (company reopening/closing) — into a LIVE
      // company only; an idle one gets them with the operator's next message (ADR-0007).
      void flushDispatcherInbox(ledger, liveCompanyLink(registry, lifecycle), Date.now());
      // Release todo queues a hold, a resume or the restart left waiting (ADR-0008). Completions
      // release their own project at once; this tick is the backstop.
      void todo.pump();
      // The daily toolchain check (and the retry of items a busy session deferred).
      runScheduledUpdate();
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
      });
      if (cfg.loopSchedulerEnabled) {
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
              });
            }
            return startScheduledLoop(def, {
              chatId: admin.adminId() ?? -1, // resolved at fire time — the TOFU admin may claim later
              reply: loopReply,
              shouldStop: () => meter.shouldThrottleBackground(),
              cfg,
              store: ledger, // feeds the LEARNED cache-TTL resume gate (Ledger satisfies LoopStore)
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
      }
      scheduleHeartbeat(); // re-derive next tick's interval from the loops enabled right now
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
    const bot = startTelegram(cfg, ledger, admin, registry, meter, trust, usage, inbox, gatewaySendUrl, { lifecycle, requestReload, cooldown, todo, updates: updater }, bus);
    // bot.stop() confirms the last handled update's offset with Telegram — without it a /reload
    // update is redelivered after the restart and reloads again (an endless restart loop).
    stopHooks.push(() => bot.stop());
    console.log("  telegram  -> started. /open · /list · /use · /recent · /usage · /kill · /help");

    // Web console shares the same engine + admin; auth is Telegram-login (TOFU admin).
    const sessions = createSessionStore({
      secret: createHash("sha256").update(`${cfg.telegramToken}:web-session`).digest("hex"),
    });
    const botUsername = await resolveBotUsername(cfg.telegramToken, cfg.botUsername);
    startWeb(
      { engine: { cfg, ledger, registry, meter, trust, lifecycle, cooldown, todo }, requestReload, updates: updater, usage, botToken: cfg.telegramToken, botUsername, sessions, admin, ingressSecret: cfg.agentIngressSecret, inbox, gatewaySendUrl, bus },
      cfg.webPort,
      cfg.webHost,
    );
    const publicHint = cfg.publicUrl ? ` · ${cfg.publicUrl}` : "";
    console.log(`  web       -> http://${cfg.webHost}:${cfg.webPort} (sign in as @${botUsername})${publicHint}`);
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
}

void main();
