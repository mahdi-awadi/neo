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

export function readOnlySandboxRequested(disallowedTools: readonly string[] | undefined): boolean {
  if (!disallowedTools) return false;
  const denied = new Set(disallowedTools);
  return READ_ONLY_DENY_TOOLS.every((tool) => denied.has(tool));
}

export const SDK_COMPATIBILITY = {
  subscription: {
    label: "Claude Agent SDK",
    modelRules: [
      { match: /^haiku$/i, patch: { model: "haiku", reason: "claude-alias" } },
      { match: /^sonnet$/i, patch: { model: "sonnet", reason: "claude-alias" } },
      { match: /^opus$/i, patch: { model: "opus", reason: "claude-alias" } },
    ],
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
    modelRules: [
      { match: /haiku/i, patch: { dropModel: true, effort: "low", reason: "claude-tier-haiku" } },
      { match: /sonnet/i, patch: { dropModel: true, effort: "medium", reason: "claude-tier-sonnet" } },
      { match: /opus/i, patch: { dropModel: true, effort: "high", reason: "claude-tier-opus" } },
      { match: /^claude-/i, patch: { dropModel: true, reason: "foreign-claude-model" } },
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
