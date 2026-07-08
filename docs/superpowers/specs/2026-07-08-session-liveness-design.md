# Session liveness — non-blocking dispatch, activity visibility, stuck-watchdog — design

**Date:** 2026-07-08
**Status:** approved (brainstormed 2026-07-08; operator: "the main agent should always be free —
it should pass work to other agents so it can take new orders")

## Problem

The always-on company session goes unresponsive and the operator can't tell why. Root cause
observed in production: `dispatchToProject` **awaits** the sub-worker inside the company's turn
with no bound (`dispatch.ts`), so a long/hung dispatch wedges the company — later Telegram/web
messages just queue. And there is no surface showing what a session is doing right now.

Operator requirement (governing principle): **the company agent must always be free.** It
delegates; it never blocks on delegated work.

## Design

### A. Non-blocking dispatch (the structural fix)

`dispatch` becomes fire-and-report:

1. The tool handler validates the project, registers/reuses the session, **starts** the sub-run
   in the background (not awaited), and returns immediately to the company:
   `"dispatched to <name> — running in the background; its output streams to the operator and
   you will receive its result as a follow-up message when it finishes."`
   The company's turn can end; new operator messages route normally.
2. The background run streams to the operator tagged with the project name (unchanged), is
   metered/ledgered on completion (unchanged bookkeeping, moved into the background
   continuation), and is bounded by a **liveness monitor** (revised 2026-07-08 — the original
   fixed 15 min wall clock killed 18 long builds in a row; the timeout must protect against a
   HUNG worker, not a busy one):
   - **Stall limit:** the sub-run is aborted when it has produced **no activity** (no tool
     milestone, no assistant text) for `dispatchStallMs` (default **300_000** = 5 min). A worker
     streaming output for 90 minutes stays alive.
   - **Per-dispatch ceiling:** the `dispatch` tool accepts an optional `timeoutMinutes` — the
     company sizes it to the task (2 for a lookup, 60–120 for a build). Unset →
     `dispatchTimeoutMs` (default 15 min). Always clamped to `dispatchTimeoutMaxMs`
     (default **7_200_000** = 2 h) so a caller can never run unbounded.
   - **Graceful wrap-up:** when either limit fires, the engine first pushes a follow-up telling
     the worker to commit green work + write a brief WIP note, waits `dispatchGraceMs`
     (default **75_000** = 75 s), then hard-interrupts. A worker that finishes within the grace
     window keeps its own result (no error recorded). The timed-out result text names which
     limit fired (stall vs ceiling).
   To make interruption + the wrap-up follow-up possible, the dispatch run uses `startOrder`
   (which exposes `.followUp()`, `.interrupt()` and `.done`).
3. **Completion report-back:** when the background run settles (done / error / timeout), the
   engine (a) replies to the operator (`✅ gold finished: <summary>` / `⛔ gold timed out after
   15m`), and (b) if the company session is live, pushes a follow-up into it:
   `[dispatch result] gold: <summary>` — so the company can incorporate the result into whatever
   it does next. If the company is not live, (a) alone suffices; the ledger holds the outcome.
4. Concurrency guard: a second dispatch to a folder whose session is `running` returns
   `"<name> is still busy with the previous dispatch"` instead of stacking runs (the registry
   already exposes status).

The customer/ingress path is unaffected (dispatch there is dispatch:true with denyAllTrust;
same non-blocking mechanics apply harmlessly — its completion report goes to CUSTOMER_CHAT's
reply sink as before).

### B. Activity visibility (what is it doing right now)

- `SessionInfo` gains `activity?: { label: string; since: number }`. The session-runner already
  parses every tool_use for milestones; a new optional handler `onActivity(label)` reports each
  one (e.g. `Bash: bun test`, `dispatch: gold`) and each assistant text (label `thinking/writing`
  → use `replying`). The pipeline wires `onActivity` → `registry.noteActivity(id, label, now)`.
- The input channel (`createInputChannel`) exposes `queued()` — messages waiting behind the
  in-flight turn; surfaced via the SessionRun handle → registry.
- `/status` (Telegram) and the web dashboard render:
  `gold — running · Bash: bun test · busy 4m · 2 queued · ctx 42%`
  (ctx % comes from the context-policy spec's `sessionContext`; if that feature isn't merged
  yet, omit the ctx segment).

### C. Stuck-watchdog (proactive alert, manual recovery)

In the existing 60s scheduler/daemon tick: for every session with status `running`,

- **silent**: `now − lastActivityAt ≥ stuckAfterMs` (default **600_000** = 10 min), or
- **long turn**: `now − activity.since ≥ longTurnAlertMs` (default **1_200_000** = 20 min on the
  same activity label),

→ send ONE operator alert (`⚠️ company stuck on dispatch: gold for 12m — /kill company to
abort`), dedup via `alertedAt` on the session (re-alert only after `alertRepeatMs`, default
15 min). Recovery stays manual (`/kill`); the watchdog never interrupts by itself.

Watchdog + activity tracking are observers: any error inside them is caught and logged, never
thrown into a worker path.

## Config

`dispatchTimeoutMs` (900_000), `dispatchTimeoutMaxMs` (7_200_000), `dispatchStallMs` (300_000),
`dispatchGraceMs` (75_000), `stuckAfterMs` (600_000), `longTurnAlertMs` (1_200_000),
`alertRepeatMs` (900_000) — all in `config.ts` with standard precedence.

## Testing (TDD, bun test)

- Dispatch returns immediately (fake run that never resolves → tool result contains
  "dispatched"; company not blocked); completion report-back replies to operator and follows-up
  into a live company control; timeout path interrupts (fake with interrupt spy) and records
  `error` outcome; busy-folder guard; bookkeeping (meter/ledger/status) still happens on
  background completion.
- Registry `noteActivity` + `queued()` plumbing via fake SDK stream.
- Watchdog: threshold matrix, single-alert dedup, re-alert after `alertRepeatMs`, never fires on
  idle sessions.
- `/status` rendering includes activity, busy-duration, queue depth.

## Non-goals

- Auto-recovery (watchdog interrupting workers itself) — alert only, operator decides.
- A general job queue; dispatch stays one background run per project folder.
- Persisting activity/queue state across daemon restarts (in-memory observability).
