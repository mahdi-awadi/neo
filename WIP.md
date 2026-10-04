# WIP — resume after engine reload (2026-09-30)

**Branch:** `fix/interactive-turns-bypass-budget-throttle` (off `fix/dispatch-stall-background-wait`,
unpushed). The only uncommitted change is the Agent SDK pin in `package.json` + `bun.lock` — leave
that alone until the operator decides (see the next section).

## State: GREEN (checked 2026-09-20)
- `bunx tsc --noEmit` — clean
- `bun test` — 818 pass, 0 fail.
- Latest work: a loop can be authored from the CLI, and `waselni-store-readiness` is live (see
  HISTORY + `docs/adr/0004`). Before that: one activity clock and one derived session state
  (`docs/adr/0003`).

## Uncommitted — the Agent SDK is pinned, not floating
- **What:** `@anthropic-ai/claude-agent-sdk` moves from `latest` to the exact `0.3.270` in
  `package.json` + `bun.lock`, so two installs of the same commit get the same worker binary.
- **Why it is still uncommitted:** it is a dependency change, not part of this branch's fix. Commit
  it as its own piece, or drop it.
- **After a bump:** restart the daemon. A worker reads its SDK binary at launch, so a pinned version
  reaches no running worker.
- Docs record it: `docs/sdk-notes.md` (header), `docs/HISTORY.md`, `README.md`.

## Latest change — a loop can be authored from the CLI, and the first project loop is live
- **Why:** loop definitions are data, but the only door was `/api/loop/*`, which is
  admin-session-gated — an agent in this repo could not author a loop without hand-written SQL.
- **Seam:** `tools/create-loop.ts` — `validateLoopInput` → `createLoop` → ledger `loop_defs`, the same
  path the web console uses, so the `/home` folder fence and every validation rule apply identically.
  `promptFile` keeps a long brief in reviewable markdown. Also: `LEDGER_PATH` now lives in
  `ledger.ts`; `tools/` is in `tsconfig.json`'s `include`.
- **No restart needed** for a loop written this way — `effectiveLoops()` re-reads `loop_defs` each
  scheduler tick. `waselni-store-readiness` (daily `0 6 * * *`, `/home/waselni`, judge goal, 30
  iterations, $12 per fire, `freshSession`) is live in `data/ledger.db` and enabled.
- **A loop prompt is a standing brief** (ADR `docs/adr/0004`): `runProjectLoop` hands
  `LoopDef.prompt` to the worker verbatim, so there is no preamble and no `ask_operator`. The prompt
  carries the engineering baseline, the project's rules and the governance envelope itself. Rejected:
  wiring `neoMcpServers` + `briefWithProjectDocs` into the loop path — better long-term, but an engine
  change that also re-prices every built-in loop.
- **Two engine gaps this leaves open, both restart-gated and neither fixed:** loop workers have no
  `ask_operator` (a blocked item leaves only as reply text), and `runLoop` sums only `iterate()`'s
  `costUsd` (`loop-runner.ts:54`), never the judge run between iterations — so real spend is
  ≈ `budgetUsd` plus one judge run per iteration, and `Bounds.budgetUsd`'s "incl. judge runs" comment
  (`project-loop.ts:16`) is wrong. Minor: `judgeGoal` accepts `timeoutMs` and never reads it.
- TDD: 8 in `tests/create-loop-tool.test.ts` (validated path · folder fence writes nothing ·
  `--update` · `promptFile` · unreadable input reported, never thrown).

## Latest fix — work class follows the ORIGINATING TRIGGER, so a conversational order is never held
- **Why:** ADR 0001 put the budget gate on the right side (background work) but classified by
  *mechanism* — "a dispatch is background". `dispatchToProject` has one caller, the company's
  `dispatch` tool, one hop from the operator's message, so at a $16 allowance vs $10–35 real
  dispatches nearly every conversational order would have been held. Operator's call: classify by
  what TRIGGERED the work.
- **Rule:** `handleMessage` (the operator's only entry point) launches `interactive` workers; the
  `dispatch` tool inherits the class of the worker calling it, and a sub-worker inherits it again.
  `background` = loop fires, cron/automations, secretary, dream sweep, customer-brief ingress runs.
  Decided once per launch (`pipeline.ts:297,320` interactive · `ingress.ts:78` background), captured
  in the tool's closure — never re-derived at a call site.
- **Seam:** `heldByReserve(workClass, meter)` in `budget.ts` is the ONE answer to "does the reserve
  apply?" (used by the dispatch gate *and* the sub-run's API-retry gate), plus
  `DEFAULT_WORK_CLASS = "background"` — unclassified work can only over-protect, never silently
  disable the guard.
- Dispatch events now carry `workClass`, so `dispatch_end`'s `costUsd` splits interactive vs
  background spend with no new accounting.
- TDD: 4 in `budget.test.ts`, 4 in `dispatch.test.ts` (interactive starts at the same usage that
  holds a background one · fail-safe default · events carry the class · the tool inherits its
  session's class, proven through the real MCP handler). ADR 0001 amended; `CONTEXT.md`,
  `docs/CONFIG.md`, `README.md` updated.
- **Restart pending** (operator-gated): the running daemon still classifies every dispatch as
  background.

## Latest fix — the interactive reserve was throttling the operator instead of background work
- **Symptom:** `/open /home/waselni say hi back` (2026-09-13 16:50 UTC) → `throttled: protecting
  interactive headroom`. **Root cause:** `handleMessage` gated the operator's own turn on
  `meter.shouldThrottle()` (`pipeline.ts:263`), the same class-blind predicate background work uses.
  The 5 h window held $42.39 of dispatch spend against a $16 background allowance — all of it
  background. Mirror-image half: `dispatchToProject` never checked the meter at all.
- **Fix:** work class is now explicit. `Meter.shouldThrottle` → **`shouldThrottleBackground`**; the
  interactive gate is deleted; the gate is added to `dispatchToProject` (`dispatch_refused` /
  `reason: "budget"`); the interactive retry no longer passes `throttled`. A genuinely rejected
  rate-limit window now *warns* the operator with the real reset time and starts anyway.
- New: `CONTEXT.md` (glossary) + `docs/adr/0001-interactive-reserve-gates-background-work-only.md`
  (the repo's first ADR). `docs/CONFIG.md` + `README.md` updated for the sharper knob semantics.
- Also: `UsageMeter.rateLimits()` — a cheap in-memory read of the live windows, so the interactive
  gate never triggers `snapshot()`'s walk of every transcript under `~/.claude/projects`.
- Review pass also fixed: warning moved to the top of `handleMessage` (plain-text follow-ups never
  reached it), default priority not `"alert"` (would flood the Decisions group for hours), dropped a
  false "background work is held" claim, dispatch gate moved after `resolveProject` (a typo'd project
  was reporting a budget hold), and an honest `budgetHoldMessage` with real numbers. Plus a
  pre-existing bug this exposes: `resolveApiRetryDelayMs` treated `allowed_warning` as governing, so
  a retry could wait out a 7-day window — now only `rejected` governs.
- TDD: failing tests first — 6 in `pipeline.test.ts`, 2 in `dispatch.test.ts` (one is the
  under-the-reserve control), 2 in `api-retry.test.ts`.
- **RESOLVED** — the `budgetWindowUsd` calibration question is closed: the operator chose the ADR's
  follow-up (work class follows the originating trigger), so the `20` default now governs background
  work alone. See the newer section above.
- **Restart pending** (operator-gated): the running daemon still holds the old in-memory meter and
  the old gate, so the operator stays throttle-able until it restarts.

## Latest fix — dispatched workers killed on a background wait; "permission stream" hiccups are SDK-side
- **Permission-stream errors = SDK-side, not ours.** Zero `approval_error` events all-time; waselni is
  trusted so tools auto-approve with no escalation round-trip; `buildCanUseTool` is already
  stateless + fail-safe + self-healing. The worker's own read ("a harness hiccup") was right. SDK
  `0.3.270`; mitigation = fewer/shorter calls per session.
- **Stall abort of a non-hung worker = ours, by contract.** The liveness monitor only sees streamed
  SDK events, so a worker parked on a background wait/Monitor/long `sleep`/`gh run watch` yields
  nothing for >5 min and is killed though not hung. Fix = the dispatch preamble now forbids background
  waits and requires short FOREGROUND polling (<90 s) + finishing within the single-shot run.
  Rejected raising `stallMs` / counting in-flight tools as activity (would blind the hung-worker guard).
- TDD: `dispatch.test.ts` preamble assertion + `approval-resilience.test.ts` 300-repeated-call guard.
- **Restart pending** (operator-gated): the preamble is read at worker launch, so it is inert until then.

## Latest change — the engineering baseline rides in the dispatch preamble, not in the brief
- **Why:** the operator's hard rule (non-standard code = failure; the five items live in `CLAUDE.md`)
  only ever reached a worker when the brief author typed it. A dispatched worker loads the *target*
  folder's `CLAUDE.md`, never Neo's, so the engine is the only place the rule cannot be forgotten.
- **Seam:** `briefWithProjectDocs` (`src/engine/dispatch.ts`) — one block beside the other standing
  instructions. Rejected: per-project `CLAUDE.md` copies (drift; new projects start without it) and a
  governor check (it gates tool calls, not judgments about a finished change). ADR `docs/adr/0002`.
- **Cost:** preamble 3627 → 4311 chars (~1080 tokens per dispatch); a test pins a 5000-char ceiling.
- TDD: 2 in `dispatch.test.ts` (one assertion per baseline item + the size ceiling).
- **Restart pending** (operator-gated): the preamble is read at worker launch, so it is inert until then.

## What this branch delivers (built + committed; the in-progress restart activates it)
- **Two-phase design→build worker flow:** every dispatched brief now steers the worker through DESIGN
  (sharpen the domain model with the model-invocable `domain-modeling` + `codebase-design` skills into
  a `CONTEXT.md` glossary + ADRs, then a spec — one clean seam) then BUILD (superpowers TDD → verify →
  code-review). The interactive-only Matt Pocock skills (grill/to-spec/to-tickets) are NOT told to
  governed workers, which cannot invoke them. See memory `mattpocock-skills-evaluation` (`b69dc01`).
- Structured-question Telegram keyboards (tap/submit/other) + governor servicing native AskUserQuestion.
- Deterministic message-priority model; job RESULTS → Decisions group, progress stays in the DM.
- `answerDecision` homes to the decision's original DM chat, not the answering group.
- Workers challenge themselves (root-cause + industry fix + self-critique) before raising a decision (`e401c7b`).
- **Schema-enforced matured decisions:** one `ask_operator` call = ONE decision carrying title +
  root-cause context + 2–5 options each with a trade-off detail + a recommendation; Zod rejects a
  shapeless or bundled question at the tool boundary. Enriches the existing decisions machinery
  (`spec` column), does not fork it. Design: `docs/superpowers/specs/2026-09-09-matured-decisions-design.md`.
- `decisionsChatId` config knob (env `DECISIONS_CHAT_ID` wins).
- **A loop can be authored from the CLI** (`tools/create-loop.ts`, through the validated path), and
  the first operator-authored project loop — `waselni-store-readiness` — is live and enabled. This
  one item needs **no restart**: `effectiveLoops()` re-reads `loop_defs` every tick.

## Next steps on resume
1. Confirm the daemon came back healthy after the reload (systemctl status / logs).
2. PLANNED, not started: **maturing reviewer / adversarial reviewer-gate** (Layer B in the matured-
   decisions design) — before a decision posts, the engine spawns a fresh worker on the same choke
   point (`raiseOperatorDecision`) that sharpens a shallow ask; the engine still only validates +
   routes (AI stays out of the engine). See memory `workers-challenge-self-before-raising-decision.md`.
3. Consider merging this branch → `master` once the operator confirms it behaves live.

## DONE 2026-10-04 — per-project todo queue (merged to master, restart pending)
Merged `feat/project-todo-queue` → `master` (fast-forward, local only — master is not pushed).
Code-review pass fixed: a run that throws before it has a result left its todo + session `running`
(queue wedged until restart) → dispatch now closes it as failed; `cancel` raced the run's end (registry
reads idle first) → the queue tracks its own live runs; `/todo` accepted `0x2`/`2e0` and ignored extra
words → strict parsing. `agent/CLAUDE.md` already carries the queue rule. tsc clean; 929 tests green.
**Restart pending** (operator-gated): the running daemon has no queue until it restarts.

## DONE 2026-10-04 — toolchain auto-updater (merged to master, restart pending)
`feat/auto-update` fast-forwarded into local `master`. `updates` config block (docs/CONFIG.md), `/updates`
(status · run · apply <item> · rollback <item>) on Telegram + web, daemon heartbeat runs a due update
(24h), a scheduled run reports only what is new, docs/loops.md note. `@openai/codex-sdk` pinned to 0.145.0.
First real run (direct, separate ledger `data/updates-first-run.db` — the live ledger has no busy_timeout):
SDK 0.3.286 → 0.3.289 merged to master behind green tsc + tests · @playwright/mcp 0.0.80 → 0.0.83 applied
+ probed · agent-teams 1.0.2 → 1.0.3, ui-design 1.0.3 → 1.0.5 applied + validated · codebase-memory 0.8.1
→ 0.11.0 HELD (index rebuild) · context7 3.2.4 → 4.1.1 in /home/waselni/.mcp.json report-only.
The run found and fixed two bugs (pretty JSON from `claude plugin list`; bun test summary on stderr).
**Restart pending** (operator-gated): `bun install` in the live checkout, then restart — the daemon has no
updater and workers still load SDK 0.3.286 until then.

## DONE 2026-10-04 — engine error containment (ADR-0010, merged to master, restart pending)
Wired: daemon (safety net, configured fault reporter → log + `engine_fault` + capped alert + company queue,
isolated heartbeat steps with an always-re-armed tick, health timer, startup failure exits 1, busy_timeout
on every store, alerts + loop lines through the 429-aware Api), Telegram (retry transformer, errorBoundary
+ bot.catch, every fire-and-forget send contained, failed approval post → deny, inbox send/draft detached:
the approval deadlock fix), web (route throw → 500 + report; background sends contained), pipeline (run
completion, api-retry follow-up, dispatcher flush contained), manual loop starts (`launchLoop`).
Tests: `tests/fault-injection.test.ts` (10). docs/CONFIG.md section; ADR-0010 amended (deadlock, runner
rejected). Not done: the unbounded web `events[]` the audit noted is out of this scope.
**Restart pending** (operator-gated).

## RESUME HERE (2026-10-04, time limit hit mid-rebase)
- master = 6c3ad92 (flood-control + tool-lines + 207aed4 trust merged; 4b7848c fence ported; ADR-0011). 1001 tests green.
- This branch (9bbfc04) is NOT yet rebased on 6c3ad92: rebase was aborted. Conflicts: CONTEXT.md, trust.ts (keep 207aed4 store + openSqlite busyTimeoutMs), config.test.ts (keep both), daemon.ts (trust opts + busyTimeoutMs; loopReply via operatorApi + toolSteps), telegram.ts (take master's, re-apply wiring; a draft of that is in untracked `.rebased-telegram.ts.wip`).
- Unify 429: drop telegram-retry.ts + telegramMaxRetryAfterS; use master's flood gate (`installFloodGate(api)`, `createOperatorApi(token)`); fix telegram-tool-lines.test sendOperatorLine(api,...).
- Review fixes to apply: cap + digit-normalise company handoff in fault.ts; polling reject → report + exit 1; inbox send in-flight set + re-read draft (in the wip file); tests via grammy `client.fetch` so the flood gate is exercised; contain `void handoff` pipeline.ts.
- Then: tsc + bun test, ff master, switch /home/neo to master (HANDOFF.md there is an auto-written idle note — stash it), bun install, delete merged branches/worktrees (fix/telegram-flood-control, fix/telegram-tool-lines-all-paths, feat/trust-default-new-projects, integrate/flood-trust). No restart.
