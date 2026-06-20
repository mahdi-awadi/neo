// Integration: run a verifiable loop on a project by composing the governed SDK worker
// (session-runner) with the loop primitive (loop-runner) and a command goal (goal). Each
// iteration opens the folder and resumes the prior session so the worker keeps its context;
// the engine checks the goal (run the tests) between iterations. Escalations are AUTO-DENIED:
// an autonomous loop can read/edit/test/commit, but never push/deploy/rm — those still need a
// human. This is the safe shape for "Neo works while you sleep" (docs/loops.md).
import { runLoop, type LoopOutcome } from "./loop-runner";
import { commandGoal, type GoalCheck } from "./goal";
import { runOrder } from "./session-runner";
import type { Order } from "../types";

const LOOP_CHAT_ID = -1; // loops aren't bound to a chat

export interface ProjectLoopOpts {
  folder: string;
  /** What the worker should attempt each iteration (e.g. "run the tests; fix any failures"). */
  prompt: string;
  /** The verifiable goal — a command that exits 0 when done (e.g. ["bun","test"]). */
  goalCommand: string[];
  maxIterations: number;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
  shouldStop?: () => boolean;
}

export async function runProjectLoop(
  opts: ProjectLoopOpts,
  deps: { run?: typeof runOrder; check?: GoalCheck } = {},
): Promise<LoopOutcome> {
  const run = deps.run ?? runOrder;
  const check = deps.check ?? commandGoal({ command: opts.goalCommand, cwd: opts.folder, timeoutMs: opts.timeoutMs });

  return runLoop({
    maxIterations: opts.maxIterations,
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
      return { sessionId: result.sessionId, summary: result.summary };
    },
  });
}
