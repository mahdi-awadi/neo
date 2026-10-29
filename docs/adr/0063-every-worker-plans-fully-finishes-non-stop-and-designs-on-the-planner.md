# Every worker plans fully, finishes non-stop, and designs on the planner model

**Status:** accepted (2026-10-29; built on dev, restart-gated). Related: ADR-0005 (pinned models),
ADR-0004 (loop prompts are standing briefs; amended here), ADR-0049 (decision cards), ADR-0055 (stay alive).

## Context

Operator order 2026-10-29 (very important): every worker in every project must (1) plan fully, then finish
non-stop, stopping only for a real operator decision or a hard blocker; (2) write rich, ambitious plans and
think deeply when designing; (3) plan, design and review on the strongest model at the highest effort, from
config; (4) write production-grade, well-tested code; (5) pick the best technology, not the easy path, and
record it in an ADR.

## Decision

1. **One text, every brief.** The rule sentences live in `standing-rules.ts`. The dispatch preamble folds
   them into its sections, so every dispatch, todo run and plan execution gets them: the plan rule in DESIGN,
   the finish rule in BUILD, quality and technology in the engineering baseline (items 4 and 6), and the stop
   clause in "challenge yourself" (one list of what the operator decides, not two). A loop iteration's brief
   starts with them (ADR-0004 amended: the engine adds the rules and still never rewrites the loop's prompt).
   A consult run (read-only) answers by the quality and technology rules.
2. **A `planner` subagent, not a second launch.** Every `dispatch`, `project` and `loop` run gets the SDK
   subagent `planner` (`AgentDefinition` takes `model` and `effort`), from config `planner` (default the
   `opus` tier, pinned to its id through `models.aliases`, at effort `max`, the SDK's deepest). The preamble
   hands it the DESIGN phase and the final review; the main run builds on its own model. Not on Codex (no
   agents), the company, consult, judge or ingress.
3. **The preamble stays under its 5000-character ceiling** (with a long codebase-memory line): the rules were
   merged and the wording tightened, not appended.

## Alternatives rejected

- **The whole dispatch run at max effort.** Every build turn would pay the deepest reasoning budget; the order
  asks for it in planning, design and review.
- **A separate engine "plan run" before each dispatch.** The engine cannot tell a design step from a build step
  inside a task, and a second session loses the worker's context; the subagent runs inside the same task.
- **Fable as the default planner model.** On the subscription Fable needs usage credits and the engine budgets
  it like Sonnet (docs/sdk-notes.md); Opus is the strongest model the plan runs without credits. Config can
  choose Fable.
- **The model alias `opusplan`.** It switches by permission mode (plan mode), which dispatched workers do not use.

## Consequences

- Planning and review cost more per task (max effort on Opus); config `planner` turns it down.
- Restart-gated: the preamble and the subagent reach workers started by the new daemon.
