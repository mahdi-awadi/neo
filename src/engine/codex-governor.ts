// Neo's governor for Codex workers. The Codex SDK has no `canUseTool` hook, so the policy is
// applied in two layers instead:
//   1. Prevent: Neo's rules are mapped onto Codex's own sandbox before the thread starts —
//      writes fenced to the project folder (workspace-write, never danger-full-access), no
//      network, approval "never" (headless: nobody can answer Codex's own prompts, so a request
//      to leave the sandbox fails closed), web search off when the run disallows it.
//   2. Stop: every streamed item (command, file change, MCP call, web search) is judged by the
//      same `decide()` the Claude path uses. Codex can't pause for an answer, so an escalation
//      on an untrusted project, or any deny, aborts the turn and tells the operator.
// Deterministic, no AI — same contract as governor.ts.
import type { SandboxMode, ThreadOptions } from "@openai/codex-sdk";
import type { Verdict } from "../types";
import { decide, type ConnectorPolicies } from "./governor";
import { readOnlySandboxRequested } from "./model-resolver";

export interface CodexGovernorCtx {
  folder: string;
  connectors?: ConnectorPolicies;
  /** The run's deny-list (judge = read-only, ingress = tainted). A listed tool is a hard deny. */
  disallowedTools?: readonly string[];
}

type CodexItem = { type?: string; [k: string]: unknown };

/** Codex item → the governor tool calls it represents. Items that do nothing (messages,
 *  reasoning, todo lists, errors) map to none and are always allowed. */
export function codexItemCalls(item: CodexItem): Array<{ tool: string; input: Record<string, unknown> }> {
  if (item.type === "command_execution") {
    return [{ tool: "Bash", input: { command: typeof item.command === "string" ? item.command : "" } }];
  }
  if (item.type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map((c) => (c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string" ? (c as { path: string }).path : ""));
    // An empty change list still goes through the fence so a malformed item fails closed.
    return (paths.length ? paths : [""]).map((file_path) => ({ tool: "Edit", input: { file_path } }));
  }
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    const args = item.arguments && typeof item.arguments === "object" ? (item.arguments as Record<string, unknown>) : {};
    return [{ tool: `mcp__${server}__${tool}`, input: args }];
  }
  if (item.type === "web_search") {
    return [{ tool: "WebSearch", input: { query: typeof item.query === "string" ? item.query : "" } }];
  }
  return [];
}

/** Codex file changes are one item type for create/update/delete; a deny-list naming any
 *  file-writing tool covers them all. */
const FILE_WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

function disallowed(tool: string, list: readonly string[] | undefined): boolean {
  if (!list?.length) return false;
  if (tool === "Edit") return FILE_WRITE_TOOLS.some((t) => list.includes(t));
  return list.includes(tool);
}

/** The strictest verdict across every call an item makes (deny > escalate > allow). */
export function judgeCodexItem(item: CodexItem, ctx: CodexGovernorCtx): Verdict {
  let escalate: string | undefined;
  for (const { tool, input } of codexItemCalls(item)) {
    if (disallowed(tool, ctx.disallowedTools)) return { deny: `${tool} is not allowed in this run` };
    const v = decide(tool, input, { folder: ctx.folder, connectors: ctx.connectors });
    if ("deny" in v) return v;
    if ("escalate" in v) escalate ??= v.escalate;
  }
  return escalate ? { escalate } : { allow: true };
}

export interface CodexPolicyInput {
  folder: string;
  disallowedTools?: readonly string[];
  sandboxMode?: SandboxMode;
  networkAccessEnabled?: boolean;
  webSearchMode?: ThreadOptions["webSearchMode"];
}

/** Neo's policy as Codex thread options. `clamped` names a requested sandbox that was refused. */
export function codexPolicyOptions(p: CodexPolicyInput): { options: ThreadOptions; clamped?: SandboxMode } {
  const readOnly = readOnlySandboxRequested(p.disallowedTools);
  let sandboxMode: SandboxMode = p.sandboxMode ?? (readOnly ? "read-only" : "workspace-write");
  let clamped: SandboxMode | undefined;
  // The path fence is not optional: full access would let Codex write anywhere on the host.
  if (sandboxMode === "danger-full-access") {
    clamped = sandboxMode;
    sandboxMode = readOnly ? "read-only" : "workspace-write";
  }
  if (readOnly) sandboxMode = "read-only";
  const options: ThreadOptions = {
    workingDirectory: p.folder,
    sandboxMode,
    approvalPolicy: "never",
    // curl/wget/WebFetch escalate on the Claude path; with no way to ask, Codex gets no network
    // unless the operator turns it on explicitly.
    networkAccessEnabled: p.networkAccessEnabled === true && !readOnly,
  };
  if (p.disallowedTools?.includes("WebSearch")) options.webSearchMode = "disabled";
  else if (p.webSearchMode) options.webSearchMode = p.webSearchMode;
  return { options, clamped };
}
