// Neo engine — entry point. Loads config, opens the ledger, owns the shared live-session
// registry + budget meter + idle watchdog, and starts the Telegram frontend (if a token is
// set). The frontend feeds messages into the engine pipeline; the watchdog closes stale
// sessions so background work never holds the subscription pool open forever.
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config";
import { openLedger } from "./engine/ledger";
import { createRegistry } from "./engine/registry";
import { createMeter } from "./engine/budget";
import { sweepIdle } from "./engine/idle";
import { startTelegram } from "./frontends/telegram";

// Idle-close: a session quiet this long is closed (its sdk id persisted for resume).
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const IDLE_POLL_MS = 60 * 1000;

function main(): void {
  const cfg = loadConfig();
  mkdirSync("data", { recursive: true });
  const ledger = openLedger("data/ledger.db");
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
  console.log(`  idle      -> close after ${IDLE_CLOSE_MS / 60000}m quiet, sweep every ${IDLE_POLL_MS / 1000}s`);

  if (cfg.telegramToken) {
    startTelegram(cfg, ledger, registry, meter);
    console.log("  telegram  -> started. /open <folder> <task> · follow up by chatting · /status · /kill <name>");
  } else {
    console.log("  telegram  -> NOT configured (set TELEGRAM_TOKEN in .env).");
  }
}

main();
