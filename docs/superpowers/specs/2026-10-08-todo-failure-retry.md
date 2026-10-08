# Todo failures: retry on a transient end, never drop a failed todo (ADR-0027)

## Problem
Each bad end made a todo `failed`, and nothing re-ran it. A Claude account outage (`oauth_org_not_allowed`)
failed #76–#80 one after another. The re-dispatched RESUME briefs (#81–#87) finished the work, but the old
rows stayed red.

## Seam
`src/engine/todo-retry.ts`: pure functions and no I/O.
- `classifyEnd(failure?: string): { transient: true; reason } | { transient: false }`
- `nextRetry(attempts, ladderMs, now): { retryAt } | undefined` (undefined means park as `failed`)
- `retryBrief(t): string`: the preamble + the original brief, for a run with `attempts > 0`

The queue (`todo-queue.ts`) is the only caller. Dispatch only adds `failure` to its end report.

## Acceptance criteria
1. A run that ends with `failure` `api:oauth_org_not_allowed`, `api:rate_limit`, `stall`, `reload`,
   `checkpoint` or `launch` → the todo becomes `retry`, with `attempts` 1 and `retry_at` = now + ladder[0].
   Its `result` keeps the summary. The next queued todo starts. The failure policy is not applied.
2. `api:invalid_request`, `api:model_not_found`, `api:max_output_tokens`, or no `failure` → `failed` at once.
3. A due retry (`retry_at <= now`) goes back to queued at position 1 on `pump()`, and then starts when the
   project is free. A retry that is not due stays `retry`.
4. A retry run's brief starts with the retry preamble (the attempt number and the last result), followed
   by the original brief. The stored brief does not change.
5. After `ladder.length` retries, the next transient end parks the todo as `failed` and says it gave up.
   The failure policy applies.
6. Boot `recover()`: a `running` todo → `retry` (reason `restart`) under the same ladder.
7. `retry(id)` on `failed` → queued at the end of the queue with `attempts` 0. On `retry` → queued at the
   head now. On any other status → refused with a message. Offered by `/todo retry <id>`, the company
   `todo` tool and the console Queue tab (a Retry button, AR+EN catalogue strings).
8. `cancel(id)` also cancels a `retry` todo.
9. A todo run that ends `done` (with no continuation) closes, as `done`, the todos of the same thread
   and folder that had already stopped when it was created: `failed`, `retry`, or a due retry already
   queued. Their result names the closing todo. A sibling that failed after the closer was created,
   other folders, other threads, and todos with no thread are not changed.
10. Pruning never deletes `failed` or `retry` rows.
11. A thread with a `retry` todo is `open` (it counts as active work).
12. The console Queue tab and `/todo` show `retry` todos (when they re-run) and `failed` todos (with retry).
13. Any todo that ran before (`started_at` set) gets the retry preamble, including after the operator's
    retry. A cut-short todo's boot report says "do NOT dispatch it again", not "resume it".
    `error_max_turns` and `error_during_execution` results carry no API kind.

## Edge cases
- The project is paused when a retry becomes due: it is queued at the head and waits for resume.
- A retry run that ends with a hand-off continuation: the continuation goes first, as today.
- A "delivered into the operator's session" todo does not close older todos. It is not a finished run.
- Migration: new columns with defaults. Existing rows get `attempts` 0.

## One-off data fix (live ledger, after a backup)
Mark these done, each with a note that names the later work: #10, #16, #42, #46, #59, #60, #76, #77, #78,
#79, #80. #61 (Cloudflare Browser Cache TTL) stays `failed`, because the edge still rewrites `no-cache`
to `max-age=14400`. The operator can retry it.
