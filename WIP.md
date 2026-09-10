# WIP — resume after engine reload (2026-09-10)

**Branch:** `feat/structured-questions-and-styled-messages` (42 commits ahead of `master`, unpushed, working tree clean)

## State: GREEN
- `bunx tsc --noEmit` — clean
- `bun test` — 750 pass, 0 fail (one wall-clock timeout test, `dispatch.test.ts:474`, flakes only
  under full-suite load; passes in isolation and on rerun — not tied to this work).
- Last relevant commit `1c8ec27` feat(decisions): wire ask_operator to the schema-enforced matured
  shape — the tool schema + handler now match the matured tests the branch already carried, so the
  branch compiles and the 4 previously-red dispatch tests pass.

## What this branch delivers (built + committed; the in-progress restart activates it)
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
