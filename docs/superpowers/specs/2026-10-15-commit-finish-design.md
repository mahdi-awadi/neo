# Commit finish — spec (ADR-0037)

Seam: `src/engine/commit-finish.ts` — `createCommitFinish(folder, cfg, git?)` returns
`{ atSettle(), nudged(), end() }`, plus `commitFinishInFlight(folder)` / `awaitCommitFinish(folder)`.
Dispatch calls `atSettle()` in `onSettled` and `end()` after the run; the todo queue checks the hold
in `release()`.

## Acceptance criteria
1. A run that settles ok with its own changes gets ONE follow-up (the fixed text, files listed) and
   the run is not closed. The next settle closes it. Never a second follow-up.
2. Clean folder, or only pre-existing untouched dirty paths, or only ignored paths → close at once.
3. No follow-up when: API-error turn, draining, wrap-up sent, checkpoint armed, session blocked on
   the operator, `commitFinish.enabled: false`, or `deps.commitFinish` absent.
4. Final result: first turn's summary and ok, plus `committed by resume: <sha subject>` /
   `cleaned by resume (nothing committed)` / `still uncommitted after one resume: <files>` (the last
   also sends an alert).
5. While the follow-up runs, `commitFinishInFlight` is true for every worktree of the repo; a queued
   todo in a sibling worktree waits and is released when it ends.
6. Config `commitFinish { enabled, ignore }` parses with fail-closed defaults; the pipeline passes it.

## Edge cases
- Not a git repo → no check.
- Stall during the follow-up → the task still ends good; outcome "still uncommitted".
- A path deleted by the run counts (fingerprint "gone").

## Status (2026-10-15)
Built on `dev`. Each acceptance criterion has a test: `tests/commit-finish.test.ts` (module, AC1,
AC2, AC4-AC6, edge cases), `tests/dispatch-commit-finish.test.ts` (dispatch AC1-AC4, AC6, the stall
edge case), `tests/todo-queue.test.ts` (AC5), `tests/config.test.ts` (AC6).
