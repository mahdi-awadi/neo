// Neo engine — entry point. Loads config, opens the ledger, owns the shared live-session
// registry + budget meter + idle watchdog + admin store, and starts the operator frontends:
// the Telegram bot and the web console (both drive the same source:"neo" SDK pipeline).
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadConfig } from "./config";
import { openLedger } from "./engine/ledger";
import { openAdminStore } from "./engine/admin";
import { createRegistry } from "./engine/registry";
import { createMeter } from "./engine/budget";
import { createSessionStore } from "./engine/web-session";
import { sweepIdle } from "./engine/idle";
import { startTelegram } from "./frontends/telegram";
import { startWeb } from "./frontends/web";

// Idle-close: a session quiet this long is closed (its sdk id persisted for resume).
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const IDLE_POLL_MS = 60 * 1000;
const WEB_PORT = 3002; // Traefik routes neo.tech-gate.online -> 172.20.0.1:3002

// Resolve the bot's @username (needed by the web Login Widget) — read-only, no polling.
async function resolveBotUsername(token: string): Promise<string> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = (await r.json()) as { result?: { username?: string } };
    return j.result?.username ?? "neo_bot";
  } catch {
    return "neo_bot";
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync("data", { recursive: true });
  const ledger = openLedger("data/ledger.db");
  const admin = openAdminStore("data/admin.db");
  const registry = createRegistry();
  const meter = createMeter({
    windowBudgetUsd: cfg.budgetWindowUsd,
    reservePct: cfg.subscriptionInteractiveReservePct,
    windowMs: cfg.budgetWindowMs,
  });

  // Idle watchdog — shares the registry the pipeline registers sessions in.
  setInterval(() => sweepIdle(registry, ledger, { idleMs: IDLE_CLOSE_MS, now: Date.now() }), IDLE_POLL_MS);

  console.log("Neo engine");
  console.log(`  providers -> own:${cfg.providers.ownWork}  customer:${cfg.providers.customerWork}`);
  console.log(`  reserve   -> ${Math.round(cfg.subscriptionInteractiveReservePct * 100)}% interactive headroom of $${cfg.budgetWindowUsd}`);
  console.log(`  ledger    -> data/ledger.db (${ledger.listRecent().length} prior orders)`);
  console.log(`  admin     -> ${admin.adminId() ?? "unclaimed (first Telegram message becomes admin)"}`);
  console.log(`  idle      -> close after ${IDLE_CLOSE_MS / 60000}m quiet, sweep every ${IDLE_POLL_MS / 1000}s`);

  if (cfg.telegramToken) {
    startTelegram(cfg, ledger, admin, registry, meter);
    console.log("  telegram  -> started. /open <folder> <task> · follow up by chatting · /status · /kill <name>");

    // Web console shares the same engine + admin; auth is Telegram-login (TOFU admin).
    const sessions = createSessionStore({
      secret: createHash("sha256").update(`${cfg.telegramToken}:web-session`).digest("hex"),
    });
    const botUsername = await resolveBotUsername(cfg.telegramToken);
    startWeb(
      { engine: { cfg, ledger, registry, meter }, botToken: cfg.telegramToken, botUsername, sessions, admin },
      WEB_PORT,
    );
    console.log(`  web       -> http://0.0.0.0:${WEB_PORT} (sign in as @${botUsername}) · route neo.tech-gate.online here`);
  } else {
    console.log("  telegram  -> NOT configured (set TELEGRAM_TOKEN in .env). Web console disabled (needs the bot for login).");
  }
}

void main();
