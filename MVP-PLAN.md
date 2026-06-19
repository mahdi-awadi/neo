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

## Phase 1 — Walking skeleton: order → open project → govern → stream back  *(the MVP)*

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

## Phase 2 — Live follow-ups + resume + full budget  *(own sub-plan)*
Follow-up messages into a live session; idle-close + `resume`; full headroom metering; concurrent
sessions; `/status`, `/kill`.

## Phase 3 — Customer path (Gemini)  *(own sub-plan)*
One customer channel (email webhook or web form) → Gemini reads → `Order(source:"customer")` →
engine executes via trusted code. Prove customer work never touches the subscription.

## Phase 4 — Port the rest  *(own sub-plan)*
Web dashboard, finance/reminders, multi-project board — onto the SDK core.

---

## Self-Review
- Phase 0 scaffolds + de-risks the SDK; Phase 1 is the full order→open→govern→stream MVP; the
  firewall + budget + approval gate are first-class from Phase 1; Gemini lands in Phase 3.
- `session-runner` is deliberately a stub until the Phase 0 spike records the SDK's real behavior in
  `docs/sdk-notes.md` — no fabricated SDK code.
