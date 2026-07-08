# Context policy — token-smart sessions (compact/clear at safe boundaries) — design

**Date:** 2026-07-08
**Status:** approved (brainstormed 2026-07-08; operator chose handoff-then-clear over SDK compaction)

## Problem

Long-lived sessions (the always-on company, loop workers, resumed projects) accumulate context:
quality degrades (context rot), every resumed turn re-reads a fat transcript (subscription burn),
and at 100% the SDK auto-compacts at the worst moment (mid-task). The engine has the signals —
`usage.ts` already parses per-turn token usage from the transcript JSONL — but no policy.

## Design

### A new deterministic module: `src/engine/context-policy.ts` (no AI)

**Signals.** `sessionContext(folder, sdkSessionId, opts?)` reads the session's transcript
(`~/.claude/projects/<encoded-cwd>/<sdkSessionId>.jsonl` — same encoding/parsing as `usage.ts`)
and returns `{ occupancy, turns, ageMs }`:

- `occupancy` = last assistant turn's `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens` divided by the context window (200_000, a module constant).
- `turns` = count of assistant-usage lines; `ageMs` = now − first line's timestamp.
- Missing/unparseable transcript → `{ occupancy: 0, turns: 0, ageMs: 0 }` (fail OPEN — a read
  error must never destroy a session).

**Policy.** `decideContext(signals, cfg)` returns `"keep" | "handoff" | "clear"`:

- `clear` — `occupancy ≥ emergencyPct` (default **0.85**): too fat to spend a handoff turn.
- `handoff` — `occupancy ≥ handoffPct` (default **0.65**) OR `turns ≥ maxTurns` (default **200**)
  OR `ageMs ≥ maxAgeMs` (default **7 days**).
- `keep` — otherwise.

Config lives in `config.ts` under `contextPolicy: { handoffPct, emergencyPct, maxTurns, maxAgeMs,
handoffTimeoutMs }` with the standard precedence; `handoffTimeoutMs` default **180_000**.

### The handoff turn

A fixed prompt constant, `HANDOFF_PROMPT`:

> Write a concise state-of-work handoff to `HANDOFF.md` in the project root: what is in flight,
> decisions made, blockers, and next steps. Overwrite any existing HANDOFF.md. Then stop —
> do not continue other work.

`runHandoff(sessionInfo, deps)` pushes this as a follow-up into the live session (or resumes the
persisted id single-shot when no live control exists), bounded by `handoffTimeoutMs`; on
completion OR timeout OR error it **clears** the persisted session id: `registry.setSdkSessionId(id,
"")` plus the session-id row is superseded so `ledger.lastSessionFor` no longer returns it (append a
cleared marker; exact mechanism: record a new session row with empty id, and `lastSessionFor`
returns undefined for empty). HANDOFF.md is written by the worker inside the folder (governor
path-fence allows it).

### Boundaries (where the policy is consulted)

1. **Order/iteration completion** — after `runOrder`/loop iteration finishes and the session id is
   persisted (pipeline + loop-runner paths): `decideContext`; `handoff` → run the handoff turn
   now (session warm), then clear.
2. **Idle sweep** — the existing idle-close pass: before closing a fat session, same as (1).
3. **Pre-resume** — wherever a persisted id is about to be passed as `resume` (pipeline `/open`,
   dispatch reuse, project-loop, untainted ingress): `clear` verdict → drop the id and start
   fresh; `handoff` verdict → run the handoff turn first (resuming the old session for that one
   turn), then open fresh for the real task.
4. **Fresh start after a policy clear** — when opening a session and `<folder>/HANDOFF.md` exists
   (plain `existsSync`), prefix the task with: `Read HANDOFF.md first — it is the previous
   session's state-of-work note.\n\n`.

**Exclusions:** tainted ingress runs (already isolated one-shots, nothing persisted); the handoff
turn itself is never re-evaluated (no thrash: a fresh session's occupancy is ~0).

### Observability

- `/status` + web dashboard: per-session `ctx NN%` from `sessionContext`.
- Ledger table `context_events(session_folder, verdict, occupancy, at)` — one row per non-keep
  decision, so a cleared session is auditable.

## Error handling

- Transcript read errors → `keep` (fail open).
- Handoff turn error/timeout → clear anyway (folder + CLAUDE.md is fallback memory); record the
  event with verdict `clear`.
- Policy/observer code must never throw into the worker path — wrap and log.

## Testing (TDD, bun test)

- `decideContext` threshold matrix (all three verdicts, boundary values).
- `sessionContext` against fixture JSONL (occupancy math, turns, age; missing file → zeros).
- Wiring with fakes: order-complete triggers handoff exactly once then clears the persisted id;
  pre-resume `clear` starts fresh (no `resume` in run deps); handoff-first-then-fresh on
  pre-resume `handoff`; HANDOFF.md prefix added only when the file exists; tainted path untouched;
  `context_events` row recorded; handoff timeout still clears.

## Non-goals

- No SDK auto-compaction control (we clear, we don't compact).
- No per-message token prediction; decisions only at boundaries from measured transcript data.
- No UI to tune thresholds (config file only, for now).
