# A todo that fails for a passing reason is retried, and a failed todo is never dropped

**Status:** accepted (2026-10-08) · amends ADR-0008 (the todo queue): its "re-run the interrupted
todo at boot — rejected" option and its failure policy.

On 2026-10-07 four eticket-v3 todos (#77–#80) and one Neo todo (#76) ended `failed` within one
minute. The SDK said "Your organization has disabled Claude subscription access" (`apiError:
oauth_org_not_allowed`). This is an account error, not a task failure. The queue marked each one
`failed` and started the next one, which failed in the same way. Nothing re-ran them. The next day the
company dispatched new "RESUME" briefs (#81–#87) in a different thread. The work got done, but the
old rows stayed `failed`, so the console showed red items for finished work. Earlier, #46 (a stall
abort) and seven todos cut short by restarts had the same result.

The operator's order (2026-10-08): a failed todo is **kept, never dropped, and re-run later**.

## Decision

1. **The end of a run is classified by code, from structured facts.** Dispatch already knows why a
   run ended. It now passes the reason to the queue as `failure` on its end report: `stall` (the
   liveness limit aborted it), `reload` (the engine wrapped it up for a reload), `checkpoint` (a
   context checkpoint could not complete), `launch` (the worker failed to start), or `api:<kind>` (the
   SDK's own error kind). A restart that cuts a run short is `restart` (boot recovery). The rule is
   in `todo-retry.ts`. Every reason above is **transient**, except three API kinds that a re-run
   cannot fix: `invalid_request`, `model_not_found`, `max_output_tokens`. A run that ends `ok: false`
   with no reason is a **task failure**: the worker finished and said it failed, or the operator
   stopped it with `/kill`. The engine never reads the summary text to decide.
2. **A transient end keeps the todo as `retry`.** The todo gets a new status, `retry`, plus an
   `attempts` count and a `retry_at` time from a backoff ladder in config (`todoRetryBackoffMs`,
   default 15 min, 1 h, 4 h, 12 h). As with `apiRetryLadderMs`, the number of automatic retries is
   the length of the ladder, not a separate setting. On the daemon tick, a due retry goes back to
   the **head** of its project's queue, because it was ahead of everything queued after it. While it
   waits, the rest of the queue keeps running. A `retry` todo is open work: its thread stays `open`,
   not `failed`.
3. **A todo that ran before is told so.** This covers an automatic retry, and the operator's re-run of
   a failed todo. The test is "has started before", not the retry count. The stored brief does not
   change. The run gets a fixed preamble from the engine: the attempt (or "re-run on request"), why
   the last run stopped, and "check what is already done (git log, git status, the files) and
   continue; do not repeat finished steps". This
   is how ADR-0008's objection is met: work is not idempotent. The company wrote this same preamble
   by hand for #81–#87.
4. **When the retries are used up, the todo is parked as `failed`.** It is still visible and can
   still be re-run. A task failure is `failed` at once. Only a parked or task `failed` todo applies
   the `todoOnFailure` policy (`continue` / `pause`). A todo that waits as `retry` does not, because
   it has not ended.
5. **A failed todo is never removed.** History pruning (`TODOS_KEEP`) now drops only `done` and
   `cancelled` rows. The operator and the company can re-queue a failed todo with **retry**
   (`/todo retry <id>`, the company's `todo` tool `retry` action, a Retry button in the console's
   Queue tab). Retry puts the same row back in the queue with a new attempt budget. It does not
   create a second todo. Retry on a `retry` todo runs it now, without waiting for the backoff. A
   `retry` todo can also be cancelled, like a queued one.
6. **A later finished redo in the same thread closes it.** Todo N runs in thread T and folder F and
   ends `done`, with no hand-off continuation. The todos of T and F that had **already stopped when
   N was created** become `done`: `failed`, `retry`, or a due retry already back in the queue.
   N was dispatched after they stopped, so it was their redo. A todo that was queued alongside N, and
   failed only later, is a separate task and is not changed. The result names N and keeps the old
   result after it. A pending retry is closed too, so finished work is never done twice.
7. **No "resume it" for work the queue re-runs.** At boot, the report for a cut-short todo run says
   that the todo is kept and re-runs by itself — "do NOT dispatch it again" — instead of asking the
   company to resume it. Otherwise the same work would run twice, which is the #81–#87 pattern.
8. **An API kind only for a real API failure.** A result that ends with `error_max_turns` or
   `error_during_execution` (a turn cap, an interrupt) gets no API kind, so it is a task failure,
   not a transient one. A "→ todo" tap on an attention item whose todo failed re-runs that row.

## Considered options

- **Classify by matching the result text** ("disabled Claude subscription access", "timed out").
  Rejected. The text is the SDK's and changes between versions. The SDK already gives a typed
  `apiError`, and dispatch knows about stalls, reloads and launch failures as facts.
- **Retry every failure, including task failures.** Rejected. A worker that reported "I could not do
  this" will report it again. `/kill` is the operator's order to stop. Re-running either one burns
  the subscription for nothing.
- **Retry at the end of the queue, or pause the queue while a retry waits.** Rejected. The end of the
  queue reorders the operator's work behind a transient failure. Pausing the queue for a todo that
  waits hours for backoff stops unrelated work. The head of the queue, once the retry is due, keeps
  the order the operator chose.
- **Re-run the interrupted todo at once at boot** (ADR-0008's rejected option). Still rejected as
  stated: no backoff and no retry preamble. A restart now gives `retry` with the same backoff and
  preamble as any other transient end.
- **Close every earlier failed todo of the thread and folder when a later todo there succeeds.**
  Rejected after review. One message often makes several separate todos for one project ("do A, B
  and C"). If B succeeds, A would be closed without ever running. Only a todo created after A had
  stopped can be A's redo.
- **Close a failed todo when any later run in the thread succeeds**, including company turns and
  operator-session orders. Rejected. The company's session folder is `/home/neo`, the same as the
  neo project, so a company reply would close neo todos it never worked on. Only a **todo** run in
  the **same folder** counts, because only that is evidence that the project's work went on.
- **Ask the company to mark the old todo done when it re-dispatches.** Rejected. That puts queue
  bookkeeping in the AI. Retry re-runs the same row, and the thread rule covers the rest
  deterministically.
- **Match a new brief to an old failed todo by its text.** Rejected. It is fuzzy, and it is not the
  engine's job to guess. The 2026-10-08 RESUME briefs ran in a new thread, so even the thread rule
  would not have linked them. Automatic retry removes the need for those briefs.

## Consequences

- A ledger migration adds `attempts`, `retry_at` and `failure` to `project_todos`.
- The operator sees one line per transition, for example: "eticket-v3: #77 stopped (api:
  oauth_org_not_allowed) — retry 1/4 at 15:37".
- During an account outage, each todo uses its own retries and then parks as `failed`. One Retry tap
  per todo re-queues it.
- The company's `todo` tool says: to re-run a failed todo, use `retry`. Never dispatch a new brief
  for it.
- Restart-gated, like every engine change.
