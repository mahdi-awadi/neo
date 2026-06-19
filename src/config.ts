// Configuration: .env (secrets) + config.json (structured settings). Env wins.
// Mirrors operant's precedence (env > config.json > defaults) but trimmed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./types";

export interface NeoConfig {
  telegramToken: string;
  telegramAllowFrom: number[];
  geminiApiKey: string;
  /**
   * Provider routing, kept in config so a future Anthropic plan change is a flip,
   * not a code rewrite. Defaults encode the compliance firewall.
   */
  providers: { ownWork: Provider; customerWork: Provider };
  /** Fraction of the Claude subscription pool reserved for Neo's interactive use. */
  subscriptionInteractiveReservePct: number;
  /** Default root under which worker project folders live. */
  workRoot: string;
  /** Per-window USD budget for background SDK work (the budget guard). */
  budgetWindowUsd: number;
  /** Rolling budget window in ms (default 5h, matching the subscription's usage window). */
  budgetWindowMs: number;
}

const DEFAULTS = {
  providers: { ownWork: "subscription" as Provider, customerWork: "gemini" as Provider },
  subscriptionInteractiveReservePct: 0.2,
  workRoot: process.env.HOME ?? "/home",
  budgetWindowUsd: 20,
  budgetWindowMs: 5 * 60 * 60 * 1000,
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
    providers: fileCfg.providers ?? DEFAULTS.providers,
    subscriptionInteractiveReservePct:
      fileCfg.subscriptionInteractiveReservePct ?? DEFAULTS.subscriptionInteractiveReservePct,
    workRoot: fileCfg.workRoot ?? DEFAULTS.workRoot,
    budgetWindowUsd: fileCfg.budgetWindowUsd ?? DEFAULTS.budgetWindowUsd,
    budgetWindowMs: fileCfg.budgetWindowMs ?? DEFAULTS.budgetWindowMs,
  };
}
