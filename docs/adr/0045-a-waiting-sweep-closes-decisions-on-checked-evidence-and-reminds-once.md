# A waiting sweep closes decisions on checked evidence, and reminds the operator once

**Status:** accepted (2026-10-22; built on `dev`, restart-gated). Amended by ADR-0054: an evidence close of a plan card now marks its plan done, and the card follows. Amends ADR-0038 (a thread waits
only on a live question). Builds on ADR-0029 (a run parks on its decision), ADR-0043 (closing is
checked against a real commit) and the loop runtime (`docs/loops.md`).

On 2026-10-22 the console's `waiting` filter showed 20 threads that the operator saw as finished.
These included m74i2 (mirshad), m9pfe (waselni), m7nk8 (eticket-v3), m9g0b (contantme) and m8k9f
(gold).

## Root cause

1. **A decision closes only through its own card.** `deriveThreadState`
   (`src/engine/thread-state.ts:18`) returns `waiting` while the thread has an open decision. That
   is correct. The problem is the decisions. A decision becomes `answered` only when the operator
   taps its card or replies to the card message. In practice the answer arrives elsewhere:
   - The operator sends a new Telegram message, which starts a new thread. For example, the sandbox
     account sent as m9ytv answered m9ygk's #2f66c3ce.
   - The question is asked again under a new id and answered there. Contantme's #d8de5017 was
     "answered as #86b3d086".
   - The worker acts on an answer given in chat. Mirshad commits `f279ee4f` and `d3996242` cite
     "Operator decision #8c5ad70f" and "#f4cf5967".

   Nothing then closes the original question. The worker that acted on the answer has no way to close
   it, and the engine cannot see the link. Of the 28 open decisions in the 20 threads, 14 were in
   fact answered or made moot (evidence in `docs/investigations/2026-10-22-waiting-threads.md`).
2. **ADR-0038 is not live.** It has been on `dev` since 2026-10-15 (`1b4f5f9`). The daemon runs
   master `51e0fd9` (2026-10-13). Even live, its rules would settle 1 of the 20 threads: they look
   only inside one thread, and they never close a batch of questions.

## Decision

1. **A verified close.** A decision may be closed with evidence: `commit <sha>` or `file <path>`
   in the decision's repository. The engine checks the evidence: the commit exists and was made
   after the question was asked, or the file is tracked and was last changed after the question.
   Then it **supersedes** the decision (ADR-0038 status), with the reason and the evidence in its
   answer, and re-derives the thread. If a todo is parked on the decision (ADR-0029), that todo is
   cancelled with the same reason, as when the operator closes a thread. A plan card is never closed
   this way, because a plan card follows its plan (ADR-0036). The closer may be a worker (the AI
   judges); the engine only checks the evidence. That is the ADR-0043 pattern.
2. **The waiting sweep** is a checked-in loop, `waiting-sweep`, that runs every hour (cron
   `0 * * * *`), with the deterministic CLI `tools/threads/sweep.ts`:
   - `check` (the loop's goal, which runs **before** any worker; this is how `runLoop` already
     works):
     - It re-derives every WAITING thread, applying ADR-0038.
     - It finds the open decisions that **need judging**: their repository has a commit newer than
       the last judgement of that decision.
     - If none: the goal is met, and **no worker runs**. It prints the operator reminder, only if
       the reminder changed.
     - Otherwise the goal is not met, and a worker runs.
   - `list`, `close <id> --commit|--file … --reason …` and `keep <id> --ask "…"` are for the
     worker. `keep` records the judgement and the one-line ask.
3. **The loop reports only its goal.** New loop field `report: "goal"`. In a scheduled run, worker
   text is recorded in the thread but not sent. The goal's output is sent once, and only when it is
   not empty. So the only message is the reminder, and it is deterministic. Every engine-side Bot
   API call already goes through the flood gate.
4. **One reminder, only on change.** The reminder lists each thread that still needs the operator:
   the thread ref, the project, and the ask (or the question). It is capped at
   `waitingSweep.reminderMaxLines` (15), with "…and N more" after that. A fingerprint of the list is
   kept in the ledger `meta` table (`waitingSweep.reminder`). The reminder is sent only when the list
   is not empty and differs from the last one sent.
5. **A one-time cleanup** (`tools/oneoff/2026-10-22-close-done-waiting-threads.ts`) closes the 14
   decisions found done, each with the evidence a person checked by hand. It uses only v11 columns,
   so it runs against the live ledger without migrating it. It takes a `VACUUM INTO` backup first,
   the same way as the 2026-10-08 one-off.

## Rejected

- **Close a decision when any later commit cites `#<id>`.** We measured this against the 28
  decisions checked by hand: 4 true hits and 2 false positives. The false positives came from
  handoff commits that list the open questions ("Waits on #a1b13247 — OPEN"). One more hit was the
  commit that *asked* for the deploy. Citing a decision is not acting on it, and only a reader can
  tell the difference.
- **Expire a decision after N days (a stale bot).** ADR-0038 rejected an age limit. It hides a real
  question. Ten of the 20 threads hold a real, unanswered question: a prod PII purge, prod
  credentials, plan approvals.
- **A worker in every hourly run.** Most hours bring no new evidence. Gating on "a newer commit in
  the repository" keeps the AI cost at zero when nothing moved.
- **Send the worker's text as the reminder.** A scheduled loop forwards every worker text, so an
  hourly worker would be chatty, and an LLM cannot promise silence. The goal command's output is
  deterministic.
- **Reuse the secretary loop.** It is a daily digest of all open decisions, phrased by a worker.
  The operator asked for an hourly reminder that is sent only on change and is limited to WAITING
  threads. The secretary stays as it is.

## Consequences

- Restart-gated: the CLI needs `dev` code. The loop is loaded after the restart with
  `bun tools/create-loop.ts docs/loops/waiting-sweep.json`. Loading it now would migrate the live
  ledger to v12 under the v11 daemon.
- The CLI writes the ledger from its own process, as `tools/create-loop.ts` does. Its thread
  re-derive cannot see live sessions, so it may mark a thread `done` while a session is still
  working on it. The daemon corrects that with the thread's next line.
