# WIP — resume after engine reload (2026-09-13)

**Branch:** `fix/interactive-turns-bypass-budget-throttle` (off `fix/dispatch-stall-background-wait`,
unpushed). The only uncommitted change is the Agent SDK pin in `package.json` + `bun.lock` — leave
that alone until the operator decides (see the next section).

## State: GREEN (checked 2026-09-20)
- `bunx tsc --noEmit` — clean
- `bun test` — 818 pass, 0 fail.
- Latest work: one activity clock and one derived session state (see HISTORY + `docs/adr/0003`).

## Uncommitted — the Agent SDK is pinned, not floating
- **What:** `@anthropic-ai/claude-agent-sdk` moves from `latest` to the exact `0.3.270` in
  `package.json` + `bun.lock`, so two installs of the same commit get the same worker binary.
- **Why it is still uncommitted:** it is a dependency change, not part of this branch's fix. Commit
  it as its own piece, or drop it.
- **After a bump:** restart the daemon. A worker reads its SDK binary at launch, so a pinned version
  reaches no running worker.
- Docs record it: `docs/sdk-notes.md` (header), `docs/HISTORY.md`, `README.md`.

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

## WIP 2026-10-04 — toolchain auto-updater (branch feat/auto-update, worktree /home/neo-wt-auto-update)
Built + tested (28 tests green: tests/updater.test.ts, tests/update-sys.test.ts): ADR-0009, CONTEXT.md terms,
src/engine/updater.ts (orchestrator: due/run/rollback/status, ledger `update_*` events, one report per run),
update-sdk.ts (branch+worktree bump, tsc+test gate, ff master, model ids), update-plugins.ts (claude plugin
update + validate/details verify + registry-entry rollback), update-mcp.ts (classify every server; npm-global,
docker, codebase-memory apply + MCP probe + rollback), update-sys.ts (real port + MCP stdio probe).
LEFT: (1) `updates` config block in src/config.ts + docs/CONFIG.md; (2) `/updates` command (status · run ·
apply <item> · rollback <item>) in commands.ts, wired via CommandDeps like `todo`; (3) daemon: createUpdater
with realUpdateSys, builtins (playwright-mcp, cfg.codebaseMemoryBin), busy = any registry session running,
report = alertOperator, tick: `if (updater.due(now)) void updater.run({trigger:"schedule"})`;
(4) docs/loops.md note (deterministic job, not a loop — ADR-0009); (5) tsc + full bun test, merge to master;
(6) first run, report results. Do NOT restart the daemon.
Inventory found 2026-10-04: SDK 0.3.286 → 0.3.289 (no breaking notes); codebase-memory 0.8.1 → v0.11.0
(BREAKING: index rebuild — will be held); @playwright/mcp global 0.0.80 → 0.0.83; context7 pin 3.2.4 → 4.1.1
in /home/waselni/.mcp.json (report-only); agent-orchestration plugin already moved 1.2.1 → 1.2.2 by a probe.
`@openai/codex-sdk` floats on "latest" in package.json (not pinned).
