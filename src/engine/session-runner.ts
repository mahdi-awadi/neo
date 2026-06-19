// The execution core: opens a project folder as a headless Claude Code worker via the
// Claude Agent SDK and streams its work back to the engine. Replaces operant's tmux +
// shim + Ink-scraping entirely.
//
// Two entry points:
//   runOrder   — single-shot: open the folder, run one task to completion (Phase-1 path).
//   startOrder — live session: keep the worker warm on a streaming input channel so the
//                engine can push follow-up messages mid-run, then interrupt / idle-close it.
//
// Verified SDK surface (docs/sdk-notes.md): query({ prompt, options }) -> async generator.
//   options: cwd, settingSources:["project"], systemPrompt preset, permissionMode, canUseTool.
//
// ASSUMED (build-then-verify, isolated here): `prompt` may be an AsyncIterable<SDKUserMessage>
// for streaming input, the returned Query exposes interrupt(), and options.resume resumes a
// prior session id. These are reconciled against a real run before Phase 2 ships.
//
// SPIKE FINDING (docs/sdk-notes.md): the canUseTool ALLOW decision MUST echo `updatedInput`.
//
// Auth: draws from your Claude subscription (current behavior; see README + plan).
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Order, SessionControl } from "../types";
import type { RateLimitInfo } from "./usage";
import { decide } from "./governor";

export interface RunHandlers {
  /** Stream a human-readable line from the worker back to the channel. */
  onMessage: (text: string) => void;
  /** Ask the human to approve a risky tool; resolves with their decision. */
  onEscalation: (reason: string) => Promise<"allow" | "deny">;
  /** Reported the SDK's running cost (`total_cost_usd`) as each turn completes. */
  onCost?: (usd: number) => void;
  /** Reported subscription rate-limit info from the SDK's rate_limit_event. */
  onRateLimit?: (info: RateLimitInfo) => void;
}

/** Per-run dependencies/config: an injectable query (tests) and an optional resume id. */
export interface RunDeps {
  query?: QueryFn;
  /** Resume a prior SDK session id (idle-close → resume). */
  resume?: string;
}

export interface RunResult {
  ok: boolean;
  /** SDK session id, for resume/fork. */
  sessionId: string;
  summary: string;
  costUsd: number;
}

/** A live, long-running session: push follow-ups, interrupt, await the final result. */
export interface SessionRun extends SessionControl {
  /** Resolves when the session ends (interrupt / idle-close / worker completion). */
  done: Promise<RunResult>;
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

function userMessage(text: string): SdkUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

// The governance hook: governor decides; risky tools escalate to the human. The allow
// decision MUST echo updatedInput (docs/sdk-notes.md) — a bare allow is a ZodError.
function buildCanUseTool(handlers: RunHandlers) {
  return async (tool: string, input: Record<string, unknown>) => {
    const verdict = decide(tool, input);
    if ("allow" in verdict) {
      return { behavior: "allow", updatedInput: verdict.updatedInput ?? input };
    }
    const decision = await handlers.onEscalation(verdict.escalate);
    if (decision === "allow") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: `denied by Neo: ${verdict.escalate}` };
  };
}

function sdkOptions(
  order: Order,
  handlers: RunHandlers,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cwd: order.folder,
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: "default",
    canUseTool: buildCanUseTool(handlers),
    ...extra,
  };
}

// Drain the SDK message stream into a RunResult, forwarding assistant text to the channel.
async function consumeStream(queryObj: QueryObject, handlers: RunHandlers): Promise<RunResult> {
  let ok = false;
  let sessionId = "";
  let summary = "";
  let costUsd = 0;

  try {
    for await (const msg of queryObj) {
      if (typeof msg.session_id === "string") sessionId = msg.session_id;

      if (msg.type === "assistant") {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const b of content as Array<{ type?: string; text?: string }>) {
            if (b?.type === "text" && b.text?.trim()) handlers.onMessage(b.text.trim());
          }
        }
      } else if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info as RateLimitInfo | undefined;
        if (info) handlers.onRateLimit?.(info);
      } else if (msg.type === "result") {
        ok = msg.subtype === "success";
        summary = typeof msg.result === "string" ? msg.result : "";
        costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
        handlers.onCost?.(costUsd);
      }
    }
  } catch {
    // The SDK throws from readMessages when a turn is interrupted mid-tool-use
    // (idle-close / kill — verified via the P2 spike). Treat it as the session ending,
    // not a crash, so `done` resolves and the pipeline's supervise/cleanup still runs.
    if (!summary) summary = "interrupted";
  }

  return { ok, sessionId, summary, costUsd };
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
  };
}

// Only-defined keys survive into the SDK options (so an absent resume isn't sent as undefined).
function runConfig(deps: RunDeps): Record<string, unknown> {
  return deps.resume ? { resume: deps.resume } : {};
}

/** Single-shot: open `order.folder` and run one task to completion. */
export async function runOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): Promise<RunResult> {
  const query: QueryFn = deps.query ?? (realQuery as unknown as QueryFn);
  const options = sdkOptions(order, handlers, runConfig(deps));
  return consumeStream(query({ prompt: order.task, options }), handlers);
}

/** Live session: open `order.folder` and keep it warm for streamed follow-ups. */
export function startOrder(
  order: Order,
  handlers: RunHandlers,
  deps: RunDeps = {},
): SessionRun {
  const query: QueryFn = deps.query ?? (realQuery as unknown as QueryFn);
  const channel = createInputChannel(userMessage(order.task));
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
    done,
  };
}
