// The execution core: opens a project folder as a headless Claude Code worker via the
// Claude Agent SDK and streams its work back to the engine. Replaces operant's tmux +
// shim + Ink-scraping entirely.
//
// Verified SDK surface (https://code.claude.com/docs/en/agent-sdk/typescript):
//   import { query } from "@anthropic-ai/claude-agent-sdk";
//   const q = query({
//     prompt: order.task,
//     options: {
//       cwd: order.folder,                                   // "open the project"
//       settingSources: ["project", "local"],                // load its CLAUDE.md / .mcp.json / settings
//       systemPrompt: { type: "preset", preset: "claude_code" },
//       permissionMode: "default",
//       canUseTool: (tool, input) => governor.decide(tool, input),  // governance hook
//       mcpServers: { /* operant tools: worker -> engine callback */ },
//     },
//   });
//   for await (const msg of q) { /* msg.type: "assistant" | "result" | "system" | ... */ }
//
// Auth: draws from your Claude subscription (current behavior; see README + plan).
// Phase 1 (TDD): implement runOrder against a mocked `query()`; assert safe tools
// auto-allow, risky tools route to onEscalation, messages forward, result returns.
import type { Order } from "../types";

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
}

export async function runOrder(_order: Order, _handlers: RunHandlers): Promise<RunResult> {
  throw new Error("not implemented (Phase 1)");
}
