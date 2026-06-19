// Neo engine — entry point. Loads config, opens the ledger, and starts the Telegram
// frontend (if a token is set). The frontend feeds messages into the engine pipeline.
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config";
import { openLedger } from "./engine/ledger";
import { startTelegram } from "./frontends/telegram";

function main(): void {
  const cfg = loadConfig();
  mkdirSync("data", { recursive: true });
  const ledger = openLedger("data/ledger.db");

  console.log("Neo engine");
  console.log(`  providers -> own:${cfg.providers.ownWork}  customer:${cfg.providers.customerWork}`);
  console.log(`  reserve   -> ${Math.round(cfg.subscriptionInteractiveReservePct * 100)}% interactive headroom`);
  console.log(`  ledger    -> data/ledger.db (${ledger.listRecent().length} prior orders)`);

  if (cfg.telegramToken) {
    startTelegram(cfg, ledger);
    console.log("  telegram  -> started. Send: /open <folder> <task>");
  } else {
    console.log("  telegram  -> NOT configured (set TELEGRAM_TOKEN in .env).");
  }
}

main();
