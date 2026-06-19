// Neo engine — entry point. Phase 0: loads config and reports readiness.
// Phase 1 wires the Telegram frontend + the engine pipeline (orders -> route ->
// session-runner -> governor -> ledger).
import { loadConfig } from "./config";

function main(): void {
  const cfg = loadConfig();
  console.log("Neo engine — Phase 0 scaffold");
  console.log(`  own work   -> ${cfg.providers.ownWork} (Claude Agent SDK on your subscription)`);
  console.log(`  customer   -> ${cfg.providers.customerWork}`);
  console.log(`  reserve    -> ${Math.round(cfg.subscriptionInteractiveReservePct * 100)}% interactive headroom`);
  console.log(`  telegram   -> ${cfg.telegramToken ? "token present" : "NOT configured"}`);
  console.log(`  gemini     -> ${cfg.geminiApiKey ? "key present" : "NOT configured"}`);
  console.log("  status     -> scaffold only; engine modules are Phase 1 stubs.");
}

main();
