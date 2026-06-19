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

export function decide(_tool: string, _input: Record<string, unknown>): Verdict {
  throw new Error("not implemented (Phase 1)");
}
