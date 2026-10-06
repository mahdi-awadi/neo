// Safe checkpoints and resume orientation (ADR-0014) — deterministic, NO AI. A pure state machine
// fed the raw stream facts the session runner reports (each turn's usage, every tool call and its
// result). It answers two questions the context policy cannot answer from a transcript alone:
//   • is THIS the moment a heavy session can be handed off mid-task? Only right after the work so far
//     is committed (a commit succeeded, or the plan marked a step done) and the tree is clean. Then
//     it ARMS: the governor hook denies every tool except what writing + committing the note needs.
//   • did a session started from a handoff note get going quickly? (CONTEXT.md "Orientation")
import { resolve, join } from "node:path";
import { decideContext, checkpointSteer, type ContextDecision, type ContextPolicyCfg } from "./context-policy";
import { uncommittedIn } from "./dispatch-report";

export interface Armed {
  at: number;
  decision: ContextDecision;
  occupancy: number;
}

export interface CheckpointWatch {
  onUsage(model: string | undefined, usage: Record<string, number>): void;
  onToolUse(id: string | undefined, name: string, input: unknown): void;
  onToolResult(id: string | undefined, isError: boolean): void;
  /** The deny reason for this tool call while armed; undefined = no opinion. */
  steer(toolName: string, input: unknown): string | undefined;
  armed(): Armed | undefined;
  disarm(): void;
  /** The latest measured occupancy (undefined until a turn on a known window). */
  occupancy(): number | undefined;
}

export interface CheckpointWatchOpts {
  folder: string;
  cfg: ContextPolicyCfg;
  /** The known context window per model (contextWindows) — read live, so a window the SDK reports
   *  mid-session counts at once. */
  windows: () => Record<string, number>;
  now?: () => number;
  /** Test seam (default: git). undefined = not a git repo → a mid-task handoff is never safe. */
  uncommitted?: (folder: string) => string[] | undefined;
  onArm?: (armed: Armed) => void;
}

const COMMIT_RE = /\bgit\b[^|;&\n]*\bcommit\b/;
const NOTE_SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite"]);
const NOTE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const PRODUCTIVE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GIT_NOTE_SEGMENT = /^git\s+(status|diff|log|show|add|commit|rev-parse|branch)\b/;

const commandOf = (input: unknown): string => {
  const c = (input as { command?: unknown } | undefined)?.command;
  return typeof c === "string" ? c : "";
};

const isCommit = (name: string, input: unknown): boolean => name === "Bash" && COMMIT_RE.test(commandOf(input));

/** True for the tools a worker needs to write and commit its handoff note: reading, `Write`/`Edit` of
 *  the folder's own `HANDOFF.md`, and a `Bash` made only of read/add/commit git commands. */
export function steerAllows(folder: string, toolName: string, input: unknown): boolean {
  if (NOTE_SAFE_TOOLS.has(toolName)) return true;
  if (NOTE_WRITE_TOOLS.has(toolName)) {
    const fp = (input as { file_path?: unknown } | undefined)?.file_path;
    return typeof fp === "string" && resolve(folder, fp) === join(folder, "HANDOFF.md");
  }
  if (toolName !== "Bash") return false;
  const cmd = commandOf(input);
  if (!cmd.trim() || /[`$<>]/.test(cmd)) return false; // no substitution or redirection
  return cmd.split(/&&|\|\||;|\||\n/).every((seg) => GIT_NOTE_SEGMENT.test(seg.trim()));
}

interface PlanState {
  occ0: number;
  done0: number;
  done: number;
  total: number;
}

export function createCheckpointWatch(o: CheckpointWatchOpts): CheckpointWatch {
  const now = o.now ?? (() => Date.now());
  const uncommitted = o.uncommitted ?? uncommittedIn;
  let occ: number | undefined;
  let plan: PlanState | undefined;
  let armedState: Armed | undefined;
  const commits = new Set<string | undefined>();

  const projected = (): number | undefined => {
    if (!plan || occ === undefined || plan.done <= plan.done0 || plan.total <= plan.done) return undefined;
    const perStep = (occ - plan.occ0) / (plan.done - plan.done0);
    return occ + perStep * (plan.total - plan.done);
  };

  // A safe point was just reached: ask the one policy whether to hand off here.
  const checkpoint = (): void => {
    if (armedState || occ === undefined || o.cfg.checkpointPct >= 1) return;
    const decision = decideContext({ occupancy: occ, turns: 0, ageMs: 0, idleMs: 0 }, o.cfg, Infinity, { boundary: "checkpoint", projected: projected() });
    if (decision.verdict !== "handoff") return;
    const dirty = uncommitted(o.folder);
    if (dirty === undefined || dirty.length > 0) return; // not a git repo, or work not yet committed
    armedState = { at: now(), decision, occupancy: occ };
    o.onArm?.(armedState);
  };

  return {
    onUsage(model, usage) {
      const windows = o.windows();
      const window = (model !== undefined ? windows[model] : undefined) ?? windows.default;
      if (!window) return; // a guessed window never drives a checkpoint (ADR-0013)
      occ = ((usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)) / window;
    },
    onToolUse(id, name, input) {
      if (isCommit(name, input)) commits.add(id);
      if (name !== "TodoWrite") return;
      const todos = (input as { todos?: Array<{ status?: string }> } | undefined)?.todos;
      if (!Array.isArray(todos)) return;
      const done = todos.filter((t) => t?.status === "completed").length;
      const before = plan?.done ?? done;
      if (!plan || occ === undefined) {
        if (occ !== undefined) plan = { occ0: occ, done0: done, done, total: todos.length };
        return;
      }
      plan = { ...plan, done, total: todos.length };
      if (done > before) checkpoint();
    },
    onToolResult(id, isError) {
      if (!commits.delete(id)) return;
      if (!isError) checkpoint();
    },
    steer(toolName, input) {
      if (!armedState || steerAllows(o.folder, toolName, input)) return undefined;
      return checkpointSteer(armedState.occupancy);
    },
    armed: () => armedState,
    disarm() {
      armedState = undefined;
    },
    occupancy: () => occ,
  };
}

export interface ResumeProbe {
  onUsage(): void;
  onToolUse(id: string | undefined, name: string, input: unknown): void;
  /** Model calls so far, up to and including the first productive one. */
  report(): { productive: boolean; steps: number };
}

/** Counts a resumed session's model calls up to its first productive action — an edit or a commit —
 *  and reports that moment once. */
export function createResumeProbe(onProductive?: (r: { productive: true; steps: number }) => void): ResumeProbe {
  let steps = 0;
  let productive = false;
  return {
    onUsage() {
      if (!productive) steps++;
    },
    onToolUse(_id, name, input) {
      if (productive || !(PRODUCTIVE_TOOLS.has(name) || isCommit(name, input))) return;
      productive = true;
      onProductive?.({ productive: true, steps });
    },
    report: () => ({ productive, steps }),
  };
}
