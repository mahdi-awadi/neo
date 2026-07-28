// Fold a config worker profile into RunDeps for a launch path. Pure + deterministic: the ONLY
// place path→model/effort/skills/env routing happens, so no launch site hardcodes cost choices.
import type { NeoConfig, WorkerPathName } from "../config";
import type { RunDeps } from "./session-runner";
import { filterSdkEnv, supportsRunConfigField } from "./model-resolver";

type WorkerProfileConfig = Pick<NeoConfig, "workers" | "workerEnv"> & Partial<Pick<NeoConfig, "providers">>;

export function profileDeps(
  cfg: WorkerProfileConfig,
  path: WorkerPathName,
  base: RunDeps = {},
): RunDeps {
  const p = cfg.workers[path] ?? {};
  const d: RunDeps = { ...base };
  if (cfg.providers?.ownWork && d.provider === undefined) d.provider = cfg.providers.ownWork;
  delete d.env;
  if (supportsRunConfigField(d.provider, "model") && p.model && d.model === undefined) d.model = p.model;
  if (supportsRunConfigField(d.provider, "effort") && p.effort && d.effort === undefined) d.effort = p.effort;
  if (supportsRunConfigField(d.provider, "skills") && p.skills !== undefined && d.skills === undefined) d.skills = p.skills;
  if (supportsRunConfigField(d.provider, "maxTurns") && p.maxTurns && d.maxTurns === undefined) d.maxTurns = p.maxTurns;
  const env = filterSdkEnv(d.provider, { ...cfg.workerEnv, ...(base.env ?? {}) });
  if (Object.keys(env).length) d.env = env;
  return d;
}
