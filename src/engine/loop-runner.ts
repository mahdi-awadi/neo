// The loop primitive: run a governed worker repeatedly toward a VERIFIABLE goal, stopping
// when the goal holds, a bound is hit, or a kill-switch fires. The Agent SDK has no built-in
// "run until goal" — the engine owns the loop (see docs/loops.md). This module is the engine
// part: deterministic, AI-free. Each iteration resumes the prior SDK session so the worker
// keeps its context; the goal is checked by the ENGINE (e.g. run the tests + read exit code),
// never by trusting the worker's word.

export interface LoopSpec {
  /** Run one iteration (a governed worker run). Receives the prior SDK session id to resume
   * (undefined on the first), and the 1-based iteration number. Returns the new session id +
   * the run's cost (USD), so the loop can enforce a budget ceiling. */
  iterate: (resumeId: string | undefined, n: number) => Promise<{ sessionId: string; summary: string; costUsd?: number }>;
  /** Verifiable goal check — deterministic, engine-side. Returns whether it's met + a one-liner. */
  check: () => Promise<{ met: boolean; detail: string }>;
  /** Hard bound: give up after this many iterations even if the goal isn't met. */
  maxIterations: number;
  /** Optional cost ceiling (USD), summed across iterations. */
  budgetUsd?: number;
  /** Optional kill-switch / throttle checked before each iteration (usage cap, /kill, etc.). */
  shouldStop?: () => boolean;
  /** Optional progress reporter (one line per iteration). */
  onProgress?: (msg: string) => void;
  /** Engine-side gate on the carried session id before each resume: return the id to keep it,
   *  undefined to start the iteration fresh (context policy verdict, cache-staleness, …). */
  gateResume?: (resumeId: string) => Promise<string | undefined>;
}

export interface LoopOutcome {
  met: boolean;
  iterations: number;
  reason: "goal-met" | "max-iterations" | "over-budget" | "stopped";
  lastDetail: string;
  spentUsd: number;
}

export async function runLoop(spec: LoopSpec): Promise<LoopOutcome> {
  let resumeId: string | undefined;
  let lastDetail = "";
  let spentUsd = 0;

  for (let n = 0; ; n++) {
    const goal = await spec.check();
    lastDetail = goal.detail;
    if (goal.met) return { met: true, iterations: n, reason: "goal-met", lastDetail, spentUsd };
    if (n >= spec.maxIterations) return { met: false, iterations: n, reason: "max-iterations", lastDetail, spentUsd };
    if (spec.budgetUsd !== undefined && spentUsd >= spec.budgetUsd)
      return { met: false, iterations: n, reason: "over-budget", lastDetail, spentUsd };
    if (spec.shouldStop?.()) return { met: false, iterations: n, reason: "stopped", lastDetail, spentUsd };

    spec.onProgress?.(`iteration ${n + 1}: ${goal.detail}`);
    const gated = resumeId && spec.gateResume ? await spec.gateResume(resumeId) : resumeId;
    const r = await spec.iterate(gated, n + 1);
    resumeId = r.sessionId;
    spentUsd += r.costUsd ?? 0;
  }
}
