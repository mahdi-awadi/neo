# Errors are contained per unit and reported; only an unrecoverable state exits

**Status:** accepted (2026-10-04)

The operator's order (2026-10-04): "when Neo faces an error it should not break the whole engine and
exit; report it instead of crashing", and "report the error to Neo itself to investigate and fix".

An audit of master 91b56be found that the daemon had no `uncaughtException` / `unhandledRejection`
handler, so under Bun one rejected promise nobody awaited exits the process. A systemd restart then
kills every running worker mid-turn. The log already showed three such crashes: `database is locked`
from a Telegram send's route write, the same from an SDK stream's event write, and a port-in-use
boot loop. grammy had no `bot.catch`, and its default handler stops polling and rethrows. About 15
`void bot.api.sendMessage(...)` calls had no `.catch`, so one Telegram 429 was fatal. SQLite ran
with no `busy_timeout` and no WAL.

## Decision

1. **One fault seam: `src/engine/fault.ts`.** `faults.report(component, err, ctx)` never throws.
   It (a) logs one line with component, project, order id and the stack, (b) records an
   `engine_fault` ledger event, (c) sends the operator a deduplicated, rate-limited alert, and (d)
   queues the fault in the dispatcher inbox, so the company (Neo) gets it to investigate on its next
   delivery. `guard` (sync) and `contain` (a promise nobody awaits) are thin wrappers. It is a
   module-level reporter that the daemon configures once, as an error tracker usually is. Threading
   a reporter through every frontend and engine call would touch every signature for no added rule.
2. **Contain per unit, at the boundary where the unit starts.** Each heartbeat step runs in its own
   `guard`, and the tick re-arms in `finally`. Then a failed step cannot stop the watchdog, the
   scheduler or the todo pump. Telegram: `bot.catch` reports the failed update and polling goes on.
   Every fire-and-forget send, web `send`, manual loop start and interactive-run continuation is
   `contain`ed, with its project and order id.
3. **Process safety net.** `uncaughtException` and `unhandledRejection` report and keep running.
   Only an **unrecoverable state** exits: `main()` failing at startup (ledger cannot open, port
   cannot bind) logs the error and exits 1, so the supervisor restarts it. Without that, the safety
   net would keep a half-started daemon alive.
4. **Telegram 429.** Handled by the existing flood gate (`frontends/telegram-flood.ts`,
   `telegramFloodMaxWaitMs`), not a second mechanism: a short `retry_after` is waited out once, a
   long one holds sends to that chat until it lifts. `installFloodGate(api)` puts every Bot API
   client behind it — the bot, and the daemon's own operator client (`createOperatorApi`) for alerts
   and scheduled-loop lines — so no send bypasses the rate-limit state. A first draft of this ADR
   added its own retry transformer; it was dropped on the rebase onto the flood gate.
5. **SQLite.** Every store opens through `openSqlite`: WAL plus `busy_timeout`
   (`sqliteBusyTimeoutMs`). That gives SQLite's own retry on a locked database. A write that still
   fails is a fault of its unit, not of the process.
6. **No update handler waits on a later update.** grammy handles updates one at a time. The
   Telegram inbox send awaited the Allow/Deny press inside its own callback handler, so the press
   could never be delivered: a deadlock. A wait for a later update (and a long company drafting
   run) now runs detached as its own contained unit, and the handler returns at once. An approval
   whose message cannot be posted is denied at once (fail closed), never left waiting.
7. **Health check.** On an interval (`health.everyMs`), the daemon measures event-loop lag (timer
   drift), RSS memory and a `SELECT 1` on the ledger. When one crosses its threshold it reports
   once, and once more when it recovers.

## Considered options

- **Let it crash; the supervisor restarts.** Rejected. A restart kills every running worker and
  every in-flight dispatch. The operator asked for the opposite. Crash-only design fits stateless
  workers, not a daemon that holds live SDK sessions.
- **Exit on `uncaughtException` after logging (the Node.js docs' advice).** Rejected as the default,
  because Bun treats an unhandled rejection the same way and most of ours are one failed send.
  Instead, the states that really leave the process unsound (startup failure) exit explicitly.
- **`@grammyjs/auto-retry`, or a separate retry transformer.** Rejected: the flood gate already
  owns 429 state per chat. A second retry layer would wait twice and could resend into a live ban.
- **`@grammyjs/runner` (concurrent updates) for the deadlock.** Rejected. It changes the order of
  every update for every chat, needs `sequentialize` to keep one chat in order, and adds a
  dependency. Only two handlers wait on long work. Detaching those two fixes the cause.
- **Wake the company for every fault.** Rejected. A repeating fault would spend budget on the same
  investigation many times. Faults are deduplicated by signature, then queued, and the company gets
  them on its next delivery.

## Amendment (2026-10-04, code review)

- **Company handoff is capped** (`faults.maxHandoffsPerHour`, default 3), separately from alerts,
  and a fault signature ignores digits. Before, a flood ban made every failed send a new signature
  (`retry_after` changes), each one woke the company, and the company's reply failed again: a loop.
- **Telegram polling.** `bot.start()` rejects on 401/409 and also on a failed startup
  `getMe`/`deleteWebhook`. Only 401/409 is an unrecoverable state (exit 1, supervisor restarts).
  Any other stop is reported and polling restarts on a 5 s / 30 s / 120 s backoff
  (`superviseTelegramPolling`).
- **Inbox Send is idempotent on the draft version** (see CONTEXT.md). The guard is in
  `sendInboxReply`, so web and Telegram share it. Rejected: a Telegram-only in-flight set (web
  double posts stay open) and comparing draft text (an edit back to the same text is still an edit
  the operator did not approve).
- The post-completion context handoff is contained (`pipeline.handoff`).

