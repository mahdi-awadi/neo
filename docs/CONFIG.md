# Configuration reference

Neo resolves every setting with the precedence **environment variable → `config.json` → built-in
default** (`src/config.ts`). Secrets belong in `.env`; structured non-secret knobs belong in
`config.json`. Both files are gitignored — only `.env.example` and `config.example.json` are
committed. A fresh clone runs with a single value set: `TELEGRAM_TOKEN`.

## Secrets & deployment (`.env`)

These are read from environment variables (a few also fall back to `config.json`). Put the sensitive
ones in `.env` (`chmod 600`).

| Variable | Env-only? | Default | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_TOKEN` | yes | — | BotFather token. Required for the Telegram bot + web console. |
| `GEMINI_API_KEY` | yes | *(empty)* | Gemini key for the customer-facing path. Never touches the Claude subscription. |
| `AGENT_INGRESS_SECRET` | yes | *(empty)* | Bearer secret for `POST /agent/ingress` + `/inbox`. Empty → those endpoints refuse all requests. |
| `STITCH_API_KEY` | yes | *(empty)* | Google Stitch MCP (design generation) for operator workers. Off when empty. |
| `BOT_USERNAME` | env or `config.json` | *(auto via getMe)* | Bot `@username` (no `@`) for the web Telegram Login Widget. |
| `WEB_HOST` | env or `config.json` | `127.0.0.1` | Interface the web console binds. Set to a bridge IP to let a proxy reach it. |
| `WEB_PORT` | env or `config.json` | `3003` | Web console port. |
| `PUBLIC_URL` | env or `config.json` | *(empty)* | Public HTTPS URL the console is reached at (behind your proxy). |
| `GATEWAY_SEND_URL` | env or `config.json` | *(empty)* | Customer-reply gateway `/send` endpoint. Off when empty. |
| `MEETING_LINK` | env or `config.json` | *(empty)* | Booking link for the customer-reply CTA. |
| `BUSINESS_NAME` | env or `config.json` | *(empty)* | Name customer replies sign off as (never "Neo"). |
| `CODEBASE_MEMORY_BIN` | env or `config.json` | *(empty)* | Path to the codebase-memory MCP binary (code intelligence). Off when empty. |
| `WORK_ROOT` | env or `config.json` | `/home` | Root holding your project repos (picker / dispatch / loop fence). |
| `COMPANY_FOLDER` | env or `config.json` | `<repo>/agent` | The always-on "company" workspace folder. |
| `NEO_LOOP_SCHEDULER` | env or `config.json` | `1` (on) | Set `0` to disable the loop scheduler. |

## Structured knobs (`config.json`)

Non-secret tuning, read only from `config.json` (copy `config.example.json`). All optional.

| Key | Default | Purpose |
| --- | --- | --- |
| `telegramAllowFrom` | `[]` | Numeric Telegram ids allowed to reach the bot / claim admin. Empty → first-come trust-on-first-use. |
| `providers` | `{ ownWork: "subscription", customerWork: "gemini" }` | Provider routing (the compliance firewall). `ownWork` may be `"subscription"` (Claude Agent SDK, default) or `"codex"` (OpenAI Codex SDK). |
| `subscriptionInteractiveReservePct` | `0.2` | Fraction of the subscription pool reserved for interactive use. |
| `budgetWindowUsd` | `20` | Per-window USD budget for background SDK work. |
| `budgetWindowMs` | `18000000` (5h) | Rolling budget window, matching the subscription usage window. |
| `idleCloseMs` | `86400000` (24h) | Idle-close threshold for normal projects (the company is exempt). |
| `dispatchTimeoutMs` | `900000` (15m) | Default per-dispatch ceiling when the caller doesn't request one. |
| `dispatchTimeoutMaxMs` | `7200000` (2h) | Hard cap on any per-dispatch ceiling a caller may request. |
| `dispatchStallMs` | `300000` (5m) | Abort a dispatched sub-run that produces no activity for this long. |
| `dispatchGraceMs` | `75000` (75s) | Grace window to commit green work + write a WIP note before a hard abort. |
| `apiRetryLadderMs` | `[30000, 120000, 480000]` (30s→2m→8m) | Second-tier backoff waits (ms/attempt) when a rate-limited turn gives no real reset time. The number of automatic retries is **derived from this array's length** — a longer ladder means more retries, no separate knob. |
| `apiRetryJitterFrac` | `0.2` (±20%) | Jitter magnitude (0–1) on every retry wait so co-throttled workers don't sync up: ladder waits get ±frac, reset-based waits get +frac (upward only). |
| `apiCooldownMs` | `60000` (60s) | Engine-wide hold on **new** background work after a throttle report, so retries + the scheduler can't amplify a rate-limit storm. |
| `routeKeep` | `20000` | Reply-route retention cap: max persisted message→project routes (oldest pruned; the ledger stays the source of truth). |
| `eventsKeep` | `50000` | Diagnostic event-log retention cap: max rows kept in the `events` table (pruned in amortised batches). |
| `codebaseMemoryIndexTimeoutMs` | `300000` (5m) | Bounded wait for an engine-side codebase-memory `index_repository` before a dispatch proceeds anyway (best-effort). |
| `codebaseMemoryListTimeoutMs` | `15000` (15s) | Bounded wait for a codebase-memory `list_projects` op (the sibling of the index timeout above). |
| `inboxListDefault` | `100` | Default page size for the customer-inbox list in the web console when no explicit limit is given. |
| `messageRoutesCacheCap` | `2000` | In-memory reply-route cache bound (oldest evicted first); the ledger backs it, so this only sizes the fast front cache. |
| `drainWindowMs` | `90000` (90s) | Graceful-reload wait for running turns to wrap up before interrupt. |
| `stuckAfterMs` | `600000` (10m) | Alert when a running session has produced nothing for this long. |
| `longTurnAlertMs` | `1200000` (20m) | Alert when one activity label has run this long. |
| `alertRepeatMs` | `900000` (15m) | Re-alert about the same session only after this long. |
| `contextPolicy` | `{ handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604800000, handoffTimeoutMs: 180000, staleResumePct: 0.35, cacheTtlFallbackMs: 3600000, cacheTtlMinObservations: 5, cacheObsWindow: 50 }` | Session context-window lifecycle thresholds. See "Context policy: learned cache TTL + per-model window" below for `staleResumePct`/`cacheTtlFallbackMs`/`cacheTtlMinObservations`/`cacheObsWindow`/`windowTokensByModel`. |
| `workers` | `{ company: {effort:"low"}, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: {effort:"low"}, handoff: {} }` | Per-launch-path worker profiles. See "Worker profiles" below. |
| `workerEnv` | `{}` | Extra env vars merged over `process.env` for every spawned worker after SDK-specific filtering. Claude Code env knobs such as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `MAX_MCP_OUTPUT_TOKENS`, and `CLAUDE_CODE_SUBAGENT_MODEL` apply only on the Claude adapter. |
| `memory` | `{ scopes: [], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 }` | Per-project long-term memory (store/inject/recall). `scopes: []` = off. See "Memory system" below. |

> **Note:** if you raise `drainWindowMs` past ~90s, also raise `TimeoutStopSec` in your service unit
> (systemd's default stop timeout is 90s and would kill the process mid-drain).

## Worker profiles (`workers`)

Each of the seven launch paths — `company`, `project`, `dispatch`, `loop`, `judge`, `ingress`,
`handoff` — takes an optional `{ model?, effort?, skills?, maxTurns? }` profile (`WorkerProfile` /
`WorkerPathName` in `src/config.ts`). `profileDeps(cfg, path, base)` (`src/engine/worker-profile.ts`)
looks up `cfg.workers[path]` and fills the configured own-work provider plus
`model`/`effort`/`skills`/`maxTurns` onto the caller's `RunDeps` only where the caller didn't
already set them (the caller's own values always win), then merges `cfg.workerEnv` with any
caller-supplied `env`. Those fields are applied through the SDK compatibility table in
`src/engine/model-resolver.ts`: Claude gets the Claude-only controls, while Codex keeps
`model`/`effort` and drops profile-level `skills`/`maxTurns`. A per-path object set in `config.json`
**replaces** the built-in default object for that path (it does not merge field-by-field), so
include every field you want to keep.

**Quality invariant:** the shipped defaults reproduce today's behavior exactly. Only `company` and
`ingress` set anything (`effort: "low"`, both pre-existing in code before this became config); every
other path is `{}` (full inherit — same model/effort/skills/maxTurns as before this feature
existed). Changing a path's profile in `config.json` is opt-in and the only way behavior changes.

### Economy mode (opt-in, measured)

Eligible paths only (their output is not project work product): `handoff`, `judge`, `ingress`.
Example: `"workers": { "handoff": { "model": "haiku", "effort": "low" }, "judge": { "model": "haiku", "effort": "low" } }`.
`CLAUDE_CODE_SUBAGENT_MODEL` is the same trade for subagents inside workers — set it only after
reading the guardrail. Guardrail: watch ledger loop `goal-met` rate, iterations-to-green, and
whether resumed sessions recover from handoff notes without re-asking, for two weeks; any
regression → remove the override (a config flip). Code-writing paths (`company`, `project`,
`dispatch`, `loop`) are NOT eligible — see the design spec's quality guarantee.

## Worker SDK provider

By default Neo runs operator work through the Claude Agent SDK:

```json
{ "providers": { "ownWork": "subscription", "customerWork": "gemini" } }
```

Set `ownWork` to `"codex"` to run operator workers through the OpenAI Codex SDK instead:

```json
{ "providers": { "ownWork": "codex", "customerWork": "gemini" } }
```

At runtime, the operator can switch the same value for new sessions with `/sdk claude`,
`/sdk codex`, or the Worker SDK segmented control in the web console. Existing sessions keep the
SDK they started with; restart persistence still comes from `config.json`.

The runner wrapper keeps the engine-facing API the same (`runOrder` / `startOrder`), including live
follow-ups and resume. The Claude adapter keeps Neo's existing `canUseTool` governor and in-process
MCP servers. The Codex adapter uses Codex SDK threads with `workingDirectory`, `sandboxMode`,
`approvalPolicy`, model, and reasoning-effort controls; it streams Codex JSON events into Neo's
message/activity/event hooks. Compatibility is table-driven in `src/engine/model-resolver.ts`:

| Run/profile setting | `subscription` (Claude Agent SDK) | `codex` (OpenAI Codex SDK) |
| --- | --- | --- |
| `model` | Forwarded. `haiku`, `sonnet`, and `opus` remain Claude tier aliases. | Provider-native model IDs pass through. Claude tier aliases map to Codex default model plus effort (`haiku`→`low`, `sonnet`→`medium`, `opus`→`high`). |
| `effort` | Forwarded to the Claude adapter. | Forwarded as Codex reasoning effort (`max` becomes Codex `xhigh`). |
| `skills` / `maxTurns` | Forwarded to Claude Code. | Dropped from worker profiles and omitted from Codex launch config; direct `RunDeps` usage records `worker_compat_warning`. |
| `agents` / dispatch team mode | Forwarded to Claude Code; team dispatch adds the lead-agent preamble. | Unsupported. Team dispatch falls back to a normal single-worker brief; direct `agents` usage records `worker_compat_warning`. |
| `mcpServers` | In-process MCP servers attach to the Claude SDK. | Unsupported by the current Codex wrapper shape; records `worker_compat_warning`. |
| `disallowedTools` | Forwarded to Claude Code/governor. | The standard read-only deny-list (`Write`, `Edit`, `NotebookEdit`, `Bash`) becomes Codex `sandboxMode: "read-only"`. Other tool deny-lists record `worker_compat_warning`. |
| `workerEnv` | Merged over `process.env` unchanged. | `CLAUDE_*`, `ANTHROPIC_*`, and `MAX_MCP_OUTPUT_TOKENS` are filtered before launch; other keys such as `CODEX_API_KEY` stay available. |

Worker profile `model` values are resolved at the SDK boundary. Provider-native model IDs pass
through unchanged, but Claude tier aliases do not leak into Codex: `haiku` maps to Codex default
model + `low` effort, `sonnet` to default model + `medium` effort, and `opus` to default model +
`high` effort. An explicit `effort` in the worker profile wins over the alias-derived effort.

Codex SDK auth is handled by Codex itself: use your local Codex login or provide `CODEX_API_KEY` in
the process environment. Neo does not read or store that key directly.

## Context policy: learned cache TTL + per-model window

Three `contextPolicy` fields (`ContextPolicyCfg` in `src/engine/context-policy.ts`) gate the
LEARNED cache-TTL resume rule: a resume idle past the *effective* cache TTL (derived from real
per-resume cache-hit observations in the ledger's `cache_observations` table via
`effectiveCacheTtlMs`) on a transcript at/above `staleResumePct` occupancy triggers a handoff
instead of a cold, unwarmed-cache resume.

| Field | Category | Default | Meaning |
| --- | --- | --- | --- |
| `staleResumePct` | ratio | `0.35` | Occupancy above which a stale-past-TTL resume triggers handoff instead of keep. |
| `cacheTtlFallbackMs` | provider-fact fallback | `3600000` (1h) | The provider-documented prompt-cache TTL, used until enough real observations exist to derive a learned TTL. |
| `cacheTtlMinObservations` | operator choice | `5` | Minimum `(gapMs, hit)` observations required before the learned TTL is trusted over the fallback. |
| `cacheObsWindow` | operator choice | `50` | Rolling sample size for the learned-TTL window — how many of the most recent `(gapMs, hit)` observations the learner keeps. |

`contextPolicy.windowTokensByModel` (optional, `Record<string, number>`, unset by default) is an
operator-choice override layered over the built-in context-window-size facts map
(`windowTokensFor`'s `MODEL_WINDOW_TOKENS`, keyed by the model id Claude Code's own transcripts
report). It is not a new fixed knob — the window is still derived from the model the transcript
reports; this only lets you correct or extend the facts map (e.g. for a model id the built-in map
doesn't know yet). It is threaded into every gate that measures context: `dispatch`'s gate,
`pipeline`'s pre- and post-resume gates, the loop-resume gate, and `runHandoff`'s own
re-measurement — so a configured override changes gate verdicts, not just the number shown for
`/status` ctx%.

## Memory system (`memory`) — Phase 2: store / inject / recall

Per-project long-term memory: a frozen ground-truth snapshot injected at worker start, a `memory`
tool workers use to write durable curated facts (applies NEXT session, never mid-run), a `memory_log`
tool to append a one-line note to today's running log immediately, and a `memory_search` tool over a
cited daily-log recall index. **Off by default** — `memory.scopes: []` is a total no-op until you opt
a folder in. Code: `src/engine/memory.ts`, `memory-recall.ts`, `memory-tool.ts`; `MemoryCfg` in
`src/config.ts`.

| Field | Category | Default | Meaning |
| --- | --- | --- | --- |
| `scopes` | operator choice | `[]` | Which folders get the snapshot injected / memory tools attached: the literal keyword `"company"` (matches `companyFolder`) and/or a project's absolute folder path. Empty = the feature is entirely off. |
| `snapshotMaxPct` | ratio of the session model's window | `0.004` (≈800 tokens on a 200k window) | MEMORY.md's char cap: `windowTokens * snapshotMaxPct * 4` (4 chars/token). |
| `userMaxPct` | ratio of the session model's window | `0.0025` (≈500 tokens on a 200k window) | USER.md's char cap, same formula. |
| `dreamMaxMutations` | operator choice (dream-loop budget) | `3` | Max memory-file mutations (add/replace/remove) per nightly consolidation run. |
| `dreamMaxAdds` | operator choice (dream-loop budget) | `1` | Max NEW entries (`add`) per nightly consolidation run — a subset of `dreamMaxMutations`. |
| `dreamMaxNetChars` | operator choice (dream-loop budget) | `250` | Max net character growth across memory files per nightly consolidation run. |
| `dreamLookbackDays` | operator choice | `14` | How many days of daily logs the dream loop reviews per run. |

`scopes` semantics: the literal string `"company"` opts the always-on company workspace
(`cfg.companyFolder`) in; any other entry is compared as an absolute folder path (realpath-resolved,
symlink/trailing-slash-insensitive) — a project only gets memory when its own folder appears there.
Default `[]` means neither matches, so the whole system (snapshot injection, the `memory`/
`memory_log`/`memory_search` tools, the dream loop) stays inert — verified byte-identical to
pre-memory behavior by a dedicated test.

### Snapshot inject (compose-time scan + caps)

The injected snapshot isn't a raw copy of MEMORY.md/USER.md. At compose time each file is run through
the same write-time poisoning scan (`scanMemoryText`) and truncated to its per-file char cap
(`snapshotMaxPct` / `userMaxPct` of the model window). This catches drift the write-time scan never
saw — a hand-edit or an externally-written entry — and drops offending or over-cap entries before
they reach the worker. When anything is withheld or truncated, a short notice (`[N entries withheld
by scan]` / a truncation marker) is appended so the worker knows it got a filtered view rather than
silently trusting a partial one (`memorySnapshot` / `scannedAndCapped` in `memory.ts`).

### Flush sentence (pre-handoff / pre-drain memory capture)

When a context-boundary handoff, a dispatch grace-window wrap-up, or a graceful-reload drain fires
for a memory-scoped folder, `MEMORY_FLUSH_SENTENCE` (`src/engine/context-policy.ts`) is prepended to
the worker's wrap-up task, asking it to save durable facts via the `memory` tool and append a
one-line session summary to today's log **before** writing the separate, ephemeral HANDOFF.md note.
Gated by the same `memoryScopeEnabled` check every other memory injection uses — a folder outside
`memory.scopes` never sees it, and the sentence is never merged into the base prompt text (kept
byte-identical when memory is off, pinning the pre-memory fence).

### Idle-close capture (deterministic, no worker)

Distinct from the flush sentence above (which *asks a worker* to save): when a NORMAL project session
idle-closes (the company is exempt) in a memory-scoped folder, the engine itself appends a
deterministic one-line summary to today's log — in addition to, never instead of, the ephemeral
HANDOFF.md note. No worker runs and no AI is involved (`idle.ts` → `appendDailyLog`). It's gated
BEFORE the write by the same `memoryEnabledFor` check, so an out-of-scope folder never even gets a
`memory/` dir created.

### Dream loop (nightly memory consolidation)

`memory-dream` (`src/engine/loops.ts`) — disabled by default like every other cron loop; enable via
`/loop memory-dream on` or the web console's Loops tab. Fires nightly (`0 3 * * *`), reviews the
last `dreamLookbackDays` days of the company workspace's `memory/log/` plus MEMORY.md/USER.md, and
proposes consolidations through the same `memory` tool — but running in **dream mode**: an
engine-enforced budget (`dreamMaxMutations` / `dreamMaxAdds` / `dreamMaxNetChars`), tallied in a
closure scoped to that one run. An over-budget mutation is rejected without taking effect; if the
revert write itself fails, the run hard-stops and diaries the mutation as "applied (OVER BUDGET —
revert failed)" rather than silently misreporting it as rejected. Every attempted mutation (applied
or rejected) is appended to `<folder>/memory/DREAMS.md`, a plain timestamped diary — engine-written,
no AI in the engine. A `memory_log` append during a dream run is diaried too but is **not** a capped
mutation — it never consumes the mutation/add/net-char budget, and a scan-rejected log line is
recorded in the diary by its rejection reason, never its withheld content. Before the first attempted
mutation of a run, both memory files are backed up
to `<folder>/memory/.backups/<file>.<timestamp>.md`. The loop refuses to run at all (0 iterations,
no worker started) when the company folder isn't in `memory.scopes` — a dream loop never spends a
run on an opted-out folder. Like every loop, it's governed and never pushes or deploys.

### Daily log & recall (`memory_log` / `memory_search`)

Beside the curated MEMORY.md/USER.md facts, each project keeps a running, dated **daily log** — a
journal of one-line notes (e.g. a session summary). Workers append to it with `memory_log(line)`:
unlike the `memory` tool it is *not* a capped-file mutation (it never counts against the dream
budgets) and it takes effect immediately, but it runs through the same write-time poisoning scan — a
rejected line is silently not written (not an error, just not saved).

`memory_search(query, limit?)` (`memory-tool.ts`) reads that log back through an FTS5 (bm25) index
(`memory-recall.ts`; one `<folder>/memory/index.sqlite` per project). Every hit is cited with its
`file` (relative to `memory/`, e.g. `log/2026-07-01.md`) and `day`. `limit` defaults to 5, max 20.
This is **keyword** search (FTS5), not semantic — a query needs to share literal word stems with the
stored line to match.

### Bootstrap (`bun run memory:bootstrap <folder>`)

`memory-bootstrap.ts` seeds a project's memory log once, deterministically (no AI): one dated log
line per recorded ledger outcome for that folder, plus every non-empty line of an existing
HANDOFF.md imported verbatim. Guarded by a `<folder>/memory/.bootstrapped` sentinel, so a re-run
(daemon restart, re-`/open`, or invoking the CLI again) is always a safe no-op. Run it once per
project you opt into `memory.scopes`, so its first snapshot isn't empty:

```sh
bun run memory:bootstrap /home/you/some-project
```

### `.git/info/exclude` hygiene

The first `memory` write to a project folder (`applyMemoryOp` / `appendDailyLog`, via
`ensureExcluded`) appends `memory/` to that folder's `.git/info/exclude` if it's a real git repo and
the line isn't already there — **never** the tracked `.gitignore` (machine-local law: memory is
per-machine/per-checkout state, not something to commit). Fail-open and a no-op outside a git repo;
runs at most once per process per folder.

## There is no `idlePollMs` / `loopTickMs`

The daemon's scheduler tick is **derived**, not a fixed config knob. `heartbeatMs()`
(`src/engine/heartbeat.ts`) returns `min(CRON_RESOLUTION_MS /* 60s, cron's own minute resolution */,
...everyMs of every enabled interval-trigger loop)` — so the tick is 60s unless an *enabled* loop
with an `interval` trigger wants something faster, in which case the fastest such interval wins
(disabled loops and manual/cron-trigger loops never speed it up). In practice operator-authored
loops can't go below 60s — loop validation rejects intervals under `MIN_INTERVAL_MS` (= the 60s
cron resolution), so today only a code-defined interval loop could pull the tick faster; the
derivation (plus its 1s defensive floor) exists so that if one ever does, the daemon follows it
with no restart. The daemon re-derives this every
tick from `effectiveLoops()` (built-in + data-driven loops) and self-reschedules a single
`setTimeout` (not `setInterval`) — so enabling a fast loop speeds up the daemon with no restart, and
there is no separate poll-interval setting to keep in sync.

## `freshSession` (loop definitions, not global config)

A per-loop flag (`LoopDef.freshSession?: boolean` in `src/engine/loops.ts`, also settable on
data-driven loops via `loop-validate.ts`), not a `config.json` key. When `true`, the loop never
resumes across iterations — every fire starts a brand-new session, overriding the normal
context-gated resume decision entirely (useful for judge/report loops where a fresh look matters
more than continuity). When `false`/unset, the loop defers to the normal context-policy
`gateResume` (keep / handoff / clear based on measured occupancy).

## Recipes

**Run locally (minimum).** Set `TELEGRAM_TOKEN` in `.env`, `bun run src/daemon.ts`, message your
bot. The web console needs `BOT_USERNAME` too.

**Expose the web console behind a TLS reverse proxy.** Bind the console where your proxy can reach
it and tell it its public identity:

```env
WEB_HOST=172.17.0.1          # a docker-bridge / LAN IP your proxy can reach (not 127.0.0.1)
WEB_PORT=3003
PUBLIC_URL=https://neo.example.com
BOT_USERNAME=your_bot        # must match @BotFather /setdomain for this PUBLIC_URL
```

Point your proxy (Traefik/Caddy/nginx) at `WEB_HOST:WEB_PORT` and terminate TLS there. Register the
`PUBLIC_URL` domain with @BotFather (`/setdomain`) so the Telegram Login Widget works.

**Enable the optional MCP servers.** If you have the binary installed, set `CODEBASE_MEMORY_BIN`
(codebase-memory is Neo's one code-intelligence MCP — chosen by a measured head-to-head, see the
2026-07-23 context-efficiency design spec) and `STITCH_API_KEY` for Stitch. They attach to operator
workers only — never to the customer/ingress path.

Operator workers also get a **Playwright browser MCP** (headless, isolated Chromium) for web/UI
testing. This one needs no config — it attaches automatically on the operator path, never the
customer/ingress path. It requires the `playwright-mcp` binary on `PATH` (`@playwright/mcp`) and a
Chromium browser (`playwright install chromium`). If the binary is absent, the MCP does not start and
the worker runs without it. The browser launches only on first tool use.

**Point projects at a non-`/home` root.** Set `WORK_ROOT=/srv/projects` (and, if you keep the
company workspace elsewhere, `COMPANY_FOLDER=/srv/projects/company`).
