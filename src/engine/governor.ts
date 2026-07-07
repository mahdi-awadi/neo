// Deterministic tool policy: allow a known-safe set, path-fence writes, escalate everything
// else to a human. Default-ESCALATE: a tool this file doesn't recognize asks the operator.
// This is half of the "AI orders, engine governs" boundary (the other half is the provider
// firewall). Wired into the SDK via the `canUseTool` callback. Autonomous paths (loops,
// customer-driven briefs) auto-deny escalations, so for them default-escalate = default-deny.
import { resolve, sep } from "node:path";
import type { Verdict } from "../types";

/** Per-session context the governor judges against (the worker's project folder = SDK cwd). */
export interface GovernorCtx {
  folder: string;
}

/** Risky bash patterns that must never auto-run — they escalate to Neo. Defense-in-depth
 *  only (a keyword regex is bypassable); the real guards are the path fence + default-escalate. */
export const RISKY_BASH =
  /\b(rm|deploy|git\s+push|force|curl|wget|sudo|prod(uction)?|drop\s+table|shutdown|reboot|chmod\s+-R|dd|mkfs|p?kill|npm\s+publish|gh\s+pr\s+merge|ssh|scp|truncate)\b|\bfind\b.*?\s-delete\b/is;

/** Tools that are always safe to auto-allow (read-only / local bookkeeping). `Task`/`Agent`
 *  are safe because subagent tool calls re-enter canUseTool and are governed individually. */
export const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "NotebookRead",
  "ListMcpResources",
  "WebSearch",
  "Task",
  "Agent",
]);

/** Tools that write files — allowed only inside the session's project folder. */
const FENCED_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** True iff `filePath` (absolute or folder-relative) resolves inside `folder`. Fails closed. */
function insideFolder(filePath: string, folder: string): boolean {
  if (!filePath || !folder) return false;
  try {
    const base = resolve(folder);
    const target = resolve(base, filePath);
    return target === base || target.startsWith(base + sep);
  } catch {
    return false;
  }
}

export function decide(tool: string, input: Record<string, unknown>, ctx: GovernorCtx): Verdict {
  // The SDK's structured-question tool can't be serviced headlessly: its options never reach
  // the operator's channel and there's no path to feed an answer back. Deny it and steer the
  // worker to ask in plain text — the channel surfaces that and the reply returns as a follow-up.
  if (tool === "AskUserQuestion") {
    return {
      deny: "Neo has no structured-question UI. Ask the operator your question in plain text instead; their reply arrives as a normal follow-up message. Do not assume a default — wait for the answer.",
    };
  }

  if (SAFE_TOOLS.has(tool)) return { allow: true };

  // Neo's own in-process MCP tools (dispatch, ...). Foreign mcp__* falls to default-escalate.
  if (tool.startsWith("mcp__neo__")) return { allow: true };

  if (FENCED_TOOLS.has(tool)) {
    const raw = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    const path = typeof raw === "string" ? raw : "";
    if (insideFolder(path, ctx.folder)) return { allow: true };
    return {
      escalate: `file write outside the project folder: ${path || "(no path)"} (folder: ${ctx.folder || "(unset)"})`,
    };
  }

  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (RISKY_BASH.test(command)) return { escalate: `risky shell command: ${command}` };
    return { allow: true };
  }

  // Default: escalate. New/unknown SDK tools, WebFetch (exfiltration channel), foreign MCP.
  return { escalate: `unrecognized tool: ${tool}` };
}
