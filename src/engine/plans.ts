/** Plan registry (ADR-0019, spec §10): find plan/spec files a run changed, register each one in the
 *  ledger, send each new version to the operator once, and move its status on operator taps and on
 *  deterministic facts. Plain code over git and the filesystem — no AI. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Cause, Ledger, PlanRow, PlanStatus } from "./ledger";
import { git as defaultGit } from "./dispatch-report";
import { faults } from "./fault";
import type { Trace } from "./trace";
import type { TodoQueue } from "./todo-queue";

/** Spec default for config `plans.paths`. */
export const DEFAULT_PLAN_PATHS: string[] = ["docs/**/plans/**/*.md", "docs/**/specs/**/*.md", "specs/**/*.md", "plans/**/*.md"];

/** One bounded git query in `folder`; undefined on failure. */
export type GitRunner = (folder: string, args: string[]) => string | undefined;

/** Plan files under `globs` (relative to `folder`) changed since `sinceSha` (committed), or modified
 *  or untracked in the working tree; deleted files are never listed. `folder` may be a subfolder of
 *  its repo: paths are relative to it and only files under it count. No `sinceSha` → working-tree
 *  changes only. `[]` when `folder` is not a repo; a git failure inside a repo is logged. Never throws. */
export function changedPlanFiles(folder: string, sinceSha: string | undefined, globs: string[], git: GitRunner = defaultGit): string[] {
  try {
    // The folder's place in its repo; undefined = not a repo (or git missing) — nothing to detect, quietly.
    const prefixOut = git(folder, ["rev-parse", "--show-prefix"]);
    if (prefixOut === undefined) return [];
    const prefix = prefixOut.trim();
    const failed = (what: string) => console.warn(`[plans] git ${what} failed in ${folder} — plan detection is partial`);
    const found = new Set<string>();
    if (sinceSha) {
      // -z: NUL-separated and never quoted (non-ASCII names); --relative: paths from `folder`, only
      // under it; --diff-filter=d: no deletions.
      const diff = git(folder, ["diff", "--name-only", "-z", "--relative", "--diff-filter=d", `${sinceSha}..HEAD`]);
      if (diff === undefined) failed("diff");
      for (const p of (diff ?? "").split("\0")) if (p) found.add(p);
    }
    // Porcelain paths are relative to the repo root (the pathspec keeps them under `folder`); rename
    // entries carry the old path as a second field.
    const status = git(folder, ["status", "--porcelain", "-z", "--untracked-files=all", "--", "."]);
    if (status === undefined) failed("status");
    const parts = (status ?? "").split("\0");
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!;
      if (e.length < 4) continue;
      if (e[0] === "R" || e[0] === "C") i++; // skip the rename source
      const path = e.slice(3);
      if (!path.startsWith(prefix)) continue;
      const rel = path.slice(prefix.length);
      if (e[0] === "D" || e[1] === "D") found.delete(rel);
      else found.add(rel);
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
    sentSha256: prev?.sentSha256,
  });
  return { plan, isNewVersion };
}

// ── Send, buttons, lifecycle (Task 2.2) ──────────────────────────────────────────────────────

/** Config `plans` (docs/CONFIG.md). */
export interface PlansCfg {
  /** Globs, relative to a project folder, that a plan or spec lives under. */
  paths: string[];
  /** Send each new plan version to the operator. Off → plans are still registered (`/plans`). */
  send: boolean;
  /** A plan file bigger than this is skipped: never read, registered or sent. */
  maxBytes: number;
  /** The brief an Execute tap queues; `{path}` is the plan's path in its project. */
  executeBrief: string;
}

export const DEFAULT_PLANS_CFG: PlansCfg = {
  paths: DEFAULT_PLAN_PATHS,
  send: true,
  maxBytes: 1_000_000,
  executeBrief: "Execute the plan at {path} task by task. Tick each step's checkbox in the file when it is done.",
};

/** What the operator can do with a plan (the card's buttons; `/plans` and the web API take the same). */
export type PlanAction = "approve" | "changes" | "execute" | "done" | "drop";

/** The button label of each action; the decision row's options are all of them, in card order. */
export const PLAN_LABELS: Record<PlanAction, string> = { approve: "Approve", changes: "Changes", execute: "Execute", done: "Done", drop: "Drop" };
export const PLAN_OPTIONS = ["Approve", "Changes", "Execute", "Done", "Drop"];

/** The buttons a plan offers in a status, in card order. A finished plan offers none. */
export function planActions(status: PlanStatus): PlanAction[] {
  switch (status) {
    case "draft":
    case "sent":
      return ["approve", "changes", "execute", "drop"];
    case "approved":
      return ["execute", "drop"]; // accepted: its review is closed, so no more Changes
    case "executing":
      return ["done", "drop"];
    default:
      return [];
  }
}

export function isPlanAction(s: string): s is PlanAction {
  return s in PLAN_LABELS;
}

/** The frontend half of a send: post the file (`path` is absolute) with the buttons `planActions`
 *  names for `rec.status`, as one card. Returns where it landed; undefined = not posted. */
export type PostPlan = (
  rec: { planId: number; project: string; folder: string; status: PlanStatus },
  path: string,
  caption: string,
) => Promise<{ chatId: number; messageId: number } | undefined>;

export interface PlanDeps {
  ledger: Ledger;
  cfg: PlansCfg;
  /** Absent (the customer path, a test) → plans are registered, never sent. */
  postPlan?: PostPlan;
  trace?: Trace;
  git?: GitRunner;
  /** For Execute (ADR-0008): the todo it queues runs through the project's queue. */
  todo?: TodoQueue;
}

/** The plan deps of a run's deps (pipeline or dispatch): one place, so both build them alike. */
export function planDepsFrom(d: { ledger: Ledger; postPlan?: PostPlan; trace?: Trace; todo?: TodoQueue }, cfg: PlansCfg | undefined): PlanDeps {
  return { ledger: d.ledger, cfg: cfg ?? DEFAULT_PLANS_CFG, postPlan: d.postPlan, trace: d.trace, todo: d.todo };
}

/** One run: where it ran, the HEAD it started from, the operator message it answers. */
export interface PlanRun {
  project: string;
  folder: string;
  startSha?: string;
  cause?: Cause;
  orderId?: string;
  /** The chat the run reports to — the decision's raising chat (a reply resumes there). */
  chatId: number;
}

/** The folder's HEAD sha (a run records it at start), or undefined (not a repo, no commit yet). */
export function headSha(folder: string, git: GitRunner = defaultGit): string | undefined {
  return git(folder, ["rev-parse", "HEAD"])?.trim() || undefined;
}

/** `📄 plan · gold · Fare list port · v2 · thread m4g2` — the version only from the second. */
export function planCaption(p: Pick<PlanRow, "project" | "title">, version: number, ref?: string): string {
  return `📄 plan · ${p.project} · ${p.title}${version > 1 ? ` · v${version}` : ""}${ref ? ` · thread ${ref}` : ""}`;
}

/** The plan's text, or undefined when it is gone, not a file, or over `maxBytes` (logged). */
function readPlan(folder: string, path: string, maxBytes: number): string | undefined {
  const abs = join(folder, path);
  try {
    const st = statSync(abs);
    if (!st.isFile()) return undefined;
    if (st.size > maxBytes) {
      console.warn(`[plans] ${abs} is ${st.size} bytes, over plans.maxBytes (${maxBytes}) — not registered or sent`);
      return undefined;
    }
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** Register the file and finish an executing plan whose every step is checked. */
function register(deps: PlanDeps, run: PlanRun, path: string, content: string): PlanRow {
  const { plan } = registerPlan(deps.ledger, { project: run.project, folder: run.folder, path, content, cause: run.cause, orderId: run.orderId });
  if (plan.status === "executing" && plan.stepsTotal > 0 && plan.stepsDone === plan.stepsTotal) {
    return deps.ledger.upsertPlan({ ...plan, status: "done" });
  }
  return plan;
}

/** Send this content version unless it already went out. The card is posted first; only a posted
 *  card opens its tracked decision (so a failed post leaves nothing open, and the next run end
 *  tries again), closes the previous version's decision and becomes a `plan` line of its thread. */
async function sendPlan(deps: PlanDeps, plan: PlanRow, run: PlanRun): Promise<boolean> {
  if (!deps.postPlan || !deps.cfg.send || plan.sentSha256 === plan.sha256) return false;
  const { ledger, trace } = deps;
  const cause = run.cause;
  const ref = cause && trace ? trace.ref(cause.threadId) : undefined;
  const version = plan.version + 1;
  const status = plan.status === "draft" ? "sent" : plan.status;
  const caption = planCaption(plan, version, ref);
  const posted = await deps.postPlan({ planId: plan.id, project: plan.project, folder: plan.folder, status }, join(plan.folder, plan.path), caption);
  if (!posted) return false;
  const decisionId = ledger.openDecision({
    kind: "decision",
    project: plan.project,
    folder: plan.folder,
    orderId: run.orderId,
    chatId: run.chatId,
    question: `Plan ready for review: ${plan.path} — ${plan.title}`,
    options: PLAN_OPTIONS,
    cause,
  });
  ledger.setDecisionMessage(decisionId, posted.chatId, posted.messageId);
  const previous = plan.decisionId ? ledger.decisionById(plan.decisionId) : undefined;
  if (previous?.status === "open") ledger.dismissDecision(previous.id);
  ledger.upsertPlan({ ...plan, status, decisionId, sentAt: Date.now(), sentSha256: plan.sha256, version });
  ledger.recordEvent("plan_sent", { folder: plan.folder, orderId: run.orderId, cause, data: { project: plan.project, planId: plan.id, path: plan.path, version } });
  if (trace && cause) {
    faults.guard("plans.line", () => {
      const lineId = trace.outbound({ chatId: posted.chatId, text: caption, cause, kind: "plan", project: plan.project, folder: plan.folder, orderId: run.orderId });
      trace.bindChannel(lineId, posted.chatId, posted.messageId);
      trace.refreshThread(cause.threadId);
    });
  }
  return true;
}

/** At a run's end (company, project, dispatch, loop): register every plan file the run changed and
 *  send each content version the operator has not had. Each file is its own unit (ADR-0010): one
 *  that throws is reported and the rest still go. */
export async function onRunEndPlans(deps: PlanDeps, run: PlanRun): Promise<void> {
  for (const path of changedPlanFiles(run.folder, run.startSha, deps.cfg.paths, deps.git)) {
    try {
      const content = readPlan(run.folder, path, deps.cfg.maxBytes);
      if (content === undefined) continue;
      await sendPlan(deps, register(deps, run, path, content), run);
    } catch (e) {
      faults.report("plans.runEnd", e, { project: run.project, folder: run.folder, path });
    }
  }
}

/** A worker's own `send_file` (`path` relative to the folder). A plan path is sent through the
 *  registry, so the operator gets each version once; anything else (or nowhere to post it) is not
 *  handled here and the caller sends it as a plain file. */
export async function offerPlanFile(deps: PlanDeps, p: PlanRun & { path: string }): Promise<{ handled: false } | { handled: true; text: string }> {
  if (!deps.postPlan || !deps.cfg.send) return { handled: false };
  if (!deps.cfg.paths.some((g) => new Bun.Glob(g).match(p.path))) return { handled: false };
  const content = readPlan(p.folder, p.path, deps.cfg.maxBytes);
  if (content === undefined) return { handled: false };
  const plan = register(deps, p, p.path, content);
  if (plan.sentSha256 === plan.sha256) return { handled: true, text: `already sent: ${p.path} — this version reached the operator` };
  return (await sendPlan(deps, plan, p)) ? { handled: true, text: `sent plan ${p.path}` } : { handled: false };
}

/** Close the plan's open decision with the action taken, and re-derive its thread. */
function answerCard(deps: PlanDeps, plan: PlanRow, action: PlanAction): void {
  const dec = plan.decisionId ? deps.ledger.decisionById(plan.decisionId) : undefined;
  if (dec?.status === "open") deps.ledger.resolveDecision(dec.id, PLAN_LABELS[action]);
  const trace = deps.trace;
  if (trace && plan.threadId !== undefined) faults.guard("plans.refreshThread", () => trace.refreshThread(plan.threadId!));
}

/** An operator tap (Telegram, web, a command). The plan moves only here and on the checkbox count. */
export async function applyPlanAction(deps: PlanDeps, planId: number, action: PlanAction): Promise<{ ok: boolean; text: string }> {
  const { ledger } = deps;
  const plan = ledger.planById(planId);
  if (!plan) return { ok: false, text: `no plan #${planId}` };
  if (plan.status === "done" || plan.status === "abandoned") return { ok: false, text: `this plan is already ${plan.status === "done" ? "done" : "dropped"}` };
  switch (action) {
    case "changes":
      return { ok: true, text: "Reply to the plan with your changes — they go to the worker that wrote it." };
    case "approve":
      if (plan.status === "approved" || plan.status === "executing") return { ok: false, text: `already ${plan.status}` };
      ledger.upsertPlan({ ...plan, status: "approved" });
      answerCard(deps, plan, action);
      return { ok: true, text: "Approved" };
    case "done":
      ledger.upsertPlan({ ...plan, status: "done" });
      answerCard(deps, plan, action);
      return { ok: true, text: "Marked done" };
    case "drop":
      ledger.upsertPlan({ ...plan, status: "abandoned" });
      answerCard(deps, plan, action);
      return { ok: true, text: "Dropped" };
    case "execute": {
      if (plan.status === "executing") return { ok: false, text: `already executing${plan.todoId !== undefined ? ` as #${plan.todoId}` : ""}` };
      const launcher = deps.todo?.launcher();
      if (!deps.todo || !launcher) return { ok: false, text: "the todo queue is unavailable — Execute needs it" };
      const cause = plan.decisionId ? ledger.decisionById(plan.decisionId)?.cause : undefined;
      // Marked before the await, so a second tap meanwhile is refused instead of queueing twice.
      ledger.upsertPlan({ ...plan, status: "executing" });
      const brief = deps.cfg.executeBrief.replaceAll("{path}", plan.path);
      let text: string;
      try {
        text = await deps.todo.submit({ project: plan.folder, brief, workClass: "interactive", cause, planId: plan.id }, launcher.deps, launcher.replyChat);
      } catch (e) {
        ledger.upsertPlan({ ...plan });
        throw e;
      }
      const todo = ledger.todoForPlan(plan.id);
      if (!todo || todo.status === "cancelled") {
        ledger.upsertPlan({ ...plan }); // refused or held: nothing runs, the plan stays where it was
        return { ok: false, text };
      }
      ledger.upsertPlan({ ...plan, status: "executing", todoId: todo.id });
      answerCard(deps, plan, action);
      return { ok: true, text: `Executing as todo #${todo.id}` };
    }
  }
}

/** `/plans [project]`: newest first, bounded — status, checked steps, project, title, thread ref, path. */
export function renderPlans(ledger: Ledger, trace: Trace | undefined, project?: string): string {
  const rows = ledger.listPlans(project, 20);
  if (!rows.length) return project ? `No plans for ${project} yet.` : "No plans yet.";
  const lines = rows.map((p) => {
    const ref = trace && p.threadId !== undefined ? ` · ${trace.ref(p.threadId)}` : "";
    return `#${p.id} · ${p.status} · ${p.stepsDone}/${p.stepsTotal} · ${p.project} · ${p.title}${ref}\n  ${p.path}`;
  });
  return `📄 Plans${project ? ` — ${project}` : ""} (newest first):\n${lines.join("\n")}`;
}
