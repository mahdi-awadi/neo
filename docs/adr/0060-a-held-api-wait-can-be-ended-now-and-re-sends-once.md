# A held API wait can be ended now, and its brief is re-sent once

**Status:** accepted (2026-10-29; built on dev, restart-gated). Related: ADR-0027 (todo retries),
ADR-0047 (limit-wait display), ADR-0008 (todo queue).

## Context

After an API error (a weekly usage limit, an overload), dispatch keeps the todo `running` and re-sends its
brief into the same open run when the wait ends — up to the limit's reset, hours or days away. The wait was a
bare `sleep().then(re-send)`: nothing could end it. `todo retry` refused a running todo, and the `todo` tool
described a running todo as "stopped by the operator with /kill". On 2026-10-29 the main agent told the
operator to `/kill` four held projects. The operator reset the limit and sent "Resume" into one: it went on
at once. That also exposed a second fault: the old timer would still fire later and re-send the whole brief
into a session that had already moved on.

## Decision

1. **One in-memory registry, `api-wait.ts`,** shared by dispatch and the todo queue. Dispatch holds every
   API wait through it; the re-send runs exactly once — on the timer, or on `wake`.
2. **`todo retry` on a running todo wakes its hold** (the same run, the brief re-sent now). A running todo
   with no hold is still refused. `cancel` on a held todo points at `retry`.
3. **A turn that really goes through (`ok`) on a held run ends its hold at once:** the re-send goes right
   after that turn (the retry follow-up asks the worker to check what is already done), never days later.
   It is not dropped: the turn that went through may have been another brief delivered into the session,
   and dropping would lose the task. A run that ends drops its hold (nothing re-sends into a closed run).
   An interrupted or turn-capped turn (`ok: false`) proves nothing and changes nothing.
4. **A turn that goes through wakes the same provider's other limit holds early** (config
   `apiLimitWakeEarly`, default on), each after a random wait up to `apiLimitWakeJitterMs`. Only `rate_limit`
   holds, only the same provider: a limit is one account's.
5. **Every end is on the ledger** (`api_wait_ended`, with its reason). The display reads it: `apiWait`
   (any API backoff) and `limitWait` (limits only, ADR-0047) treat an ended wait as gone. `/todo`, the
   Queue tab (a "resume now" button) and `sessions` show "held: limit wait · resumes HH:MM".

## Alternatives rejected

- **Make `todo retry` cancel the run and queue the todo again.** It starts a second run and throws away the
  open session the operator could simply resume.
- **A new tool that sends any text into a project's session.** Much wider than the need, and it would let
  the agent push briefs into a busy session, which ADR-0008 forbids.
- **Shorten the wait by re-reading the account's limit status.** The SDK gives no reliable "limit cleared"
  probe before the reset; a turn that goes through is the proof, and that is what decision 4 uses.
- **Persist holds in the ledger.** A restart ends every run (ADR-0054 interrupted orders), so a hold never
  outlives the process; the ledger keeps only the trail.

## Consequences

- The chief of staff can resume a limit-held project without a kill; the `todo` tool and `agent/CLAUDE.md`
  say so.
- An early wake that comes too soon (the limit not really gone) hits the limit again and waits again. An early
  wake gives back its API retry, so it never uses up the run's budget and makes it give up.
- An early end gives back the rest of the wait: the stall clock and the spin count work again at once.
- Low, not changed: `apiWait` compares the end and the retry by time; two events in the same millisecond
  cannot happen with real clocks (a re-send takes longer).
- Restart-gated: the registry, the retry path and the new displays need the new daemon.
