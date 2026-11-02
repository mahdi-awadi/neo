// Goal checks for loops. A goal is "met" either when a deterministic command succeeds (exit 0)
// — the engine judging the work, not trusting a claim — or when an LLM-judge worker votes DONE.
// The engine stays AI-free: the judge's verdict comes from a worker (Claude, your subscription),
// and the engine only parses its strict last line (docs/loops.md).
import { runOrder, type RunDeps } from "./session-runner";
import { DEFAULT_COMMANDS_CFG, runCommand } from "./run-command";
import type { Order } from "../types";

/** `output`: a command goal's whole stdout (capped at GOAL_OUTPUT_MAX), for a loop that reports its
 *  goal (ADR-0045). `detail` stays the one-line summary. `costUsd`: what the check itself spent (a
 *  judge run), so the loop's budget counts it. */
export type GoalCheck = () => Promise<{ met: boolean; detail: string; output?: string; costUsd?: number }>;

/** The most stdout a command goal keeps as `output`. */
export const GOAL_OUTPUT_MAX = 4000;

/** A declarative goal: a verifiable command, or an LLM-judge condition. */
export type Goal =
  | { kind: "command"; command: string[]; timeoutMs?: number }
  | { kind: "judge"; criteria: string; timeoutMs?: number };

/** Met when `command` exits 0 in `cwd`. `detail` is the exit code + the last output line.
 * A non-zero exit (or a timeout) means not-met — which keeps the loop going. */
export function commandGoal(opts: { command: string[]; cwd: string; timeoutMs?: number }): GoalCheck {
  return async () => {
    // The engine's one runner (run-command.ts, W0.4): a missing binary or a deleted project folder
    // (Bun.spawn's ENOENT on the executable) is a spawn error, never a throw — a goal-check must not
    // escape into the scheduler (2026-07-24 crash: a loop's folder was deleted). A timeout is not-met
    // and returns at once even when a grandchild still holds the pipe. No timeout given → the
    // runner's default bound, never unbounded.
    const r = await runCommand(opts.command, { cwd: opts.cwd, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    if (r.spawnError !== undefined) return { met: false, detail: `spawn error: ${r.spawnError}` };
    if (r.timedOut) return { met: false, detail: `timed out after ${opts.timeoutMs ?? DEFAULT_COMMANDS_CFG.timeoutMs}ms` };

    const tail = `${r.stdout}${r.stderr}`.trim().split("\n").filter(Boolean).at(-1) ?? "";
    return { met: r.exit === 0, detail: `exit ${r.exit}${tail ? `: ${tail.slice(0, 140)}` : ""}`, output: r.stdout.trim().slice(0, GOAL_OUTPUT_MAX) };
  };
}

const JUDGE_CHAT_ID = -1; // judge runs aren't bound to a chat
/** Exported so callers building a judge RunDeps overlay (e.g. profileDeps(cfg, "judge", …)) can
 *  reuse the same read-only denial list as the base, rather than duplicating it. */
export const READONLY_DENY = ["Write", "Edit", "NotebookEdit", "Bash"];

function judgePrompt(criteria: string): string {
  return [
    "You are a STRICT, READ-ONLY verifier. Do not modify, create, or run anything that changes state.",
    "Inspect the project and decide whether the following condition holds:",
    "",
    criteria,
    "",
    "Explain your reasoning briefly, then on the FINAL line output EXACTLY one of:",
    "VERDICT: DONE — <one-line reason>",
    "VERDICT: CONTINUE — <what is still missing>",
  ].join("\n");
}

/** LLM-as-judge goal: a fresh, read-only worker returns the verdict. The engine stays AI-free —
 * it only parses the worker's strict last line. Unparseable ⇒ not met (never falsely "done").
 * `timeoutMs` aborts the judge run (not met). Its cost is the run's `costUsd`; the Claude SDK sends
 * that only with its final result, so a timed-out Claude judge run reports 0. */
export function judgeGoal(opts: {
  criteria: string;
  cwd: string;
  run?: typeof runOrder;
  timeoutMs?: number;
  /** RunDeps overlay for the judge worker (model/effort/skills via profileDeps(cfg, "judge", …)).
   *  Unset ⇒ the fixed read-only denial list only (today's behavior). */
  runDeps?: RunDeps;
}): GoalCheck {
  const run = opts.run ?? runOrder;
  return async () => {
    const order: Order = {
      id: crypto.randomUUID(),
      source: "neo",
      folder: opts.cwd,
      task: judgePrompt(opts.criteria),
      chatId: JUDGE_CHAT_ID,
      createdAt: Date.now(),
    };
    let text = "";
    let timedOut = false;
    const abort = opts.timeoutMs ? new AbortController() : undefined;
    const timer = abort ? setTimeout(() => ((timedOut = true), abort.abort()), opts.timeoutMs) : undefined;
    const base = opts.runDeps ?? { disallowedTools: READONLY_DENY };
    let result;
    try {
      result = await run(
        order,
        { onMessage: (t) => void (text += `${t}\n`), onEscalation: async () => "deny" },
        abort ? { ...base, abortController: abort } : base,
      );
    } finally {
      clearTimeout(timer);
    }
    const cost = result.costUsd !== undefined ? { costUsd: result.costUsd } : {};
    if (timedOut) return { met: false, detail: `judge: timed out after ${opts.timeoutMs}ms`, ...cost };
    const blob = `${text}\n${result.summary}`;
    const met = /^\s*VERDICT:\s*DONE\b/im.test(blob);
    const reason = (blob.match(/VERDICT:\s*(?:DONE|CONTINUE)\s*[—-]?\s*(.*)$/im)?.[1] ?? "").trim();
    return { met, detail: `judge: ${met ? "done" : "continue"}${reason ? ` — ${reason}` : ""}`, ...cost };
  };
}

/** Build the GoalCheck for a declarative Goal. Verifiable command is preferred; judge is for
 * docs/refactor-style sweeps (docs/loops.md). */
export function makeGoalCheck(goal: Goal, deps: { cwd: string; run?: typeof runOrder; runDeps?: RunDeps }): GoalCheck {
  if (goal.kind === "command") {
    return commandGoal({ command: goal.command, cwd: deps.cwd, timeoutMs: goal.timeoutMs });
  }
  return judgeGoal({ criteria: goal.criteria, cwd: deps.cwd, run: deps.run, timeoutMs: goal.timeoutMs, runDeps: deps.runDeps });
}
