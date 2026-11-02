// A private, per-turn native Codex role. Role files are never written into a project or Codex home.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CodexOptions } from "@openai/codex-sdk";
import type { RunDeps } from "./session-runner";

export function createCodexPlannerRole(planner: NonNullable<RunDeps["codexPlanner"]>): {
  config: NonNullable<CodexOptions["config"]>;
  close(): Promise<void>;
} {
  const parent = process.env.NEO_CODEX_LAUNCHER_DIR?.trim() || join(homedir(), ".cache", "neo", "codex-launchers");
  if (!isAbsolute(parent)) throw new Error("NEO_CODEX_LAUNCHER_DIR must be an absolute daemon-private path");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const directory = mkdtempSync(join(realpathSync(parent), "planner-"));
  const path = join(directory, "planner.toml");
  try {
    writeFileSync(path, [
      `model = ${JSON.stringify(planner.model)}`,
      `model_reasoning_effort = ${JSON.stringify(planner.effort)}`,
      `developer_instructions = ${JSON.stringify(planner.instructions)}`,
      "",
    ].join("\n"), { mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    config: {
      "features.multi_agent": true,
      "agents.planner.description": "Design, plan, and review using the configured planning model.",
      "agents.planner.config_file": path,
      developer_instructions: "For design, features, implementation, debugging, and architectural reviews, delegate the initial plan to the planner agent using its configured model and wait for its result before proceeding. Delegate final review of implemented changes to the planner and wait for its result. Handle straightforward status checks and small edits directly. Never claim that a planner ran unless you actually invoked it.",
    },
    close: async () => rmSync(directory, { recursive: true, force: true }),
  };
}
