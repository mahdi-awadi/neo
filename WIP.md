# WIP — resume after engine reload (2026-09-03)

**Branch:** `feat/structured-questions-and-styled-messages` (37 commits ahead of `master`, unpushed, working tree clean)

## State: GREEN
- `bunx tsc --noEmit` — clean
- `bun test` — 741 pass, 0 fail
- Last commit `7bbab20` test(config): isolate DECISIONS_CHAT_ID env in the default-case assertion.
  (The one failing test was a test-isolation bug — ambient `DECISIONS_CHAT_ID` broke the
  "undefined by default" assertion; now wrapped in `withEnv(undefined)`.)

## What this branch delivers (built + committed; the in-progress restart activates it)
- Structured-question Telegram keyboards (tap/submit/other) + governor servicing native AskUserQuestion.
- Deterministic message-priority model; job RESULTS → Decisions group, progress stays in the DM.
- `answerDecision` homes to the decision's original DM chat, not the answering group.
- Workers challenge themselves (root-cause + industry fix + self-critique) before raising a decision (`e401c7b`).
- `decisionsChatId` config knob (env `DECISIONS_CHAT_ID` wins).

## Next steps on resume
1. Confirm the daemon came back healthy after the reload (systemctl status / logs).
2. PLANNED, not started: **adversarial reviewer-gate** — engine spawns a separate critic before any
   decision/question reaches the operator (fresh, AI-free gate at the engine layer). See memory
   `workers-challenge-self-before-raising-decision.md`.
3. Consider merging this branch → `master` once the operator confirms it behaves live.
