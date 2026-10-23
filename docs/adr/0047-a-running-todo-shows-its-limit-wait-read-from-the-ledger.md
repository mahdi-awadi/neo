# A running todo shows its limit wait, read from the ledger

**Status:** accepted (2026-10-23; built on `dev`, restart-gated). Display only. Builds on the API
rate-limit recovery (`src/engine/api-retry.ts`) and the todo queue (ADR-0008, ADR-0027).

When a worker's turn ends because the subscription hit its usage/session limit, the dispatch keeps
its run open and re-sends the brief into the same session at the reported reset
(`dispatch.ts`, `onTurnComplete`). The todo correctly stays `running`. But the queue showed
"running 47m", so on 2026-10-22 the operator read #515, #517 and #524 as stuck.

## Decision

1. **A limit wait is derived, not stored.** Every wait already writes one `api_retry` event under
   the todo's order, with `kind`, `delayMs` and `at`. The todo's **limit wait** is the newest
   `api_retry` of its order when its `kind` is `rate_limit` and `at + delayMs` is still in the
   future. Its resume time is `at + delayMs`: the moment the dispatch really re-sends the brief
   (the reset plus its jitter), not the bare `resetsAt`.
2. **One seam:** `limitWait(ledger, orderId, now)` in `api-retry.ts`. The text queue
   (`todo list`, Telegram `/todo`) and the console snapshot (`activeTodos`) both call it. Neither
   reads events itself.
3. **No status change.** The todo stays `running`. The text line reads
   `⏳ #id waiting for limit reset · resumes HH:MM UTC — title`, with the date first when the resume is another day (a weekly limit). The console gets
   `limitResumesAt` on the todo and shows `queue.limitWait` (AR+EN), with the time as an LTR isolate
   in the browser's own clock.

## Rejected

- **A new todo status (`limit_wait`).** The handoff notes show why: a status change invites the
  queue to act on it. `retry` would start a second dispatch at `retry_at` while the first one still
  waits. The run is live; only the label is wrong.
- **In-memory state in the dispatch or the registry.** The dispatch knows `retryingUntil`, but
  exposing it means a new registry field, plumbing through two frontends, and it would not survive
  into the CLI view. The ledger event already holds the same fact durably.
- **Show every API wait.** An `overloaded` or `server_error` wait is a 30 s–8 m ladder, not a limit
  reset. Calling it "waiting for limit reset" would be false.

## Consequences

- Restart-gated: the daemon must run `dev` for the new line.
- One indexed query (`events (order_id, at)`) per running todo per view. There are few running todos.
- A restart during a wait already turns the todo into `retry` (`recover`); the label then goes with it.
