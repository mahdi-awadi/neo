# Resume a limit-held todo now (ADR-0060)

Operator bug report 2026-10-29: the main agent said a project held on a usage-limit wait could only be
resumed with `/kill`. The operator sent "Resume" in waselni and the session went on at once.

## Root cause

- `dispatch.ts` waits out an API error with a bare `sleep(delayMs).then(re-send)`: nothing outside the run
  can end it. `todo retry` refuses a `running` todo, and the `todo` tool description itself says a running
  todo "is stopped by the operator with /kill". So the agent had no tool, and was told to say `/kill`.
- Second bug behind it: when the operator's message restarts a held session, the timer still fires later
  and re-sends the whole brief a second time.

## Design: one seam, `src/engine/api-wait.ts`

`createApiWaits({ ledger, now })` → `ApiWaits`, one per daemon, shared by dispatch and the todo queue:

- `hold({ orderId, kind, provider, until }, delay, resend)` — `resend` runs **exactly once**: when `delay`
  resolves, or on `wake`.
- `wake(orderId, reason)` — end the wait now and re-send (the timer's own path). False when none is held.
- `drop(orderId)` — the run is over: no re-send.
- `limitCleared(provider, exceptOrderId, jitter)` — a turn succeeded on the account: every other
  rate-limit hold of that provider wakes after its own jitter.
- Every end records `api_wait_ended { reason }` on the order. `limitWait` (ADR-0047) treats an ended wait
  as gone, so `/todo`, the Queue tab and `sessions` stop showing it.

Wiring: dispatch holds through it (a plain sleep without it, for tests that do not wire it); its
`onTurnComplete` with `ok` and no API error wakes its own hold at once and calls `limitCleared` (config
`apiLimitWakeEarly`, default true; jitter `apiLimitWakeJitterMs`, default 30 s). `todo retry` on a
`running` todo calls `wake`; with no hold it still refuses.

## Display

- `/todo`: `⏳ #N held: limit wait · resumes HH:MM UTC · /todo retry N resumes now` (any API backoff:
  `held: API retry`).
- Queue tab: the existing `queue.limitWait` gains "retry resumes now" (EN + AR); a new `queue.apiWait`.
- `sessions`: a held run's line ends with `held: limit wait · resumes HH:MM UTC · todo retry #N resumes now`.

## Acceptance criteria

1. `todo retry` on a running todo in a limit wait (or any API backoff) re-sends the brief once, at once,
   into the same run; the timer firing later sends nothing.
2. `todo retry` on a running todo that is working (no hold) is refused, as today.
3. A successful turn on the held order (e.g. the operator's "Resume") ends the hold at once: one re-send
   right after that turn, none later; an `ok:false` turn changes nothing; a run that ends drops its hold.
4. A successful turn on another order of the same provider wakes the other rate-limit holds after jitter;
   other providers' holds and non-limit backoffs stay.
5. After any end, `limitWait` returns nothing for that order; the three displays show the hold while it
   lasts.
6. The `todo` tool description and `agent/CLAUDE.md` say retry resumes a held todo; no `/kill` advice.
