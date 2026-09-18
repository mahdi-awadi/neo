# Session liveness truth — working vs wedged — design

**Date:** 2026-09-18
**Status:** approved (operator bug report with evidence; root-caused against the ledger)
**ADR:** `docs/adr/0003-one-activity-clock-one-derived-session-state.md`
**Glossary:** `CONTEXT.md` → "Telling a working session from a wedged one"

## Problem

Neo cannot tell a working session from a wedged one, and says the wrong thing in both directions.
Root causes, with file:line:

1. `src/engine/registry.ts:142` — `noteActivity` moves `activity.since` only when the **label
   changes**, so the rendered "X for 10h" is the age of a label, not of the session's last sign of
   life. Between turns the label is `waiting` (`src/engine/session-runner.ts:460`), so a healthy
   idle session renders as `waiting for 10h`.
2. `src/engine/session-status.ts:34-46` — `describeSessionStatus` leads with
   `SessionInfo.status`, which is the registry entry's lifecycle and stays `running` for the
   session's whole life (`src/engine/registry.ts:87`), and prints `activity.since` as the only age.
   `lastActivityAt` is never shown. `running · waiting for 10h` is what the company read as
   "wedged for 10 hours" before offering to restart a working project.
3. `src/engine/session-runner.ts:392` — `onHeartbeat` fires on every streamed SDK event, but is
   wired **only** to a dispatch-local variable (`src/engine/dispatch.ts:501`). The registry's
   `lastActivityAt` is bumped from completed tool calls / text only
   (`src/engine/pipeline.ts:392-399`, `src/engine/dispatch.ts:564-572`), so a worker mid-generation
   looks silent to the watchdog (`src/engine/watchdog.ts:25`) and the idle sweep
   (`src/engine/idle.ts:52`).
4. `src/engine/dispatch.ts:615` — the stall abort measures activity (correct) but nothing pauses it
   while the worker is blocked on a permission escalation, which by construction emits **no** SDK
   events (`src/engine/session-runner.ts:335` awaits `onEscalation`). A legitimately waiting worker
   is aborted at 5 minutes. The API-retry pause (`dispatch.ts:610`) shows the shape of the fix.
5. `src/engine/session-runner.ts:824-834,878` — `active()` is `delivered > completed`. A turn that
   ends without an SDK `result` (interrupt, stream error, resume-missing restart) increments
   `delivered` only, so the session reports busy **forever**. This is dispatch's busy/queue signal
   (`dispatch.ts:368`).
6. `src/engine/dispatch.ts:349,393` vs `:589` — the session is marked `running` before the
   background continuation attaches the control, and `ensureIndexed` sits between them. Any dispatch
   landing in that window gets "appears busy … no live handle" (`dispatch.ts:386`). Ledger evidence:
   `dispatch_refused stale_running_no_control` 10:50:52Z, its own `dispatch_start` 10:52:02Z.
7. `src/engine/watchdog.ts:23` — `activity.label === "waiting"` is a blanket alert exemption, so a
   session wedged *at* a turn boundary can never be alerted.

## Design — one clock, one derived state

### The seam

`src/engine/liveness.ts` — pure, clock-injected, no I/O:

```ts
export type SessionState = "working" | "quiet" | "idle" | "awaiting-operator" | "wedged";

export interface LivenessSignals {
  /** A turn is being worked right now (control.active()). */
  inTurn: boolean;
  queued: number;
  blockedOn?: BlockedOn;          // set while the operator owes an answer
}
export interface LivenessThresholds { wedgedAfterMs: number; quietAfterMs: number }

export function sessionState(s: SessionInfo, sig: LivenessSignals, th, now): SessionState;
export function livenessEvidence(s, sig, th, now): Evidence;   // the facts a decision was made on
export function describeLiveness(s, sig, th, now): string;     // the one operator-facing line
```

Decision order (first match wins):

| # | Condition | State |
|---|-----------|-------|
| 1 | `status` is not `running` | `idle` |
| 2 | `blockedOn` set | `awaiting-operator` |
| 3 | not `inTurn` | `idle` |
| 4 | `now - lastActivityAt >= wedgedAfterMs` | `wedged` |
| 5 | `now - lastOutputAt >= quietAfterMs` | `quiet` |
| 6 | otherwise | `working` |

Only rules 4 and 5 read a clock, and only rule 4 can mean "something is wrong". Nothing reads
`activity.since`; it survives as a *label age* for display only.

### Model changes

- `SessionInfo.lastActivityAt` — redefined: last time ANY activity was seen. Fed by `onHeartbeat`.
- `SessionInfo.lastOutputAt` — new: last operator-visible output. Fed by `onMessage`.
- `SessionInfo.blockedOn?: { kind: "approval" | "decision"; label: string; since: number }`.
- `Registry.noteHeartbeat(id, now)` / `noteOutput(id, now)` / `noteBlocked(id, blocked|undefined)`.
- `SessionControl.active()` becomes a flag: true on delivery, false at the turn result and when the
  run ends.

### Wiring

- `pipeline.ts` + `dispatch.ts`: `onHeartbeat → registry.noteHeartbeat`, `onMessage →
  registry.noteOutput`, `onEscalation`/`onStructuredQuestion` wrapped to mark and clear
  `blockedOn`.
- `dispatch.ts` stall monitor: skip while `blockedOn` is set (same treatment as `retryingUntil`);
  record `dispatch_stall_evidence` before the wrap-up follow-up fires.
- `watchdog.ts`: alert on `not in-turn → never`, `awaiting-operator → never`, else
  `now - lastActivityAt >= stuckAfterMs`. Drop the `label === "waiting"` exemption.
- `session-status.ts` / `commands.ts` `/list`: render `describeLiveness`, never `status`.
- `dispatch.ts` busy guard: report the derived state + both ages; when the control is not yet
  attached, say what it is actually doing (`preparing` — indexing/context gate) and for how long.

### stdin-wait evidence (best effort, never a decision)

`looksLikeStdinWait(label)` — pure: a `Bash:` label whose command matches a known interactive shape
(`cp -i`, `mv -i`, `rm -i`, `git rebase -i`, `ssh` without `BatchMode`, `apt`/`npm init` without
`-y`, a bare `read`). When a wedge is declared, the evidence line says
`possible interactive prompt (stdin wait): <command>` so the case is diagnosable from logs alone.

## Acceptance criteria (each becomes a test)

1. A session streaming tool calls is `working` — never `idle`/`wedged` — even when its activity
   label has not changed for hours.
2. A session between turns is `idle` at any age, and the watchdog never alerts on it.
3. A genuinely silent in-turn session past `wedgedAfterMs` is `wedged`, and the watchdog alerts.
4. A session blocked on an approval or a raised decision is `awaiting-operator`, is never `wedged`,
   and is never stall-aborted by dispatch.
5. `onHeartbeat` alone (partial deltas, no completed tool call) keeps `lastActivityAt` fresh.
6. `describeLiveness` reports state, what it is doing, last-activity age, last-output age, queue
   depth — and never the word `running`.
7. `active()` stays false after a run ends without a turn result (interrupt / stream error).
8. Dispatch's busy/queue decision uses `active()`; its message names the state and the ages.
9. A stall abort records `dispatch_stall_evidence` with its ages/label/queue before it fires.
10. `looksLikeStdinWait` flags `cp -i` and does not flag `cp -r`.

## Config

`wedgedAfterMs` (default 300_000 = 5 min — the same window dispatch already aborts on) and
`quietAfterMs` (default 180_000 = 3 min). Existing `stuckAfterMs`, `longTurnAlertMs`,
`alertRepeatMs`, `dispatchStallMs` keep their meanings and defaults.

## Non-goals

- Deferring a dispatch's brief until the control attaches (a real queue). Out of scope; the fix here
  is that the refusal tells the truth about what the project is doing.
- Auto-recovery. The watchdog still only alerts; `/kill` stays the operator's.
- Persisting the clocks across a daemon restart (in-memory observability, unchanged).
