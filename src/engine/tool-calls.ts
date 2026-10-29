// The running tool calls of one worker session (ADR-0058): from a tool_use to its tool_result, with the
// SDK task the CLI starts for it (task_started arrives for a foreground Bash call too — see
// docs/sdk-notes.md). The console strip, /stop, /bg and the company's tool_control act on this list.
// Deterministic bookkeeping only.

/** The env var that marks every host process of one Bash call (the governor hook exports it). */
export const MARKER_ENV = "NEO_TOOL_USE_ID";

/** A tool-use id safe to put in a shell line (the SDK's ids are `toolu_` + base62). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `export NEO_TOOL_USE_ID=<id>; <command>` — once; an id that is not a plain token is never added. */
export function markCommand(toolUseId: string, command: string): string {
  if (!SAFE_ID.test(toolUseId)) return command;
  const prefix = `export ${MARKER_ENV}=${toolUseId}; `;
  return command.startsWith(prefix) ? command : prefix + command;
}

export interface RunningCall {
  toolUseId: string;
  tool: string;
  /** The command (first line) or the subagent's description, at most 200 characters. */
  summary: string;
  since: number;
  /** The SDK task the CLI runs it as, once `task_started` named it. */
  taskId?: string;
}

/** The SDK's text when a call was backgrounded: "… Output is being written to: <path>. If …". */
export function logPathOf(text: string): string | undefined {
  return /Output is being written to: (.+?\.output)/.exec(text)?.[1];
}

function summaryOf(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const raw = typeof i.command === "string" ? i.command : typeof i.description === "string" ? i.description : tool;
  return raw.split("\n")[0]!.trim().slice(0, 200);
}

export interface ToolCallsTracker {
  onToolUse(id: string | undefined, tool: string, input: unknown): void;
  onToolResult(id: string | undefined, text?: string): void;
  /** A `system` task_* message from the SDK. */
  onTask(m: { subtype?: unknown; task_id?: unknown; tool_use_id?: unknown; status?: unknown; output_file?: unknown }): void;
  running(): RunningCall[];
  /** The live SDK task of a call (running, or backgrounded and not ended). */
  taskOf(toolUseId: string): string | undefined;
  /** The log of a backgrounded call. */
  logOf(toolUseId: string): string | undefined;
}

export function createToolCalls(now: () => number = () => Date.now()): ToolCallsTracker {
  const calls = new Map<string, RunningCall>();
  const tasks = new Map<string, string>(); // toolUseId -> live taskId
  const logs = new Map<string, string>(); // toolUseId -> output file of a backgrounded call
  return {
    onToolUse(id, tool, input) {
      if (!id) return;
      calls.set(id, { toolUseId: id, tool, summary: summaryOf(tool, input), since: now() });
    },
    onToolResult(id, text) {
      if (!id) return;
      calls.delete(id);
      const log = text ? logPathOf(text) : undefined;
      if (log) logs.set(id, log);
    },
    onTask(m) {
      const toolUseId = typeof m.tool_use_id === "string" ? m.tool_use_id : undefined;
      const taskId = typeof m.task_id === "string" ? m.task_id : undefined;
      if (!toolUseId || !taskId) return;
      if (m.subtype === "task_started") {
        tasks.set(toolUseId, taskId);
        const c = calls.get(toolUseId);
        if (c) c.taskId = taskId;
      } else if (m.subtype === "task_notification") {
        tasks.delete(toolUseId);
        if (typeof m.output_file === "string") logs.set(toolUseId, m.output_file);
      }
    },
    running: () => [...calls.values()].map((c) => ({ ...c })),
    taskOf: (id) => tasks.get(id),
    logOf: (id) => logs.get(id),
  };
}
