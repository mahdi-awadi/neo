# Done is assigned by the engine, for one revision, under a frozen policy

**Status:** accepted (2026-11-02; plan `docs/superpowers/plans/2026-11-02-world-class-coding-agent.md`
W1.1–W1.4; built on `dev`, restart-gated). Related: ADR-0007 (a dispatch ends when settled),
ADR-0027 (the todo queue decides from facts), ADR-0037 (the commit finish), ADR-0049 (a card the
engine rejects), ADR-0054 (done means live), ADR-0072 (bounded commands). Amends ADR-0069's
preamble ceiling by the report rule's length, as ADR-0069 amended it by the push rule's.

## Context

A dispatch's end was inferred: the run settled (ADR-0007), the engine read its exit, its stop
point and its last commit, and the worker's prose became the result. Nothing distinguished "I ran
the tests and they pass" from "it looks done". The research behind the plan measured why that
matters: fabricated success appears in about a quarter of failed agent trajectories, agents
"reliably skew positive when grading their own work", and a submitted patch resolves its task far
less often than it is submitted. The operator's own review of the plan added the sharper point: a
worker can also change what verification means (edit `.neo/checks.json`, weaken a `package.json`
script) during the run it is verified by.

## Decision

1. **A claim is data.** The worker's last call is the `report` tool (`report-tool.ts`): a status in
   {ready, blocked, failed, dropped, no_change_needed, handback}, one plain summary, the commands it
   ran with exit codes, the files changed, a PR or commit ref or null, risks, assumptions, evidence.
   The engine validates the shape and names every problem at once (`ready` with nothing run or with a
   non-zero exit, a hash in the summary, `no_change_needed` without evidence, `handback` without a
   reason). A good claim is a `report_claimed` event on the order. The tool is gated exactly like
   `ask_operator`: operator surfaces only, never the customer path, never a consult run.
2. **The policy is frozen at start.** `checks.ts` reads `.neo/checks.json` (argv arrays, never shell
   strings), lists the files the checks depend on (the file itself, `package.json`, `bunfig.toml`,
   `tsconfig.json`, test configs, `go.mod`, scripts a check names, and `dependsOn`), hashes them, and
   the dispatch records a `policy_frozen` event. The gate runs that policy, not the folder's current
   one. A policy file that differs at the end is reported as `policyChanged`, and a `ready` claim
   with a changed policy is `blocked` until an operator accepts the change.
3. **The gate verifies the commit, for one revision.** `verify.ts` adds a detached clean worktree at
   the run's HEAD outside every project, runs each frozen check through the bounded runner with the
   worker-scrubbed environment (`NEO_VERIFY=1`, `CI=1`), keeps a bounded tail of each output as
   evidence, removes the worktree, and marks the result `stale` when HEAD is not the expected sha
   before or after the run. Uncommitted changes in the project are reported as `dirty`: the worker's
   tree is never what is verified.
4. **The verdict is one pure rule** (`verdict.ts`): `stale` beats everything; no claim → `unreported`;
   a non-ready claim stands as the worker said it; `ready` is earned only when the run ended well,
   the tree is committed, the policy is unchanged and every check passed. With no checks declared
   the claim stands and the reason says "unverified". The verdict, its reason, whether it disagrees
   with the claim, the HEAD sha and the policy hash ride on `dispatch_end`; the evidence tails ride on
   `dispatch_verified`. Every result line shows the verdict beside the claim
   (`claim ready ≠ verdict failed: bun test exited 1`).
5. **`requireReport` is a config switch, default off.** On, an `unreported`, `stale` or contradicted
   end is a bad end for the todo queue (`failure: "verify"`). Off while workers learn the tool: the
   verdict is recorded and shown, and the queue behaves as before.
6. **The preamble says it in one sentence** (`REPORT_RULE`, `standing-rules.ts`), and the ceiling
   test moves by that sentence's length, as it did for the push rule.

## Rejected

- **Reading the worker's last paragraph for the outcome.** That is the inference being removed.
- **A hard deny on editing test files.** TDD is the convention; workers write tests first. The
  frozen policy, the clean checkout and (W1.7) a lint that names deleted or weakened assertions are
  the enforceable shape.
- **A second-vendor reviewer.** The research found no measured gain over a fresh same-model
  session fed the gate's evidence (W1.8).
- **Columns on a `dispatch_end` table.** `dispatch_end` is an event with JSON data; no migration.
- **Retrying the session with the failing output inside the gate.** Wanted (the plan's
  `dispatchCheckRetries`), but it re-enters the commit-finish's still-open-session machinery;
  it follows as its own task once the gate has run in production for a while.

## Consequences

- A dispatch now records what the worker claimed and what the engine found, for a named revision.
- Every result line grows by one `verdict …` line; runs by workers that do not yet call `report`
  read `verdict unreported`, which is the honest word for them.
- The gate costs one worktree add, the project's checks and a worktree remove per dispatch, bounded
  by `verify.maxTotalMs`; projects with no `.neo/checks.json` pay nothing but a hash.
- `.neo/checks.json` is a new per-project file: `{ "checks": [["bun","test"],["bunx","tsc","--noEmit"]] }`.
