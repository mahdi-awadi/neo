# ADR-0057: side lanes — small, independent tasks run beside a project's main task

**Status:** proposed (2026-10-28). It waits for the operator's approval of the plan
`docs/superpowers/plans/2026-10-28-side-lanes.md`. Spec: `docs/superpowers/specs/2026-10-28-side-lanes-design.md`.
Amends ADR-0008 (one todo at a time per project). Related: ADR-0001 (work class and reserve), ADR-0012
(out-of-folder writes), ADR-0031 (project fence), ADR-0037 (commit finish).

## Context

ADR-0008 runs one todo at a time per project. eticket-v3 has 7+ queued todos. Some are small side jobs:
create a dev super-admin user, change a password, run a test, check docker, run a CityNet API test.
They wait hours behind long builds, but they touch nothing the build touches. The operator wants them
to run at the same time.

## Decision

1. **The chief of staff decides the lane.** It already rewrites every operator order into a brief.
   `dispatch` and `todo add` get `lane: "side" | "queue"` and, for `side`, a `kind`:
   `read-only | ops | test | code`. No separate classifier call is made on this path. AI deciding is
   allowed in Neo (operator, 2026-10-28). The **engine** still enforces the lane.
2. **A brief with no lane goes to the queue** (today's behaviour). This covers plan Execute taps,
   attention briefs, `todo add` without a lane and old callers. No classifier in v1: the engine has
   no Jev or ScaleDown integration to reuse, and a wrong "side" guess costs more than a wait. A
   config switch (`lanes.noLaneClassifier`, only `"none"` in v1) leaves room for one later.
   Customer-tainted work never gets a lane; it does not go through the todo queue at all.
3. **A side lane is its own session.** It is a fresh, single-brief dispatch run with its own registry
   entry, marked with its lane, that never resumes the main session. `findByFolder` (the main-lane
   lookup used by reuse, focus, busy and replies) skips side-lane sessions. Approvals, decisions,
   the stall monitor and the result to the dispatcher already work per session, so they work per
   lane.
4. **Isolation lives in the governor**, through one new field on `GovernorCtx` (`lane`), and a
   forbidden action is **denied** with a clear message (never escalated):
   - shared-folder kinds (`read-only`, `ops`, `test`): no `Write`/`Edit`/`NotebookEdit` in the
     project folder (`read-only`: nowhere except the temp dir); no Bash write commands or
     redirections into the project folder; no git write subcommands; no container lifecycle commands
     (`docker`/`docker compose` `restart|stop|start|up|down|kill|rm|build|create`, `systemctl
     restart|stop|start`).
   - `code`: runs in a temporary git worktree on branch `side/<todo id>`, under `lanes.worktreeRoot`
     (outside the work root, so no file watcher in the main folder sees it). It is denied writes and
     git commands in the main project folder, `git checkout`/`switch` of another branch, `git push`,
     and container lifecycle commands. When it ends, the engine removes the worktree (the branch
     stays). If the branch has commits, the engine queues a main-lane todo: "merge `side/<id>`".
5. **Caps fall back to the queue.** `lanes.maxSidePerProject` (default 1) and
   `lanes.maxDispatchesHost` (default 3, counting every running dispatch run, main and side). If a cap
   is hit, the side todo waits as a queued **side** todo. It starts when a side slot frees, without
   waiting for the main queue. The interactive reserve (`heldByReserve`) applies as for any dispatch.
   `lanes.enabled: false` sends every brief to the queue.
6. **One scheduler.** The todo queue gains a lane column; its pump releases queued side todos into
   free side slots and main todos as today. Side runs go through `dispatchToProject`, with options
   that skip session reuse, the commit-finish nudge (ADR-0037), the context handoff and the main
   project's notes block.
7. **Visible everywhere.** `/list`, `/todo`, the console Queue tab and the `todo` tool show side lanes
   in their own section, with the kind: `⇉ #812 side·ops running 3m — create dev super-admin`.

## Rejected

- **An external classifier on every brief.** The chief of staff already reads the order and writes the
  brief, so a second model call adds cost, delay and a second opinion that can disagree.
- **Running side tasks inside the main session (subagents).** The main worker would have to stop and
  delegate. Its context and turn are shared, so nothing actually runs in parallel from the queue's view.
- **A second scheduler or a second session table.** The todo queue, registry and dispatch already hold
  every needed state; a lane is a column and a field.
- **Isolation by prompt only.** A worker that misreads its brief would edit the main tree. The
  governor must deny it.
- **A worktree for every side task.** `ops`, `test` and `read-only` tasks act on the running services
  and the current code. A worktree would make them test the wrong tree, and it costs a dependency
  install.
- **Escalating a forbidden side-lane action to the operator.** The answer is always "no"; asking only
  blocks the lane.

## Known limits

- The governor reads Bash text. An interpreter that writes files itself (`python -c`, `node -e`) is not
  parsed. This is the same limit as the project fence (ADR-0031). The kinds are small, declared tasks,
  and `code` work is isolated physically in a worktree.
- A `code` side lane cannot run a dockerized test stack bound to the main folder. It suits small code
  changes checked by unit tests.
