# Context sweet spot — boundary handoffs, safe checkpoints, measured resumes — design

**Status:** approved by operator order (2026-10-06, todo "keep each project session's context in a
sweet spot automatically"). Builds on `fix/context-window-from-sdk` (ADR-0013). Decision record:
ADR-0014. Terms: `CONTEXT.md` → "How full a session is".

## Problem

1. **No check while a session lives.** A live project or company session is measured only when its
   run *ends* (`run.done`) or at the next resume. Between turns nothing looks. So a long-lived
   session grows until it closes. With the window bug (ADR-0013), the policy then fired 520 `clear`
   verdicts at a real ~30% occupancy, dropping sessions with no note.
2. **The lines are not from data.** `handoffPct` 0.65 / `emergencyPct` 0.85 were guesses.
3. **Handoffs fire at the worst time.** The only handoff on a live session is lazy: at the next
   resume, against a cold cache (a full replay at 25× the read price), while the operator waits.
4. **Nobody checks the note is used.** 8 of 47 fresh sessions told "Read HANDOFF.md first" never
   read it (transcripts, 2026-07-08 → 2026-10-06).
5. **Invisible.** `context_events` has no reason. The console never shows ctx% or resets.
6. **A message sent while a session closes is lost.** `followUp` into a closed channel is a silent
   no-op (`createInputChannel.push`), and the follow-up branch does not check `closed()`.

## Evidence for the band (31,585 Opus turns, 125 sessions, 1M window)

| occupancy | turns | avg context read / turn | tool-error rate |
|---|---|---|---|
| 5–10% | 3,394 | 77k | 2.9% |
| 20–25% | 3,441 | 225k | 2.0% |
| 40–45% | 1,696 | 425k | 1.9% |
| 45–50% | 1,354 | 474k | 1.9% |
| 60–65% | 322 | 620k | 1.4% |
| 80–85% | 145 | 824k | 4.6% |

- **Quality**: no measurable decline below 65% (tool errors, edit misses). Above 55% the samples
  are thin (≤ 7 sessions), so the data neither shows nor rules out a decline there.
- **Cost**: linear in occupancy. The 19% of turns above 40% read 41% of all cache tokens. A handoff
  (≈ $0.6) pays back in ≈ 10 turns; sessions past 40% ran ≈ 270 more turns.
- **Real limit**: SDK auto-compaction fired at 967k–1,007k (13 events).
- **Session peaks**: p50 18%, p75 30%, p90 48%, p99 81%.
- **Orientation after a handoff** (model calls before the first edit/commit): p50 47, p75 70, p90 101.

Defaults: **sweet spot 0.40**, **checkpoint 0.60**, **emergency 0.90**, orientation success ≤ 70
steps. All are `contextPolicy` knobs.

## Design

### One policy, a boundary argument

`decideContext(sig, cfg, ttlMs, at)` in `context-policy.ts` stays the single policy. It now takes
**where** it is asked (`at.boundary`: `resume` | `settled` | `checkpoint`, plus an optional
`projected` occupancy). It returns `{ verdict, reason, band }`. `verdict` is `keep` | `handoff` | `clear`.
`reason` is one of `emergency`, `above-sweet-spot`, `heavy`, `projected-overflow`, `stale-resume`,
`max-turns`, `max-age`, `guessed-window`.

| boundary | rule (first match wins) |
|---|---|
| any | occupancy ≥ emergency → `resume`: `clear` (known window) or `handoff` (guessed); else `handoff` — reason `emergency` |
| any | window guessed → no band rule (ADR-0013); only turns/age/stale below |
| `resume` | idle ≥ cache TTL and occupancy ≥ `staleResumePct` → `handoff` (stale-resume) |
| `resume`, `settled` | occupancy ≥ sweet spot → `handoff` (above-sweet-spot); turns ≥ max / age ≥ max → `handoff` |
| `checkpoint` | occupancy ≥ checkpoint → `handoff` (heavy); occupancy ≥ sweet spot and projected ≥ emergency → `handoff` (projected-overflow) |
| — | otherwise `keep` |

`contextBand(occupancy, cfg)` → `healthy` | `above` | `heavy` | `emergency` (display + alerts).

### Where it is asked

| where | boundary | action on `handoff` |
|---|---|---|
| a pipeline session **settles** (new) | `settled` | close the live run; `run.done` runs the warm handoff turn |
| a pipeline run **ends** (idle-close, kill, the close above) | `settled` | `runHandoff` (as today) |
| a dispatch run **ends** (new) | `settled` | `runHandoff` right after bookkeeping, before the todo queue releases |
| before resuming an idle session (pipeline, dispatch) | `resume` | `runHandoff`, then fresh (as today) |
| loop iteration start | `resume` | start fresh (as today) + record |
| a **safe checkpoint** mid-turn (new, Claude only) | `checkpoint` | arm the steer (below) |

### Never with uncommitted work

`uncommittedIn(folder)` (git, next to `lastCommitIn`) lists changed paths, ignoring `HANDOFF.md`;
`undefined` = not a git repo. A `settled`/`resume` handoff with uncommitted changes is **deferred**
(`keep`, one `deferred` event per session) unless the band is `emergency`. A non-git folder counts
as clean for boundaries. A checkpoint needs a git repo.

### Safe checkpoint (mid-task, case b)

New `context-checkpoint.ts`: `createCheckpointWatch(opts)`. It is a pure state machine fed by
new raw stream callbacks on `RunHandlers`:
`onUsage(model, usage)`, `onToolUse(id, name, input)` and `onToolResult(id, isError)`.

- **Occupancy** comes live from each assistant message's usage and the known window. A guessed
  window never arms.
- **Candidate checkpoint**: a `Bash` `git commit` whose result is not an error, or a `TodoWrite`
  that raises the number of completed items.
- **Projection**: from the first `TodoWrite`, growth per completed item × remaining items.
- At a candidate: `decideContext(..., {boundary: "checkpoint", projected})`. If it says handoff and
  `uncommittedIn` is empty, the watch **arms**.
- **Steer**: `RunHandlers.contextSteer(tool, input)`. The governor hook calls it first. When armed,
  it lets through only `Read`/`Glob`/`Grep`/`TodoWrite`, `Write`/`Edit` of `<folder>/HANDOFF.md`,
  and `Bash` made only of `git status|diff|log|show|add|commit|rev-parse|branch`. Those still pass
  the normal governor. Everything else is **denied** (`permissionDecision: "deny"`) with
  `CHECKPOINT_STEER`, which tells the worker to stop and write the note in the required shape,
  then end its turn.
- **On settle after arming**: the note is fresh (its mtime is after `armedAt`) and the tree is
  clean → close and clear the session with no extra handoff turn, record `handoff`
  (`boundary: checkpoint`), then start the **continuation**. If the note is stale →
  `runHandoff` first. If the tree is dirty → disarm, record `deferred`, keep the session.
- **Continuation**: pipeline → `resumeSession(entry, CONTINUATION_BRIEF)`. Dispatch →
  `onEnd({..., continuation})`. The todo queue then adds a continuation todo at the head of the
  project's queue and releases it. The steer is wired only where a continuation path exists:
  pipeline sessions, and dispatches started by the todo queue.

### The handoff note

`HANDOFF_PROMPT` asks for fixed sections: `## Goal`, `## Done` (with commits), `## Next steps`,
`## Branch / commit`, `## Open decisions`, `## Gotchas`. After the turn, the engine appends
`## Engine facts`: branch, HEAD, uncommitted files, reason, occupancy and time, taken from git, not
the worker. It checks the sections and records the missing ones. A note the turn failed to write
gets a deterministic fallback (`idleStateNote` + engine facts).

### Continuation reads the note — by construction

A fresh start (pipeline `startSession`, dispatch fresh run) in a folder with a **pending handoff**
(its newest `handoff` event has no `resumed` event after it) gets the note text **inline** at the
top of its first brief, capped at `handoffNoteMaxChars` (beyond the cap: the head plus a pointer).
It records a `resumed` event. `createResumeProbe()` (same stream callbacks) counts the model calls
before the first productive action (`Edit`/`Write`/`NotebookEdit` or `git commit`). It writes
`{productive, steps, success: productive && steps ≤ handoffOrientationMaxSteps}` into that event's
detail. A folder with a `HANDOFF.md` but no pending handoff keeps today's pointer line.

### In-flight handoff guard + no lost messages

`context-policy.ts` keeps `handoffsInFlight: Map<folder, Promise>`. `runHandoff` registers itself,
and so does the settle path before it closes the run. `applyContextPolicy`, the dispatch gate and
the follow-up path first `await awaitHandoff(folder)`. In `handleMessage` branch 1, a control
whose `closed()` is true now waits for the handoff and then resumes. It no longer pushes into a
closed channel.

### Ledger + visibility

`context_events` gains `reason`, `boundary`, `session_id` and `detail` (JSON). The migration is
`ALTER TABLE ... ADD COLUMN`, the existing pattern. Verdicts: `handoff`, `clear`, `deferred`,
`resumed`, `fresh` (loop). `recordContextEvent(folder, verdict, occupancy, at?, extra?)` returns
the row id, and `updateContextEventDetail(id, detail)` fills it in later.
`listContextEvents({folder?, limit})`.

- **Operator lines** go through the existing `reply(chat, text, project, priority)`. Each handoff
  sends one muted line tagged with the project, so it shows in that project's console feed (the
  timeline). An `emergency` handoff or clear goes as `alert` (Decisions group).
- **`/status`**: ` · ctx 52% above` (band word only outside `healthy`), plus `↻ 2h (task done)`
  for the last reset.
- **Console**: the project card shows ctx% with a band colour and the last reset. The Recent tab
  gets a "Context resets" card (time, project, verdict, reason, occupancy, resume outcome).

### Knobs (`contextPolicy`)

| knob | default | meaning |
|---|---|---|
| `sweetSpotPct` | 0.40 | hand off at the next task boundary above this (was `handoffPct` 0.65; a legacy `handoffPct` in config.json is still honoured) |
| `checkpointPct` | 0.60 | hand off at the next safe checkpoint, mid-task (≥ 1 disables mid-task handoffs) |
| `emergencyPct` | 0.90 | last resort (was 0.85) |
| `handoffNoteMaxChars` | 20000 | inline note cap for a continuation |
| `handoffOrientationMaxSteps` | 70 | a resume counts as successful at or under this many model calls before its first productive action |

## Acceptance criteria

1. `decideContext` follows the table above for every boundary (unit tests per row).
2. A pipeline session that settles above the sweet spot with a clean tree is closed and handed off
   once. One below it is untouched. A dirty tree defers (one event) unless emergency.
3. A dispatch run ending above the sweet spot hands off before the todo queue's next release, and
   the next dispatch waits for it.
4. A watch fed a commit (or a completed plan item) at ≥ checkpoint, with a clean tree, arms. Then
   the hook denies `Edit src/x.ts` and allows `Write HANDOFF.md` and `git commit`. Below the line,
   with a dirty tree, or with a guessed window, it does not arm.
5. Projection: at 0.45 with 1 of 5 items done and growth 0.15 per item, it arms (0.45 + 0.6 ≥ 0.90).
6. After an armed settle with a fresh note: no handoff turn, the session is cleared, the event is
   recorded with `boundary: checkpoint`, and the continuation starts (pipeline: fresh session;
   dispatch: a head-of-queue todo).
7. A fresh start with a pending handoff gets the note inline (capped). `resumed` is recorded, and
   the probe fills `steps`/`success`.
8. Every handoff/clear/deferred/resumed/fresh row carries a reason and a boundary. Emergency goes
   out as `alert`.
9. `/status` and the dashboard expose the band and the last reset. The console renders them.
10. A follow-up sent while a session is closing for a handoff is delivered to the fresh session,
    not dropped.
11. `bunx tsc --noEmit` and `bun test` are green.

## Edge cases

- Codex: no hook → no checkpoint steer. Boundaries still apply.
- A worker ignores the steer: each tool call is denied until it ends its turn. Background agents
  are steered the same way (the hook sees them).
- An operator message during the handoff turn waits (in-flight guard), then goes to the fresh session.
- The company session settles above the sweet spot: it is handed off like any project. It is never
  idle-closed, so this is now its only reset path besides emergency.
- The note is written but HEAD moved (the worker committed the note): fine. Engine facts read HEAD
  after the turn.
- Restart with a pending handoff: the ledger row persists, so the first fresh start still inlines it.

## Not in scope

- i18n of Neo's own operator surfaces. The console and Telegram lines are English literals today
  with no catalogue mechanism. This change follows that pattern and flags the gap. It does not add
  a second mechanism.
- Per-project learned thresholds (spec 2026-07-23 phase 4).
