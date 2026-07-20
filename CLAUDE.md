# Neo

Neo is a personal work **engine**. You give it an order ("open this project and do X"); it opens
the project as a headless Claude Code worker via the **Claude Agent SDK**, governs the work
deterministically, and streams progress back over a channel (Telegram first). No `cd`, no terminal,
no tmux.

**Core principle:** AI *decides*; the engine *acts and governs*. The engine itself contains **no
AI** — it routes, governs, meters, and records. AI lives only inside SDK workers (Claude, on your
subscription) and customer-message reading (Gemini).

Neo is the clean successor to **operant** (at `/home/operant`). Same goals, rebuilt on the Agent
SDK so the old tmux/socket/scraper spine is gone.

## Architecture (three layers)

```
Frontend  (Telegram / email / WhatsApp)            ← you talk to projects here
   ↕
Engine    (orders · provider routing · governance  ← deterministic. THIS repo's job.
           · budget · ledger)
   ↕  query(task, { cwd, canUseTool, mcpServers, settingSources })
Worker    (Claude Agent SDK = Claude Code in a      ← does the actual project work
           project folder, on your subscription)
```

## Rules that live in CODE, not prompts (the compliance firewall)

These are enforced by `src/engine/provider-router.ts` and `governor.ts` — never by trusting a
prompt:

- **Your own work → your Claude subscription** (via the Agent SDK). It draws from your normal
  subscription usage limits today. The monthly-credit change Anthropic announced is **paused**;
  nothing changed. Do **not** build credit/overflow accounting (YAGNI). Keep the provider choice in
  `config` so if the plan ever changes it's a config flip, not a rewrite.
- **Customer-direct work (email/WhatsApp/web) → Gemini.** A customer must never touch the
  subscription, and Neo must never offer customers a Claude login. The router must **refuse, in
  code**, any attempt to route `source: "customer"` to the subscription.
- **Budget guard:** background SDK work shares your subscription pool, so reserve interactive
  headroom — never drain the plan you use yourself (`subscriptionInteractiveReservePct`).
- **Approval gate (hardened):** the governor is default-ESCALATE — unknown tools, foreign MCP
  tools, WebFetch, and out-of-folder Write/Edit all ask Neo (autonomous paths auto-deny). File
  writes are path-fenced to the session's project folder. Customer-tainted briefs (inbox
  drafting) run with **zero tools** (`TAINTED_DISALLOWED_TOOLS` + no MCP): customer email text
  never reaches a worker that can act. Operator-mediated drafting on Claude is own-work
  (Neo reviews/edits/sends every reply); direct customer I/O stays off the subscription.

## Current status

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
`.md` files, query the `codebase-memory` MCP for a structural map before cold-reading files, and
use the superpowers skills — the engine appends it so the operator never has to and it can't be
omitted. `bun test` is scoped to `tests/` via
`bunfig.toml` (no more `agent/desks/**` sweep). Specs:
`docs/superpowers/specs/2026-07-08-context-policy-design.md`,
`docs/superpowers/specs/2026-07-08-session-liveness-design.md`.

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

Next: **Phase 3b** (the deferred Gemini customer path), then Phase 4 (finance/board). Keep building
**phase by phase, TDD**, per `MVP-PLAN.md`. Deferred loop follow-ons (reuse the same data layer):
Telegram `/loop new` guided flow, an agent/MCP `create_loop` tool, and edit-prefill in the web form.
Wire the context policy into the loop-runner path.

## How to work here

- **Stack:** Bun + TypeScript. `bun install` · `bun test` · `bunx tsc --noEmit` · `bun run
  src/daemon.ts`.
- **Follow `MVP-PLAN.md`** in order. Write the failing test first, then the minimal code (TDD).
  `bunx tsc --noEmit` + `bun test` must be green before any task is "done." Commit per logical piece.
- **Port the proven code from `/home/operant`** — don't rebuild it: `store.ts` → `ledger.ts`,
  `finance.ts`, `frontends/telegram.ts`, the `config.ts` precedence pattern, the risk keywords from
  `autopilot-risk.ts`. **Do NOT port** `screen-manager.ts`, `shim.ts`, `socket-server.ts`,
  `autopilot.ts`, `autopilot-parser.ts` — they exist only to puppet the interactive CLI and are
  deleted by design.
- **Verified Agent SDK surface** (https://code.claude.com/docs/en/agent-sdk/typescript): package
  `@anthropic-ai/claude-agent-sdk`; entry `query({ prompt, options })`; key options `cwd`,
  `settingSources: ["user","project"]` (`user` loads `~/.claude` plugins/skills, `project` loads the
  folder's CLAUDE.md/.mcp.json/settings), `skills: "all"` (the one switch that turns skills on),
  `systemPrompt: { type:"preset", preset:"claude_code" }`, `permissionMode`, `canUseTool`,
  `mcpServers`, `resume`. The async generator yields `{ type: "assistant" | "result" | "system" |
  ... }`. The full shape is documented in `src/engine/session-runner.ts` (SDK findings:
  `docs/sdk-notes.md`).

## Conventions

- **Secrets** in `.env` (gitignored, `chmod 600`). Runtime/tenant data under `company/` is
  gitignored. Never commit keys or echo them into logs/replies.
- **No AI in the engine.** Determinism by default; AI only inside SDK workers + Gemini reads.
- Operator is addressed as **Neo** (not "Mahdi" — that's only the repo-author handle).
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Workflow patterns (field notes — only what fits Neo)

Distilled from how expert agent-coders work. The tool-specific bits (Cursor/Codex cloud agents,
Greptile) are noted but not adopted; these principles are:

- **Skillify anything done more than once.** A recurring task (review pass, release check, a port)
  becomes a skill/command, not a re-typed prompt. Keep leaning on `superpowers` skills.
- **Loops & automations ARE Neo's product model.** An *automation* = `trigger → prompt`; a *loop* =
  `trigger → repeated action → goal` (stops when the goal is met). That is exactly the company-engine
  autonomy: a department is *triggered* (cron / board event) → *acts* (works a board task via an SDK
  worker) → until a *goal* (task done / board drained). Design the scheduler around this
  trigger/action/goal shape. Loops worth stealing: nightly **docs-sweep** (sync docs to the day's
  diff), nightly **error-sweep** (scan logs → fix → record), a **coverage** loop (write tests until
  green).
- **Quality flywheel: tests + docs + logs, always green.** TDD covers tests. Also keep docs synced to
  the code (don't let them drift) and log enough that an agent can diagnose any failure from logs
  alone. Cheap, compounding.
- **Be concise.** Short, plain-English summaries of what changed — never essays. Applies to how Neo
  reports progress, too.
- **Parallelism needs isolation.** Many agents on one repo conflict → git worktrees per agent (Neo's
  concurrent sessions already isolate by folder). Agent-scale merge/deploy is genuinely unsolved —
  batch and be patient.

## Why these decisions (so you don't relitigate them)

- **New project, not an evolution of operant:** operant's spine (socket-server + shim + tmux +
  Ink-scraper) inverts under the SDK model. Building clean and porting only the proven, model-
  agnostic modules avoids carrying dead abstractions ("add the good" beats "subtract the bad").
- **Agent SDK, not Managed Agents:** the SDK runs on *your* server against *your* `/home` folders,
  on *your* subscription. Managed Agents runs in a remote sandbox that can't see your files.
- **Gemini for customers:** the Claude subscription is personal-use; customer-facing usage must not
  draw on it.
- **Subscription use is confirmed compliant — DO NOT re-litigate (Anthropic support, 2026-06-20):**
  a personal, single-user, self-hosted Agent-SDK daemon — *including* scheduled/autonomous automation
  and client-*motivated* work (you own the output) — is "ordinary individual usage" covered by the Max
  subscription; **no API key needed.** (The credit change announced 2026-06-15 is paused.) The
  invariant that keeps it compliant, in support's words: **"Claude never touches clients directly"** —
  it only does *your* own work; direct customer-facing I/O (email/WhatsApp reading + reply) stays on
  Gemini (that's all the firewall enforces). Don't switch to an API key, don't narrow the autonomy on
  compliance grounds, don't re-open this.

## Map

- `MVP-PLAN.md` — the phased build plan. Phase 0 (scaffold) done; Phase 1 is the walking skeleton.
- `src/` — engine modules; each file header states its responsibility + its Phase 1 TODO.
- `/home/operant` — the predecessor. Mine it for proven code to port.
- `docs/loops.md` — loops & automations reference (trigger → action → goal); the autonomy model for
  the company-engine scheduler.
