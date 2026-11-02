# Execute is judged against the file, the repository and the design unit

**Status:** accepted (2026-10-12) · extends ADR-0019 (the plan registry) and ADR-0008 (the todo queue).

An Execute tap queued a todo whenever the tapped plan row allowed it. A row is keyed by
(folder, path) and its step count is the one the last run end saw. From 2026-10-10 to 2026-10-12 this
caused four kinds of duplicate work:
- **Finished work ran again** (#162, #165, #166, #175, #177, #179, #180). The file was finished, but
  the row had not seen the last ticks, or the tap was on a spec.
- **Work already in hand was queued again** (#147, #148, #181). The project's own session was
  executing the plan. That run had no Execute todo, so nothing knew about it.
- **A phase ran in a worktree** (#175). A worktree checkout of eticket-v3 had sent the plan last,
  so its row's folder was the worktree. Phase 7 was built twice, on two branches.
- **One design ran twice** (#171 + #172). The spec and the plan derived from it each had an
  Execute button.

## Decision

`judgeExecute(deps, plan)` in `plan-execute.ts` decides every Execute, deterministically. The
verdict is one of these:
- `done`: the file has nothing left to do.
- `busy`: the design is already queued or running somewhere in the repository.
- `choose`: a spec has more than one open plan.
- `run`: start a todo for the named plan row and folder.

`applyPlanAction` only acts on the verdict, and every verdict is a sentence the operator sees.

1. **The file is the truth.** The verdict reads the plan file at Execute time, not the row.
   - The file is done when every checkbox is ticked.
   - It is also done when every unticked box matches `plans.gatedStepPatterns` (push, deploy, merge,
     restart, "ask the operator", …). A worker must not do those steps alone anyway.
   - A done verdict offers **Run anyway**: the `anyway` action skips only this check.
2. **The repository is the scope.** Two folders are the same repository when
   `git rev-parse --git-common-dir` gives the same path, whatever the folder names are. A plan is
   busy in any of these cases:
   - An active todo (queued, running, retry or waiting) of the same repository targets the same
     design: by its plan row, or because its brief names the plan's path.
   - A live session in the same repository has the plan's path in its order or its current turn.
   - A live session in the same repository ticked the plan's file within `plans.activeWindowMinutes`.
3. **The main checkout runs it.** The todo goes to the repository's main worktree (the first entry of
   `git worktree list`) when the plan file exists there. Otherwise it goes to the worktree that has
   the file, and the reply says so.
4. **A spec and its plans are one unit.** A file under a `specs/` folder is a spec. A plan is derived
   from a spec when the plan's text names the spec's path. Execute on a spec resolves like this:
   - One open plan: that plan runs.
   - None open: `done`.
   - Several open: `choose`, which lists them.
   - No derived plan at all: the spec itself runs, as before.

   The duplicate check covers the whole unit, so a spec todo blocks its plans and a plan todo blocks
   its spec.

## Considered options
- **Mark rows in every folder when one is executed.** Rejected: rows exist only for folders that
  sent the plan, and this misses work started without a tap (#147, #148, #181).
- **Match repositories by folder name.** Rejected: `booking-timeline` and `eticket-v3` are the same
  repository with different names. The git common dir is the identity git itself uses.
- **Hide Execute on specs.** Rejected: a spec with no plan yet is a fair thing to execute (the worker
  writes the plan and builds). Resolving the unit keeps the button and removes the duplicate.
- **Ask an AI whether the work is done or running.** Rejected: the engine has no AI (CLAUDE.md).
  Checkbox counts, git, the ledger and the registry answer it.
- **A generic "force" that also skips the duplicate check.** Rejected: running the same plan twice at
  the same time is never wanted, so Run anyway skips only the done check.

## Consequences
- An Execute reply always says what happened and why: `done` with its counts, `busy` with where the
  work is, `choose` with the open plans, `run` with its folder when that is not the tapped one.
  Telegram posts the reply as a message, not only a tap toast. The console shows it in the feed with
  a Run anyway chip.
- The gate patterns and the active window are config (`plans.gatedStepPatterns`,
  `plans.activeWindowMinutes`).
- Restart-gated.
