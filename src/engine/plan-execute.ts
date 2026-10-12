/** Execute judge (ADR-0034): before an Execute tap queues a todo, decide it from facts the engine can
 *  read. The facts are the plan file on disk, git (which folders are one repository), the ledger
 *  (active todos, plan rows) and the registry (live sessions). The result is a verdict:
 *  - done: nothing left to do.
 *  - busy: the design is already queued or running in this repository.
 *  - choose: a spec has several open plans.
 *  - run: run this plan in this folder.
 *  Pure reads, no AI, no side effects: `applyPlanAction` acts on the verdict. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Ledger, PlanRow, TodoRow, TodoStatus } from "./ledger";
import type { Registry } from "./registry";
import { git as defaultGit, type GitRunner } from "./git-read";
import type { PlansCfg } from "./plans";

/** One checkbox step of a plan: ticked or not, and its text. Outside ``` fences only. */
export interface PlanStep {
  done: boolean;
  text: string;
}

export function planSteps(md: string): PlanStep[] {
  const out: PlanStep[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line);
    if (m) out.push({ done: m[1] !== " ", text: m[2]! });
  }
  return out;
}

/** A step a worker must not do alone (push, deploy, restart, ask the operator…): config patterns. */
export function gatedStep(text: string, cfg: Pick<PlansCfg, "gatedStepPatterns">): boolean {
  return cfg.gatedStepPatterns.some((p) => new RegExp(p, "i").test(text));
}

/** A repository: `key` is its git common dir (shared by every worktree), `main` its main worktree.
 *  A folder git cannot read is its own repository. */
export interface RepoId {
  key: string;
  main: string;
}

export function repoOf(folder: string, git: GitRunner = defaultGit): RepoId {
  const common = git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
  if (!common) return { key: folder, main: folder };
  // The main worktree is always the first entry of the list.
  const first = /^worktree (.+)$/m.exec(git(folder, ["worktree", "list", "--porcelain"]) ?? "")?.[1];
  return { key: resolve(common), main: first ?? folder };
}

/** A file under a `specs/` folder is a spec; anything else under the plan paths is a plan. */
export function isSpec(path: string): boolean {
  return path.split("/").includes("specs");
}

/** Spec paths a text names (`docs/superpowers/specs/x.md`). */
function specRefs(md: string): string[] {
  return [...new Set([...md.matchAll(/[\w./-]*specs\/[\w./-]+\.md/g)].map((m) => m[0].replace(/^\.\//, "")))];
}

function readText(path: string, maxBytes: number): string | undefined {
  try {
    const st = statSync(path);
    return st.isFile() && st.size <= maxBytes ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** How far a plan file is: ticked, total, and how many unticked steps are operator-gated. `finished`:
 *  it has steps and none is left that a worker may do. */
export interface Progress {
  done: number;
  total: number;
  gated: number;
  finished: boolean;
}
function progressOf(md: string, cfg: PlansCfg): Progress {
  const steps = planSteps(md);
  const open = steps.filter((s) => !s.done);
  const gated = open.filter((s) => gatedStep(s.text, cfg)).length;
  return { done: steps.length - open.length, total: steps.length, gated, finished: steps.length > 0 && gated === open.length };
}

/** The plans of a spec, added up: finished when every one is. */
function sumProgress(plans: Progress[]): Progress {
  return plans.reduce((a, p) => ({ done: a.done + p.done, total: a.total + p.total, gated: a.gated + p.gated, finished: a.finished && p.finished }), { done: 0, total: 0, gated: 0, finished: true });
}

/** The design unit's progress when it is finished on disk, else undefined (ADR-0034 rules 1 and 4;
 *  the plan registry's first sight, ADR-0035). A plan is judged by its own steps (`content`); a spec
 *  by the plans that name it, when it has at least one and every one is finished. */
export function finishedUnit(cfg: PlansCfg, folder: string, path: string, content: string, git: GitRunner = defaultGit): Progress | undefined {
  if (!isSpec(path)) {
    const p = progressOf(content, cfg);
    return p.finished ? p : undefined;
  }
  const plans = plansOfSpec(folder, path, cfg, git).map((p) => progressOf(readText(join(folder, p), cfg.maxBytes) ?? "", cfg));
  const sum = sumProgress(plans);
  return plans.length > 0 && sum.finished ? sum : undefined;
}

/** The plan files in `folder` (tracked or untracked, not ignored) whose text names `spec`. */
function plansOfSpec(folder: string, spec: string, cfg: PlansCfg, git: GitRunner): string[] {
  const out = git(folder, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...cfg.paths.map((g) => `:(glob)${g}`)]);
  const matchers = cfg.paths.map((g) => new Bun.Glob(g));
  return [...new Set((out ?? "").split("\0"))]
    .filter((p) => p && !isSpec(p) && matchers.some((m) => m.match(p)))
    .filter((p) => readText(join(folder, p), cfg.maxBytes)?.includes(spec))
    .sort();
}

export interface JudgeDeps {
  ledger: Ledger;
  cfg: PlansCfg;
  registry?: Registry;
  git?: GitRunner;
}

export type ExecuteVerdict =
  | { kind: "run"; path: string; folder: string; notes: string[] }
  | { kind: "done"; path: string; progress: Progress }
  | { kind: "busy"; path: string; where: string }
  | { kind: "choose"; spec: string; plans: Array<{ path: string; progress: Progress }> };

const ACTIVE: TodoStatus[] = ["queued", "running", "retry", "waiting"];
const TODO_STATE: Record<string, string> = { queued: "queued", running: "running", retry: "waiting to retry", waiting: "waiting on a decision" };

/** Decide one Execute (ADR-0034). `anyway`: the operator's Run anyway, which skips only the done check. */
export function judgeExecute(deps: JudgeDeps, plan: PlanRow, opts: { anyway?: boolean; now?: number } = {}): ExecuteVerdict {
  const git = deps.git ?? defaultGit;
  const { cfg, ledger } = deps;
  const now = opts.now ?? Date.now();
  const repos = new Map<string, RepoId>();
  const repo = (folder: string) => {
    let r = repos.get(folder);
    if (!r) repos.set(folder, (r = repoOf(folder, git)));
    return r;
  };
  const home = repo(plan.folder);
  const notes: string[] = [];

  // Where it runs: the main checkout when the file is there, else the worktree that has it (rule 3).
  const folder = home.main !== plan.folder && existsSync(join(home.main, plan.path)) ? home.main : plan.folder;
  if (folder !== plan.folder) notes.push(`in ${folder}, the main checkout of this repository`);
  else if (home.main !== plan.folder) notes.push(`in ${folder}: the plan exists only on this worktree's branch`);

  // The design unit (rule 4): a spec resolves to its plan; a plan carries the spec it names.
  let target = plan.path;
  let unit: string[];
  if (isSpec(plan.path)) {
    const plans = plansOfSpec(folder, plan.path, cfg, git).map((path) => ({ path, progress: progressOf(readText(join(folder, path), cfg.maxBytes) ?? "", cfg) }));
    unit = [plan.path, ...plans.map((p) => p.path)];
    const candidates = opts.anyway ? plans : plans.filter((p) => !p.progress.finished);
    if (candidates.length > 1) return { kind: "choose", spec: plan.path, plans: candidates };
    if (candidates.length === 1) {
      target = candidates[0]!.path;
      notes.push(`the plan of spec ${plan.path}`);
    } else if (plans.length > 0) {
      return { kind: "done", path: plan.path, progress: sumProgress(plans.map((p) => p.progress)) };
    }
  } else {
    unit = [plan.path, ...specRefs(readText(join(folder, plan.path), cfg.maxBytes) ?? "")];
  }

  // The file is the truth (rule 1): read it now, not the row's last count.
  if (!opts.anyway) {
    const progress = progressOf(readText(join(folder, target), cfg.maxBytes) ?? "", cfg);
    if (progress.finished) return { kind: "done", path: target, progress };
  }

  // Already in hand anywhere in this repository (rule 2).
  const inUnit = (path: string | undefined) => path !== undefined && unit.includes(path);
  const named = (text: string | undefined) => !!text && unit.some((p) => text.includes(p));
  const sameRepo = (f: string) => repo(f).key === home.key;
  for (const t of ledger.listTodos({ statuses: ACTIVE, limit: 500 })) {
    if (!sameRepo(t.folder)) continue;
    const row = t.planId !== undefined ? ledger.planById(t.planId) : undefined;
    if (inUnit(row?.path) || named(t.brief)) return { kind: "busy", path: target, where: todoWhere(t) };
  }
  // A session in this repository: the plan named in its order or current turn, or its file ticked
  // there within the active window. Spec paths are left out of the name match when the unit has a
  // plan: the session that wrote the plan named the spec in its order.
  const planPaths = unit.filter((p) => !isSpec(p));
  const names = (planPaths.length ? planPaths : unit).map((p) => basename(p));
  const windowMs = cfg.activeWindowMinutes * 60_000;
  for (const s of deps.registry?.list() ?? []) {
    if (s.status !== "running" || !sameRepo(s.order.folder)) continue;
    const reg = deps.registry!;
    const texts = [s.order.task, ...[reg.causeOf(s.id), ...reg.pendingCauses(s.id)].map((c) => (c ? ledger.messageById(c.msgId)?.content : undefined))];
    if (texts.some((x) => !!x && names.some((n) => x.includes(n)))) return { kind: "busy", path: target, where: `session ${s.name} (${s.order.folder}) is executing it` };
    // The file's own mtime, not the ledger row's updatedAt: the engine writes rows too (a card
    // send, a refused tap), but only work on the plan changes the file.
    const ticked = planPaths.map((p) => tickedAt(join(s.order.folder, p), cfg.maxBytes)).find((at) => at !== undefined && now - at <= windowMs);
    if (ticked !== undefined) return { kind: "busy", path: target, where: `session ${s.name} (${s.order.folder}) ticked it ${Math.max(1, Math.round((now - ticked) / 60_000))}m ago` };
  }
  return { kind: "run", path: target, folder, notes };
}

/** When a plan file with at least one ticked step was last written, else undefined. */
function tickedAt(path: string, maxBytes: number): number | undefined {
  const md = readText(path, maxBytes);
  if (!md || !planSteps(md).some((s) => s.done)) return undefined;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function todoWhere(t: TodoRow): string {
  return `${TODO_STATE[t.status] ?? t.status} as todo #${t.id} in ${t.folder}`;
}

/** The operator's reply for a verdict that starts nothing. */
export function verdictText(v: Exclude<ExecuteVerdict, { kind: "run" }>): string {
  switch (v.kind) {
    case "done": {
      const p = v.progress;
      const gated = p.gated ? `; ${p.gated} operator-gated step${p.gated === 1 ? "" : "s"} left for you` : "";
      return `✅ ${v.path} is already done — ${p.done}/${p.total} steps ticked${gated}. Nothing new started. Tap Run anyway to run it again.`;
    }
    case "busy":
      return v.where.startsWith("session ")
        ? `⏳ ${v.path}: ${v.where}. Nothing new started.`
        : `⏳ ${v.path} is already ${v.where}. Nothing new started.`;
    case "choose":
      return `📄 ${v.spec} has ${v.plans.length} open plans. Nothing started — Execute the plan you want:\n${v.plans.map((p) => `• ${p.path} (${p.progress.done}/${p.progress.total})`).join("\n")}`;
  }
}
