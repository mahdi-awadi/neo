# WIP — resume after engine reload (2026-09-10)

**Branch:** `feat/mattpocock-domain-design-skills` (43 commits ahead of `master`, unpushed, working tree clean)

## State: GREEN
- `bunx tsc --noEmit` — clean
- `bun test` — 751 pass, 0 fail.
- Latest commit `b69dc01` feat(dispatch): wire the two-phase design→build flow into the worker
  preamble — the last piece on top of the structured-questions + matured-decisions work this branch
  carries.

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
