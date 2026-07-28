import type { Provider } from "../types";

export type WorkerSdkProvider = Extract<Provider, "subscription" | "codex">;

export interface WorkerSdkState {
  provider: Provider;
  label: string;
  choices: Array<{ provider: WorkerSdkProvider; label: string; active: boolean }>;
}

export interface WorkerSdkConfig {
  providers: { ownWork: Provider };
}

const SDK_LABELS: Record<WorkerSdkProvider, string> = {
  subscription: "Claude Agent SDK",
  codex: "OpenAI Codex SDK",
};

const SDK_ALIASES: Record<string, WorkerSdkProvider> = {
  anthropic: "subscription",
  claude: "subscription",
  "claude-agent-sdk": "subscription",
  "claude_sdk": "subscription",
  subscription: "subscription",
  codex: "codex",
  "codex-sdk": "codex",
  "codex_sdk": "codex",
  openai: "codex",
};

export function normalizeWorkerSdk(input: string): WorkerSdkProvider | undefined {
  return SDK_ALIASES[input.trim().toLowerCase()];
}

export function workerSdkLabel(provider: Provider): string {
  if (provider === "subscription" || provider === "codex") return SDK_LABELS[provider];
  return `${provider} (not an operator SDK)`;
}

export function workerSdkState(provider: Provider): WorkerSdkState {
  return {
    provider,
    label: workerSdkLabel(provider),
    choices: (Object.keys(SDK_LABELS) as WorkerSdkProvider[]).map((choice) => ({
      provider: choice,
      label: SDK_LABELS[choice],
      active: choice === provider,
    })),
  };
}

export function setWorkerSdk(cfg: WorkerSdkConfig, raw: string): { ok: boolean; error?: string; sdk: WorkerSdkState; changed: boolean } {
  const provider = normalizeWorkerSdk(raw);
  const current = cfg.providers.ownWork;
  if (!provider) {
    return {
      ok: false,
      error: "Use claude or codex.",
      sdk: workerSdkState(current),
      changed: false,
    };
  }
  cfg.providers.ownWork = provider;
  return { ok: true, sdk: workerSdkState(provider), changed: current !== provider };
}
