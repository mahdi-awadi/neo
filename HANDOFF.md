# HANDOFF — agents ask and tell (ADR-0050): plan awaiting approval

Branch `feat/agent-messaging` (from `dev`, with `feat/tools-catalogue` merged; worktree
`/home/neo-agent-messaging`). Docs only so far: ADR-0050, the spec
`docs/superpowers/specs/2026-10-25-agent-ask-and-tell-design.md`, the plan
`docs/superpowers/plans/2026-10-25-agent-ask-and-tell.md` (`approval: required`) and the CONTEXT.md
terms (§ Agents asking each other). Approving the plan also approves ADR-0044 (it builds its P1–P2).
Found while designing: `mergedSdkEnv` passes the engine's whole env (Neo's `.env` keys) to every
worker. The plan's Task 5 fixes it, in report mode first.

---

# Earlier: waiting threads (ADR-0045) + project notes (ADR-0043)

## Goal
Finished threads must leave WAITING. An hourly loop re-checks WAITING threads and reminds the
operator once, only when the list changes.

## Done (on `dev`, restart-gated)
- **Root cause:** a decision closes only through its own card (tap or reply to the card). The
  operator answers elsewhere: a new message (a new thread), a re-ask under a new id, or chat that the
  worker acts on. Nothing closed the original question, so `deriveThreadState`
  (`src/engine/thread-state.ts:18`) kept the thread `waiting`. ADR-0038 (on dev since 10-15, not
  live) would settle only 1 of 20.
- **Fix (ADR-0045):** `src/engine/waiting-sweep.ts` + CLI `tools/threads/sweep.ts`:
  - A decision closes only on evidence the engine checks: a commit or tracked file newer than the
    question.
  - The worker is offered only the decisions whose repository moved.
  - One reminder is sent, only when the list changed.
  - Loops gained `report: "goal"`, and a command goal keeps its output.
  - `supersedeDecision` cancels the todos parked on the decision.
- **Loop:** `docs/loops/waiting-sweep.json`, cron `0 * * * *`. It is NOT loaded yet.
- **Cleanup, applied to the live ledger 2026-10-22:** `tools/oneoff/2026-10-22-close-done-waiting-threads.ts`.
  - Backup: `data/ledger.db.bak-2026-10-22-waiting-sweep-1792684504336`.
  - 14 decisions superseded. 9 threads went to done (m9g0b m74i2 ma18s mae06 m9ygk macay m9pfe
    m9piu m9yn1).
  - Todos #406 #413 #418 cancelled. The SOS plan was marked done.
  - The 14 asks that stay open were seeded as judgements.
  - WAITING threads: 21 → 12. Evidence: `docs/investigations/2026-10-22-waiting-threads.md`.
- Tests: 2010 pass. `tsc` clean. Security review: no findings. Code review: findings fixed.
- Earlier on dev: project notes (ADR-0043), test temp root (ADR-0042).

## Next steps (operator)
1. Merge `dev` → master, then restart neo.service, with the operator's permission. Never restart
   without it.
2. After the restart, run `bun tools/create-loop.ts docs/loops/waiting-sweep.json` (loads the hourly
   loop). Do not run it before: dev code would migrate the live ledger to v12 under the v11 daemon.
3. Rotate the sandbox password that the operator typed in plain text in thread m9ytv. It is stored
   in the ledger.

## Still waiting for the operator (10 + 1 unclear + 1 live approval)
m7hji, m7ijm, m9snq ×2, m9ytv ×2, ma71j, ma8ox (plan), m7wys, maby3, mab0w (2 plans), m8k9f.
Unclear: m7nk8. Live approval: maeue. The asks are in the investigation doc.

## Gotchas
- The sweep CLI writes the ledger from its own process and cannot see live sessions. The daemon
  corrects a thread on its next line.
- Commit messages: write them to a file and use `git commit -F`.
- A worktree needs a `node_modules` symlink. Remove the link before `git worktree remove`.
