# ADR-0055: long checks run in the background and never block the worker

Status: **accepted** (2026-10-28, operator order). Amends the 2026-09-13 liveness contract in the
dispatch preamble (`briefWithProjectDocs`, `docs/HISTORY.md` "stall abort").

## Context

The 2026-09-13 contract told workers to never park on a background wait and to poll in short
foreground steps. That kept the stall detector fed, but it also made workers run long checks in the
foreground. An eticket-v3 worker ran `go vet` over 7 modules in one foreground loop, with
`timeout 150`/`timeout 200` wrappers, through `docker run`/`exec`, and the session waited for all of
it. The engine already supports background work: a dispatch ends only when the session is settled,
with no background work left (ADR-0007).

## Decision

The single "stay alive" rule in the preamble now says:
- Long checks (vet/test/lint loops across modules, builds, image pulls, CI waits) start in the
  background, as a background Bash command or a subagent. Each module gets its own log.
- The worker keeps working on other steps and reads each result when it is ready. Only when nothing
  else is left does it poll, in foreground steps under 90 s.
- It never ends its turn while a check is still running or its result is unread (single-shot).
- No Monitor and no long silent wait. A real test is never wrapped in `timeout`. This ban was
  enforced only in briefs and memory until now; it is now in the preamble.

The stall detector is unchanged: it still counts only streamed activity.

## Rejected

- **A second rule next to the old one.** The two would contradict each other ("never a background
  wait" vs "start it in the background").
- **Raising `dispatchStallMs` or counting an in-flight tool as activity.** This blinds the detector to
  hung calls (the same reason as in 2026-09-13).
- **Keeping foreground-only checks and splitting them into steps under 90 s.** This still blocks
  the work for the whole check, and it is what made workers add `timeout` wrappers.
