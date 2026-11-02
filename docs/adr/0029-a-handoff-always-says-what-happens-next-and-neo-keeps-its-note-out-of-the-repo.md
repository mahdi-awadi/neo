# A handoff always says what happens next, and Neo keeps its note out of the repo

**Status:** accepted (2026-10-09) · amends ADR-0014 and ADR-0021 (boundary handoffs).

On 2026-10-09 eticket-v3 todo #141 (agency desk Phase 4) finished at 15:53. The engine handed the
session off at the "task done" boundary at 15:56 (41%, above the 40% sweet spot) and told the
operator: "🔁 context handoff at 41% … — the next session starts from HANDOFF.md". Nothing started.
The run had raised decision #f6193fc8 and stopped on it, and its note listed Phases 5–7. The operator
read the line as "Neo is continuing" and then thought Neo was stuck.

## Root cause

1. **A settled handoff schedules nothing.** At the `settled` boundary, dispatch runs the handoff
   turn, writes the note, clears the session and announces it. Only the `checkpoint` boundary (a
   handoff in the middle of a task) returns a continuation, which the todo queue turns into a todo.
   After a settled handoff, the note waits for whatever fresh start comes next, if one ever does.
2. **The engine wrote the project's own `HANDOFF.md`.** The handoff prompt and the checkpoint steer
   told the worker to overwrite `HANDOFF.md` in the project root. `finalizeHandoffNote` rewrote it
   to add the engine facts, and the idle-close note replaced it on every idle close. A project that
   keeps its own `HANDOFF.md` (waselni's 52-plan audit, eticket-v3's working notes) lost it.

## Decision

1. **After a settled handoff, the engine decides the next step from facts, in this order:**
   - **Blocked:** the run's own order raised a decision that is still open. The engine parks a
     continuation todo as `waiting` on that decision and says "paused: waiting on decision #<id> —
     <question>". When the operator answers, the same todo goes to the head of the queue with the
     answer in its brief and runs. The answer no longer opens an operator session for that project.
   - **More to do:** the note's "Next steps" section lists work (a line that is not empty and does
     not start with none, nothing, n/a or a dash). The engine queues a continuation todo at the
     head of the project's queue, like a checkpoint continuation, and says "continuing as #<n>".
   - **Waiting on a plan card:** the open decision is a plan's Approve/Execute card. Nothing is
     parked, because the Execute tap queues the work itself (ADR-0019). It says "paused: waiting on
     plan approval #<id> — …".
   - **Nothing left:** it says "done, idle".

   A parked continuation carries the finished note in its own brief, and the pending handoff is
   marked as claimed. Other todos may run before the answer arrives, and they must not take the note
   or be told they "continue earlier work". If the operator answers while the handoff turn is still
   writing the note, the answer is held for that order and goes into the continuation. No operator
   session is opened, so the work never runs twice. If no settled handoff takes the answer (a
   checkpoint handoff), it is queued as a continuation once the handoff settles.

   Only a decision raised by this run's order blocks (`openDecisionsForOrder`, queried by order id). eticket-v3 has about 25 old open decisions
   from other runs; a folder-wide rule would never continue.
2. **The continuation decides what is approved; the engine does not.** The continuation brief says:
   continue only with next steps that are inside the original brief or an approved plan, and ask
   with `ask_operator` before starting anything else. The engine has no AI. "Next steps is not
   empty" is a fact it can check; "approved" is not.
3. **Neo's note lives outside the repo.** It is at `<handoffNotesDir>/<folder path, "/" → "-">.md`
   (config `handoffNotesDir`, default `data/handoffs` in Neo's own folder). The handoff prompt, the
   checkpoint steer (and the governor's allowance during the steer), the engine-facts step and the
   idle-close note all use that path. Neo never writes the project's `HANDOFF.md` again. The next
   session gets Neo's note inline and is told that the project's own `HANDOFF.md`, if any, belongs to
   the project and should be read too. If the worker cannot write outside the repo (Codex's sandbox,
   or `outOfFolderWrites: "ask"` refused), it replies with the note instead and the engine keeps the
   reply.
4. **No line is ambiguous.** Every handoff notice ends with what happens next: "continuing as #n",
   "paused: waiting on decision …", "done, idle", or "the task continues in a fresh session" (a
   checkpoint). An operator-opened session, which has no queue, says "your next message starts a
   fresh session from Neo's note".

## Considered options

- **Always queue a continuation after a settled handoff.** Rejected. A finished task would start
  a session that only says "nothing to do", and a blocked one would spin.
- **Read the run's result text for "waiting on you".** Rejected. It is the worker's prose. The
  decision row and the note's sections are facts.
- **Resume a blocked continuation through the operator session** (the old answer path). Rejected
  for queued work. It bypasses the queue, so another todo could run in the same folder at the same
  time, and the answer would land in a session with no note. The parked todo keeps it in order and
  visible.
- **A Neo section inside the project's `HANDOFF.md`.** Rejected. A worker writes the note with one
  Write call, which replaces the whole file. A delimited section only survives if every worker edits
  it perfectly. A separate file cannot clobber the project's content.
- **Neo's note inside the repo (`.neo/handoff.md`).** Rejected. Each project would need a
  `.gitignore` change, and until then the file shows as uncommitted work, which the "never hand off
  with uncommitted work" rule (ADR-0021) would trip on.

## Consequences

- A new todo status, `waiting`, with `waiting_on` (a decision id). Migration 10. It is open work:
  the queue shows it, `cancel` works on it, and the release never starts it.
- `/todo`, the console Queue tab and the project dashboard show waiting todos.
- Existing `HANDOFF.md` files in projects are left as they are. Neo stops writing them.
- The "no work" test strips list markers, checkboxes and markdown emphasis. It treats none, nothing,
  n/a, done, complete and "no pending/outstanding/further/next work" as no work.
- `git-read` still leaves a project's own `HANDOFF.md` out of "uncommitted work". That rule dates
  from when Neo wrote the file. It is kept so that projects whose `HANDOFF.md` changes all the time
  (eticket-v3) do not hold every handoff back.
- Restart-gated.
