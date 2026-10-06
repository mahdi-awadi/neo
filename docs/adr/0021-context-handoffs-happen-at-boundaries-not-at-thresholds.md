# Context handoffs happen at boundaries, not at thresholds

**Status:** accepted (2026-10-06)

A context number crossing a line says *that* a session should be replaced, never *when*. Replacing a
session mid-step loses the step. So the engine checks occupancy only at a **task boundary** or a
**safe checkpoint**, and the band decides what that boundary may do:

| band | occupancy (default) | what happens |
|---|---|---|
| healthy | < `sweetSpotPct` 0.40 | keep |
| above | < `checkpointPct` 0.60 | hand off at the next task boundary |
| heavy | < `emergencyPct` 0.90 | also hand off at the next safe checkpoint, mid-task |
| emergency | ≥ 0.90 | hand off anyway (uncommitted work allowed); at a cold resume, clear + alert |

A mid-task handoff also fires inside the sweet spot's upper band (`above`) when the plan's own
growth rate projects the session past `emergencyPct` before the plan ends.

The defaults come from 31,585 Opus turns in 125 sessions (2026-07-08 → 2026-10-06, 1M window). The
tool-error rate stayed flat at 1.4–3.4% up to 65%, so quality gives no early line. Cost does. A turn
reads its whole context from cache: 77k tokens at 5–10%, 474k at 45–50%. The 19% of turns above 40%
read 41% of all cache tokens. A fresh session starts at 44–77k. At Opus 5.5 prices (cache read
$0.20/MTok, cache write ≈ $5/MTok), one turn at 40% costs ≈ $0.065 more in cache reads than a turn in
a fresh session. A handoff costs ≈ $0.6: the note turn, a ~60k fresh cache write, and about ten
orientation turns. So it pays back in about 10 turns. The 22 sessions that went past 40% ran
≈ 270 turns each above that line. SDK auto-compaction fired at 967k–1,007k (13 times), so 0.90
leaves room for the handoff turn itself.

## Decisions

1. **Eager at settle, while the cache is warm.** A task that settles above the sweet spot is handed
   off at once. Waiting for the next resume gate would replay the full context cold: a cache write
   costs 25× a cache read on Opus 5.5. The resume gate stays as the backstop.
2. **Mid-task: steer through the governor hook.** At a safe checkpoint in the heavy band, the
   `PreToolUse` hook denies every further tool call except what writing and committing the note
   needs. The deny reason tells the worker to write `HANDOFF.md` and end its turn. The worker writes
   the note in its own warm context. No extra handoff turn is needed.
3. **The continuation gets the note inline.** A fresh session after a handoff gets the note's text
   in its first brief, not "Read HANDOFF.md first". 8 of 47 measured sessions told to read it never
   did.
4. **Never with uncommitted work.** A boundary with a dirty working tree (ignoring `HANDOFF.md`)
   defers the handoff, except in the emergency band. A mid-task handoff needs a git repository.
5. **One record.** Each handoff, deferral, clear and continuation outcome is a `context_events` row
   with its reason and boundary. The console timeline and `/status` read it.

## Considered options

- **Interrupt the turn when the number crosses a line.** Rejected: it lands wherever the worker is,
  usually mid-edit.
- **Send the checkpoint instruction as a follow-up message.** Rejected: a follow-up waits behind the
  turn in flight, so it arrives after the task, not at the checkpoint.
- **Let the SDK auto-compact.** Rejected: it fires at ~97% (too late for cost). It loses detail
  without telling the engine, and it leaves no note and no record.
- **Hand off lazily at the next resume gate (the old behaviour).** Rejected for the normal case. It
  pays a cold replay of the whole context, and it delays the operator's next message by a full
  handoff turn. Kept as the backstop for sessions closed by a restart.
- **A higher sweet spot (e.g. 0.65, the old `handoffPct`).** Rejected: no quality signal argues for
  it, and cost per turn at 0.65 is ~8× a fresh session's.

## Consequences

- Codex sessions get boundary handoffs only. Codex has no `PreToolUse` hook, so it gets no mid-task
  steer.
- `handoffPct` is renamed `sweetSpotPct` (default 0.65 → 0.40). `emergencyPct` changes from
  0.85 to 0.90.
- A worker in the heavy band that keeps calling tools after the steer only gets denials. A task
  that never commits never reaches a safe checkpoint. The emergency band covers both cases.
