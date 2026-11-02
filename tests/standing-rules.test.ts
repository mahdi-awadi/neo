// The standing rules every worker gets (operator, 2026-10-29, ADR-0063): plan fully then finish non-stop,
// rich plans made with the `planner` subagent (the strongest model at the highest effort), production-grade
// code, the best technology with an ADR. One text, used by every brief the engine builds.
import { expect, test } from "bun:test";
import { briefWithProjectDocs, codebaseMemoryLine } from "../src/engine/dispatch";
import { consultPrompt } from "../src/engine/consult";
import { FINISH_RULE, LOOP_PUSH_RULE, PLAN_RULE, PUSH_RULE, QUALITY_RULE, TECH_RULE, loopBrief } from "../src/engine/standing-rules";
import { profileDeps } from "../src/engine/worker-profile";
import { DEFAULT_MODELS, DEFAULT_PLANNER } from "../src/config";

const cfg = (over: Record<string, unknown> = {}) => ({ workers: {} as never, workerEnv: {}, models: DEFAULT_MODELS, ...over });

test("the dispatch preamble carries all five standing rules once, merged into its sections", () => {
  const pre = briefWithProjectDocs("TASK");
  for (const rule of [FINISH_RULE, PLAN_RULE, QUALITY_RULE, TECH_RULE]) {
    expect(pre).toContain(rule);
    expect(pre.split(rule).length).toBe(2); // exactly once
  }
  expect(pre).toContain("`planner` subagent");
  expect(pre).toContain("ADR");
  // The plan rule sits in DESIGN, before BUILD; the finish rule in BUILD.
  expect(pre.indexOf(PLAN_RULE)).toBeLessThan(pre.indexOf("  BUILD —"));
  expect(pre.indexOf(FINISH_RULE)).toBeGreaterThan(pre.indexOf("  BUILD —"));
  // The stop clause is merged into "challenge yourself", not a second list of what the operator decides.
  expect(pre.match(/product\/UX policy/g)?.length).toBe(1);
  expect(pre.endsWith("TASK")).toBe(true);
});

// ADR-0069 (operator, 2026-10-30): every push starts paid CI/CD runs.
test("the dispatch preamble carries the push rule once, in BUILD, beside the checkpoint rule", () => {
  const pre = briefWithProjectDocs("TASK");
  expect(PUSH_RULE).toBe(
    "Commit locally in checkpoints. Do NOT `git push` during the task. Push once, only when the whole task is complete, and only after asking the operator (ask_operator).",
  );
  expect(pre.split(PUSH_RULE).length).toBe(2);
  expect(pre.indexOf(PUSH_RULE)).toBeGreaterThan(pre.indexOf("  BUILD —"));
  expect(pre.indexOf(PUSH_RULE)).toBeLessThan(pre.indexOf("REQUIRED — engineering baseline"));
});

test("a loop iteration is told it never pushes (a loop cannot ask the operator)", () => {
  expect(loopBrief("x")).toContain(LOOP_PUSH_RULE);
  expect(LOOP_PUSH_RULE).toContain("never `git push`");
});

test("the preamble stays under the ceiling with a long codebase-memory line", () => {
  const pre = briefWithProjectDocs("");
  // 5000 (ADR-0063), plus the operator's push rule verbatim (ADR-0069).
  expect((codebaseMemoryLine({ project: "home-" + "x".repeat(80) }) + "\n\n" + pre).length).toBeLessThan(5350) /* + the report rule (ADR-0073) */;
});

test("a loop iteration's brief starts with the standing rules, then the loop's own prompt", () => {
  const b = loopBrief("Run the nightly sweep.");
  for (const rule of [FINISH_RULE, QUALITY_RULE, TECH_RULE]) expect(b).toContain(rule);
  expect(b.endsWith("Run the nightly sweep.")).toBe(true);
});

test("a consult answer follows the quality and technology rules (it never acts, so no plan rule)", () => {
  const p = consultPrompt({ asker: "gold", need: "know", question: "which queue?", matches: [], answerMaxChars: 2000 } as never);
  expect(p).toContain(QUALITY_RULE);
  expect(p).toContain(TECH_RULE);
  expect(p).not.toContain(FINISH_RULE);
});

test("dispatch, project and loop runs get the planner subagent: the planning model, pinned, at the planning effort", () => {
  for (const path of ["dispatch", "project", "loop"] as const) {
    const d = profileDeps(cfg(), path);
    const planner = (d.agents as Record<string, { model?: string; effort?: string; description: string; prompt: string }>).planner!;
    expect(planner.model).toBe(DEFAULT_MODELS.aliases[DEFAULT_PLANNER.model]); // a pinned id, never a bare alias (ADR-0005)
    expect(planner.effort).toBe(DEFAULT_PLANNER.effort);
    expect(planner.description.length).toBeGreaterThan(20);
    expect(planner.prompt).toContain(PLAN_RULE);
  }
  expect(DEFAULT_PLANNER).toEqual({ model: "opus", effort: "max" });
});

test("config picks the planner's model and effort; other agents stay; never on company, consult, judge or Codex", () => {
  const d = profileDeps(cfg({ planner: { model: "fable", effort: "xhigh" } }), "dispatch", { agents: { lead: { description: "d", prompt: "p" } } as never });
  const agents = d.agents as Record<string, { model?: string; effort?: string }>;
  expect(agents.lead).toBeDefined();
  expect(agents.planner).toMatchObject({ model: DEFAULT_MODELS.aliases.fable, effort: "xhigh" });
  for (const path of ["company", "consult", "judge", "ingress"] as const) expect((profileDeps(cfg(), path).agents as Record<string, unknown> | undefined)?.planner).toBeUndefined();
  expect(profileDeps(cfg({ providers: { ownWork: "codex", customerWork: "gemini" } }), "dispatch").agents).toBeUndefined();
});
