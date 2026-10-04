// Deterministic tool policy: allow a known-safe set, path-fence writes, escalate everything
// else to a human. Default-ESCALATE: a tool this file doesn't recognize asks the operator.
// This is half of the "AI orders, engine governs" boundary (the other half is the provider
// firewall). Wired into the SDK via the `canUseTool` callback. Autonomous paths (loops,
// customer-driven briefs) auto-deny escalations, so for them default-escalate = default-deny.
import { resolve, sep } from "node:path";
import type { Verdict } from "../types";

/** Per-connector access level (config `connectors`). `read` lets read-named tools flow and asks
 *  before anything outbound; `send` allows every tool on the server; `deny` blocks it outright. */
export type ConnectorAccess = "deny" | "read" | "send";
/** Per-tool override inside a connector: `allow` / `ask` (escalate) / `deny`. */
export type ConnectorToolRule = "allow" | "ask" | "deny";
export type ConnectorPolicy = ConnectorAccess | { access?: ConnectorAccess; tools?: Record<string, ConnectorToolRule> };
/** MCP server name → policy. Unlisted servers keep the default: escalate every tool. */
export type ConnectorPolicies = Record<string, ConnectorPolicy>;

/** Per-session context the governor judges against (the worker's project folder = SDK cwd). */
export interface GovernorCtx {
  folder: string;
  /** Operator-configured connector scopes (config.json `connectors`). Unset = escalate all. */
  connectors?: ConnectorPolicies;
}

const ACCESS_LEVELS = new Set<ConnectorAccess>(["deny", "read", "send"]);
const TOOL_RULES = new Set<ConnectorToolRule>(["allow", "ask", "deny"]);

/** Validate a raw config value. Malformed entries are dropped, so they fall back to escalate. */
export function normalizeConnectors(raw: unknown): ConnectorPolicies {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ConnectorPolicies = {};
  for (const [server, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (ACCESS_LEVELS.has(value as ConnectorAccess)) out[server] = value as ConnectorAccess;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as { access?: unknown; tools?: unknown };
    const access = ACCESS_LEVELS.has(v.access as ConnectorAccess) ? (v.access as ConnectorAccess) : undefined;
    const tools: Record<string, ConnectorToolRule> = {};
    if (v.tools && typeof v.tools === "object" && !Array.isArray(v.tools)) {
      for (const [tool, rule] of Object.entries(v.tools as Record<string, unknown>)) {
        if (TOOL_RULES.has(rule as ConnectorToolRule)) tools[tool] = rule as ConnectorToolRule;
      }
    }
    if (!access && Object.keys(tools).length === 0) continue;
    out[server] = access ? { access, tools } : { tools };
  }
  return out;
}

/** `mcp__<server>__<tool>` → its parts. The server name is everything up to the next `__`. */
export function parseMcpTool(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const cut = name.indexOf("__", 5);
  if (cut <= 5 || cut + 2 >= name.length) return undefined;
  return { server: name.slice(5, cut), tool: name.slice(cut + 2) };
}

/** Verbs that name a read. Deterministic name match only (no AI judge): a tool whose first word
 *  is one of these counts as a read under `read` access; everything else is outbound and asks. */
const READ_VERBS = new Set([
  "get", "list", "search", "read", "fetch", "query", "find", "describe", "view", "show", "lookup",
  "count", "retrieve", "browse", "inspect", "preview",
]);

export function isReadToolName(tool: string): boolean {
  const first = tool.split(/[_\-\s]|(?=[A-Z])/)[0]?.toLowerCase() ?? "";
  return READ_VERBS.has(first);
}

function decideConnector(server: string, tool: string, policy: ConnectorPolicy): Verdict {
  const access = typeof policy === "string" ? policy : policy.access;
  const rule = typeof policy === "string" ? undefined : policy.tools?.[tool];
  if (rule === "allow") return { allow: true };
  if (rule === "deny") return { deny: `connector ${server}: ${tool} is denied by Neo's connector config` };
  if (rule === "ask") return { escalate: `connector ${server}: ${tool} needs approval (connector config)` };
  if (access === "deny") return { deny: `connector ${server} is denied by Neo's connector config` };
  if (access === "send") return { allow: true };
  if (access === "read") {
    if (isReadToolName(tool)) return { allow: true };
    return { escalate: `outbound action on read-only connector ${server}: ${tool}` };
  }
  return { escalate: `unrecognized tool: mcp__${server}__${tool}` };
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

  // Foreign MCP tools: the operator's per-connector scopes decide; unlisted servers escalate.
  const mcp = parseMcpTool(tool);
  const policy = mcp ? ctx.connectors?.[mcp.server] : undefined;
  if (mcp && policy !== undefined) return decideConnector(mcp.server, mcp.tool, policy);

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
