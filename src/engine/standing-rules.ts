// The standing rules every worker gets, in every project (operator, 2026-10-29, ADR-0063). One text: the
// dispatch preamble folds them into its sections, a loop iteration's brief starts with them, a consult run
// answers by the quality and technology rules, and the `planner` subagent is told the plan rule. A leaf
// module (no imports), so every brief builder can use it.

/** Rule 1: plan fully, then finish non-stop; stop only for a real operator decision or a hard blocker. */
export const FINISH_RULE =
  "Then execute the plan to the end, non-stop, in committed checkpoints: never stop halfway or end a turn with work you could still do.";

/** Rule 6 (operator, 2026-10-30, ADR-0069): every push starts paid CI/CD runs. The governor enforces it too:
 *  a `git push` is an operator-only escalation that trust never lifts. */
export const PUSH_RULE =
  "Commit locally in checkpoints. Do NOT `git push` during the task. Push once, only when the whole task is complete, and only after asking the operator (ask_operator).";

/** The same rule for a loop iteration: it cannot ask the operator, and Neo denies its escalations. */
export const LOOP_PUSH_RULE = "Commit locally; never `git push` (a push needs the operator, and a loop cannot ask).";

/** Rules 2 and 3: rich, ambitious plans, made (and reviewed) with the strongest model at the highest effort. */
export const PLAN_RULE =
  "Plans are complete and ambitious, never the minimum: the whole goal, every feature the domain needs, edge cases, UX, tests and ops.";

/** Rule 4: high-standard code always (it joins the engineering baseline). */
export const QUALITY_RULE = "Code is production-grade and well tested.";

/** Rule 5: the best technology, not the easy path, recorded in an ADR. */
export const TECH_RULE =
  "Pick the best technology (a real queue, search or time-series store) for correctness, scale and quality, never the quickest hack; record it and the rejected alternatives in an ADR.";

/** When a worker may stop (merged into "challenge yourself": the same list of what the operator decides). */
export const STOP_RULE = "Stop only for such a decision or a hard blocker, and say what remains.";

/** A loop iteration's brief: the standing rules, then the loop's own standing prompt (ADR-0004 amended by
 *  ADR-0063: the engine adds the rules, it still never rewrites the loop's prompt). */
export function loopBrief(prompt: string): string {
  return `Standing rules (Neo): plan the iteration fully. ${FINISH_RULE} Stop only for a real operator decision or a hard blocker, and say what remains. ${LOOP_PUSH_RULE} ${QUALITY_RULE} ${TECH_RULE}\n\n${prompt}`;
}

/** The `planner` subagent's own instructions (its model and effort come from config `planner`). */
export function plannerPrompt(): string {
  return [
    "You are the planner: the main worker hands you the DESIGN phase (spec, plan) or a final review. Think deeply.",
    "Read the project's rule files and the code first (the codebase-memory map when there is one).",
    PLAN_RULE,
    TECH_RULE,
    "Follow the project's design discipline: CONTEXT.md terms, an ADR per real decision with the rejected alternatives, acceptance criteria and edge cases, one clean seam.",
    "Write a spec or plan under docs/superpowers/specs/ or docs/superpowers/plans/. For a review, check the change against its spec and report findings, most severe first, with file:line.",
    "Return a short summary of what you wrote or found.",
  ].join("\n");
}
