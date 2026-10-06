import type { Provider } from "../types";
import type { EffortLevel } from "./session-runner";

export type WorkerSdkProvider = Extract<Provider, "subscription" | "codex">;
export type WorkerModelProvider = WorkerSdkProvider;
export type RunConfigField =
  | "resume"
  | "effort"
  | "mcpServers"
  | "disallowedTools"
  | "model"
  | "skills"
  | "maxTurns"
  | "agents"
  | "env";

export interface ModelSelection {
  model?: string;
  effort?: EffortLevel;
}

export interface SdkRunSelection extends ModelSelection {
  query?: unknown;
  resume?: string;
  mcpServers?: unknown;
  disallowedTools?: readonly string[];
  skills?: unknown;
  maxTurns?: number;
  agents?: unknown;
  env?: Record<string, string>;
}

export interface ResolvedModelSelection extends ModelSelection {
  provider: WorkerModelProvider;
  originalModel?: string;
  changed: boolean;
  reason?: string;
}

type ModelPatch = {
  model?: string;
  dropModel?: true;
  effort?: EffortLevel;
  reason: string;
};

type ModelRule = {
  match: RegExp;
  patch: ModelPatch;
};

type UnsupportedFieldRule = {
  field: string;
  present: (selection: SdkRunSelection) => boolean;
};

type EnvRules = {
  denyKeys: readonly string[];
  denyPrefixes: readonly string[];
};

type SdkCompatibility = {
  label: string;
  modelRules: readonly ModelRule[];
  runConfigFields: readonly RunConfigField[];
  unsupportedFields: readonly UnsupportedFieldRule[];
  env: EnvRules;
};

const PROVIDER_KEYS: Record<string, WorkerModelProvider> = {
  subscription: "subscription",
  codex: "codex",
};

const READ_ONLY_DENY_TOOLS = ["Write", "Edit", "NotebookEdit", "Bash"] as const;

/** The pinned Claude model id for each tier — the ONE place a model id is written in the engine.
 *  `config.ts` seeds `DEFAULTS.models` from here and `config.json` can override it, so a tier
 *  upgrade is a config edit with a record, never an ambient release change (ADR-0005).
 *
 *  Why ids and not the bare aliases `opus`/`sonnet`/`haiku`/`fable`: the alias means "whatever that
 *  family currently points at", so it moves under us silently. The SDK's own allowlist validator
 *  says the same thing — "it names a different model depending on the release and settings. Name
 *  the model instead, for example claude-opus-5-5".
 *
 *  `[1m]` on the opus pin is the 1M-context tag (the SDK strips it from the reported model id). It
 *  keeps the context size workers already run on; the cheap tiers stay plain, where 1M is cost with
 *  no benefit. Verified against the live API on 2026-10-01 with SDK 0.3.286. */
export const CLAUDE_TIER_MODELS = {
  opus: "claude-opus-5-5[1m]",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
} as const;

/** The tier words a profile, brief, or config alias key may use. */
export type ClaudeTier = keyof typeof CLAUDE_TIER_MODELS;

/** Add the 1M-context tag to a model id, unless it already carries one. `[1m]` is a context-size
 *  tag valid on any canonical id, so `sonnet[1m]` can be pinned without losing the caller's
 *  requested context size. */
export function withLongContext(id: string): string {
  return /\[1m\]$/i.test(id) ? id : `${id}[1m]`;
}

/** Claude names that are NOT a tier: `best` picks the best model available and `opusplan` switches
 *  model by phase, so both depend on the release AND the settings and no single id expresses them.
 *  Neo does not pin them (pinning would change what they mean, not fix it) — but on Codex they must
 *  never pass through as a literal model name, because none of them is an OpenAI model. */
const CLAUDE_MODE_ALIASES = /^(best|opusplan)$/i;

export function readOnlySandboxRequested(disallowedTools: readonly string[] | undefined): boolean {
  if (!disallowedTools) return false;
  const denied = new Set(disallowedTools);
  return READ_ONLY_DENY_TOOLS.every((tool) => denied.has(tool));
}

/** One rule pair per tier — the bare word and its `[1m]` spelling — generated from the pins so a new
 *  tier cannot be added to `CLAUDE_TIER_MODELS` and forgotten here. */
const CLAUDE_TIER_RULES: readonly ModelRule[] = Object.entries(CLAUDE_TIER_MODELS).flatMap(
  ([tier, id]): ModelRule[] => [
    { match: new RegExp(`^${tier}$`, "i"), patch: { model: id, reason: "claude-tier-pin" } },
    {
      match: new RegExp(`^${tier}\\[1m\\]$`, "i"),
      patch: { model: withLongContext(id), reason: "claude-tier-pin" },
    },
  ],
);

export const SDK_COMPATIBILITY = {
  subscription: {
    label: "Claude Agent SDK",
    // A bare tier alias is expanded to its pinned id, so no release-dependent tier alias can reach
    // the SDK even from a caller that set RunDeps.model by hand and bypassed profileDeps. Both
    // spellings are covered: the bare tier and the `[1m]` context-tag form, where the tag is carried
    // onto the pinned id so the requested context size survives the expansion. A full model id
    // matches no rule and passes through untouched — the SDK is the authority on whether an id is
    // real, and it already reports an unknown one precisely (classifyApiError → model_not_found).
    // `CLAUDE_MODE_ALIASES` are deliberately NOT expanded here; see their comment.
    modelRules: CLAUDE_TIER_RULES,
    runConfigFields: [
      "resume",
      "effort",
      "mcpServers",
      "disallowedTools",
      "model",
      "skills",
      "maxTurns",
      "agents",
      "env",
    ],
    unsupportedFields: [],
    env: { denyKeys: [], denyPrefixes: [] },
  },
  codex: {
    label: "OpenAI Codex SDK",
    // Substring matches on purpose: a Claude TIER means the same reasoning budget however it is
    // spelled, so the bare alias and the pinned id (`sonnet`, `claude-sonnet-5-5`,
    // `claude-opus-5-5[1m]`) both land on the same effort. `/opus/i` also covers `opusplan`.
    //
    // NO Claude name may fall through as a literal model: none of them is an OpenAI model. So every
    // rule drops the model, the `best` mode alias is listed, and the catch-all covers any remaining
    // `claude-*` id — including tiers this table does not know yet, such as `claude-mythos-5`.
    //
    // Every rule also sets an effort, including the catch-all. Leaving it unset would hand the run
    // to Codex's own default silently, which is the same invisible-default defect ADR-0005 is about:
    // a stated `medium` is reviewable and wrong-in-the-open. `fable` → `medium` is a judgement, not
    // a published ranking: it is a general-purpose tier, so it is budgeted alongside sonnet. A
    // caller's own `effort` always wins over the tier-derived one (see applyPatch).
    modelRules: [
      { match: /haiku/i, patch: { dropModel: true, effort: "low", reason: "claude-tier-haiku" } },
      { match: /sonnet/i, patch: { dropModel: true, effort: "medium", reason: "claude-tier-sonnet" } },
      { match: /opus/i, patch: { dropModel: true, effort: "high", reason: "claude-tier-opus" } },
      { match: /fable/i, patch: { dropModel: true, effort: "medium", reason: "claude-tier-fable" } },
      { match: CLAUDE_MODE_ALIASES, patch: { dropModel: true, effort: "medium", reason: "claude-mode-alias" } },
      { match: /^claude-/i, patch: { dropModel: true, effort: "medium", reason: "foreign-claude-model" } },
    ],
    runConfigFields: ["resume", "effort", "model", "env"],
    unsupportedFields: [
      { field: "query", present: (deps) => deps.query !== undefined },
      { field: "mcpServers", present: (deps) => deps.mcpServers !== undefined },
      { field: "skills", present: (deps) => deps.skills !== undefined },
      { field: "maxTurns", present: (deps) => !!deps.maxTurns },
      { field: "agents", present: (deps) => deps.agents !== undefined },
      {
        field: "disallowedTools",
        present: (deps) => deps.disallowedTools !== undefined && !readOnlySandboxRequested(deps.disallowedTools),
      },
    ],
    env: {
      denyKeys: ["MAX_MCP_OUTPUT_TOKENS"],
      denyPrefixes: ["CLAUDE_", "ANTHROPIC_"],
    },
  },
} satisfies Record<WorkerSdkProvider, SdkCompatibility>;

export function sdkProvider(provider: Provider | undefined): WorkerSdkProvider {
  return PROVIDER_KEYS[provider ?? "subscription"] ?? "subscription";
}

export function sdkCompatibility(provider: Provider | undefined): SdkCompatibility {
  return SDK_COMPATIBILITY[sdkProvider(provider)];
}

export function supportsRunConfigField(provider: Provider | undefined, field: RunConfigField): boolean {
  return sdkCompatibility(provider).runConfigFields.includes(field);
}

export function supportedRunConfigFields(provider: Provider | undefined): readonly RunConfigField[] {
  return sdkCompatibility(provider).runConfigFields;
}

export function unsupportedRunFields(provider: Provider | undefined, selection: SdkRunSelection): string[] {
  return sdkCompatibility(provider).unsupportedFields
    .filter((rule) => rule.present(selection))
    .map((rule) => rule.field);
}

export function unsupportedEnvKeys(provider: Provider | undefined, env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const rules = sdkCompatibility(provider).env;
  return Object.keys(env).filter(
    (key) => rules.denyKeys.includes(key) || rules.denyPrefixes.some((prefix) => key.startsWith(prefix)),
  );
}

export function filterSdkEnv(provider: Provider | undefined, env: Record<string, string>): Record<string, string> {
  const unsupported = new Set(unsupportedEnvKeys(provider, env));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !unsupported.has(key)));
}

function applyPatch(selection: ModelSelection, provider: WorkerModelProvider, patch?: ModelPatch): ResolvedModelSelection {
  if (!patch) return { provider, ...selection, changed: false };
  const model = patch.dropModel ? undefined : (patch.model ?? selection.model);
  const effort = selection.effort ?? patch.effort;
  return {
    provider,
    model,
    effort,
    originalModel: selection.model,
    changed: model !== selection.model || effort !== selection.effort,
    reason: patch.reason,
  };
}

export function resolveModelSelection(provider: Provider | undefined, selection: ModelSelection): ResolvedModelSelection {
  const key = sdkProvider(provider);
  const model = selection.model?.trim();
  if (!model) return { provider: key, effort: selection.effort, changed: false };
  const rule = SDK_COMPATIBILITY[key].modelRules.find((r) => r.match.test(model));
  return applyPatch({ ...selection, model }, key, rule?.patch);
}
