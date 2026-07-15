# Neo — MVP Implementation Plan (locked)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax. Read `CLAUDE.md` first.

**Goal:** Neo is a personal work *engine*. You give it an order ("open this project and do X") and
it opens the project as a headless Claude Code worker (Claude Agent SDK), governs the work
deterministically, and streams progress back over Telegram — no `cd`, no terminal, no tmux.

**Architecture:** Three layers — Frontend (channels) → Engine (deterministic: orders, provider
routing, governance, budget, ledger) → Worker (Agent SDK = Claude Code in a folder). AI decides;
the engine acts and governs.

**Tech Stack:** Bun + TypeScript · `@anthropic-ai/claude-agent-sdk` · grammy (Telegram) ·
bun:sqlite (ledger) · MCP (worker→engine callback channel).

**Decision (locked):** New project (not an evolution of operant). Port the proven, model-agnostic
modules from `/home/operant`; drop its tmux/shim/socket/scraper spine. See `CLAUDE.md` → "Why these
decisions."

---

## Global Constraints (copied into every task's context)

- **PROVIDER FIREWALL (compliance, enforced in engine code — never a prompt):**
  - **Subscription (Agent SDK)** → only Neo's own work. It draws from your normal Claude
    subscription usage limits today; the monthly-credit change is **paused** — build **no** credit
    accounting (YAGNI). Provider choice stays in `config` so a future plan change is a flip.
  - **Gemini** → all customer-direct interaction. The router must **refuse in code** to route
    `source: "customer"` to the subscription. Never offer customers a Claude login.
- **BUDGET GUARD:** background SDK work shares your subscription pool — reserve interactive headroom
  (`subscriptionInteractiveReservePct`); never drain the plan you use yourself.
- **APPROVAL GATE:** irreversible/external actions escalate to Neo before running.
- **Secrets** in `.env` (gitignored, `chmod 600`); runtime data under `company/` gitignored.
- `bun test` + `bunx tsc --noEmit` GREEN before any task is "done." Commit per logical piece.

## Port / build / drop (from operant)

| Disposition | Modules | Why |
|---|---|---|
| **Port (trim)** | `store.ts`→`ledger.ts`, `finance.ts`, `frontends/telegram.ts`, `config.ts` pattern, `autopilot-risk` keywords | Proven, model-agnostic. |
| **Build fresh** | `engine/session-runner.ts` (SDK), `provider-router.ts`, `governor.ts`, `orders.ts`, `budget.ts` | The new SDK execution core + firewall. |
| **Drop** | `screen-manager.ts`, `shim.ts`, `socket-server.ts`, `autopilot.ts`, `autopilot-parser.ts` | Existed only to puppet the interactive CLI. |

## File structure (scaffolded)

```
src/
  daemon.ts                 # entry — wires Telegram + engine (Phase 1)
  config.ts                 # .env + config.json loader            [REAL]
  types.ts                  # Order, Provider, RouteResult, Verdict, SessionInfo [REAL]
  engine/
    orders.ts               # text -> Order                        [stub]
    provider-router.ts      # COMPLIANCE FIREWALL: Order -> Provider [stub]
    session-runner.ts       # Agent SDK execution core              [stub, SDK surface documented]
    governor.ts             # canUseTool policy                     [stub, risk keywords seeded]
    budget.ts               # interactive-headroom reserve          [stub]
    registry.ts             # live worker sessions                  [partial]
    ledger.ts               # SQLite order/outcome record           [stub]
  frontends/
    telegram.ts             # grammy bot                            [stub]
tests/
  smoke.test.ts             # config defaults encode the firewall   [REAL]
```

---

## Phase 0 — Scaffold + verify the SDK  *(scaffold DONE)*

- [x] git init, `package.json`/`tsconfig`/`bunfig`/`.gitignore`/`.env.example`, dirs.
- [x] Typed module stubs + real `config.ts`/`types.ts` + runnable `daemon.ts` banner + smoke test.
- [x] `bun install` — Agent SDK `0.3.183`, grammy `1.44.0`, `@types/bun`, `typescript`.
- [x] `bunx tsc --noEmit` + `bun test` green; `bun run src/daemon.ts` banner runs.
- [x] **Live spike (passed)** — `query()` ran headless against a scratch folder: `canUseTool` fired,
      `Bash` denied, `hello.txt` written, the folder's `CLAUDE.md` loaded and honored (MARKER.txt),
      messages streamed as structured objects, `result` subtype `success`. Findings in
      `docs/sdk-notes.md` (key gotcha: the `allow` decision MUST echo `updatedInput`). Spike deleted.

**Phase 0 complete — Phase 1 builds on `docs/sdk-notes.md`.**

## Phase 1 — Walking skeleton: order → open project → govern → stream back  *(the MVP — DONE ✅)*

**Status: complete.** All 8 tasks implemented TDD (`bun test` green, `tsc` clean). Verified
end-to-end with a real SDK run: `/open <folder> <task>` → parse → route (firewall) → headless
Claude worker opened the folder → governed via `canUseTool` → wrote the file → outcome recorded.
The frontend-agnostic pipeline lives in `engine/pipeline.ts`; Telegram is thin grammy glue.

Eight TDD tasks (each: failing test → minimal code → green → commit):

1. **`orders.parseOrder`** — `"/open <folder> <task>"` → `Order`; reject missing/nonexistent folder.
2. **`provider-router.route`** — `source:"neo"`→`{provider:"subscription"}`; `source:"customer"`→
   `{refuse}`. Assert the firewall refusal in a test.
3. **`governor.decide`** — auto-allow `SAFE_TOOLS`; escalate `Bash` matching `RISKY_BASH`; test each
   branch.
4. **`budget.createMeter`** — under reserve → no throttle; over → throttle.
5. **`session-runner.runOrder`** — opens `order.folder` via the SDK, wires `canUseTool →
   governor.decide` (escalations bubble to `onEscalation` and block until answered), streams to
   `onMessage`, returns result. TDD with `query()` mocked.
6. **`ledger`** — `recordOrder` / `recordOutcome` / `listRecent` over bun:sqlite.
7. **`frontends/telegram`** — `/open` → parse → route → run; stream back; escalations as Allow/Deny
   inline buttons that resolve the blocked `onEscalation`.
8. **`daemon`** — wire it all; `bun run src/daemon.ts` serves the bot.

**Verification (real scratch project):** from Telegram, `/open /home/neo/scratch "add add(a,b) to
math.ts and a test"` → progress streams in → safe edits auto-approve → a `Bash` test-run escalates
→ tap Allow → tests run → outcome recorded. No tmux, no terminal, no `cd`.

## Phase 2 — Live follow-ups + resume + full budget  *(DONE ✅)*

**Status: complete** (`bun test` green — 58 tests, `tsc` clean). Built TDD in 8 tasks, one commit each,
then verified end-to-end against the **real** SDK (build-then-verify), which surfaced + fixed two
shaping bugs (see `docs/sdk-notes.md` → Phase 2):

- **T2.1 registry** — concurrent live sessions keyed by order id, addressable by name + chat.
- **T2.2 budget** — rolling-window meter + `spent`/`remaining` for `/status`.
- **T2.3 session-runner** — `startOrder`: streaming input channel + `followUp`/`interrupt` handle.
- **T2.4 session-runner** — `resume` option + `onCost` callback.
- **T2.5 ledger** — persist + look up the SDK session id (resume target).
- **T2.6 idle watchdog** — `sweepIdle` closes stale sessions, persists their id; registry holds control handles.
- **T2.7 pipeline** — `handleMessage`: follow-up routing · resume · budget gate · register + supervise.
- **T2.8 commands + daemon** — `/status` + `/kill`; daemon owns the shared registry + meter + idle sweep.

**Verified (real SDK run):** a live `/open` worker created a file; a follow-up pushed into the
*running* session created a second file; `interrupt()` resolved cleanly; `resume` continued the same
session and recalled its prior work. Firewall assertion preserved (customer → never the subscription).

## Phase 3 — Operator web console  *(DONE ✅ — reprioritized)*

**Status: complete** (`bun test` green — 82 tests, `tsc` clean; live-verified over the real domain).
Reprioritized from the Gemini customer path to a **second operator frontend**: a web console at
`neo.example.com` where Neo talks to the engine exactly like Telegram (`source:"neo"` → Agent
SDK on the subscription). The engine is unchanged — the web frontend is thin glue over the existing
`handleMessage`, sharing the registry/meter/ledger/admin with Telegram. Built TDD in 7 tasks:

- **T3.1 admin** — trust-on-first-use: the first Telegram id to message claims admin; only that id
  acts on both the bot and the web login.
- **T3.2 telegram-auth** — verify the Telegram Login Widget hash (key `SHA256(bot_token)`) + freshness.
- **T3.3 web-session** — stateless HMAC-signed session cookies.
- **T3.4 web-channel** — adapter driving `handleMessage` from the web, streaming worker output +
  escalations as events (SSE), resolving Allow/Deny out-of-band.
- **T3.5 frontends/web** — `Bun.serve` app (login/console UI); auth + routing unit-tested via `fetch`.
- **T3.6 daemon** — Telegram gate swapped to the TOFU admin; daemon owns admin + web session stores,
  resolves the bot @username, serves the console on the configured `WEB_HOST:WEB_PORT` (default `127.0.0.1:3003`).
- **T3.7 reverse proxy** — front the console with your own TLS proxy (e.g. Traefik) → `PUBLIC_URL` (e.g. `neo.example.com`).
  Live-verified: HTTPS 200 + valid cert + login page over the real domain.

## Loop runtime — trigger → action → goal  *(DONE ✅ — the autonomy backbone)*

**Status: complete** (`bun test` green, `tsc` clean). The company-engine autonomy from `docs/loops.md`
is now engine-native: autonomous loops run through the **same governed worker** (firewall + approval
gate + budget every iteration; escalations auto-deny, so loops never push/deploy). Built TDD per the
plan (`docs/superpowers/plans/2026-06-26-loop-runtime.md`; design
`docs/superpowers/specs/2026-06-26-loop-runtime-design.md`):

- **`goal.ts`** — `Goal` union: verifiable command (deterministic check) + LLM-judge (read-only
  worker via `disallowedTools`); `makeGoalCheck` resolves either to a `met` boolean.
- **`trigger.ts`** — `Trigger` union (manual / interval / cron) + a dependency-free 5-field cron
  matcher (`isDue`).
- **`loop-runner.ts` / `project-loop.ts`** — iterate the worker toward the goal under `Bounds`
  (`maxIterations` + `budgetUsd`); stop on goal-met, bound, or throttle, with `spentUsd` accounting.
- **`scheduler.ts`** — deterministic tick: fire a loop only when **due + enabled + a free slot +
  unthrottled**. `LoopStateStore` (ledger) persists each loop's `enabled` + `lastRun`.
- **`loops.ts`** — a code-defined loop library (`gold-gofmt`, `green`, `error-sweep`, `docs-sweep`,
  `inbox-delete`) + the `/loop` command (list · run-now · `on|off` a schedule).
- **`daemon.ts`** — runs the scheduler tick every 60s (`NEO_LOOP_SCHEDULER`, default on), wiring the
  ledger as the state store and the meter as the throttle, and streaming each scheduled fire's worker
  text to the operator's Telegram chat (`startScheduledLoop` → `sendOperatorLine`, `#project`-tagged;
  silent when a fire emits nothing; falls back to daemon stdout with no admin/token).

**Next (spec'd, not built):** data-driven loop CRUD — loop *definitions* become data authored from the
admin console (built-ins ∪ custom, read fresh each tick, no restart):
`docs/superpowers/specs/2026-06-27-loop-crud-design.md`.

## Phase 3b — Customer path (Gemini)  *(deferred — own sub-plan)*
One customer channel (email webhook or web form) → Gemini reads → `Order(source:"customer")` →
engine executes via trusted code. Prove customer work never touches the subscription. The firewall
already refuses `customer` → subscription; this builds the Gemini path behind it.

## Phase 4 — Port the rest  *(own sub-plan)*
Web dashboard, finance/reminders, multi-project board — onto the SDK core.

---

## Self-Review
- Phase 0 scaffolds + de-risks the SDK; Phase 1 is the full order→open→govern→stream MVP; the
  firewall + budget + approval gate are first-class from Phase 1; Gemini lands in Phase 3.
- `session-runner` is deliberately a stub until the Phase 0 spike records the SDK's real behavior in
  `docs/sdk-notes.md` — no fabricated SDK code.
