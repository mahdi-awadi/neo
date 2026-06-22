// Deterministic tool policy: auto-allow safe tools, escalate risky ones to a human.
// This is half of the "AI orders, engine governs" boundary (the other half is the
// provider firewall). Wired into the SDK via the `canUseTool` callback.
// Phase 1 (TDD): each branch gets a test; ported from operant's autopilot-risk keywords.
import type { Verdict } from "../types";

/** Risky bash patterns that must never auto-run — they escalate to Neo. */
export const RISKY_BASH =
  /\b(rm|deploy|git\s+push|force|curl|wget|sudo|prod(uction)?|drop\s+table|shutdown|reboot|chmod\s+-R)\b/i;

/** Tools that are always safe to auto-allow (read-only / in-folder). */
export const SAFE_TOOLS = new Set(["Read", "Glob", "Grep"]);

export function decide(tool: string, input: Record<string, unknown>): Verdict {
  // The SDK's structured-question tool can't be serviced headlessly: its options never reach
  // the operator's channel (only assistant text does) and there's no path to feed an answer
  // back, so the worker reads the empty result as "you didn't pick" and guesses. Deny it and
  // steer the worker to ask in plain text — which the channel surfaces and the operator's reply
  // returns as a follow-up.
  if (tool === "AskUserQuestion") {
    return {
      deny: "Neo has no structured-question UI. Ask the operator your question in plain text instead; their reply arrives as a normal follow-up message. Do not assume a default — wait for the answer.",
    };
  }

  if (SAFE_TOOLS.has(tool)) return { allow: true };

  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (RISKY_BASH.test(command)) {
      return { escalate: `risky shell command: ${command}` };
    }
    return { allow: true };
  }

  // Other tools (Write, Edit, ...) act within the project folder — allow.
  return { allow: true };
}
