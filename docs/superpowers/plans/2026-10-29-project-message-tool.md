# `project_message` tool — plan

Spec: `docs/superpowers/specs/2026-10-29-project-message-tool-design.md` (ADR-0061). Builds on ADR-0060
(branch `fix/limit-wait-resume`). No migration, no new store. TDD; tsc + bun test green per commit.

- [x] 1. Extract `deliverToSession` from `handleMessage` branch 1 (behaviour unchanged; existing tests green).
- [x] 2. `projectMessage` dep in the pipeline: checks (text, session, own-work, rate limit), delivery, the
   `project_message` event, the `agent_message` line (cause = the company turn's), the Telegram line.
   Config `projectMessage.{maxChars,perProjectPerHour}`. Ingress strips the dep.
- [x] 3. The `project_message` tool on the company session; description says when (and when not) to use it.
- [x] 4. Console label `threads.agentTo` (EN + AR) for `agent_message` lines.
- [x] 5. Docs: tool card, ADR-0061, CONTEXT, CONFIG, HISTORY, HANDOFF, `agent/CLAUDE.md` guidance.
- [x] 6. Full suite, independent review, commit on dev.
