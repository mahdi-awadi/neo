# HANDOFF — neo

_Auto-written by Neo when this session was idle-closed (a deterministic engine note, not a
worker turn). It records where the session left off so the next run can pick up; it is
overwritten each time the session is closed._

- Folder: /home/neo
- Opening brief: Before starting, read this project's rule and doc .md files so you work by its rules: AGENTS.md, DESIGN.md, and any other root-level .md files (besides CLAUDE.md, already loaded), plus the docs relevant to this task (e.g. under docs/). Follow them together with CLAUDE.md.

REQUIRED — use the `codebase-memory` MCP FIRST. The engine has already indexed this project for you, so the structural map is ready to query. Start every investigation there: get_architecture for the module layout, then search_code / query_graph to find the code that matters. Read source files directly ONLY for what the map doesn't cover — never as your default way in.

REQUIRED — use the superpowers skills for the shape of work at hand: brainstorming → writing-plans for design, systematic-debugging to root-cause any bug, and test-driven-development for implementation (write the failing test first).

CONTEXT — read CLAUDE.md, docs/HISTORY.md, and query the codebase-memory MCP for the structural map first. This is the Neo engine itself (Bun + TypeScript; `bun test`, `bunx tsc --noEmit`). The engine currently persists CONVERSATION messages only (ledger `messages` table, written from src/engine/pipeline.ts), but has essentially NO durable diagnostic/event logging: src/engine/session-runner.ts, api-retry.ts, usage.ts, and dispatch.ts have no structured logging, so when the engine becomes unstable (API throttle/retry loops, wedged dispatches, orphaned sessions) there is no persistent trace to diagnose from. Only startup/reload lines go to the systemd journal. We want to close this observability gap.

GOAL — add a durable, structured **event log** to the engine so instability leaves a diagnosable trail. Follow the repo's discipline strictly: TDD (write the failing test first), minimal code, `bunx tsc --noEmit` + `bun test` green before done, commit per logical piece. Do NOT restart or reload the daemon. Do NOT deploy. Machine-local state must stay untracked per CLAUDE.md conventions.

SCOPE (confirm/refine against the actual code before building — brainstorm the shape first):
1. A new ledger table (e.g. `events`) + a small `recordEvent(kind, data)` helper in src/engine/ledger.ts, with an index on (kind, at) and (session/order id, at). Keep it cheap (single insert, no blocking).
2. Instrument the high-value points that correlate with the known instability (see the last HANDOFF's 7 issues):
   - api-retry.ts / usage.ts: every API error + each retry attempt (attempt N/max, delay, the REAL resetsAt if the API provided one) and final give-up.
   - session-runner.ts: session lifecycle transitions (start, turn begin/end, interrupted, wedged/stalled, recovered) + stall-monitor aborts.
   - dispatch.ts: dispatch lifecycle (enqueue, run, refuse-because-busy, timeout/abort, result-returned) — these are the wedge/queue asymmetries noted in memory.
3. Make the log queryable: a minimal way to read recent events (a ledger query + surface it wherever /dashboard or admin status already exposes engine state — reuse existing patterns, don't build a new UI from scratch).
4. Keep it lightweight and privacy-sane: log event kinds + structured metadata (ids, counts, timings, error codes/messages), NOT full message bodies (those already live in the messages table).

DELIVERABLE — a short design note of the event schema + instrumentation points you chose, the TDD commits, and confirmation that tsc + tests are green. Report what you changed and what (if anything) needs a daemon reload to take effect (report it — do NOT perform it). Emit progress every ~2 min.</task>
<parameter name="timeoutMinutes">90
- Last activity: waiting
- Idle-closed at: 2026-07-28T01:39:00.006Z

## Outstanding
The session went quiet and was closed to free the subscription pool. If work was mid-flight,
re-read this and continue from the last activity above; otherwise treat the opening brief as done.