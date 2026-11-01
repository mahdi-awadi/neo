import type { Provider } from "../types";
import type { Registry } from "./registry";

export type WorkerSdkProvider = Extract<Provider, "subscription" | "codex">;

export interface WorkerSdkState {
  provider: Provider;
  label: string;
  switching?: Array<{ name: string; provider: WorkerSdkProvider | "unknown"; blocked: boolean }>;
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
 * owner (written before ids carried their SDK) is still tried on Claude, whose runner recovers
 * from a missing conversation. Codex has no equivalent missing-thread recovery, so an unowned id
 * starts fresh there instead of potentially leaving the project unreachable.
 */
export function canResumeWith(mintedBy: Provider | undefined, worker: Provider | undefined): boolean {
  return mintedBy === worker || (mintedBy === undefined && worker !== "codex");
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

/** Durable operator SDK selection shared by all entry points. */
export function createWorkerSdkSelection(
  cfg: WorkerSdkConfig,
  store: { getMeta(key: string): { value: unknown } | undefined; setMeta(key: string, value: unknown, at: number): void },
  registry?: Pick<Registry, "list" | "getControl">,
): { get(): WorkerSdkProvider; set(raw: string): ReturnType<typeof setWorkerSdk> } {
  const key = "worker_sdk_provider";
  const saved = store.getMeta(key)?.value;
  if (typeof saved === "string") {
    const restored = normalizeWorkerSdk(saved);
    if (restored) cfg.providers.ownWork = restored;
  }
  return {
    get() {
      return normalizeWorkerSdk(cfg.providers.ownWork) ?? "subscription";
    },
    set(raw) {
      const provider = normalizeWorkerSdk(raw);
      if (!provider) return { ok: false, error: "Use claude or codex.", sdk: workerSdkState(cfg.providers.ownWork), changed: false };
      try {
        store.setMeta(key, provider, Date.now());
      } catch {
        return { ok: false, error: "Could not save the worker SDK selection.", sdk: workerSdkState(cfg.providers.ownWork), changed: false };
      }
      const result = setWorkerSdk(cfg, provider);
      if (result.changed && registry) {
        for (const session of registry.list()) {
          if (session.order.source !== "neo" || session.customerDriven) continue;
          const control = registry.getControl(session.id);
          const runningProvider = control?.tools?.provider === "claude" ? "subscription" : control?.tools?.provider ?? session.sdkProvider;
          if (control && runningProvider !== provider) {
            try {
              if (!control.closed?.()) {
                if (control.switchProvider) control.switchProvider();
                else control.close?.();
              }
            } catch { /* dashboard shows the blocked session */ }
          }
        }
      }
      return result;
    },
  };
}
