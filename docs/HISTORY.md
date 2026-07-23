# History

Phase-by-phase build narrative, moved out of `CLAUDE.md` to keep that file under the ~200-line
guidance (it auto-loads into every worker). Verbatim history — read newest-last, oldest-first below.

**Phase 2 complete — live, concurrent, governed sessions** (verified with a real SDK run): on top of
the Phase 1 skeleton, the engine now holds **live SDK sessions** you can talk to. Plain-text messages
stream as **follow-ups into the running worker**; quiet sessions **idle-close** and persist their SDK
id so a later `/open` **resumes** them; a rolling **budget meter** reserves interactive headroom and
throttles background work; multiple projects run **concurrently** in a registry; and `/status` + `/kill`
give visibility and control. All TDD (`bun test` green — 58 tests, `tsc` clean). The real-SDK
build-then-verify run confirmed streaming input, mid-run follow-ups, interrupt, and resume, and fixed
two shaping bugs (see `docs/sdk-notes.md` → Phase 2). The Telegram frontend needs a `TELEGRAM_TOKEN`
to run live.

**Phase 3 complete — the operator web console** (reprioritized from the Gemini customer path): a
second operator frontend at your `PUBLIC_URL` (e.g. `neo.example.com`) with Telegram-Login auth →
trust-on-first-use admin → signed session cookie, where Neo talks to the engine over the web exactly
like Telegram — same `source:"neo"` SDK pipeline, sharing the registry/meter/ledger/admin. The
console binds `WEB_HOST:WEB_PORT` (default `127.0.0.1:3003`) and is meant to sit behind your own TLS
reverse proxy (e.g. Traefik); live-verified HTTPS + valid cert. `bun test` green (82 tests), `tsc` clean.

**Loop runtime — live** (the autonomy model is now engine-native): a `trigger → action → goal` loop
runtime drives autonomous work through the same governed worker. `Goal` union (verifiable command +
LLM-judge worker), `Trigger` union (manual/interval/cron, dependency-free matcher), per-loop `Bounds`
(maxIterations + budgetUsd) wired to the meter, a deterministic `scheduler` fired from the daemon
every 60s (`NEO_LOOP_SCHEDULER`, default on), and a `/loop` command (list · run · on/off) over a
code-defined loop library (`src/engine/loops.ts`). Loop enable/last-run persist in the ledger; every
iteration stays firewalled + escalation-auto-denied (loops never push/deploy). A **scheduled** fire
streams **only** the worker's text to the operator's Telegram chat (the admin, resolved at fire time),
tagged with the loop's `#project` — the same style as dispatch — with no start/iteration/outcome
chrome, so a loop that emits nothing stays silent (a reminder loop is quiet when there's nothing to
report); it falls back to daemon stdout when there's no admin/token yet. The interactive `/loop` path
keeps its start/progress/outcome chrome (`startScheduledLoop` + `sendOperatorLine` vs `startLoop`).
Specs: `docs/superpowers/specs/2026-06-26-loop-runtime-design.md`, `docs/loops.md`.

**Customer inbox — live:** inbound customer mail queues in a bun:sqlite store for operator review (no
auto-reply); reachable from both Telegram `/inbox` and the web console (view · send-to-agent draft ·
edit · approval-gated send · **delete**).

**Governor hardening — live:** default-escalate tool policy + project-folder path fence +
zero-tool tainted drafting (spec: `docs/superpowers/specs/2026-07-07-governor-hardening-design.md`).

**Context policy + session liveness — live:** sessions are measured (transcript-derived ctx%) and
handoff-cleared at safe boundaries before they rot or hit the wall (`context-policy.ts`, HANDOFF.md
notes); dispatch is non-blocking (the company is always free; sub-runs report back) and bounded by
a **liveness monitor**, not a fixed wall clock: abort on stall (`dispatchStallMs`, 5m of **true
silence** — the stall clock resets on *any* streamed SDK event via an `onHeartbeat` pulse +
`includePartialMessages`, so a worker mid-generation, even one long turn writing a huge file, is
never mistaken for silence) or on a per-dispatch ceiling (the dispatch tool's `timeoutMinutes`,
default `dispatchTimeoutMs` 15m, clamped to `dispatchTimeoutMaxMs` 2h), with a graceful wrap-up
window (`dispatchGraceMs`, 75s: commit green work + WIP note) before the hard abort; a
stuck-watchdog alerts the admin when a running session goes silent. Every dispatched brief is
auto-prefixed (`briefWithProjectDocs`) with a preamble telling the worker to read its own rule/doc
`.md` files, use the `codebase-memory` MCP FIRST for a structural map (**REQUIRED**, not "if
indexed" — read source files only for what the map misses), and use the superpowers skills — the
engine appends it so the operator never has to and it can't be omitted. The "must use
codebase-memory" instruction is made satisfiable in code: before a worker starts, the engine
(`ensureIndexed` in `src/engine/codebase-memory.ts`) checks the target folder against
codebase-memory and **indexes it if missing** — the worker can't self-index because the governor
denies subagents the index tools. Best-effort (a failed/absent index never blocks a dispatch; the
worker falls back to file reads); already-indexed folders cost one cached/`list_projects` call
(process-lifetime cache), and a first-time index emits an operator "indexing…" line
(`codebaseMemoryIndexTimeoutMs`, default 5m). `bun test` is scoped to `tests/` via
`bunfig.toml` (no more `agent/desks/**` sweep). Specs:
`docs/superpowers/specs/2026-07-08-context-policy-design.md`,
`docs/superpowers/specs/2026-07-08-session-liveness-design.md`,
`docs/superpowers/specs/2026-07-21-dispatch-mandatory-codebase-memory-design.md`.

**Graceful daemon reload — live:** engine code deploys without losing open project sessions.
`SIGTERM` (e.g. `systemctl restart neo`) or the operator `/reload` command (Telegram + web) drains:
the lifecycle gate refuses new orders/dispatches, every RUNNING worker gets a wrap-up follow-up
(commit green work + WIP note — the dispatch grace-window pattern), the engine waits a bounded
`drainWindowMs` (default 90 s, config) then hard-interrupts stragglers, snapshots every open
session (folder + SDK resume id) into the ledger (`open_sessions`), and exits 0 so systemd
(`Restart=always`) starts the new code. On boot `restoreSessions()` consumes the snapshot and
re-registers each session as idle+resumable — the next follow-up/dispatch resumes it. Operator
flow: pull/edit code → `/reload` (or `systemctl restart neo`) → sessions reappear in `/list` as
idle. NOTE: if `drainWindowMs` is raised past ~90 s, also raise `TimeoutStopSec` in
`/etc/systemd/system/neo.service` (systemd's default stop timeout is 90 s and would SIGKILL
mid-drain). Module: `src/engine/reload.ts`.

**API rate-limit recovery — live:** Anthropic throttles the subscription server-side ("API Error:
Server is temporarily limiting requests · Rate limited") and the SDK reports the dead turn as
`subtype:"success"` **with `is_error:true`** — the engine used to read only the subtype, so a
throttled turn was booked as *done* and the brief vanished silently (2026-07-22: four sessions at
once). Now `session-runner` reads `is_error` + the assistant `error` kind (`RunResult.apiError`)
and surfaces the SDK's own `system/api_retry` events as activity, and `api-retry.ts` owns the
policy: retryable kinds (`rate_limit`/`overloaded`/`server_error`) get a bounded second-tier
backoff — 30s → 2m → 8m, ±20% jitter so co-throttled sessions don't sync up — re-sending the SAME
brief into the SAME live session, prefixed with a warning that the cut-off attempt may be half-done.
Retries never fight the operator (interrupt/kill), a reload drain, or the budget meter, and after
`MAX_API_RETRIES` the operator is told plainly the work is **not** done. One shared `ApiCooldown`
gate (armed by any throttled worker, 60s) holds **new background work** — dispatches and loop fires
— while the storm lasts; interactive operator messages are never held (that's the reserved
headroom). A dispatch's backoff wait pauses the stall clock and doesn't count against the dispatch
ceiling.

**Data-driven loop CRUD — live:** loop *definitions* are now data (ledger `loop_defs`), merged with
the built-in library by `effectiveLoops()` and re-read each scheduler tick, so an operator can
author/edit/delete loops from the admin web console (`/api/loop/{create,update,delete,enable}` +
the Loops tab) with **no restart**. Validated input (`loop-validate.ts`, `/home` folder fence),
admin-gated, built-ins are run/toggle-only. Spec/plan:
`docs/superpowers/specs/2026-06-27-loop-crud-design.md`, `docs/superpowers/plans/2026-06-28-loop-crud.md`.

**One-shot session focus + real status + company awareness — live:** the default follow-up target is
always the company; a project is addressed **explicitly and one-shot** (per-chat focus with a mode in
`registry.ts`: `setFocus`/`clearFocus`/`getFocus`; `findByChat` returns only the focused session — no
more sticky most-recent fallback), so a stray next message reverts to the company instead of hitting a
project. `/use <name>` (and tapping a project, or replying to its streamed message) focuses **once**;
`/pin <name>` holds it; `/unpin` (`/company`, `/main`) returns. Blocked messages/dispatches report the
**real status** (which project, what it's doing, how long, queue depth) via `session-status.ts`
(`describeSessionStatus`/`sessionStatuses`/`sessionsReport`) instead of an opaque "busy", and the
company gets a `sessions` MCP tool (same gate as `dispatch`) for live awareness of every project's
state. Spec: `docs/superpowers/specs/2026-07-16-session-focus-status-design.md`.

**Context-efficiency Phase 1 — live:** per-path worker profiles (`workers` in config:
company/project/dispatch/loop/judge/ingress/handoff, each `{model?, effort?, skills?, maxTurns?}`,
defaults = inherit except company/ingress `effort:"low"`) + a `workerEnv` map for extra env vars on
every spawned worker; loop `freshSession` flag + context-gated loop resume; a learned prompt-cache
TTL (`contextPolicy` gains `staleResumePct` 0.35 ratio, `cacheTtlFallbackMs` 3.6e6 provider-fact
fallback, `cacheTtlMinObservations` 5 operator choice; ledger `cache_observations`); a derived daemon
heartbeat (from enabled loops' triggers; `CRON_RESOLUTION_MS` fact) replacing the fixed 60s tick
constants; and a per-model context window (`contextPolicy.windowTokensByModel` optional override
map, applied at all 5 gate sites). See `docs/CONFIG.md` for the `workers`/`workerEnv`/`contextPolicy`
field reference and `docs/superpowers/plans/2026-07-23-context-efficiency-phase1.md` for the plan.
