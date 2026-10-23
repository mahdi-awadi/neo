# Spec: a running todo shows its limit wait (ADR-0047)

Display only. Small change: one seam, three views.

## Seam

`limitWait(ledger, orderId, now): { resumesAt: number } | undefined` in `src/engine/api-retry.ts`.

## Acceptance criteria

1. The newest `api_retry` of the order has `kind: "rate_limit"` and `at + delayMs > now` → returns
   `{ resumesAt: at + delayMs }`.
2. The wait has passed (`at + delayMs <= now`) → undefined.
3. The newest `api_retry` is `overloaded` or `server_error` → undefined.
4. No order id or no `api_retry` event → undefined.
5. `todo list` / Telegram `/todo` (`TodoQueue.list`): a running todo in a limit wait shows
   `⏳ #id waiting for limit reset · resumes HH:MM UTC — title` (with the date first when it is not today). Other running todos keep
   `▶ #id running Nm — title`. The status stays `running`.
6. Console: `activeTodos` adds `limitResumesAt` to a running todo in a limit wait. The Queue tab
   shows `queue.limitWait` (EN and AR catalogues) with the time as an LTR isolate.

## Edge cases

- Several waits on one order: only the newest counts.
- A restart during the wait: `recover` makes the todo `retry`; nothing new is shown for it.
