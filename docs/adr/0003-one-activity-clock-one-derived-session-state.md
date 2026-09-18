# One activity clock, one derived session state

**Status:** accepted (2026-09-18)

Neo could not tell a working session from a wedged one, in both directions on the same day:

- `sessions` reported `adminli · running · waiting for 10h · up 1d` while adminli was healthy and
  answered the next brief 3.4 seconds later. The company read that line as "wedged" and offered to
  restart a working project (ledger: `dispatch_queued` at 2026-09-18T09:46:28Z, followed
  immediately by that worker's own `list_projects` / `get_architecture` / `Bash` stream).
- A worker hung ~9 minutes on an interactive `cp -i` prompt and nothing noticed.
- Dispatch reported "busy — queued" and "busy but no live handle" against healthy sessions
  (ledger: `dispatch_refused … stale_running_no_control` at 10:50:52Z, then that same dispatch's
  `dispatch_start` at 10:52:02Z — 70 s later).

Every one of these is the same defect: **the engine had several partial signals and no
authoritative one**, and it reported the wrong one.

- `SessionInfo.status` is the *lifecycle of the registry entry*. It reads `running` for a session's
  entire life, including while it sits between turns doing nothing wrong. It was printed to the
  operator as if it meant "busy".
- `activity.since` only moves when the activity *label changes* (`registry.ts`), so it answers
  "how long on this label", which for the between-turns label `waiting` is "how long idle" and for a
  repeated `Bash` is "how long grinding". It was printed as the session's headline fact.
- `lastActivityAt` was bumped only by completed tool calls and assistant text, never by
  `onHeartbeat` — the one handler that fires on *every* streamed SDK event. The registry's clock was
  therefore coarser than the clock dispatch kept privately in a local variable.
- `onHeartbeat` was wired **only** into that dispatch-local variable, so the one true liveness
  signal in the codebase existed nowhere the operator, the watchdog, or the idle sweep could read.
- `SessionControl.active()` derived "a turn is in flight" from two monotonic counters
  (`delivered > completed`). Any turn that ends without an SDK `result` — an interrupt, a stream
  error, a resume-missing restart — increments one and not the other and leaves the session
  **permanently** reporting busy.

## Decision

1. **One clock.** `lastActivityAt` means *the last time ANY worker activity was seen*, and
   `onHeartbeat` feeds it. Every judgement of alive-or-wedged — dispatch's stall abort, the stuck
   watchdog, the idle sweep, the operator's status line — reads that one field.
2. **Output is reported, never judged.** `lastOutputAt` is a second, separate clock for what the
   operator can read. It appears in status text and never in a decision.
3. **State is derived, not stored.** One pure function, `sessionState()` in `src/engine/liveness.ts`,
   maps (status, in-turn, blocked-on, the two clocks, thresholds) to exactly one of `working`,
   `quiet`, `idle`, `awaiting-operator`, `wedged`. Everything operator-facing renders that word;
   nothing renders `status` any more.
4. **Awaiting the operator is a first-class state.** The engine marks a session blocked when it
   raises a permission escalation or a decision, and clears it on the answer. A blocked session is
   never wedged, and its stall clock is paused exactly like the API-retry backoff already is.
5. **`active()` is a flag, not a difference of counters** — set when a brief is delivered, cleared at
   the turn result and when the run ends. It can no longer drift permanently out of true.
6. **An abort states its evidence first.** Before a stall abort fires, dispatch records a
   `dispatch_stall_evidence` event carrying the ages, the last label, the queue depth and the
   blocked state it decided on.

## Considered options

- **Keep judging on `activity.since` and just widen the thresholds.** Rejected: it is not a
  calibration problem. `activity.since` answers a different question than the one being asked, so no
  threshold makes it correct — a wider one merely delays both the false "wedged" and the real one.
- **Make `status` turn-scoped (flip it to `idle` between turns).** Rejected: `status` is load-bearing
  for reuse, the idle sweep, reload restore and `findByFolder`, all of which mean "is this entry
  open". Overloading it with "is it busy right now" would trade an operator-facing lie for an
  engine-internal one. The two questions stay two fields, and only the derived state is shown.
- **Have the watchdog probe worker processes for liveness instead of trusting stream events.**
  Rejected as the primary signal: process-level liveness cannot distinguish a worker thinking from
  one blocked on stdin, and it ties the engine to `/proc`. Kept only as *evidence* — a best-effort
  probe that annotates an already-decided wedge, never one that decides it.
- **Report raw numbers and let the company session interpret them.** Rejected: that is what produced
  the incident. The company is an AI reading a string; a line that requires correct interpretation
  of `running` + `waiting for 10h` will eventually be misread, and it was. The engine decides the
  word, deterministically.

## Consequences

- The operator-facing vocabulary changes: `/list`, `sessions` and dispatch's busy replies now say
  `working` / `quiet` / `idle` / `awaiting-operator` / `wedged` and print both ages
  (`last activity 4s ago · last output 3m ago`). `running` disappears from operator text.
- A between-turns session is now reported `idle` at any age, so "it has been like this for 10 hours"
  stops implying a fault. Dispatch says "idle — delivering now", which is what actually happens.
- The stuck watchdog loses its blanket "label is `waiting` → never alert" exemption (which made a
  session wedged *at* a turn boundary undetectable) and gains the narrower, correct one: not in-turn
  → not wedged; awaiting the operator → not wedged.
- A dispatch whose worker is waiting on an approval or a raised decision can no longer be
  stall-aborted at 5 minutes. The per-dispatch ceiling still bounds it.
- `wedgedAfterMs` / `quietAfterMs` join the existing thresholds in `config.ts`, so all of this is
  tunable without a code change.
