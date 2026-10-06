// The toolchain updater as the engine runs it (ADR-0009): the three sources (`sdk`, `plugins`,
// `mcp`) over the real `UpdateSys`, configured from `NeoConfig`. The daemon builds it for its 24 h
// schedule and `/updates`; a direct run (no daemon) builds the very same thing, so there is one
// definition of "what Neo updates and how".
import { homedir } from "node:os";
import { join } from "node:path";
import type { NeoConfig } from "../config";
import { PLAYWRIGHT_MCP } from "./dispatch";
import type { Registry } from "./registry";
import { mcpSource } from "./update-mcp";
import { pluginsSource } from "./update-plugins";
import { sdkSource } from "./update-sdk";
import { realUpdateSys } from "./update-sys";
import { createUpdater, type McpLaunch, type Updater, type UpdaterDeps, type UpdateSys } from "./updater";

export interface EngineUpdaterDeps {
  cfg: () => Pick<NeoConfig, "updates" | "workRoot" | "codebaseMemoryBin">;
  ledger: UpdaterDeps["ledger"];
  /** True while a session runs a turn or a dispatch — plugin/MCP files must not change under it. */
  busy: () => boolean;
  /** One message per run to the operator. */
  report: (text: string) => void;
  /** The engine's own git repo (the SDK pin is bumped on a branch of it). */
  repo: string;
  /** Home of the user whose `~/.claude` the workers load. Default: this process's home. */
  home?: string;
  sys?: UpdateSys;
}

/** Any session mid-turn or mid-dispatch? (An idle, resumable session reads nothing.) */
export function registryBusy(registry: Pick<Registry, "list">): boolean {
  return registry.list().some((s) => s.status === "running");
}

export function createEngineUpdater(d: EngineUpdaterDeps): Updater {
  const sys = d.sys ?? realUpdateSys();
  const home = d.home ?? homedir();
  const cfg = d.cfg();
  const builtins: Array<McpLaunch & { name: string }> = [{ name: "playwright", ...PLAYWRIGHT_MCP }];
  if (cfg.codebaseMemoryBin) builtins.push({ name: "codebase-memory", command: cfg.codebaseMemoryBin, args: [] });
  return createUpdater({
    ledger: d.ledger,
    cfg: () => d.cfg().updates,
    busy: d.busy,
    report: d.report,
    sources: [
      sdkSource({ sys, repo: d.repo, baseBranch: cfg.updates.baseBranch }),
      pluginsSource({ sys, pluginsFile: join(home, ".claude", "plugins", "installed_plugins.json") }),
      mcpSource({
        sys,
        claudeJson: join(home, ".claude.json"),
        workRoot: cfg.workRoot,
        builtins,
        npmGlobals: cfg.updates.npmGlobals,
        codebaseMemory: { bin: cfg.codebaseMemoryBin, ...cfg.updates.codebaseMemory },
        verifyTimeoutMs: cfg.updates.verifyTimeoutMs,
      }),
    ],
  });
}
