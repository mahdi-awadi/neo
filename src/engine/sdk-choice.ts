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

/**
 * May `worker` resume a session id minted by `mintedBy`?
 *
 * A session id is private to the SDK that issued it: a Codex thread id handed to the Claude SDK
 * dies instantly with "No conversation found with session ID: …" (and vice versa), which before
 * this check read as an API failure and left the project unreachable — every message resumed the
 * same dead id, and the run never survived long enough to mint a live one.
 *
 * A KNOWN mismatch is refused here, so the doomed attempt never happens. An id with no recorded
 * owner (written before ids carried their SDK) is still tried: continuity is worth more than one
 * round-trip, and if it turns out dead the runner restarts cold on its own (RESUME_MISSING_RE in
 * session-runner) and re-mints an id that IS tagged. Prevention where we have proof, recovery
 * where we don't.
 */
export function canResumeWith(mintedBy: Provider | undefined, worker: Provider | undefined): boolean {
  return mintedBy === undefined || mintedBy === worker;
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
