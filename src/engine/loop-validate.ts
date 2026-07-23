// Pure validation: turn untrusted loop-creation input into a safe LoopDef or a clear error.
// No AI; the only side effect is reading the filesystem to check the folder fence (injectable).
import { statSync, realpathSync } from "node:fs";
import type { LoopDef } from "./loops";
import { isValidCron } from "./trigger";
import { MIN_INTERVAL_MS } from "./heartbeat";

export interface LoopInput {
  name: string;
  summary: string;
  folder: string;
  prompt: string;
  goalKind: "command" | "judge";
  goalCommand?: string; // command: a shell one-liner, wrapped as ["sh","-c", cmd]
  goalCriteria?: string; // judge: the criteria text
  goalTimeoutMs?: number;
  triggerKind: "manual" | "interval" | "cron";
  intervalMinutes?: number;
  cronExpr?: string;
  maxIterations: number;
  budgetUsd?: number;
  enabledByDefault?: boolean;
  /** Never resume across iterations — each one starts fresh (default false). */
  freshSession?: boolean;
}

const slug = (s: string) =>
  (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Fence a candidate loop folder to `root` (the operator's project root) — an existing directory
 *  whose real path is inside root. Root is normalized to end with a separator so a prefix match
 *  can't leak into a sibling (e.g. root "/home" must not admit "/homexyz"). */
function defaultFolderOk(folder: string, root: string): boolean {
  const fence = root.endsWith("/") ? root : root + "/";
  try {
    return statSync(folder).isDirectory() && realpathSync(folder).startsWith(fence);
  } catch {
    return false;
  }
}

export function validateLoopInput(
  input: LoopInput,
  opts: { existingNames: string[]; folderOk?: (folder: string) => boolean; root?: string },
): { def: LoopDef } | { error: string } {
  const root = opts.root ?? "/home";
  const folderOk = opts.folderOk ?? ((f: string) => defaultFolderOk(f, root));
  const name = slug(input.name);
  if (!name) return { error: "name is required" };
  if (opts.existingNames.includes(name)) return { error: `a loop named "${name}" already exists` };
  if (!input.summary?.trim()) return { error: "summary is required" };
  if (!input.prompt?.trim()) return { error: "prompt is required" };
  if (!input.folder?.trim() || !folderOk(input.folder)) return { error: `folder must be an existing directory under ${root}` };

  const timeoutMs = input.goalTimeoutMs ?? 120000;
  let goal: LoopDef["goal"];
  if (input.goalKind === "command") {
    if (!input.goalCommand?.trim()) return { error: "a command goal needs a command" };
    goal = { kind: "command", command: ["sh", "-c", input.goalCommand.trim()], timeoutMs };
  } else if (input.goalKind === "judge") {
    if (!input.goalCriteria?.trim()) return { error: "a judge goal needs criteria" };
    goal = { kind: "judge", criteria: input.goalCriteria.trim(), timeoutMs };
  } else {
    return { error: "goalKind must be command or judge" };
  }

  let trigger: LoopDef["trigger"];
  if (input.triggerKind === "manual") {
    trigger = { kind: "manual" };
  } else if (input.triggerKind === "interval") {
    if (!input.intervalMinutes || input.intervalMinutes <= 0) return { error: "interval needs intervalMinutes > 0" };
    const everyMs = Math.round(input.intervalMinutes * 60000);
    // The daemon's own tick can't fire more often than MIN_INTERVAL_MS (tied to the cron
    // resolution the tick derives from — see heartbeat.ts) — an interval below that floor could
    // never actually be honored, so this is a fact about the scheduler, not tuning.
    if (everyMs < MIN_INTERVAL_MS) return { error: `interval must be at least ${MIN_INTERVAL_MS / 60000} minute(s) (the daemon's tick can't fire more often)` };
    trigger = { kind: "interval", everyMs };
  } else if (input.triggerKind === "cron") {
    if (!input.cronExpr?.trim() || !isValidCron(input.cronExpr.trim())) return { error: "cron needs a valid 5-field expression" };
    trigger = { kind: "cron", expr: input.cronExpr.trim() };
  } else {
    return { error: "triggerKind must be manual, interval, or cron" };
  }

  if (!Number.isFinite(input.maxIterations) || input.maxIterations < 1) return { error: "maxIterations must be ≥ 1" };
  if (input.budgetUsd !== undefined && (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0)) {
    return { error: "budgetUsd must be ≥ 0" };
  }

  const def: LoopDef = {
    name,
    usage: `/loop ${name}`,
    summary: input.summary.trim(),
    folder: input.folder.trim(),
    prompt: input.prompt.trim(),
    goal,
    trigger,
    bounds: {
      maxIterations: Math.floor(input.maxIterations),
      ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    },
    ...(input.enabledByDefault !== undefined ? { enabledByDefault: input.enabledByDefault } : {}),
    ...(input.freshSession !== undefined ? { freshSession: input.freshSession } : {}),
  };
  return { def };
}
