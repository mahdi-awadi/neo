// Integration: run a verifiable OR judged loop on a project by composing the governed SDK worker
// (session-runner) with the loop primitive (loop-runner) and a Goal (goal). Each iteration opens
// the folder and resumes the prior session so the worker keeps its context; the engine checks the
// goal between iterations. Escalations are AUTO-DENIED: an autonomous loop can read/edit/test/
// commit, but never push/deploy/rm — those still need a human. This is the safe shape for
// "Neo works while you sleep" (docs/loops.md).
import { runLoop, type LoopOutcome } from "./loop-runner";
import { makeGoalCheck, type Goal, type GoalCheck } from "./goal";
import { runOrder } from "./session-runner";
import type { Order } from "../types";

const LOOP_CHAT_ID = -1; // loops aren't bound to a chat

export interface Bounds {
  maxIterations: number;
  /** Optional cost ceiling (USD) summed across iterations (incl. judge runs). */
  budgetUsd?: number;
}

export interface ProjectLoopOpts {
  folder: string;
  /** What the worker should attempt each iteration (e.g. "run the tests; fix any failures"). */
  prompt: string;
  /** The goal: a verifiable command or an LLM-judge condition. */
  goal: Goal;
  bounds: Bounds;
  onProgress?: (msg: string) => void;
  shouldStop?: () => boolean;
}

export async function runProjectLoop(
  opts: ProjectLoopOpts,
  deps: { run?: typeof runOrder; check?: GoalCheck } = {},
): Promise<LoopOutcome> {
  const run = deps.run ?? runOrder;
  const check = deps.check ?? makeGoalCheck(opts.goal, { cwd: opts.folder, run });

  return runLoop({
    maxIterations: opts.bounds.maxIterations,
    budgetUsd: opts.bounds.budgetUsd,
    shouldStop: opts.shouldStop,
    onProgress: opts.onProgress,
    check,
    iterate: async (resumeId) => {
      const order: Order = {
        id: crypto.randomUUID(),
        source: "neo",
        folder: opts.folder,
        task: opts.prompt,
        chatId: LOOP_CHAT_ID,
        createdAt: Date.now(),
      };
      const result = await run(
        order,
        {
          onMessage: (t) => opts.onProgress?.(t),
          onEscalation: async () => "deny", // autonomous loop never does risky/irreversible ops
        },
        resumeId ? { resume: resumeId } : {},
      );
      return { sessionId: result.sessionId, summary: result.summary, costUsd: result.costUsd };
    },
  });
}
