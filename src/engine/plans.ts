/** Plan registry (ADR-0019, spec §10): find plan/spec files a run changed, and register each one in
 *  the ledger. Plain code over git and the filesystem — no AI. Sending to the operator comes later. */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Cause, Ledger, PlanRow } from "./ledger";
import { git as defaultGit } from "./dispatch-report";

/** Spec default for config `plans.paths` (Task 2.3 moves it into config defaults). */
export const DEFAULT_PLAN_PATHS: string[] = ["docs/**/plans/**/*.md", "docs/**/specs/**/*.md", "specs/**/*.md", "plans/**/*.md"];

/** One bounded git query in `folder`; undefined on failure. */
export type GitRunner = (folder: string, args: string[]) => string | undefined;

/** Plan files under `globs` (relative to `folder`) changed since `sinceSha` (committed), or modified
 *  or untracked in the working tree. No `sinceSha` → working-tree changes only. `[]` on any failure. */
export function changedPlanFiles(folder: string, sinceSha: string | undefined, globs: string[], git: GitRunner = defaultGit): string[] {
  try {
    const found = new Set<string>();
    if (sinceSha) {
      for (const l of (git(folder, ["diff", "--name-only", `${sinceSha}..HEAD`]) ?? "").split("\n")) if (l.trim()) found.add(l.trim());
    }
    // -z: NUL-separated, no quoting; rename entries carry the old path as a second field.
    const status = git(folder, ["status", "--porcelain", "-z", "--untracked-files=all"]) ?? "";
    const parts = status.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!;
      if (e.length < 4) continue;
      found.add(e.slice(3));
      if (e[0] === "R" || e[0] === "C") i++; // skip the rename source
    }
    const matchers = globs.map((g) => new Bun.Glob(g));
    return [...found].filter((p) => matchers.some((m) => m.match(p))).sort();
  } catch {
    return [];
  }
}

/** Checkbox steps (`- [ ]`, `- [x]`, also `*`/`+` bullets, indented) outside ``` fences. */
export function countSteps(md: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^\s*[-*+]\s+\[([ xX])\]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== " ") done++;
  }
  return { total, done };
}

/** First `# ` heading outside fences, else the file name. */
function planTitle(md: string, path: string): string {
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = /^# +(.+?)\s*#*\s*$/.exec(line);
      if (m) return m[1]!;
    }
  }
  return basename(path);
}

/** Upsert the plan by (folder, path). `isNewVersion` = new row or a different sha256. A new version
 *  resets status to draft only from draft/sent; an approved/executing/done plan that is edited keeps
 *  its status while sha, title and steps update. */
export function registerPlan(
  ledger: Ledger,
  p: { project: string; folder: string; path: string; content: string; cause?: Cause; orderId?: string },
): { plan: PlanRow; isNewVersion: boolean } {
  const sha256 = createHash("sha256").update(p.content).digest("hex");
  const prev = ledger.planByPath(p.folder, p.path);
  const isNewVersion = !prev || prev.sha256 !== sha256;
  const steps = countSteps(p.content);
  const base = { project: p.project, folder: p.folder, path: p.path, title: planTitle(p.content, p.path), sha256, stepsTotal: steps.total, stepsDone: steps.done };
  if (prev && !isNewVersion) {
    return { plan: prev, isNewVersion: false };
  }
  const status = !prev || prev.status === "draft" || prev.status === "sent" ? "draft" : prev.status;
  const plan = ledger.upsertPlan({
    ...base,
    status,
    threadId: p.cause?.threadId ?? prev?.threadId,
    orderId: p.orderId ?? prev?.orderId,
    todoId: prev?.todoId,
    decisionId: prev?.decisionId,
    createdAt: prev?.createdAt,
    sentAt: prev?.sentAt,
  });
  return { plan, isNewVersion };
}
