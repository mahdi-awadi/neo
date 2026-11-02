# Every engine-run command is bounded and credential-free

**Status:** accepted (2026-11-02; plan `docs/superpowers/plans/2026-11-02-world-class-coding-agent.md`
W0.4; built on `dev`, restart-gated). Related: ADR-0009 (the updater's `exec`), ADR-0010 (fault
containment), ADR-0050 §7 (the worker env scrub), ADR-0062 (secrets through env).

## Context

The engine spawned child processes in three places with three different contracts: `exec` in
`update-sys.ts` (the updater and every git/gh read), `commandGoal` in `goal.ts` (a loop's command
goal) and the sync `git` reads in `git-read.ts` and `lane-worktree.ts`. Two of them shared one defect:
on a timeout they killed the direct child and then awaited its stdout and stderr to the end, so a
grandchild that inherited the pipe (`sh -c 'sleep 5'` forks `sleep`) held the result for its whole
life. The goal test "commandGoal reports a timeout as not-met" showed it: a 100 ms timeout returned
after 5 s. None of them capped output, and none of them scrubbed the environment, so a gate script
run by the engine would have seen the engine's own keys.

The plan (W1 and later) adds more engine-run commands: project checks in a clean checkout, a
reproduction run on a base commit, loop gate scripts, deploy tools. Each needs the same three bounds.

## Decision

1. **One runner.** `src/engine/run-command.ts` `runCommand(cmd, opts)` is the one way the engine runs a
   process it does not stream. `exec` and `commandGoal` keep their public shapes and delegate to it.
   The sync `git` reads stay as they are (a 5 s `spawnSync` with no output to speak of).
2. **A timeout that returns.** SIGTERM at `timeoutMs`, SIGKILL after `killGraceMs`. Once the direct
   child has exited, the stream readers are cancelled, so a grandchild holding the pipe never delays
   the result. What was read before is kept. Exit 124 marks a timeout, 127 a process that could not
   start; neither throws.
3. **A cap per stream.** Past `maxOutputChars` the rest is read and dropped (the child never blocks
   on a full pipe) and `[output truncated at N chars]` is appended, so a caller can see it happened.
4. **A scrubbed environment on request.** With `scrub` (the worker rules from `worker-env.ts`, strip
   mode) the child sees the daemon environment minus the engine's own keys and every relay key. An
   `env` overlay always wins. Callers that run project checks pass the scrub; the updater does not.
5. **Defaults in config.** `commands.timeoutMs`, `commands.maxOutputChars`, `commands.killGraceMs`
   (`docs/CONFIG.md`). A caller may pass tighter values; no caller may pass "unbounded".

## Rejected

- **A process group kill (`detached` + `kill(-pgid)`).** Bun's spawn exposes no process group, and
  the orphan is harmless once the readers are cancelled. Revisit if an orphaned check ever needs
  killing for correctness, not just for latency.
- **Keeping three runners.** Each new gate would pick one and inherit its gaps.
- **Scrubbing always.** The updater and the git/gh reads run as the engine on purpose (gh needs its
  token). The scrub is the caller's explicit choice, so a reader of the call site sees it.

## Consequences

- The goal timeout test passes in 100 ms, not 5 s.
- W1's clean-checkout gate and W2's loop gates get their bounds for free.
- `commands` is a new config block; absent, today's behaviour holds except that a command goal
  with no `timeoutMs` is now bounded by the default (10 min) instead of running forever.
