# HANDOFF — waiting threads, third report (2026-10-27): plan awaits approval

Report: `docs/investigations/2026-10-27-waiting-threads-third-report.md`. Plan (approval required):
`docs/superpowers/plans/2026-10-27-waiting-work-ship-and-settle.md`. ADR-0054 is proposed.
- The fixes for WAITING threads (ADR-0038/0045/0052/0053) never ran: the daemon runs master `4452b94`.
- On dev they are incomplete: they settle 9 of 22 stale decisions and wrongly close d83217cb.
  **Do not run `settle-decisions --apply` before plan task B1.**
- The restart producer never reported `dev` (its `branchPrefixes` are `fix/`, `feat/` and `chore/`).

---

# HANDOFF — decision threads and closing (ADR-0053): on `dev`, restart-gated

Bugs: (A) the dispatcher filed new work under the last ended turn's thread (`pipeline.ts`
`turnCause`/`runCause` → `lastCauseOf`); (B) a thread's stored state was not re-derived when a
decision closed (`plans.ts` dismissed the old card silently); (C) plan cards closed only through their
buttons, and a todo parked on a card waited forever. Fix in ADR-0053 / spec
`docs/superpowers/specs/2026-10-26-decision-threads-and-closing.md`.
Operator steps after the restart onto `dev`: run `bun tools/threads/settle-decisions.ts
data/ledger.db` (dry run), check the list, then `--apply` (it refuses on a ledger older than the code).
The keep-open list (prod/irreversible questions, awaiting plans) still needs the operator's answers.

---

# HANDOFF — a session held at a big plan takes no brief (ADR-0052): on `dev`, restart-gated

Bug: a todo for a folder whose live session was held at a big plan (ADR-0036) was delivered into it
and marked `done` at once; the worker could only answer STOP (contantme #659/#660/#665/#666/#680).
Fix: `SessionControl.held()` from the plan watch; dispatch refuses (`plan_held`); `projectBusy`
counts a held session busy, so the todo waits `queued` and starts once the hold lifts;
`clearDecisionBlock` keeps a plan hold's block. Needs a daemon restart to go live.
Still open: contantme plan #1645 (master plan) waits for the operator's Approve & build / Drop.

---

# HANDOFF — security kit fixes (ADR-0051): on `dev`, not installed

Two fixes to `tools/security/`, found while turning the kit on in eticket-v3. Commits on `dev`:
`007c038`, `03f8645` and `7dd162a`, plus the docs commit.
- Semgrep runs in parts (`semgrepChunkFiles`, default 200), each under `semgrepTimeoutSec` (default
  1800), per repo in `.security/config.json`. A part with no result is recorded as missing:
  `baseline.json` and reports get an `incomplete` list, and later layers warn against an incomplete
  baseline.
- A recorded chained hook that is missing or not executable exits 1 (it was exit 0). A `.git/hooks`
  chain is found through the common git dir, so it runs from a linked worktree too.
- Checks: `tsc` clean; `bun test` 2255 pass, 0 fail; push scan of the 3 commits: 0 high/critical.

Operator steps: re-install the kit (`bun tools/security/install.ts --host-env dev`, from a `dev`
checkout); in eticket-v3, set `semgrepTimeoutSec`/`semgrepChunkFiles` if needed, re-run
`bun ~/.claude/security/init.ts /home/eticket-v3`, then `bash ~/.claude/security/scan.sh baseline
/home/eticket-v3` and check that `incomplete` is `[]`; re-run `init.ts` on every other repo that has
the kit, so its hooks get the fail-closed template.

---

# Earlier: agent questions + live notes (ADR-0050) and tools catalogue (ADR-0044 P1–P2): on dev, restart-gated

## Done (merged to `dev`; branch `feat/agent-messaging` kept; worktree removed)
- **Tools catalogue (ADR-0044 P1–P2):**
  - cards in `docs/tools/` with a validator test;
  - `tools/catalogue/install.ts` (tool skills);
  - the `tool_api` relay: fail-closed, capped per project, key redacted from replies;
  - `tools_for` and the dispatch tools hint.
- **Worker env scrub** (`src/engine/worker-env.ts`):
  - relay keys are always removed;
  - Neo's env-file key NAMES are recorded once per start as `worker_env_report` (mode `report`);
  - `strip` exists but is off.
- **Follow-up timing** (port of `c12c46f`): `followUp(text, "steer"|"after-turn")`.
  - The operator's words steer at the next step; engine briefs wait for the turn.
  - Verified on SDK 0.3.292 (`docs/sdk-notes.md`).
- **`project_notes ask`:**
  - a question to `main` (the company folder only) or a project;
  - answered by a read-only consult run (`src/engine/consult.ts`) that forks only an idle,
    known-Claude session, has no codebase-memory, can be aborted on a stall, and spends on the
    budget meter.
- **Live notes:** notes from main and late answers reach a running worker at its next step, quoted
  as data. They never wake an idle session.
- **Ledger:** migration v13 adds `answer`, `delivered_at`, `from_session` to `attention_items`.
- **Removed:** the rev. 1 design. A guard test (`tests/no-replaced-mechanisms.test.ts`) stops it
  coming back. ADR-0043 is amended.
- **Checks:**
  - `tsc` is clean. The full `bun test` gave 2246 pass, 0 fail. `liveness-wiring` "NEVER
    stall-aborted…" is a pre-existing flake (it fails 3/5 on plain `dev` under load).
  - Per-task reviews and the final review are clean after their fix rounds.
  - Security review: no findings in the diff.
  - Push scan: 0 critical. It found 2 new HIGH in transitive deps (body-parser 2.3.0, zod 4.4.3),
    the same on `dev` and master. Fixed with `overrides` in `package.json` (body-parser 2.4.0,
    zod 4.6.7). The re-scan has 0 high. The open mediums (fast-uri, hono, ip-address and 3
    semgrep lines) are in code or deps this branch did not change.

## Next steps (operator)
1. Merge `dev` → master and restart (permission needed). Ledger migration: v11 → v13, with
   automatic backups.
2. Install the tool skills: `bun tools/catalogue/install.ts` (it writes `~/.claude/skills`; no
   restart needed).
3. Read the `worker_env_report` key names, set `tools.workerEnv.inherit`, then
   `tools.workerEnv.engineSecrets: "strip"`, then restart.
4. Relay: before `tools.relayEnabled: true`, bound the reply body read and run `findSecret` on
   replies (deferred). Then ScaleDown → `active` (DPA + quota).
5. Decide on `origin/claude/project-thread-n3xiqw`: `c12c46f` is ported. Its other 4 commits are
   typed-answer routing, yes/no answering an Allow/Deny, Telegram line order and api-retry backoff.
6. Known limit (ADR-0050): workers run as root with Bash, so the engine boundary holds at the tool
   level only. A separate worker uid closes it.

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
