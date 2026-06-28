// Neo engine — entry point. Loads config, opens the ledger, owns the shared live-session
// registry + budget meter + idle watchdog + admin store, and starts the operator frontends:
// the Telegram bot and the web console (both drive the same source:"neo" SDK pipeline).
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { openLedger } from "./engine/ledger";
import { openAdminStore } from "./engine/admin";
import { createRegistry } from "./engine/registry";
import { createMeter } from "./engine/budget";
import { createUsageMeter } from "./engine/usage";
import { openTrustStore } from "./engine/trust";
import { openInbox } from "./engine/inbox";
import { createSessionStore } from "./engine/web-session";
import { sweepIdle } from "./engine/idle";
import { effectiveLoops, startLoop } from "./engine/loops";
import { tickScheduler } from "./engine/scheduler";
import { startTelegram } from "./frontends/telegram";
import { startWeb } from "./frontends/web";
import { registerDefaultProject, DEFAULT_PROJECT } from "./engine/default-project";

// Idle-close poll interval.
const IDLE_POLL_MS = 60 * 1000;
// Loop scheduler tick — evaluate loop triggers once a minute.
const LOOP_TICK_MS = 60 * 1000;
const WEB_HOST = "172.20.0.1"; // docker-bridge IP — reachable by Traefik, not public
const WEB_PORT = 3003; // Traefik routes neo.tech-gate.online -> 172.20.0.1:3003 (3001=operant, 3002=taken)

// Resolve the bot's @username (needed by the web Login Widget). An explicit BOT_USERNAME in
// .env wins so login never depends on a network call; otherwise ask getMe (read-only, no polling).
async function resolveBotUsername(token: string): Promise<string> {
  if (process.env.BOT_USERNAME) return process.env.BOT_USERNAME;
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
  const ledger = openLedger("data/ledger.db");
  const admin = openAdminStore("data/admin.db");
  const registry = createRegistry();
  const trust = openTrustStore("data/trust.db");
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

  // Idle watchdog — shares the registry the pipeline registers sessions in. The company is exempt.
  setInterval(() => sweepIdle(registry, ledger, { idleMs: cfg.idleCloseMs, now: Date.now() }), IDLE_POLL_MS);

  console.log("Neo engine");
  console.log(`  providers -> own:${cfg.providers.ownWork}  customer:${cfg.providers.customerWork}`);
  console.log("  usage     -> measured from ~/.claude transcripts (/usage); throttling opt-in via caps later");
  console.log(`  ledger    -> data/ledger.db (${ledger.listRecent().length} prior orders)`);
  console.log(`  admin     -> ${admin.adminId() ?? "unclaimed (first Telegram message becomes admin)"}`);
  console.log(`  idle      -> close normal projects after ${cfg.idleCloseMs / 3_600_000}h quiet, sweep every ${IDLE_POLL_MS / 1000}s (company exempt)`);

  // Loop scheduler — fire due cron/interval loops through the governed runProjectLoop. AI-free:
  // it only evaluates triggers + guards (busy folder / budget throttle) and starts the worker.
  if (cfg.loopSchedulerEnabled) {
    setInterval(
      () =>
        tickScheduler({
          loops: effectiveLoops(ledger), // built-in ∪ custom, re-read each tick (no restart for new loops)
          store: ledger, // Ledger implements LoopStateStore
          isFolderBusy: (folder) => registry.findByFolder(folder) !== undefined,
          throttled: () => meter.shouldThrottle(),
          now: Date.now(),
          start: (def) =>
            void startLoop(def, -1 /* not chat-bound */, {
              reply: (_c, t) => console.log(`[loop ${def.name}] ${t}`),
              shouldStop: () => meter.shouldThrottle(),
              store: ledger,
            }),
        }),
      LOOP_TICK_MS,
    );
    console.log(`  loops     -> scheduler on, tick every ${LOOP_TICK_MS / 1000}s (${effectiveLoops(ledger).length} loops)`);
  } else {
    console.log("  loops     -> scheduler OFF (NEO_LOOP_SCHEDULER=0)");
  }

  const gatewaySendUrl = process.env.GATEWAY_SEND_URL ?? "https://neo-api.tech-gate.online/send";
  if (cfg.telegramToken) {
    startTelegram(cfg, ledger, admin, registry, meter, trust, usage, inbox, gatewaySendUrl);
    console.log("  telegram  -> started. /open · /list · /use · /recent · /usage · /kill · /help");

    // Web console shares the same engine + admin; auth is Telegram-login (TOFU admin).
    const sessions = createSessionStore({
      secret: createHash("sha256").update(`${cfg.telegramToken}:web-session`).digest("hex"),
    });
    const botUsername = await resolveBotUsername(cfg.telegramToken);
    startWeb(
      { engine: { cfg, ledger, registry, meter, trust }, usage, botToken: cfg.telegramToken, botUsername, sessions, admin, ingressSecret: cfg.agentIngressSecret, inbox, gatewaySendUrl },
      WEB_PORT,
      WEB_HOST,
    );
    console.log(`  web       -> http://${WEB_HOST}:${WEB_PORT} (sign in as @${botUsername}) · https://neo.tech-gate.online`);
  } else {
    console.log("  telegram  -> NOT configured (set TELEGRAM_TOKEN in .env). Web console disabled (needs the bot for login).");
  }

  // The always-on default project ("the company"): a pinned, idle fallback for free-text orders
  // with no active project. No SDK turn at startup — the first order starts/resumes its session
  // with the calling channel's reply, so the worker's output goes back to whoever asked.
  registerDefaultProject(registry, ledger);
  console.log(`  company   -> default project registered at ${DEFAULT_PROJECT.folder} (always-on, idle)`);
}

void main();
