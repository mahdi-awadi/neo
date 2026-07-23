// Fold a config worker profile into RunDeps for a launch path. Pure + deterministic: the ONLY
// place path→model/effort/skills/env routing happens, so no launch site hardcodes cost choices.
import type { NeoConfig, WorkerPathName } from "../config";
import type { RunDeps } from "./session-runner";

export function profileDeps(
  cfg: Pick<NeoConfig, "workers" | "workerEnv">,
  path: WorkerPathName,
  base: RunDeps = {},
): RunDeps {
  const p = cfg.workers[path] ?? {};
  const d: RunDeps = { ...base };
  if (p.model && d.model === undefined) d.model = p.model;
  if (p.effort && d.effort === undefined) d.effort = p.effort;
  if (p.skills !== undefined && d.skills === undefined) d.skills = p.skills;
  if (p.maxTurns && d.maxTurns === undefined) d.maxTurns = p.maxTurns;
  const env = { ...cfg.workerEnv, ...(base.env ?? {}) };
  if (Object.keys(env).length) d.env = env;
  return d;
}
