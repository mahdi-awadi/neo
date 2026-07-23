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
| `providers` | `{ ownWork: "subscription", customerWork: "gemini" }` | Provider routing (the compliance firewall). |
| `subscriptionInteractiveReservePct` | `0.2` | Fraction of the subscription pool reserved for interactive use. |
| `budgetWindowUsd` | `20` | Per-window USD budget for background SDK work. |
| `budgetWindowMs` | `18000000` (5h) | Rolling budget window, matching the subscription usage window. |
| `idleCloseMs` | `86400000` (24h) | Idle-close threshold for normal projects (the company is exempt). |
| `dispatchTimeoutMs` | `900000` (15m) | Default per-dispatch ceiling when the caller doesn't request one. |
| `dispatchTimeoutMaxMs` | `7200000` (2h) | Hard cap on any per-dispatch ceiling a caller may request. |
| `dispatchStallMs` | `300000` (5m) | Abort a dispatched sub-run that produces no activity for this long. |
| `dispatchGraceMs` | `75000` (75s) | Grace window to commit green work + write a WIP note before a hard abort. |
| `codebaseMemoryIndexTimeoutMs` | `300000` (5m) | Bounded wait for an engine-side codebase-memory `index_repository` before a dispatch proceeds anyway (best-effort). |
| `drainWindowMs` | `90000` (90s) | Graceful-reload wait for running turns to wrap up before interrupt. |
| `stuckAfterMs` | `600000` (10m) | Alert when a running session has produced nothing for this long. |
| `longTurnAlertMs` | `1200000` (20m) | Alert when one activity label has run this long. |
| `alertRepeatMs` | `900000` (15m) | Re-alert about the same session only after this long. |
| `contextPolicy` | `{ handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604800000, handoffTimeoutMs: 180000, staleResumePct: 0.35, cacheTtlFallbackMs: 3600000, cacheTtlMinObservations: 5 }` | Session context-window lifecycle thresholds. See "Context policy: learned cache TTL + per-model window" below for `staleResumePct`/`cacheTtlFallbackMs`/`cacheTtlMinObservations`/`windowTokensByModel`. |
| `workers` | `{ company: {effort:"low"}, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: {effort:"low"}, handoff: {} }` | Per-launch-path worker profiles. See "Worker profiles" below. |
| `workerEnv` | `{}` | Extra env vars merged over `process.env` for every spawned worker (e.g. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_SUBAGENT_MODEL`). |

> **Note:** if you raise `drainWindowMs` past ~90s, also raise `TimeoutStopSec` in your service unit
> (systemd's default stop timeout is 90s and would kill the process mid-drain).

## Worker profiles (`workers`)

Each of the seven launch paths — `company`, `project`, `dispatch`, `loop`, `judge`, `ingress`,
`handoff` — takes an optional `{ model?, effort?, skills?, maxTurns? }` profile (`WorkerProfile` /
`WorkerPathName` in `src/config.ts`). `profileDeps(cfg, path, base)` (`src/engine/worker-profile.ts`)
looks up `cfg.workers[path]` and fills `model`/`effort`/`skills`/`maxTurns` onto the caller's
`RunDeps` only where the caller didn't already set them (the caller's own values always win), then
merges `cfg.workerEnv` with any caller-supplied `env`. A per-path object set in `config.json`
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

`contextPolicy.windowTokensByModel` (optional, `Record<string, number>`, unset by default) is an
operator-choice override layered over the built-in context-window-size facts map
(`windowTokensFor`'s `MODEL_WINDOW_TOKENS`, keyed by the model id Claude Code's own transcripts
report). It is not a new fixed knob — the window is still derived from the model the transcript
reports; this only lets you correct or extend the facts map (e.g. for a model id the built-in map
doesn't know yet). It is threaded into every gate that measures context: `dispatch`'s gate,
`pipeline`'s pre- and post-resume gates, the loop-resume gate, and `runHandoff`'s own
re-measurement — so a configured override changes gate verdicts, not just the number shown for
`/status` ctx%.

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

**Point projects at a non-`/home` root.** Set `WORK_ROOT=/srv/projects` (and, if you keep the
company workspace elsewhere, `COMPANY_FOLDER=/srv/projects/company`).
