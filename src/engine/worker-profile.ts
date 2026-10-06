// Fold a config worker profile into RunDeps for a launch path. Pure + deterministic: the ONLY
// place path→model/effort/skills/env routing happens, so no launch site hardcodes cost choices.
import type { NeoConfig, ModelsCfg, WorkerPathName } from "../config";
import type { RunDeps } from "./session-runner";
import { filterSdkEnv, sdkProvider, supportsRunConfigField, withLongContext } from "./model-resolver";

type WorkerProfileConfig = Pick<NeoConfig, "workers" | "workerEnv"> &
  Partial<Pick<NeoConfig, "providers" | "models" | "governor">>;

/** Which model this launch gets, in precedence order: the call site, then the path's profile, then
 *  the pinned default — and whichever wins, a tier alias is expanded to its real id so no
 *  release-dependent alias leaves the engine (ADR-0005).
 *
 *  Absence is the defect being fixed, so absence (unset, or blank/whitespace) lands on
 *  `models.default`. Anything the alias map does not recognise is forwarded as written: the SDK is
 *  the authority on whether an id is real and reports an unknown one precisely, whereas
 *  substituting the default would mask a typo as a working config. */
function pinnedModel(models: ModelsCfg | undefined, chosen: string | undefined): string | undefined {
  const named = chosen?.trim() || models?.default?.trim();
  if (!named) return chosen;              // no pin configured at all → leave the launch as it was
  const key = named.toLowerCase();
  const direct = models?.aliases?.[key];
  if (direct) return direct;
  // A tier alias may carry the `[1m]` context-size tag (`opus[1m]`, which is what the operator's own
  // Claude Code settings use). Expand the tier and keep the tag, so asking for 1M still gets 1M.
  const tier = key.match(/^([a-z]+)\[1m\]$/)?.[1];
  const tagged = tier ? models?.aliases?.[tier] : undefined;
  return tagged ? withLongContext(tagged) : named;
}

export function profileDeps(
  cfg: WorkerProfileConfig,
  path: WorkerPathName,
  base: RunDeps = {},
): RunDeps {
  const p = cfg.workers[path] ?? {};
  const d: RunDeps = { ...base };
  if (cfg.providers?.ownWork && d.provider === undefined) d.provider = cfg.providers.ownWork;
  delete d.env;
  // `models.*` names Claude ids, so it is applied on the Claude SDK only. Pinning one onto a Codex
  // run would just be dropped downstream as a foreign model, leaving the Codex default to apply
  // invisibly — the same bug one layer down. The Codex adapter keeps owning its own model.
  if (sdkProvider(d.provider) === "subscription") {
    const model = pinnedModel(cfg.models, d.model ?? p.model);
    if (model) d.model = model;
  } else if (supportsRunConfigField(d.provider, "model") && p.model && d.model === undefined) {
    d.model = p.model;
  }
  if (supportsRunConfigField(d.provider, "effort") && p.effort && d.effort === undefined) d.effort = p.effort;
  if (supportsRunConfigField(d.provider, "skills") && p.skills !== undefined && d.skills === undefined) d.skills = p.skills;
  if (supportsRunConfigField(d.provider, "maxTurns") && p.maxTurns && d.maxTurns === undefined) d.maxTurns = p.maxTurns;
  // The operator's standing out-of-folder write approval is own work only (ADR-0012): ingress runs
  // customer-driven briefs, so it keeps the fence.
  if (path !== "ingress" && cfg.governor && d.outOfFolderWrites === undefined) {
    d.outOfFolderWrites = cfg.governor.outOfFolderWrites;
  }
  const env = filterSdkEnv(d.provider, { ...cfg.workerEnv, ...(base.env ?? {}) });
  if (Object.keys(env).length) d.env = env;
  return d;
}
