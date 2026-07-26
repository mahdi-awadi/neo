# Engine event log — design (2026-07-26)

## Problem

The engine persists CONVERSATION messages (ledger `messages`, written from `pipeline.ts`), but has
essentially **no durable diagnostic/event trail**. `session-runner.ts`, `api-retry.ts`, `usage.ts`,
and `dispatch.ts` do no structured logging; only startup/reload lines reach the systemd journal. So
when the engine goes unstable — API throttle/retry loops, wedged dispatches, orphaned/stalled
sessions (the 7 issues in `HANDOFF.md`, 2026-07-25) — there is nothing persistent to diagnose from
after the fact.

Goal: a durable, structured **event log** so instability leaves a diagnosable trail, at the
high-value points that correlate with the known instability. Lightweight, privacy-sane (kinds +
structured metadata, never message bodies), and queryable by the operator.

## Non-goals

- Not a metrics/timeseries system, not a replacement for the `messages` transcript or the
  `outcomes`/`context_events` tables.
- No new UI — reuse the existing operator command surface (`/recent` pattern).
- No per-turn success spam: a routine successful turn is already covered by `outcomes`. We record
  the *transitions that correlate with instability*, not every turn boundary.

## Architecture

One new ledger table + a `recordEvent` helper, following the ledger's existing audit-table
precedent exactly (`context_events`/`recordContextEvent`/`listContextEvents`,
`cache_observations`/`recordCacheObservation`). Instrumentation happens at the call-sites where the
`Ledger` is already in scope (`pipeline.ts`, `dispatch.ts`); the pure SDK core (`session-runner.ts`)
emits via a thin optional `onEvent` handler that those callers wire to `recordEvent` — the same
handler-injection pattern the runner already uses (`onMessage`, `onActivity`, `onHeartbeat`,
`onTurnComplete`). `api-retry.ts`/`usage.ts` stay pure (they hold no ledger); their events are
recorded at their call-sites in `pipeline.ts`/`dispatch.ts`.

```
session-runner.ts  --onEvent(kind,data)-->  pipeline.ts / dispatch.ts  --ledger.recordEvent-->  events table
                                            (also record retry/dispatch                              |
                                             lifecycle directly)                          /events (commands.ts)
```

## Data model

New table (created in `openLedger`, alongside the others):

```sql
CREATE TABLE IF NOT EXISTS events (
  kind       TEXT    NOT NULL,   -- stable event-kind slug (see catalogue)
  at         INTEGER NOT NULL,   -- epoch ms
  order_id   TEXT,               -- correlate to an order (nullable)
  session_id TEXT,               -- SDK session id when known (nullable)
  folder     TEXT,               -- project folder when known (nullable)
  data       TEXT                -- JSON blob of small structured metadata (nullable)
);
CREATE INDEX IF NOT EXISTS idx_events_kind_at  ON events (kind, at);
CREATE INDEX IF NOT EXISTS idx_events_order_at ON events (order_id, at);
CREATE INDEX IF NOT EXISTS idx_events_at       ON events (at);
```

The `(kind, at)` and `(order_id, at)` indexes are the two required by the brief; `(at)` serves the
default "recent events, newest-first" read.

### Ledger interface additions

```ts
/** One structured engine event (diagnostic trail). `data` is small structured metadata —
 *  ids/counts/timings/error codes/short messages — NEVER a full message body. */
export interface EngineEvent {
  kind: string;
  at: number;
  orderId?: string;
  sessionId?: string;
  folder?: string;
  data?: Record<string, unknown>;
}

// on Ledger:
/** Append one diagnostic event. A single cheap INSERT; retention is amortised (see EVENTS_KEEP). */
recordEvent(kind: string, input?: Omit<EngineEvent, "kind" | "at"> & { at?: number }): void;
/** Recent events, newest-first. Filter by kind and/or orderId; capped by limit (default 50). */
listEvents(opts?: { kind?: string; orderId?: string; limit?: number }): EngineEvent[];
```

`recordEvent` extracts `orderId`/`sessionId`/`folder` into columns and `JSON.stringify`s the rest of
`data` into the `data` column (or `NULL` when absent). `listEvents` parses `data` back (tolerating a
corrupt blob → `undefined`).

### Retention

`recordEvent` is a **single INSERT** on the common path (per the brief: "cheap, no blocking"). To
bound growth without a DELETE-per-insert, retention is amortised: an in-closure counter prunes only
every `EVENTS_PRUNE_INTERVAL` (1000) inserts, deleting rows beyond the newest `EVENTS_KEEP`
(50_000). Volume is low (errors/retries/dispatch/session transitions — hundreds–low-thousands/day),
so this keeps the table bounded while the hot path stays one insert. (Mirrors `message_routes`'
keep-window idea, but off the hot path.)

## Event catalogue

Stable kind slugs, each with the minimal metadata that makes it diagnosable. `scope` distinguishes
the interactive pipeline path from the company-dispatch path where a kind is shared.

**Session lifecycle** (emitted by `session-runner.ts` via `onEvent`, recorded by the caller with
`orderId`/`folder` attached):
- `session_start` — `{ folder, resume: boolean }` — a worker run began (fresh vs resume).
- `sdk_api_retry` — `{ attempt, max }` — the SDK's *own* internal api_retry (previously only shown
  as transient activity, never persisted; a leading indicator of a throttle storm).
- `session_interrupted` — `{}` — the stream ended via the interrupt/idle-close/kill catch path.

**API errors / retries** (recorded directly in `pipeline.ts` + `dispatch.ts`, where `resolveApiRetryDelayMs`/`shouldRetryApi` run):
- `api_retry` — `{ scope, project, kind, attempt, max, delayMs, source: "reset"|"ladder", resetsAt? }`
  — a second-tier retry was scheduled (captures HANDOFF issue 6: the real `resetsAt` vs the ladder).
- `api_giveup` — `{ scope, project, kind, attempts }` — retries exhausted or not attempted (throttled/
  draining/interrupted); the work did NOT run.

**Dispatch lifecycle** (recorded directly in `dispatch.ts` — the wedge/queue asymmetries in memory):
- `dispatch_refused` — `{ project, reason: "draining"|"cooldown"|"not_found"|"busy_no_control" }`.
- `dispatch_queued` — `{ project }` — brief queued behind a busy live session.
- `dispatch_start` — `{ project, resume: boolean, ceilingMs, stallMs }`.
- `dispatch_abort` — `{ project, limit: "stall"|"ceiling" }` — graceful-grace expired → hard abort.
- `dispatch_end` — `{ project, ok, timedOut, costUsd, apiError? }` — result booked + reported back
  (captures HANDOFF issue 7: whether the result was actually returned).

`session_end` for the interactive path is intentionally folded into the existing `outcomes` write +
the `api_giveup`/`dispatch_end` events rather than adding a routine per-run event — avoids drowning
the diagnostic signal. This is the one refinement from the brief's "turn begin/end" wording: we log
the *notable* transitions, not every turn.

## Query surface

A new `/events` operator command in `commands.ts`, built exactly like `/recent`
(`renderRecent(ledger)` → `renderEvents(ledger)`). Because both frontends dispatch through
`handleCommand` + `telegramCommands()`, adding it to the `COMMANDS` registry surfaces it on Telegram
and the web console with **zero frontend changes**. It renders the most recent N events newest-first
as compact lines: `HH:MM:SS · kind · project/folder · key=val…`. Optional arg `/events <kind>`
filters by kind (e.g. `/events api_retry`).

## Testing (TDD, failing test first, per piece)

1. **ledger** (`tests/ledger.test.ts`): `recordEvent`→`listEvents` round-trips fields + parsed
   `data`; newest-first; `kind`/`orderId` filters; `limit`; retention keeps ≤ `EVENTS_KEEP` after
   the prune interval; a single record with no `data` reads back `data: undefined`.
2. **session-runner** (`tests/session-runner.test.ts`): `onEvent` fires `session_start`
   (resume flag correct), `sdk_api_retry` on the SDK api_retry message, `session_interrupted` on the
   throwing-stream path — asserted with a fake `onEvent`. Existing behaviour (activity, results)
   unchanged.
3. **dispatch** (`tests/dispatch.test.ts`): after a dispatch, `ledger.listEvents` contains
   `dispatch_start` then `dispatch_end`; a refusal records `dispatch_refused` with the right reason;
   a queued brief records `dispatch_queued`; an API-errored turn that retries records `api_retry`
   with the resolved `delayMs`/`source`.
4. **pipeline** (`tests/pipeline.test.ts`): a throttled turn records `api_retry`; a non-retryable /
   exhausted turn records `api_giveup`.
5. **commands** (`tests/commands.test.ts`): `/events` renders recent events; `/events <kind>`
   filters; empty → a friendly "No events yet." line; `/events` appears in `telegramCommands()`.

## What needs a reload

**Status: IMPLEMENTED** on branch `feat/engine-event-log` (TDD, 5 feature commits; full suite green,
591 pass; `bunx tsc --noEmit` clean). NOT merged, NOT deployed, daemon NOT reloaded.

All of this is engine code. It takes effect on the **next daemon reload** — which this task does NOT
perform (per `never-restart-without-permission`). New events start being written, and `/events`
starts working, only after the operator reloads. Nothing machine-local is tracked (the events live
in the existing ledger sqlite file, already gitignored under `company/`).
