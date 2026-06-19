// The execution core: opens a project folder as a headless Claude Code worker via the
// Claude Agent SDK and streams its work back to the engine. Replaces operant's tmux +
// shim + Ink-scraping entirely.
//
// Verified SDK surface (docs/sdk-notes.md):
//   query({ prompt, options }) -> async generator of messages.
//   options: cwd, settingSources:["project"] (loads the folder's CLAUDE.md/.mcp.json),
//            systemPrompt:{type:"preset",preset:"claude_code"}, permissionMode, canUseTool.
//
// SPIKE FINDING (docs/sdk-notes.md): the canUseTool ALLOW decision MUST echo
// `updatedInput` — { behavior:"allow", updatedInput: input }. A bare { behavior:"allow" }
// is rejected by the SDK with a ZodError and the tool fails.
//
// Auth: draws from your Claude subscription (current behavior; see README + plan).
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Order } from "../types";
import { decide } from "./governor";

export interface RunHandlers {
  /** Stream a human-readable line from the worker back to the channel. */
  onMessage: (text: string) => void;
  /** Ask the human to approve a risky tool; resolves with their decision. */
  onEscalation: (reason: string) => Promise<"allow" | "deny">;
}

export interface RunResult {
  ok: boolean;
  /** SDK session id, for resume/fork. */
  sessionId: string;
  summary: string;
  costUsd: number;
}

// Loosely-typed view of the SDK so the runner is testable with an injected fake.
type SdkMessage = { type: string; [k: string]: unknown };
type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

export async function runOrder(
  order: Order,
  handlers: RunHandlers,
  deps: { query?: QueryFn } = {},
): Promise<RunResult> {
  const query: QueryFn = deps.query ?? (realQuery as unknown as QueryFn);

  // The governance hook: governor decides; risky tools escalate to the human.
  const canUseTool = async (tool: string, input: Record<string, unknown>) => {
    const verdict = decide(tool, input);
    if ("allow" in verdict) {
      return { behavior: "allow", updatedInput: verdict.updatedInput ?? input };
    }
    const decision = await handlers.onEscalation(verdict.escalate);
    if (decision === "allow") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: `denied by Neo: ${verdict.escalate}` };
  };

  let ok = false;
  let sessionId = "";
  let summary = "";
  let costUsd = 0;

  for await (const msg of query({
    prompt: order.task,
    options: {
      cwd: order.folder,
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "default",
      canUseTool,
    },
  })) {
    if (typeof msg.session_id === "string") sessionId = msg.session_id;

    if (msg.type === "assistant") {
      const content = (msg.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; text?: string }>) {
          if (b?.type === "text" && b.text?.trim()) handlers.onMessage(b.text.trim());
        }
      }
    } else if (msg.type === "result") {
      ok = msg.subtype === "success";
      summary = typeof msg.result === "string" ? msg.result : "";
      costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
    }
  }

  return { ok, sessionId, summary, costUsd };
}
