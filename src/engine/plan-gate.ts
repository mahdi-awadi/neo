/** Plan approval gate (ADR-0036): a big plan waits for the operator's Approve & build before any
 *  implementation; a small one is sent for information while the worker goes on. "Big" is decided
 *  from the file alone, by config counts and patterns — no AI. */
import { gatedStep, planSteps } from "./plan-execute";
import type { PlansCfg } from "./plans";

export interface PlanSize {
  big: boolean;
  /** Why it is big, for the card and the worker: `marked approval: required`, `7 tasks (over 4)`,
   *  `32 steps (over 20)`, `touches: migration, wallet`. Empty when small. */
  reasons: string[];
}

/** `---` front matter at the very top, else "". */
function frontMatter(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  return m ? m[1]! : "";
}

/** Big or small (ADR-0036 §1). Front matter `approval: required` makes it big; nothing makes it
 *  small. Tasks are `## Task`/`### Task` headings; steps are checkboxes. The patterns are tried on
 *  every line outside the front matter and code fences, except operator-gated steps. */
export function classifyPlan(md: string, cfg: Pick<PlansCfg, "approval" | "gatedStepPatterns">): PlanSize {
  const reasons: string[] = [];
  const fm = frontMatter(md);
  if (/^approval:\s*["']?required["']?\s*$/im.test(fm)) reasons.push("marked approval: required");
  const body = md.slice(fm ? md.indexOf("\n---", 3) + 4 : 0);
  const lines: string[] = [];
  let fenced = false;
  let tasks = 0;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{2,4}\s+Task\b/i.test(line)) tasks++;
    const step = /^\s*[-*+]\s+\[[ xX]\]\s*(.*)$/.exec(line);
    if (step && gatedStep(step[1]!, cfg)) continue;
    lines.push(line);
  }
  const { maxTasks, maxSteps, patterns } = cfg.approval;
  if (tasks > maxTasks) reasons.push(`${tasks} tasks (over ${maxTasks})`);
  const steps = planSteps(body).length;
  if (steps > maxSteps) reasons.push(`${steps} steps (over ${maxSteps})`);
  const touched = new Set<string>();
  const text = lines.join("\n");
  for (const p of patterns) for (const m of text.matchAll(new RegExp(p, "gi"))) touched.add(m[0].toLowerCase());
  if (touched.size) reasons.push(`touches: ${[...touched].slice(0, 4).join(", ")}`);
  return { big: reasons.length > 0, reasons };
}
