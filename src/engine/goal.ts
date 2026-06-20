// Verifiable goal checks for loops. A goal is "met" when a deterministic command run in the
// project succeeds (exit 0) — e.g. `bun test`, `go build ./...`, `tsc --noEmit`. This is the
// engine judging the worker's work, not trusting its claim (docs/loops.md). No AI.

export type GoalCheck = () => Promise<{ met: boolean; detail: string }>;

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
