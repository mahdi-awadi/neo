# Execute never starts duplicate work — spec (2026-10-12)

Design: ADR-0034. Evidence: todos #147, #148, #162, #165, #166, #171, #172, #175, #177, #179, #180,
#181 (the ledger, 2026-10-10..12).

## Seam
`judgeExecute(deps, plan, { anyway }) → ExecuteVerdict` (`src/engine/plan-execute.ts`). Its inputs:
- the plan files on disk,
- git (`--git-common-dir`, `worktree list`),
- the ledger (todos and plan rows),
- the registry (live sessions).

It has no side effects. `applyPlanAction` acts on the verdict.

## Acceptance criteria
1. **Done.** Execute on a plan whose file has every box ticked queues nothing. The same applies when
   only boxes matching `plans.gatedStepPatterns` are left. The reply names the path and the counts
   (done/total, gated left), and offers Run anyway.
2. **Run anyway** (`anyway` action) skips only check 1.
3. **Busy.** Execute queues nothing, and the reply names the todo (#, status, folder) or the session
   (name, folder), in any of these cases:
   - An active todo (queued, running, retry or waiting) in the same repository targets the same
     design, by its plan row or because its brief names the path.
   - A live session in the same repository names the plan's path in its order or its current turn.
   - A live session in the same repository ticked the file within `plans.activeWindowMinutes`.
4. **Same repository** means the same `git rev-parse --git-common-dir`. A folder that is not a repo is
   its own repository.
5. **Routing.** The todo runs in the main worktree when the file exists there. Otherwise it runs in
   the tapped folder, and the reply says which folder and why. The todo's plan row is the row of the
   folder that runs it (registered if missing).
6. **Unit.** A spec is a file under a `specs/` folder. Its plans are the plan files whose text names
   the spec's path. Execute on a spec resolves like this:
   - One open plan: that plan runs.
   - No open plan: done.
   - Several open plans: choose, which lists them and starts nothing.
   - No plan at all: the spec itself runs.

   The busy check uses every path of the unit.
7. **Shown.** Telegram sends the Execute reply as a chat message (Run anyway is a button). The console
   shows it in the feed (Run anyway is a chip; EN and AR catalogue key).
8. **Config.** `plans.gatedStepPatterns` (regex sources) and `plans.activeWindowMinutes` are read
   with defaults. An invalid regex keeps the default.

## Edge cases
- A plan with no checkboxes is never judged done by check 1.
- A git failure (not a repo, timeout) means the folder is its own repository and the tapped folder
  runs it. It never blocks or throws.
- A second tap while the first is queueing is refused, as before (the row is marked executing first).
- A plan row marked `executing` whose todo is over is not busy. Only active todos and live sessions
  count.
