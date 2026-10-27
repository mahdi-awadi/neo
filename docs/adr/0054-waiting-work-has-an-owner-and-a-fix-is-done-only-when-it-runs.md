# ADR-0054: waiting work has an owner and a next action, and a fix is done only when it runs

Status: **proposed** (2026-10-27). Awaits the operator's approval of
`docs/superpowers/plans/2026-10-27-waiting-work-ship-and-settle.md`. Amends ADR-0018 (restart
producer), ADR-0038 (settle rules), ADR-0045 (waiting sweep) and ADR-0053 (expiry, cleanup).

## Context

The third report (`docs/investigations/2026-10-27-waiting-threads-third-report.md`):
- 23 of 30 open decisions on waiting threads were done or moot in their repositories.
- None of the four earlier fixes runs, because the daemon runs master and the fixes are on `dev`.
- On today's data, dev's rules close 9 of the 22 stale decisions and wrongly close 1 real question.
- Two causes:
  - The rules read the ledger's shape (ages, outcomes, key words). The evidence is in the repos.
  - The restart producer cannot see `dev`.

## Decision

1. **A waiting item always has an owner and a next action.** A single read model,
   `waitingWork()`, lists every open decision, waiting todo and plan held for approval.
   - Each item has an owner: `operator`, `sweep` or `engine`.
   - Each item has a next action: the ask, "judge against the repo", or "resume when X".
   - A thread is WAITING only if it has a waiting item. The Queue and Threads views both read this
     model, so they always agree.
2. **Evidence beats guessing.** A decision closes in one of three ways:
   - the operator's answer (the card, or the dispatcher's `decision answer`, which records an answer
     given in chat);
   - a plan that moved;
   - checked repo evidence (ADR-0045).

   The ADR-0038 rule "answered in chat" is removed: it guesses, and it hid d83217cb. A plan card
   may now close on evidence too: the evidence marks its **plan** done, and the card follows the
   plan (ADR-0036 still holds).
3. **Every order ends.** At boot, an order with no outcome and no activity since the previous boot
   gets the outcome `interrupted`, dated at its last activity. Expiry counts it as ended. The thread
   state ignores it: a restart is not a failure of the work.
4. **Key words keep a question open; they do not hide it.** A keep-pattern question never expires
   on age. The sweep judges it like any other, and the reminder lists it with its age until it is
   answered or closed on evidence.
5. **A fix is done only when it runs.**
   - The restart producer reports the integration branch (`restart.integrationBranch`, default
     `dev`) as one item: "N commits on dev are not running, oldest D days".
   - Its severity rises after `restart.maxUndeployedDays`.
   - It no longer reports branches already merged into the integration branch.
   - `/status` and the console header show it.
   - A handoff says "built on dev" or "live"; never "done" for code that does not run.

## Rejected

- **Auto-merge `dev` into master and restart when green.** A restart of the live engine is the
  operator's step (standing rule). The engine makes the gap loud; it does not act on it.
- **Expire any question by age.** Rejected again (ADR-0038, ADR-0053): it hides prod questions.
- **Keep "answered in chat" and tighten it.** Any text heuristic can match the wrong line. An
  explicit `decision answer` from the dispatcher, which reads the operator's words, is the
  standard fix.
- **Re-home misfiled decisions by project.** This is a guess (ADR-0053). Instead the console counts
  waiting per decision project, so a gold question shows under gold.
