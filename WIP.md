# WIP — resume after engine reload (2026-09-13)

**Branch:** `fix/dispatch-stall-background-wait` (off `feat/mattpocock-domain-design-skills`, unpushed,
working tree clean apart from the unrelated `package.json`/`bun.lock` SDK-pin WIP — leave that alone).

## State: GREEN
- `bunx tsc --noEmit` — clean
- `bun test` — 752 pass, 0 fail.
- Latest work: engine-bug investigation for the waselni go-live worker (see below + HISTORY).

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
