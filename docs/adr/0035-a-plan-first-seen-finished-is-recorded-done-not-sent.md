# A plan first seen finished is recorded done, not sent

**Status:** accepted (2026-10-12) · extends ADR-0019 (the plan registry) and ADR-0034 (the Execute judge).

The plan registry sent every plan the first time it saw the file, as a card with Approve and Execute.
It did not look at the steps. On 2026-10-12 it saw eticket-v3's B2B sub-users plan (row 315, 90/90
steps ticked) and its spec (row 321) for the first time, days after the work was finished. Both
went to the operator as new cards (`created_at == sent_at`). The operator thought the work had to
be done again, and the taps queued todos #186 and #187, which only re-checked finished work.

ADR-0034 stops an Execute on finished work, but the card was already wrong: it asked for a review
of work that was done.

## Decision

The registry judges a plan the operator never received by its file, with ADR-0034's judge
(`finishedUnit` in `plan-execute.ts`; no second judge):
1. **First sight, finished → recorded done, not sent.** A new or unsent row (`draft`, version 0)
   whose file is finished gets status `done`. Finished means every box ticked, or only
   `plans.gatedStepPatterns` boxes left. No card, no decision, no file, no message. The engine
   records a `plan_seen_done` event (path and counts) and logs one line. `/plans` and the console
   show it as done with no buttons, because the buttons come from the status.
2. **A spec is judged with its plans.** A spec is done when it has at least one plan that names it,
   and every such plan is finished. A spec with no plan yet, or with an open plan, is sent as before.
3. **It reopens when there is work again.** A plan recorded done this way (done, version 0, no
   todo) whose file gets an unticked step that is not operator-gated goes back to `draft`, and the
   run end sends it as a normal card. A plan the operator marked done, or that an Execute finished,
   is still never sent again (ADR-0019).
4. **A worker's `send_file` of such a plan** is not sent as a card or as a plain file. The worker
   is told `already done: <path> — N/M steps ticked; recorded as done, not sent to the operator`.

A plan that was already sent keeps its lifecycle. (Changed by ADR-0036: a sent plan whose file is
finished at a run end becomes done, and its card says so.)

## Considered options
- **Send it with a short "already done" line.** Rejected: a merge or a first run in an old repo can
  bring many finished plans, and each line is noise. The flood gate exists because of noise like
  this. The event, the log, `/plans` and the console record it.
- **Send it with no buttons.** Rejected: a file the operator does not need to read is still a
  message to read.
- **Leave it to the Execute judge (ADR-0034).** Rejected: the card itself misleads, before any tap.
- **A new status (`finished`).** Rejected: `done` already means "nothing left", and every surface
  (buttons, `/plans`, the console, `openPlans`) already treats it so. "Done, never sent, no todo"
  identifies the recorded kind without a schema change.

## Consequences
- Rows already sent before this change (such as eticket-v3 rows 315 and 321) are not changed.
  The operator can tap Drop, or Execute, which ADR-0034 answers with "already done".
- A large `specs/` folder costs one `git ls-files` per unsent spec at a run end that changed it.
- Restart-gated.
