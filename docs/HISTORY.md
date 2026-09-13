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
indexed" — call `list_projects` first and pass the exact project name it returns for the working
directory, never a guessed one, because a repo can be indexed under a path-derived name or in a
subfolder as its own project; then read source files only for what the map misses), and use the
superpowers skills — the
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
once). Now `session-runner` reads `is_error` and resolves `RunResult.apiError` from the assistant
`error` kind, the result's `api_error_status`, or (last resort) the result text — covering the
text-only Claude throttle failures that arrive with no status/error field. It also surfaces the
SDK's own `system/api_retry` events as activity, and `api-retry.ts` owns the policy: retryable kinds
(`rate_limit`/`overloaded`/`server_error`) get a bounded second-tier backoff — 30s → 2m → 8m, ±20%
jitter so co-throttled sessions don't sync up — re-sending the SAME brief into the SAME live
session, prefixed with a warning that the cut-off attempt may be half-done.
Retries never fight the operator (interrupt/kill), a reload drain, or the budget meter, and after
`MAX_API_RETRIES` the operator is told plainly the work is **not** done. A zero-retry give-up now
only says "still throttled" for held server-side retryable kinds; unknown/auth/billing/invalid
failures report "without retrying" without pretending the engine is still rate-limited. One shared
`ApiCooldown` gate (armed by any throttled worker, 60s) holds **new background work** — dispatches
and loop fires — while the storm lasts; interactive operator messages are never held (that's the
reserved headroom). A dispatch's backoff wait pauses the stall clock and doesn't count against the
dispatch ceiling.

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

**Memory Phase 2 — live (default off):** the store/inject/recall memory system per
`docs/superpowers/specs/2026-07-23-hermes-openclaw-upgrades-design.md` §2: capped `§ `-delimited
memory files (MEMORY.md + USER.md, ratio caps of the model window) with a 3-op apply where an
over-cap write errors (curation by capacity); deterministic write scan + drift backups
(anti-poisoning); a frozen ground-truth snapshot injected at worker start (scanned + cap-truncated
at compose; scope-gated via one shared `memoryEnabledFor`, `memory.scopes: []` default = total
no-op); daily logs + FTS5 recall with file/day citations; `memory`/`memory_log`/`memory_search`
MCP tools with engine-enforced dream budgets (backups, DREAMS.md audit diary, honest
revert-failure accounting); pre-handoff flush + deterministic idle-close capture; the nightly
`memory-dream` consolidation loop (disabled by default, fire-once, status-aware company busy
guard); sentinel-guarded deterministic bootstrap from ledger + HANDOFF notes; the spec's three
acceptance proofs (inject / store-frozen / recall-cited) as end-to-end tests. Opt in with
`"memory": { "scopes": ["company"] }` in config.json. See `docs/CONFIG.md` → Memory.

**Loop-failure isolation — live:** one crashing loop can no longer take down the whole daemon
(2026-07-24: a scheduled loop whose project folder had been deleted → `Bun.spawn` ENOENT → uncaught
rejection → daemon exit 1 → every in-memory session dropped). Three layers: (1) `tickScheduler`
(`src/engine/scheduler.ts`) now treats each loop's `start` as fallible — `start(def)` may throw
synchronously **or** return a rejecting promise (the daemon returns the real run promise instead of
discarding it with `void`), and both are caught and routed to an `onError(def, err)` sink, so one bad
loop never propagates and never aborts the rest of the tick; (2) the daemon's `onError` logs `[loop]
"<name>" failed` and alerts the admin over Telegram (`⚠️ loop "<name>" failed and was skipped`), so a
failure is visible instead of silent; (3) `commandGoal` (`src/engine/goal.ts`) wraps `Bun.spawn` in
try/catch and reports a missing binary/cwd (a deleted project folder is reported as ENOENT on the
executable) as **not-met** rather than throwing — a goal-check should never throw in the first place.
Tests: `tests/scheduler.test.ts` (sync-throw + async-reject isolation), `tests/goal.test.ts` (missing cwd).

**Engine event log — implemented (branch `feat/engine-event-log`, pending reload):** a durable,
structured diagnostic trail so instability leaves something to diagnose from (the 7 issues in the
2026-07-25 handoff had no persistent trace). A new ledger `events` table + `recordEvent`/`listEvents`
(`src/engine/ledger.ts`), following the `context_events`/`cache_observations` audit-table precedent —
single INSERT on the hot path, amortised retention (prune every 1000 inserts, keep newest 50k),
indexed on `(kind,at)`, `(order_id,at)`, `(at)`; stores kinds + small structured metadata only, never
message bodies (those stay in `messages`). Instrumented at the points that correlate with the known
instability: `session-runner.ts` emits `session_start`/`sdk_api_retry`/`session_interrupted` via a
thin optional `onEvent` handler (the pure SDK core stays ledger-free); `pipeline.ts` + `dispatch.ts`
record `api_retry`/`api_giveup` (with the resolved reset-vs-ladder delay — handoff issue 6) plus the
full dispatch lifecycle `dispatch_refused`/`dispatch_queued`/`dispatch_start`/`dispatch_abort`/
`dispatch_end` (the wedge/queue asymmetries — issue 7). Queryable via a new `/events [<kind>]`
operator command (`commands.ts`, mirrors `/recent`), surfaced on Telegram + web with zero frontend
changes. See `docs/superpowers/specs/2026-07-26-engine-event-log-design.md` +
`docs/superpowers/plans/2026-07-26-engine-event-log.md`. TDD throughout; full suite green (591).

**Worker SDK wrapper — live:** `session-runner.ts` now exposes one internal worker boundary
(`runOrder` / `startOrder`) with provider adapters behind it. The default `"subscription"` path is
the existing Claude Agent SDK adapter, unchanged: `query()`, streaming input, resume, interrupt,
`canUseTool`, in-process MCP servers, partial-message heartbeats, and API retry/cost handling. A new
`"codex"` own-work provider selects the OpenAI Codex SDK adapter (`@openai/codex-sdk`): starts or
resumes Codex threads in the target folder, streams Codex JSON events into Neo's message/activity
hooks, queues follow-ups as sequential turns on the same thread, and aborts with `AbortSignal`.
`profileDeps()` threads `providers.ownWork` through every launch path, so choosing Codex is a
`config.json` flip (`{ "providers": { "ownWork": "codex", "customerWork": "gemini" } }`). Boundary
kept explicit: Codex SDK does not expose Claude's `canUseTool` hook or Anthropic in-process MCP
shape, so Codex runs use Codex sandbox/approval policy and emit `worker_compat_warning` for
Claude-only run options; read-only judge runs translate to Codex `sandboxMode:"read-only"`.

**Trust command explicit targets — live:** `/trust` still defaults to the focused project, then the
always-on company, but it can now pre-trust an explicit open session name, existing absolute folder,
or bare project name under `/home`: `/trust [<project-or-folder>] [on|off]`. Unknown explicit targets
return a not-found message instead of silently toggling the focused project.

**Cross-SDK resume — fixed:** switching the worker SDK (`/sdk claude` after two days on Codex) left
every message failing with "✗ agent: the API failed (unknown) — the work is NOT done". The persisted
`sdk_session_id` for the company was a **Codex thread id**; the Claude SDK answered a resume on it
in ~1s with `result{ is_error:true, num_turns:0, errors:["No conversation found with session ID: …"] }`
and then threw. Neo read no HTTP status and no `result` text, classified it as an API error of kind
`unknown`, and gave up — and because the run died before it could mint a Claude id, the next message
resumed the same dead id: permanently stuck, on a healthy API. Two layers now:
*prevention* — session ids carry the SDK that minted them (`orders.sdk_provider`,
`open_sessions.sdk_provider`, `SessionInfo.sdkProvider`), and `canResumeWith()` refuses a proven
cross-SDK resume everywhere a resume is chosen (pipeline, dispatch, ingress, reply-routing, reload);
*recovery* — the runner reads the result's `errors[]`, treats "No conversation found" as a rejected
precondition rather than an API failure (never reported as one, never retried by the throttle
ladder), and restarts cold ONCE, replaying the brief plus anything queued so no work is dropped.
Ids with no recorded owner (written before this) are still tried — continuity is worth a round-trip,
and recovery re-mints a tagged id — so the stuck company self-heals on its first message after
reload. Verified against the real SDK end-to-end, not just fakes. TDD; full suite green (630).

**Operational limits config-ified — live:** the last hardcoded operational bounds moved into `config`
behind the usual env→file→default precedence, so tuning them is a `config.json` edit, not a code
change (every default preserves today's behavior). API-throttle recovery is now data-driven:
`apiRetryLadderMs` is the second-tier backoff ladder whose *length* also sets how many automatic
retries run (no separate count knob), `apiRetryJitterFrac` adds per-wait jitter so co-throttled
workers don't resync, and `apiCooldownMs` is an engine-wide hold on **new** background work after a
throttle report so retries + the scheduler can't amplify a rate-limit storm. Ledger retention is
capped by `routeKeep` (message→project routes) + `eventsKeep` (the `events` table), oldest rows
pruned in amortised batches with the ledger still the source of truth. The remaining assumed bounds
became knobs too — `codebaseMemoryListTimeoutMs`, `inboxListDefault`, `messageRoutesCacheCap`, and
`contextPolicy.cacheObsWindow` (the learned-cache-TTL rolling sample size). Full reference in
`docs/CONFIG.md`.

**Telegram delivery robustness — fixed:** three gaps in how worker progress reached the operator.
*(1) Long reports were silently dropped* — Telegram's `sendMessage` rejects any text over 4096 chars
(verified empirically), and the single-shot send fell through to a silent catch, so long/table-heavy
reports delivered only the short narration lines. `chunkText` + `deliverChunked` (`format.ts`) now
split on line boundaries under the 4096 cap, send each chunk as rich HTML, and hard-split to plain
text if the markup is rejected — never drop, only the first chunk is tagged. *(2) Tables broke across
chunks* — a plain line-boundary split orphaned a table's body rows from the header+separator that
`mdToHtml` needs to detect a table, so continuation chunks leaked raw `| … |` pipes. `chunkMarkdown`
is table-aware: it keeps a table whole where it fits, or splits on row boundaries and re-emits the
header+separator at the top of each piece, so every chunk is independently detectable and renders as
an aligned `<pre>` (the web-console `tables:"html"` path is unchanged). *(3) Tool results were
invisible* — the stream showed the `🔧 Bash: …` milestone but never the command's output.
`session-runner.ts` now surfaces a concise `↳ <output>` preview (`⚠️ ↳` on error, truncated to 600
chars) for the meaningful tools (Bash/web/MCP/Task), gated by a `tool_use` id→name map; navigation
(Read/Glob/Grep) and boring writers (Write/Edit) stay result-silent so the stream isn't a firehose.
Requires a daemon restart to activate. TDD; full suite green (655).

**Dispatch false-busy → deliver to an idle session — fixed:** a company dispatch to a live project
could report it "busy" and queue behind it even when the session sat idle between turns, because the
guard decided on the registry `status`. But `status` stays `"running"` for a live session's whole
lifetime — it flips to `"idle"` only when the entire run ends — so it can't tell a worker mid-turn
from one waiting for the next brief. A new turn-in-flight signal, `SessionControl.active()`, reports
the real state. The Claude runner counts turn boundaries: a message `delivered` to the SDK against
its `result` `completed`, with monotonic counters in the run scope so they survive a resume-missing
restart (which recreates the input channel). The Codex runner flips a flag around each
`consumeCodexTurn` — the same contract, so the busy/idle decision is provider-neutral. `dispatch.ts`
now branches on `active()`, not on `status`. An **idle** live session takes the brief **now** (its
input channel pulls it immediately, exactly like a fresh dispatch, so a free project is never parked
behind a false "busy"). A **mid-turn** session **queues** behind the in-flight turn, like an operator
reply, and the channel flushes it the moment that turn yields. A session marked `"running"` with
**no live control** — a stale mark, for example after control is lost on a reload — is **refused**
rather than enqueued into the void or started as a second concurrent run. The three outcomes record
distinct ledger events (`dispatch_delivered`, `dispatch_queued`, `dispatch_refused`). Requires a
daemon restart to activate. TDD; full suite green (657).

**Playwright browser MCP on every operator project worker:** operator project workers now get a
headless-Chromium **Playwright MCP** (`playwright-mcp --headless --isolated`) so a project can drive a
real browser for web and UI testing. `neoMcpServers` gained a `playwright` opt-in flag, and both
operator call sites in `pipeline.ts` pass it. The customer/ingress path (`ingress.ts`) passes no flag,
so browser automation never reaches customer-tainted work. The MCP is lazy — the browser launches only
on first tool use, so the idle cost per worker is one light stdio process. This needs the
`playwright-mcp` binary (`@playwright/mcp`) and a Chromium browser. The governor is unchanged:
Playwright tools are foreign MCP tools, so they still default-escalate — an interactive operator
dispatch asks for approval, and an autonomous path auto-denies. Needs a daemon restart to activate.
`tsc` clean, full suite green (657).

**Priority tags · decisions queue · secretary loop — nothing blocking is lost.** Neo runs many
projects and sends a high volume of messages; the operator muted the bot, so blocking questions got
lost in the noise. The engine now gives every outbound line a deterministic **priority** —
`decision`, `alert`, `result`, `progress`, or `done` (`src/engine/priority.ts`, pure, AI-free) — and
splits the output into two surfaces: a muted **firehose** (the admin DM) for `progress`/`done`, and a
high-priority **Decisions** channel (`decisionsChatId`, kept unmuted) for `decision`/`alert`/`result`.
The tag comes from intent the sender already has, never from reading prose: a worker raises a blocking
question through the `ask_operator` MCP tool (options → tappable buttons); a governor escalation
(Allow/Deny) is a decision too; dispatch/API/loop failures are alerts. Each is recorded in a durable
`decisions` ledger table, so the queue survives a restart. **Answering resolves and unblocks:** a
tapped option, a typed "Other" answer, or a plain Telegram **reply** to the decision message all mark
the row answered and **resume the raising project's session** with the answer, reusing the
reply-routing resume path (`deliverIntoFolder`/`answerDecision` in `reply-routing.ts`). An ignored
escalation stays OPEN — surfaced later, never silently dropped. Finally a **secretary** loop
(`src/engine/loops.ts`, opt-in, latest model) reviews the open queue on a cadence (`secretaryCron`,
default every 2h in waking hours), writes ONE warm digest to the Decisions channel, and flags items
past `secretaryStaleHours` as escalations; the engine renders the queue deterministically into the
prompt and the worker only phrases it (no AI in the engine, and the worker never mutates a decision).
The digest is silent when the queue is empty. The firewall holds by construction: `ask_operator`
attaches only on operator paths, so customer-tainted work can never raise a decision. Config knobs:
`decisionsChatId`, `decisionsKeep`, `secretaryCron`, `secretaryStaleHours`, `workers.secretary`
(`docs/CONFIG.md`). Built phase by phase, TDD. Going live needs a daemon restart (operator-gated).
`tsc` clean; full suite green (695).

**Structured questions + styled/colored operator messages.** Two follow-ups to the decisions work,
both about how operator Telegram messages look and how the engine asks. **(1) A first-class
structured-question path**, reusing the decisions machinery — not a parallel system. The SDK's native
`AskUserQuestion` tool used to hard-error ("Neo has no structured-question UI"); it is now SERVICED:
`buildCanUseTool` parses it into a `StructuredAsk` (`src/engine/structured-question.ts`, pure) and
raises a tracked decision with tappable buttons, then denies the tool with the same check-point +
STOP steer `ask_operator` returns (the worker suspends; the operator's tap/reply resumes it). This is
wired through a `RunHandlers.onStructuredQuestion` hook on the interactive + dispatched paths, gated
on `postDecision` — the SAME firewall gate as `ask_operator`, so customer-tainted work still gets only
the plain steer. The `ask_operator` MCP tool gains a `multiSelect` flag. A structured ask (1–4
questions, each 2–5 options, optional multi-select, always an implicit free-form "Other") is stored on
the decision row (`spec` column, migration-guarded) so it survives a restart; taps accumulate an
ephemeral selection (single-select resolves on one tap as before; multi-select / multi-question show a
`✅ Submit`), and answering resumes the raising session with the combined answer. The pure module owns
all the logic (normalize, callback encode/decode — backward-compatible with the legacy
`dec:<id>:<idx>` — selection reducer, keyboard spec); the frontend stays thin. **(2) Styled + colored
messages.** Telegram has no text colors, so "color" = one data-driven accent-emoji map keyed by the
existing priority (`PRIORITY_STYLES` in `priority.ts`: decision 🔵, alert 🔴, done 🟢; `progress` is
the silent firehose default). The accent is applied once at each surface's formatting boundary —
Telegram `sendFormatted` (`outboundTag` composes accent + `#project` tag) and the web mirror — so both
render consistently and degrade to plain text where rich markup isn't supported; the redundant
per-call-site ✓/✗ (pipeline) and ✅/⛔ (dispatch) glyphs are removed. Escaping is safe by construction
(the HTML `parse_mode` path escapes bodies and falls back to plain text if Telegram rejects the
markup — a metacharacter-heavy message still sends, proven by test). Built TDD, commit per piece.
Going live needs a daemon restart (operator-gated). `tsc` clean; full suite green (730; one
pre-existing env-only config test unrelated to this work).

**Result routing — the Decisions group carries important outcomes, not just questions.** A follow-up
on the same branch. The operator keeps the Decisions group unmuted and wants it high-signal: only
decision questions and important **outcomes**. Before this, a job's completion was tagged `done`,
which stayed in the muted DM firehose, so a finished dispatch was easy to miss. A new deterministic
`result` priority (`priority.ts`) routes to the Decisions group, styled ✅ RESULT. The split is by
**call site**, never by reading prose: a background **dispatch** completion (`dispatch.ts`, the
`"<name> finished: …"` line) is a `result` → group; an **interactive-turn** completion (`pipeline.ts`)
stays `done` → DM, because the operator is already in that conversation and an echo to the group would
be noise. Routine `progress` can never be promoted, so the group never gets streamed chatter. Built
TDD (result → decisions, progress → DM, group gets no routine progress). Going live needs a daemon
restart (operator-gated). `tsc` clean; suite green (one pre-existing env-only config test unrelated).

**Bug fix — answering a decision in the group no longer floods the group with progress.** Same branch.
When the operator answered a tracked decision **in the unmuted Decisions group**, the raising project
resumed but then streamed ALL its progress to the group instead of the DM. Root cause (two parts):
(1) `answerDecision` (`reply-routing.ts`) seeded the resume against the chat the ANSWER arrived on
(the group), so `deliverIntoFolder` homed the reopened Order + focus to the group. The decision row
already stored the ORIGINAL raising chat (`chat_id`, the DM) separately from `decision_chat_id` (the
group it was posted to). Fix: resume against `dec.chatId` (fall back to the answer chat), and return
the resolved `homeChat` so the frontend runs the resumed turn on the DM too. The answer
acknowledgement still lands in the chat the operator answered in. (2) Defense in depth: a new pure
`routeChat(priority, {cid, adminDm, group})` (`priority.ts`) makes a firehose (`progress`/`done`) line
divert to the DM even if a session's chat IS the group, so routine progress can NEVER reach the group
regardless of where a session is homed; `surfaceChat` now delegates to it. Built TDD (answer-in-group
→ resume-in-DM; group-homed progress → DM; decision/result still → group; both a tapped button and a
typed reply). Needs a daemon restart (operator-gated). `tsc` clean; suite green (same pre-existing
env-only config test unrelated).

**Matured operator decisions — the schema makes a shapeless question impossible to raise.** Same
branch. An `eticket_prod` worker raised a decision the operator called unclear: three separate
questions ("Scope / Granularity / Ingestion") mashed into one message, flat option chips, no context,
no recommendation. Root cause, in code: the `ask_operator` schema was `{ question: string, options?:
string[], multiSelect? }` — `question` is free text, so a worker crams several decisions into one
call; there is **no `context` field** for the root cause and **no `recommendation` field**; and
`options: string[]` is a bare label with nothing behind it. Prose guidance in the tool description
(the earlier self-challenge hardening — root-cause first, the industry-standard fix not a patch,
self-critique) nudged but never guaranteed the shape. The fix is a **schema-enforced matured
decision**: one `ask_operator` call now carries a crisp `title`, the `context` (what happened + the
root cause), 2–5 `options` that each state what they mean + their trade-off, and a `recommendation`
(which + why); the description adds *raise exactly ONE decision per call — never bundle several*. Zod
`.min(2)` + required fields reject a shapeless or bundled question at the tool boundary, so the SDK
hands the worker a validation error and forces a well-formed retry — that is the hard guarantee
(depth is still only nudged, not proven). It **enriches, does not fork**: `StructuredQuestion` gains
`optionDetails`/`recommended`, `StructuredAsk` gains `title`/`context`/`recommendation`, but `options`
stays the index-addressed `string[]`, so every existing path (callbacks, `applyTap`, `answerText`,
`keyboardRows`, the legacy flat form) is untouched; the new fields ride in the same `spec` JSON column
and old rows degrade gracefully. `maturedAsk` (`structured-question.ts`, pure) normalizes the tool
input into the single-question ask; `decisionBody` renders the title, the root cause, each option as
`• label — detail` (⭐ on the recommended one), and a `Recommendation:` line; `fromAskUserQuestionInput`
now keeps the SDK-native option `description` as its detail (it used to throw it away), so native
structured questions render just as richly. AI stays out of the engine — it only validates shape,
renders, and routes; any *writing* of context/recommendation is the worker's job. The **maturing
reviewer** (a fresh worker that sharpens a shallow ask before it posts) is designed as the next phase
on the same choke point (`raiseOperatorDecision`), not built. Design doc:
`docs/superpowers/specs/2026-09-09-matured-decisions-design.md`. Built TDD (schema rejects the bare/
bundled/contextless/recommendation-less forms; `maturedAsk` builds + aligns details and the
recommended index; `decisionBody` renders + degrades). Going live needs a daemon restart
(operator-gated; the tool schema + description are read at worker launch). `tsc` clean; full suite
green (750).

**Two-phase design→build worker flow — dispatched work is designed before it is built.** Same
branch. The dispatch preamble (`briefWithProjectDocs`) told every worker to "use the superpowers
skills for the shape of work at hand" — a flat list that let a worker go straight to code. It now
steers the worker through **two phases**. **DESIGN** first: before writing code for any feature or
non-trivial change, sharpen the domain model with the model-invocable **`domain-modeling`** and
**`codebase-design`** skills — define the real terms and write/update the project's `CONTEXT.md`
glossary, record each genuine design decision as a short ADR (rejected alternatives included), then
synthesize a concise spec (acceptance criteria + edge cases) and design it as one clean seam (a lot
of behavior behind a small, testable interface); use `brainstorming` → `writing-plans` for the plan
and `systematic-debugging` to root-cause a bug first. **BUILD** second: implement against that spec
with `test-driven-development` (the failing test first, per acceptance criterion), then
`verification-before-completion` + `requesting-code-review` before claiming done. A trivial mechanical
edit may skip the CONTEXT.md/ADR step but must say so. The two design skills are the model-invocable
half of Matt Pocock's skill set, adopted 2026-09-10 and pinned into `~/.claude/skills` on the `user`
settingSource with a `PINNED.txt` provenance note; the interactive-only ones
(`grill-with-docs`/`to-spec`/`to-tickets`, all disable-model-invocation) are deliberately NOT named
to workers — a governed autonomous worker cannot invoke them. Evaluated in a dev-desk trial (memory
`mattpocock-skills-evaluation`): the design phase's highest-value output was making a "total order"
tiebreak explicit — exactly the eticket Sindibad nondeterministic-group bug class. Built TDD (a new
`dispatch.test.ts` assertion: the preamble names `domain-modeling`/`CONTEXT.md`/`codebase-design`
before `test-driven-development` and omits the disable-model-invocation skills). Going live needs a
daemon restart (operator-gated; the preamble is read at worker launch). `tsc` clean; full suite green
(751).

**Engine bug: dispatched workers killed while waiting on a background wait; "permission stream"
hiccups are SDK-side, not ours.** Branch `fix/dispatch-stall-background-wait`. A waselni go-live
worker reported the permission stream "erroring on repeated calls — a harness hiccup, not a CI
problem," then went idle on a background Monitor and was aborted by the 5-minute stall detector
(ledger `dispatch_abort` `limit:"stall"`, 2026-09-13 13:05 + 14:19 UTC). Root cause, two layers.
**(1) The permission-stream errors are SDK-side.** Every tool call — even an auto-approved one — is
routed through the SDK's `canUseTool` control-request protocol over the child `claude` process's
stdio; on a long, high-volume session (hundreds of `gh run view`/`sleep` calls) that control stream
transiently errors. Our governor never threw: **zero `approval_error` events all-time**, and waselni
is a *trusted* folder, so `autoApprove` returns allow instantly with no escalation round-trip.
`buildCanUseTool` is already hardened (stateless + try/catch fail-safe + self-heal), so the worker
recovered — the "harness hiccup" it described. Pinned to SDK `0.3.270`; the mitigation is fewer,
shorter calls per session (below). **(2) The stall abort of a non-hung worker is ours, by contract.**
The dispatch liveness monitor bumps `lastActivityAt` only when the SDK generator yields an event
(`onHeartbeat` fires on every streamed event; also `onMessage`/`onActivity`/`onTurnComplete`, and the
clock is held through engine-driven API-retry waits), and aborts at `t - lastActivityAt >= stallMs`
(default 5 min, `dispatch.ts`). A single step that blocks silently — a background wait/Monitor, a
long `sleep`, `gh run watch`, tailing logs — yields no events for its whole duration, so a worker
that is merely *waiting* looks identical to a hung one and is killed. The SDK exposes no in-tool-call
progress signal (`includePartialMessages` streams assistant tokens, not tool execution), so the
engine cannot observe liveness inside one opaque call. Rejected the engine-timer "fixes" — counting
an in-flight tool as activity, or raising `stallMs` — because they blind the detector to genuinely
hung tool calls, trading a precise guard for up-to-ceiling (2 h) hangs. The correct fix is the
**behavioral contract**: the dispatch preamble (`briefWithProjectDocs`) now forbids background
waits/Monitor and requires short FOREGROUND polling (status check → brief `sleep` → check again, each
under 90 s) and finishing within the single-shot run — so tool-call boundaries keep the heartbeat
fresh while the detector still catches true silence. What counts as "activity" is unchanged (any
streamed SDK event); what changed is the worker contract that keeps those events flowing. Built TDD
(a new `dispatch.test.ts` preamble assertion for the no-background-wait / poll-in-foreground /
single-shot rule; an `approval-resilience.test.ts` guard that 300 repeated trusted calls auto-allow
with no state leak, pinning that repeated-call robustness is ours-clean). No CONTEXT.md/ADR files (the
repo has no ADR convention; this is a one-line contract + guard-test edit) — the decision and its
rejected alternatives are recorded here and in memory. Going live needs a daemon restart
(operator-gated; the preamble is read at worker launch). `tsc` clean; full suite green (752).
