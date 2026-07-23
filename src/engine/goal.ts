// Goal checks for loops. A goal is "met" either when a deterministic command succeeds (exit 0)
// — the engine judging the work, not trusting a claim — or when an LLM-judge worker votes DONE.
// The engine stays AI-free: the judge's verdict comes from a worker (Claude, your subscription),
// and the engine only parses its strict last line (docs/loops.md).
import { runOrder, type RunDeps } from "./session-runner";
import type { Order } from "../types";

export type GoalCheck = () => Promise<{ met: boolean; detail: string }>;

/** A declarative goal: a verifiable command, or an LLM-judge condition. */
export type Goal =
  | { kind: "command"; command: string[]; timeoutMs?: number }
  | { kind: "judge"; criteria: string; timeoutMs?: number };

/** Met when `command` exits 0 in `cwd`. `detail` is the exit code + the last output line.
 * A non-zero exit (or a timeout) means not-met — which keeps the loop going. */
export function commandGoal(opts: { command: string[]; cwd: string; timeoutMs?: number }): GoalCheck {
  return async () => {
    const proc = Bun.spawn(opts.command, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });

    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : undefined;

    // Drain the pipes while the process runs to avoid deadlock on large output.
    const [exited, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (timer) clearTimeout(timer);

    if (timedOut) return { met: false, detail: `timed out after ${opts.timeoutMs}ms` };

    const tail = `${out}${err}`.trim().split("\n").filter(Boolean).at(-1) ?? "";
    return { met: exited === 0, detail: `exit ${exited}${tail ? `: ${tail.slice(0, 140)}` : ""}` };
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
 * it only parses the worker's strict last line. Unparseable ⇒ not met (never falsely "done"). */
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
    const result = await run(
      order,
      { onMessage: (t) => void (text += `${t}\n`), onEscalation: async () => "deny" },
      opts.runDeps ?? { disallowedTools: READONLY_DENY },
    );
    const blob = `${text}\n${result.summary}`;
    const met = /^\s*VERDICT:\s*DONE\b/im.test(blob);
    const reason = (blob.match(/VERDICT:\s*(?:DONE|CONTINUE)\s*[—-]?\s*(.*)$/im)?.[1] ?? "").trim();
    return { met, detail: `judge: ${met ? "done" : "continue"}${reason ? ` — ${reason}` : ""}` };
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
