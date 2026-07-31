// The execution core: opens a project folder as a headless coding-agent worker and streams its
// work back to the engine. The public boundary (`runOrder` / `startOrder`) is provider-neutral;
// adapters behind it target Claude Agent SDK (default) or OpenAI Codex SDK. Replaces operant's
// tmux + shim + Ink-scraping entirely.
//
// Two entry points:
//   runOrder   — single-shot: open the folder, run one task to completion (Phase-1 path).
//   startOrder — live session: keep the worker warm on a streaming input channel so the
//                engine can push follow-up messages mid-run, then interrupt / idle-close it.
//
// Verified SDK surface (docs/sdk-notes.md): query({ prompt, options }) -> async generator.
//   options: cwd, settingSources:["user","project"], systemPrompt preset, permissionMode, canUseTool.
//
// ASSUMED (build-then-verify, isolated here): `prompt` may be an AsyncIterable<SDKUserMessage>
// for streaming input, the returned Query exposes interrupt(), and options.resume resumes a
// prior session id. These are reconciled against a real run before Phase 2 ships.
//
// SPIKE FINDING (docs/sdk-notes.md): the canUseTool ALLOW decision MUST echo `updatedInput`.
//
// Auth: Claude draws from your Claude subscription; Codex uses Codex SDK/CLI auth (e.g.
// CODEX_API_KEY or saved local auth). See README + docs/CONFIG.md.
import { basename } from "node:path";
import { query as realQuery, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  Codex,
  type ApprovalMode as CodexApprovalMode,
  type CodexOptions,
  type ModelReasoningEffort as CodexReasoningEffort,
  type SandboxMode as CodexSandboxMode,
  type ThreadEvent as CodexThreadEvent,
  type ThreadOptions as CodexThreadOptions,
  type WebSearchMode as CodexWebSearchMode,
} from "@openai/codex-sdk";
import type { Order, Provider, SessionControl } from "../types";
import type { RateLimitInfo } from "./usage";
import { decide } from "./governor";
import {
  filterSdkEnv,
  readOnlySandboxRequested,
  resolveModelSelection,
  supportedRunConfigFields,
  unsupportedRunFields,
  type RunConfigField,
  type WorkerModelProvider,
} from "./model-resolver";

// High-frequency, low-signal read/navigation tools — surfacing every one would spam the operator,
// so the stream stays quiet for these (the worker's assistant text + the milestones below carry it).
const QUIET_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite", "NotebookRead", "ListMcpResources"]);

/** A short, human target for a tool call, drawn from whichever common input field is present. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const trunc = (s: string) => (s.length > 60 ? s.slice(0, 57) + "…" : s);
  if (str(i.file_path)) return basename(str(i.file_path));
  if (str(i.path)) return basename(str(i.path));
  if (str(i.command)) return trunc(str(i.command));
  if (str(i.pattern)) return trunc(str(i.pattern));
  if (str(i.url)) return trunc(str(i.url));
  if (str(i.project)) return str(i.project);
  if (str(i.description)) return trunc(str(i.description));
  return "";
}

/** Turn a tool_use block into a concise "🔧 Tool: target" milestone, or undefined to stay quiet.
 *  MCP tool names (mcp__server__tool) are shortened to the bare tool name. */
function toolMilestone(name: string, input: unknown): string | undefined {
  const short = name.startsWith("mcp__") ? name.split("__").pop() ?? name : name;
  if (QUIET_TOOLS.has(short)) return undefined;
  const detail = toolDetail(input);
  return `🔧 ${short}${detail ? `: ${detail}` : ""}`;
}

export interface RunHandlers {
  /** Stream a human-readable line from the worker back to the channel. */
  onMessage: (text: string) => void;
  /** Ask the human to approve a risky tool; resolves with their decision. */
  onEscalation: (reason: string) => Promise<"allow" | "deny">;
  /** Reported the SDK's running cost (`total_cost_usd`) as each turn completes. */
  onCost?: (usd: number) => void;
  /** Reported subscription rate-limit info from the SDK's rate_limit_event. */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** When true (read per escalation), risky tools auto-approve instead of escalating. */
  autoApprove?: () => boolean;
  /** Called with the escalation reason when trust auto-approves it (for audit/FYI). */
  onAutoApprove?: (reason: string) => void;
  /** Reports what the worker is doing (each tool_use as "Tool: detail", each text as "replying"). */
  onActivity?: (label: string) => void;
  /** Liveness pulse: fires on EVERY streamed SDK event (partial deltas, tool_use, tool_result,
   *  system, result), regardless of whether it produces an operator message. The dispatch stall
   *  monitor bumps its last-activity clock here so a worker mid-generation (e.g. writing a huge
   *  file — one long turn with no completed message) is never counted as silent (BUG 1). */
  onHeartbeat?: () => void;
  /** Fires at each SDK "result" message (turn boundary) with that turn's result. A single-brief
   *  caller (dispatch) uses this to detect completion — the stream itself stays open. */
  onTurnComplete?: (result: RunResult) => void;
  /** Structured diagnostic events (session lifecycle). The engine wires this to ledger.recordEvent;
   *  a bare worker leaves it unset. NEVER carries message bodies — kinds + small metadata only. */
  onEvent?: (kind: string, data?: Record<string, unknown>) => void;
}

/** Reasoning effort: "low" = minimal thinking / fastest responses … "max" = deepest. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Per-run dependencies/config: an injectable query (tests) and optional SDK options. */
export interface RunDeps {
  /** Worker SDK/provider to use. Default "subscription" = Claude Agent SDK; "codex" = Codex SDK. */
  provider?: Provider;
  query?: QueryFn;
  /** Injectable Codex client factory for tests; default constructs `new Codex(...)`. */
  codexFactory?: CodexFactory;
  /** Resume a prior SDK session id (idle-close → resume). */
  resume?: string;
  /** Reasoning effort for this session (the chief-of-staff runs "low" for fast routing). */
  effort?: EffortLevel;
  /** Extra in-process MCP servers/tools (e.g. the default project's `dispatch` tool). Claude-only;
   *  Codex records a compatibility warning because its SDK wrapper doesn't accept this shape. */
  mcpServers?: Record<string, unknown>;
  /** Tools the worker must NOT use (e.g. read-only judge runs deny Write/Edit/Bash). Codex maps
   *  the standard read-only deny-list to sandboxMode:"read-only"; arbitrary deny-lists warn. */
  disallowedTools?: string[];
  /** SDK model override for this run. Resolved through the SDK table: Claude tier aliases
   *  ("haiku" | "sonnet" | "opus") stay Claude aliases on subscription and become Codex effort
   *  tiers on Codex. Unset = inherit. */
  model?: string;
  /** Skills visible to a Claude worker: "all" or an explicit allowlist ([] = none). Unset = "all". */
  skills?: "all" | string[];
  /** Claude SDK cap on agentic turns for one run. Unset = uncapped. */
  maxTurns?: number;
  /** Named Claude subagents for an opt-in, lead-orchestrated team run (SDK `agents`). Each is a
   *  governed subagent whose tool calls re-enter this session's `canUseTool`, so the path-fence
   *  still holds for their writes (verified — spike/agent-team-spike-findings.md). Unset = a normal
   *  single worker (default; behaviour byte-for-byte unchanged). */
  agents?: Record<string, AgentDefinition>;
  /** Extra env for the spawned worker, merged over process.env after SDK-specific filtering. */
  env?: Record<string, string>;
  /** Codex SDK controls. These are ignored by the Claude adapter. */
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalMode;
  codexSkipGitRepoCheck?: boolean;
  codexNetworkAccessEnabled?: boolean;
  codexWebSearchMode?: CodexWebSearchMode;
}

/** Why an API call failed, as the SDK reports it (SDKAssistantMessageError). "rate_limit" and
 *  "overloaded" are the server-side throttles that produce the operator-visible
 *  "API Error: Server is temporarily limiting requests" line. */
export type ApiErrorKind =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "authentication_failed"
  | "billing_error"
  | "invalid_request"
  | "model_not_found"
  | "max_output_tokens"
  | "unknown";

/** Map the result's HTTP status to an error kind, for when no assistant error field arrived. */
function apiErrorFromStatus(status: number | null | undefined): ApiErrorKind | undefined {
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 401 || status === 403) return "authentication_failed";
  if (typeof status === "number" && status >= 500) return "server_error";
  return undefined;
}

function apiErrorFromMessage(message: string): ApiErrorKind | undefined {
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("rate limited") || lower.includes("temporarily limiting requests") || lower.includes("429")) {
    return "rate_limit";
  }
  if (lower.includes("overloaded") || lower.includes("529")) return "overloaded";
  if (lower.includes("401") || lower.includes("403") || lower.includes("authentication")) return "authentication_failed";
  if (lower.includes("billing")) return "billing_error";
  if (lower.includes("invalid request")) return "invalid_request";
  if (lower.includes("model") && lower.includes("not found")) return "model_not_found";
  if (lower.includes("max output")) return "max_output_tokens";
  return undefined;
}

export interface RunResult {
  ok: boolean;
  /** SDK session id, for resume/fork. */
  sessionId: string;
  summary: string;
  costUsd: number;
  /** Set when the turn ended on an API failure rather than the worker finishing. The SDK reports
   *  this as subtype:"success" WITH is_error:true, so reading the subtype alone recorded a
   *  throttled turn as done and silently dropped the brief. */
  apiError?: ApiErrorKind;
}

/** A live, long-running session: push follow-ups, interrupt, await the final result. */
export interface SessionRun extends SessionControl {
  /** Resolves when the session ends (interrupt / idle-close / worker completion). */
  done: Promise<RunResult>;
  /** Follow-ups waiting behind the in-flight turn. */
  queued(): number;
  /** Graceful close: end the input channel WITHOUT interrupting the SDK — the stream drains and
   *  `done` resolves with the last turn's result. The session stays resumable. */
  close(): void;
}

// Loosely-typed view of the SDK so the runner is testable with an injected fake.
type SdkMessage = { type: string; [k: string]: unknown };
// Shape matches the SDK's SDKUserMessage (sdk.d.ts): parent_tool_use_id is REQUIRED.
type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: string | null;
};
type QueryObject = AsyncIterable<SdkMessage> & { interrupt?: () => Promise<void> };
type QueryFn = (args: {
  prompt: string | AsyncIterable<SdkUserMessage>;
  options: Record<string, unknown>;
}) => QueryObject;
type CodexStreamedTurn = { events: AsyncGenerator<CodexThreadEvent> };
type CodexThreadLike = {
  readonly id: string | null;
  runStreamed(input: string, turnOptions?: { signal?: AbortSignal }): Promise<CodexStreamedTurn>;
};
type CodexClientLike = {
  startThread(options?: CodexThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadLike;
};
export type CodexFactory = (options: CodexOptions) => CodexClientLike | Promise<CodexClientLike>;

function userMessage(text: string): SdkUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

// The governance hook: governor decides; risky tools escalate to the human. The allow
// decision MUST echo updatedInput (docs/sdk-notes.md) — a bare allow is a ZodError.
// Exported for direct unit testing of the fail-safe/self-heal contract (approval-resilience.test.ts).
export function buildCanUseTool(handlers: RunHandlers, folder: string) {
  return async (tool: string, input: Record<string, unknown>) => {
    // The whole decision path is wrapped so this callback can NEVER reject. A rejected canUseTool is
    // turned by the SDK into an ungoverned permission failure with no recovery — the worker surfaces
    // it as `Tool permission request failed: Error: …` and, because the callback keeps rejecting,
    // every subsequent risky tool fails identically (the "approval channel dead without recovery"
    // the operator saw when the escalation round-trip broke mid-session during MCP reconnect churn).
    // Any failure here — onEscalation rejecting on a closed stream, or an unexpected throw — FAILS
    // SAFE to a governed deny per default-escalate policy: never a thrown/hung callback, and never a
    // silent auto-approve (a broken channel must not open a hole). The wrapper holds no state across
    // calls, so the moment the channel is healthy again the next tool call escalates normally
    // (self-heal — a transient break can't permanently wedge tool approvals).
    try {
      const verdict = decide(tool, input, { folder });
      if ("allow" in verdict) {
        return { behavior: "allow", updatedInput: verdict.updatedInput ?? input };
      }
      // deny verdict — refuse outright (never escalate, never auto-approve); the message reaches
      // the worker as the tool result, steering it (e.g. AskUserQuestion → ask in plain text).
      if ("deny" in verdict) {
        return { behavior: "deny", message: verdict.deny };
      }
      // escalate verdict — auto-approve if this project is trusted (read the thunk NOW, not at start)
      if (handlers.autoApprove?.()) {
        handlers.onAutoApprove?.(verdict.escalate);
        return { behavior: "allow", updatedInput: input };
      }
      const decision = await handlers.onEscalation(verdict.escalate);
      if (decision === "allow") return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: `denied by Neo: ${verdict.escalate}` };
    } catch (err) {
      // The approval bridge itself failed (e.g. the operator/approval channel closed mid-escalation
      // — "Stream closed"). Fail safe: deny, and surface it so a genuinely dead channel is visible
      // in the event log; the next call re-attempts against a possibly-recovered channel.
      const reason = err instanceof Error ? err.message : String(err);
      handlers.onEvent?.("approval_error", { tool, error: reason });
      return {
        behavior: "deny",
        message: `denied by Neo: approval channel unavailable (${reason}); retry once it recovers`,
      };
    }
  };
}

function sdkOptions(
  order: Order,
  handlers: RunHandlers,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cwd: order.folder,
    // "user" loads ~/.claude enabledPlugins (superpowers + workflow skills); "project" loads the folder's CLAUDE.md/.claude/.mcp.
    settingSources: ["user", "project"],
    // Explicitly enable every discovered skill. Omitting this leaves skills to ambient CLI
    // defaults (fragile across hosts); "all" makes superpowers + workflow skills always ready
    // for the worker, in any project folder. (SDK: the single switch to turn skills on.)
    skills: "all",
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: "default",
    // Stream partial/streaming message events (SDKPartialAssistantMessage, type "stream_event")
    // during generation, so a single long turn keeps producing SDK events instead of going quiet
    // for minutes — that steady drip is what keeps the dispatch stall monitor alive (BUG 1).
    includePartialMessages: true,
    canUseTool: buildCanUseTool(handlers, order.folder),
    ...extra,
  };
}

// Drain the SDK message stream into a RunResult, forwarding assistant text to the channel.
async function consumeStream(queryObj: QueryObject, handlers: RunHandlers): Promise<RunResult> {
  let ok = false;
  let sessionId = "";
  let summary = "";
  let costUsd = 0;
  let apiError: ApiErrorKind | undefined; // set by the assistant fallback message / the result's status
  let lastApiError: ApiErrorKind | undefined; // the error of the LAST turn only (for the final return)

  try {
    for await (const msg of queryObj) {
      // Liveness first: ANY streamed event proves the worker is alive and producing — reset the
      // stall clock before dispatching on type, so a long single generation (partial deltas only,
      // no completed turn) or a long tool execution never reads as silence (BUG 1).
      handlers.onHeartbeat?.();
      if (typeof msg.session_id === "string") sessionId = msg.session_id;

      if (msg.type === "assistant") {
        // The API-error fallback: the CLI gives up after its own retries and emits an assistant
        // message carrying the error kind. Remember it — the result that follows only has a status.
        if (typeof msg.error === "string") apiError = msg.error as ApiErrorKind;
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const b of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
            if (b?.type === "text" && b.text?.trim()) {
              handlers.onActivity?.("replying");
              handlers.onMessage(b.text.trim());
            } else if (b?.type === "tool_use" && typeof b.name === "string") {
              const short = b.name.startsWith("mcp__") ? b.name.split("__").pop() ?? b.name : b.name;
              const detail = toolDetail(b.input);
              handlers.onActivity?.(`${short}${detail ? `: ${detail}` : ""}`);
              const line = toolMilestone(b.name, b.input);
              if (line) handlers.onMessage(line);
            }
          }
        }
      } else if (msg.type === "system" && msg.subtype === "api_retry") {
        // The SDK is retrying a retryable API failure itself (its own backoff). Not a failure yet —
        // surface it as activity so the watchdog counts it as liveness and /status shows the wait.
        handlers.onActivity?.(`api retry ${msg.attempt ?? "?"}/${msg.max_retries ?? "?"}`);
        handlers.onEvent?.("sdk_api_retry", { attempt: msg.attempt ?? null, max: msg.max_retries ?? null });
      } else if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info as RateLimitInfo | undefined;
        if (info) handlers.onRateLimit?.(info);
      } else if (msg.type === "result") {
        // is_error marks an API failure that the SDK could not recover from — the subtype is still
        // "success", so it MUST be read too or a throttled turn passes as a completed one.
        const failed = msg.is_error === true;
        ok = msg.subtype === "success" && !failed;
        // Only surface an API error when THIS turn actually failed. `apiError` may have been set by an
        // assistant fallback earlier in the SAME session (a prior throttled turn that then recovered on
        // a retry); a later successful turn must NOT inherit it, or the engine falsely reports "work is
        // NOT done" on completed work (the leak-across-turns bug).
        summary = typeof msg.result === "string" ? msg.result : "";
        const turnError = failed
          ? (apiError ?? apiErrorFromStatus(msg.api_error_status as number | null) ?? apiErrorFromMessage(summary) ?? "unknown")
          : undefined;
        costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
        handlers.onCost?.(costUsd);
        // Turn boundary: the worker is waiting for the next input, not mid-turn — the
        // watchdog must not treat this as silence or a grinding activity (F1).
        handlers.onActivity?.("waiting");
        handlers.onTurnComplete?.({ ok, sessionId, summary, costUsd, apiError: turnError });
        lastApiError = turnError;
        apiError = undefined; // reset per-turn so this turn's throttle can't taint the next turn
      }
    }
  } catch {
    // The SDK throws from readMessages when a turn is interrupted mid-tool-use
    // (idle-close / kill — verified via the P2 spike). Treat it as the session ending,
    // not a crash, so `done` resolves and the pipeline's supervise/cleanup still runs.
    if (!summary) summary = "interrupted";
    handlers.onEvent?.("session_interrupted");
  }

  return { ok, sessionId, summary, costUsd, apiError: lastApiError };
}

// A pushable async-iterable input channel: yields queued user messages, parks until the
// next push, and ends once closed and drained (graceful close lets the in-flight turn finish).
function createInputChannel(first: SdkUserMessage) {
  const queue: SdkUserMessage[] = [first];
  let wake: (() => void) | null = null;
  let closed = false;

  const iterator = (async function* () {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();

  return {
    iterator,
    push(msg: SdkUserMessage) {
      if (closed) return;
      queue.push(msg);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    queued() {
      return queue.length;
    },
  };
}

function codexEffort(effort: EffortLevel | undefined): CodexReasoningEffort | undefined {
  if (!effort) return undefined;
  if (effort === "max") return "xhigh";
  return effort;
}

function codexThreadOptions(order: Order, deps: RunDeps): CodexThreadOptions {
  const model = resolveModelSelection("codex", deps);
  const c: CodexThreadOptions = {
    workingDirectory: order.folder,
    sandboxMode: deps.codexSandboxMode ?? (readOnlySandboxRequested(deps.disallowedTools) ? "read-only" : "workspace-write"),
    approvalPolicy: deps.codexApprovalPolicy ?? "on-request",
    skipGitRepoCheck: deps.codexSkipGitRepoCheck ?? true,
  };
  if (model.model) c.model = model.model;
  const effort = codexEffort(model.effort);
  if (effort) c.modelReasoningEffort = effort;
  if (deps.codexNetworkAccessEnabled !== undefined) c.networkAccessEnabled = deps.codexNetworkAccessEnabled;
  if (deps.codexWebSearchMode) c.webSearchMode = deps.codexWebSearchMode;
  return c;
}

function mergedSdkEnv(provider: Provider, env: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return filterSdkEnv(provider, { ...merged, ...env });
}

function codexClientOptions(deps: RunDeps): CodexOptions {
  const c: CodexOptions = {};
  if (deps.env) c.env = mergedSdkEnv("codex", deps.env);
  return c;
}

async function makeCodexClient(deps: RunDeps): Promise<CodexClientLike> {
  const factory = deps.codexFactory ?? ((options: CodexOptions) => new Codex(options));
  return factory(codexClientOptions(deps));
}

function apiErrorFromCodexMessage(message: string): ApiErrorKind | undefined {
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("overloaded") || lower.includes("529")) return "overloaded";
  if (lower.includes("401") || lower.includes("403") || lower.includes("authentication")) return "authentication_failed";
  if (lower.includes("billing")) return "billing_error";
  if (lower.includes("model") && lower.includes("not found")) return "model_not_found";
  return undefined;
}

function codexItemMilestone(item: { type?: string; [k: string]: unknown }): string | undefined {
  if (item.type === "command_execution" && typeof item.command === "string") {
    return toolMilestone("Bash", { command: item.command });
  }
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    const first = item.changes.find((c) => c && typeof c === "object") as { path?: unknown } | undefined;
    return toolMilestone("Edit", { path: typeof first?.path === "string" ? first.path : undefined });
  }
  if (item.type === "mcp_tool_call" && typeof item.tool === "string") {
    return toolMilestone(String(item.tool), item.arguments);
  }
  return undefined;
}

function codexItemActivity(item: { type?: string; [k: string]: unknown }): string | undefined {
  if (item.type === "command_execution" && typeof item.command === "string") {
    return `Bash${item.command ? `: ${toolDetail({ command: item.command })}` : ""}`;
  }
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    const first = item.changes.find((c) => c && typeof c === "object") as { path?: unknown } | undefined;
    const path = typeof first?.path === "string" ? first.path : "";
    return `Edit${path ? `: ${toolDetail({ path })}` : ""}`;
  }
  if (item.type === "mcp_tool_call" && typeof item.tool === "string") {
    const detail = toolDetail(item.arguments);
    return `${item.tool}${detail ? `: ${detail}` : ""}`;
  }
  return undefined;
}

async function consumeCodexTurn(
  thread: CodexThreadLike,
  input: string,
  handlers: RunHandlers,
  signal?: AbortSignal,
): Promise<RunResult> {
  let ok = false;
  let sessionId = thread.id ?? "";
  let summary = "";
  let apiError: ApiErrorKind | undefined;

  try {
    const { events } = await thread.runStreamed(input, signal ? { signal } : undefined);
    for await (const event of events) {
      handlers.onHeartbeat?.();
      if (event.type === "thread.started") {
        sessionId = event.thread_id;
      } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        const item = event.item as { type?: string; text?: string; message?: string; [k: string]: unknown };
        if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
          summary = item.text.trim();
          handlers.onActivity?.("replying");
          handlers.onMessage(summary);
        } else if (event.type === "item.completed" && item.type === "error" && typeof item.message === "string") {
          summary = item.message;
          apiError = apiErrorFromCodexMessage(summary);
        } else {
          const label = codexItemActivity(item);
          if (label) handlers.onActivity?.(label);
          if (event.type === "item.completed") {
            const line = codexItemMilestone(item);
            if (line) handlers.onMessage(line);
          }
        }
      } else if (event.type === "turn.completed") {
        ok = true;
        handlers.onActivity?.("waiting");
        const result = { ok, sessionId: sessionId || thread.id || "", summary, costUsd: 0, apiError };
        handlers.onTurnComplete?.(result);
      } else if (event.type === "turn.failed") {
        ok = false;
        summary = event.error.message;
        apiError = apiErrorFromCodexMessage(summary) ?? "unknown";
        const result = { ok, sessionId: sessionId || thread.id || "", summary, costUsd: 0, apiError };
        handlers.onTurnComplete?.(result);
      } else if (event.type === "error") {
        ok = false;
        summary = event.message;
        apiError = apiErrorFromCodexMessage(summary) ?? "unknown";
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    summary = summary || reason || "interrupted";
    apiError = apiErrorFromCodexMessage(summary);
    if (signal?.aborted) handlers.onEvent?.("session_interrupted");
    else handlers.onEvent?.("worker_error", { provider: "codex", error: reason });
  }

  return { ok, sessionId: sessionId || thread.id || "", summary, costUsd: 0, apiError };
}

function createTextTurnQueue(first: string) {
  const queue: string[] = [first];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(text: string) {
      if (closed) return;
      queue.push(text);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    queued() {
      return queue.length;
    },
    async next(): Promise<string | undefined> {
      while (queue.length === 0) {
        if (closed) return undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return queue.shift();
    },
  };
}

function resolvedRunDeps(deps: RunDeps, provider: WorkerModelProvider, handlers?: RunHandlers): RunDeps {
  const model = resolveModelSelection(provider, deps);
  if (model.changed) {
    handlers?.onEvent?.("worker_model_resolve", {
      provider,
      from: model.originalModel,
      model: model.model ?? null,
      effort: model.effort ?? null,
      reason: model.reason,
    });
  }
  return { ...deps, model: model.model, effort: model.effort };
}

// Only-defined keys survive into the SDK options (so absent fields aren't sent as undefined).
export function runConfig(deps: RunDeps, provider: Provider = deps.provider ?? "subscription"): Record<string, unknown> {
  const resolved = resolveModelSelection(provider, deps);
  const c: Record<string, unknown> = {};
  const values: Record<RunConfigField, unknown> = {
    resume: deps.resume || undefined,
    effort: resolved.effort,
    mcpServers: deps.mcpServers,
    disallowedTools: deps.disallowedTools,
    model: resolved.model,
    skills: deps.skills,
    maxTurns: deps.maxTurns || undefined,
    agents: deps.agents,
    env: deps.env ? mergedSdkEnv(provider, deps.env) : undefined,
  };
  for (const field of supportedRunConfigFields(provider)) {
    const value = values[field];
    if (value !== undefined) c[field] = value;
  }
  return c;
}

/** Single-shot: open `order.folder` and run one task to completion. */
export async function runOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): Promise<RunResult> {
  if (deps.provider === "codex") return runCodexOrder(order, handlers, deps);
  return runClaudeOrder(order, handlers, deps);
}

async function runClaudeOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): Promise<RunResult> {
  deps = resolvedRunDeps(deps, "subscription", handlers);
  const query: QueryFn = deps.query ?? (realQuery as unknown as QueryFn);
  const options = sdkOptions(order, handlers, runConfig(deps));
  handlers.onEvent?.("session_start", { folder: order.folder, resume: !!deps.resume });
  return consumeStream(query({ prompt: order.task, options }), handlers);
}

async function runCodexOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): Promise<RunResult> {
  deps = resolvedRunDeps(deps, "codex", handlers);
  handlers.onEvent?.("session_start", { folder: order.folder, resume: !!deps.resume, provider: "codex" });
  const unsupported = unsupportedRunFields("codex", deps);
  if (unsupported.length) handlers.onEvent?.("worker_compat_warning", { provider: "codex", unsupported });
  const client = await makeCodexClient(deps);
  const options = codexThreadOptions(order, deps);
  const thread = deps.resume ? client.resumeThread(deps.resume, options) : client.startThread(options);
  return consumeCodexTurn(thread, order.task, handlers);
}

/** Live session: open `order.folder` and keep it warm for streamed follow-ups. */
export function startOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): SessionRun {
  if (deps.provider === "codex") return startCodexOrder(order, handlers, deps);
  return startClaudeOrder(order, handlers, deps);
}

function startClaudeOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): SessionRun {
  deps = resolvedRunDeps(deps, "subscription", handlers);
  const query: QueryFn = deps.query ?? (realQuery as unknown as QueryFn);
  const channel = createInputChannel(userMessage(order.task));
  handlers.onEvent?.("session_start", { folder: order.folder, resume: !!deps.resume });
  const queryObj = query({ prompt: channel.iterator, options: sdkOptions(order, handlers, runConfig(deps)) });
  const done = consumeStream(queryObj, handlers);

  return {
    followUp: (text) => channel.push(userMessage(text)),
    interrupt: async () => {
      channel.close();
      try {
        await queryObj.interrupt?.();
      } catch {
        // best-effort — the worker may already be ending
      }
    },
    queued: () => channel.queued(),
    close: () => channel.close(),
    done,
  };
}

function startCodexOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): SessionRun {
  deps = resolvedRunDeps(deps, "codex", handlers);
  const queue = createTextTurnQueue(order.task);
  let currentAbort: AbortController | undefined;
  let interruptRequested = false;

  const done = (async () => {
    handlers.onEvent?.("session_start", { folder: order.folder, resume: !!deps.resume, provider: "codex" });
    const unsupported = unsupportedRunFields("codex", deps);
    if (unsupported.length) handlers.onEvent?.("worker_compat_warning", { provider: "codex", unsupported });
    let final: RunResult = { ok: false, sessionId: deps.resume ?? "", summary: "", costUsd: 0 };
    try {
      const client = await makeCodexClient(deps);
      const options = codexThreadOptions(order, deps);
      const thread = deps.resume ? client.resumeThread(deps.resume, options) : client.startThread(options);
      for (;;) {
        const next = await queue.next();
        if (next === undefined) break;
        currentAbort = new AbortController();
        final = await consumeCodexTurn(thread, next, handlers, currentAbort.signal);
        currentAbort = undefined;
        if (!final.ok) break;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      final = { ok: false, sessionId: final.sessionId, summary: reason, costUsd: 0, apiError: apiErrorFromCodexMessage(reason) };
    }
    if (interruptRequested && !final.summary) {
      handlers.onEvent?.("session_interrupted");
      return { ...final, summary: "interrupted" };
    }
    return final;
  })();

  return {
    followUp: (text) => queue.push(text),
    interrupt: async () => {
      interruptRequested = true;
      queue.close();
      currentAbort?.abort();
    },
    queued: () => queue.queued(),
    close: () => queue.close(),
    done,
  };
}
