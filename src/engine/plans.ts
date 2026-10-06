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
    // Git reads only the plan globs (relative to `folder`), so a big repo's walk stays small; the
    // Bun.Glob filter below stays the rule.
    const pathspecs = globs.map((g) => `:(glob)${g}`);
    const found = new Set<string>();
    if (sinceSha) {
      // -z: NUL-separated and never quoted (non-ASCII names); --relative: paths from `folder`, only
      // under it; --diff-filter=d: no deletions.
      const diff = git(folder, ["diff", "--name-only", "-z", "--relative", "--diff-filter=d", `${sinceSha}..HEAD`, "--", ...pathspecs]);
      if (diff === undefined) failed("diff");
      for (const p of (diff ?? "").split("\0")) if (p) found.add(p);
    }
    // Porcelain paths are relative to the repo root (the pathspecs keep them under `folder`); rename
    // entries carry the old path as a second field.
    const status = git(folder, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...pathspecs]);
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
  /** At most this many cards per run end (a merge or pull can bring many plans); the rest wait in `/plans`. */
  maxPerRun: number;
}

export const DEFAULT_PLANS_CFG: PlansCfg = {
  paths: DEFAULT_PLAN_PATHS,
  send: true,
  maxBytes: 1_000_000,
  executeBrief: "Execute the plan at {path} task by task. Tick each step's checkbox in the file when it is done.",
  maxPerRun: 3,
};

/** Config `plans` from config.json: each well-typed field is kept, anything else is the default. */
export function readPlansCfg(raw: unknown): PlansCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const positive = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d);
  const d = DEFAULT_PLANS_CFG;
  return {
    paths: Array.isArray(r.paths) && r.paths.length > 0 && r.paths.every((p) => typeof p === "string" && p.length > 0) ? (r.paths as string[]) : d.paths,
    send: typeof r.send === "boolean" ? r.send : d.send,
    maxBytes: positive(r.maxBytes, d.maxBytes),
    executeBrief: typeof r.executeBrief === "string" && r.executeBrief.trim() ? r.executeBrief : d.executeBrief,
    maxPerRun: positive(r.maxPerRun, d.maxPerRun),
  };
}

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
 *  names for `rec.status`, as one card for content version `rec.version` (its taps carry it, so an
 *  older card cannot act on newer content). Returns where it landed; undefined = not posted. */
export type PostPlan = (
  rec: { planId: number; project: string; folder: string; status: PlanStatus; version: number },
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

/** `📄 plan · gold · Fare list port · v2 · thread m4g2` — the version only from the second; `more`
 *  names the plans this run end held back (`· +2 more: /plans`). */
export function planCaption(p: Pick<PlanRow, "project" | "title">, version: number, ref?: string, more = 0): string {
  return `📄 plan · ${p.project} · ${p.title}${version > 1 ? ` · v${version}` : ""}${ref ? ` · thread ${ref}` : ""}${more > 0 ? ` · +${more} more: /plans` : ""}`;
}

/** The content hash a version is judged by: checkbox marks do not count, so ticking steps is
 *  progress on the version the operator has, never a new card. */
export function reviewHash(md: string): string {
  return createHash("sha256").update(md.replace(/^(\s*[-*+]\s+\[)[ xX](\])/gm, "$1 $2")).digest("hex");
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

/** A registered plan and the hash its version is judged by (`reviewHash`). */
interface Registered {
  plan: PlanRow;
  review: string;
}

/** Register the file and finish an executing plan whose every step is checked. */
function register(deps: PlanDeps, run: PlanRun, path: string, content: string): Registered {
  const { plan } = registerPlan(deps.ledger, { project: run.project, folder: run.folder, path, content, cause: run.cause, orderId: run.orderId });
  const review = reviewHash(content);
  if (plan.status === "executing" && plan.stepsTotal > 0 && plan.stepsDone === plan.stepsTotal) {
    return { plan: deps.ledger.upsertPlan({ ...plan, status: "done" }), review };
  }
  return { plan, review };
}

/** Whether a send of this version would post a card (it is not finished and not already sent). */
function unsent(deps: PlanDeps, r: Registered): boolean {
  return !!deps.postPlan && deps.cfg.send && r.plan.status !== "done" && r.plan.status !== "abandoned" && r.plan.sentSha256 !== r.review;
}

/** Content versions being posted right now, `<folder>\0<path>\0<sha256>`. Run ends overlap (a turn
 *  end, the runner's final turn end and the run end fire together) and a worker's `send_file` can
 *  land meanwhile: the first claims the version, the others see it as sent. One daemon, one set. */
const posting = new Set<string>();

/** What became of one send: `sent`; `already` (this version reached the operator, or is being
 *  posted now); `failed` (the post did not land — the next run end retries); `off` (nothing to post
 *  to, sending is off, or the plan is finished). */
type SendOutcome = "sent" | "already" | "failed" | "off";

/** Send this content version unless it already went out. The card is posted first; only a posted
 *  card opens its tracked decision (so a failed post leaves nothing open, and the next run end
 *  tries again), closes the previous version's decision and becomes a `plan` line of its thread.
 *  A done or dropped plan is never sent again. */
async function sendPlan(deps: PlanDeps, r: Registered, run: PlanRun, more = 0): Promise<SendOutcome> {
  const { plan, review } = r;
  if (!deps.postPlan || !deps.cfg.send || plan.status === "done" || plan.status === "abandoned") return "off";
  const key = `${plan.folder}\0${plan.path}\0${review}`;
  if (plan.sentSha256 === review || posting.has(key)) return "already";
  posting.add(key);
  try {
    return await postVersion(deps, r, run, deps.postPlan, more);
  } finally {
    posting.delete(key);
  }
}

async function postVersion(deps: PlanDeps, { plan, review }: Registered, run: PlanRun, postPlan: PostPlan, more: number): Promise<SendOutcome> {
  const { ledger, trace } = deps;
  const cause = run.cause;
  const ref = cause && trace ? trace.ref(cause.threadId) : undefined;
  const version = plan.version + 1;
  const status = plan.status === "draft" ? "sent" : plan.status;
  const caption = planCaption(plan, version, ref, more);
  const posted = await postPlan({ planId: plan.id, project: plan.project, folder: plan.folder, status, version }, join(plan.folder, plan.path), caption);
  if (!posted) return "failed";
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
  // Re-read after the post: only the send's own fields change (a tap may have moved the plan meanwhile).
  const now = ledger.planById(plan.id) ?? plan;
  const previous = now.decisionId ? ledger.decisionById(now.decisionId) : undefined;
  if (previous?.status === "open") ledger.dismissDecision(previous.id);
  ledger.upsertPlan({ ...now, status: now.status === "draft" ? "sent" : now.status, decisionId, sentAt: Date.now(), sentSha256: review, version });
  ledger.recordEvent("plan_sent", { folder: plan.folder, orderId: run.orderId, cause, data: { project: plan.project, planId: plan.id, path: plan.path, version } });
  if (trace && cause) {
    faults.guard("plans.line", () => {
      const lineId = trace.outbound({ chatId: posted.chatId, text: caption, cause, kind: "plan", project: plan.project, folder: plan.folder, orderId: run.orderId });
      trace.bindChannel(lineId, posted.chatId, posted.messageId);
      trace.refreshThread(cause.threadId);
    });
  }
  return "sent";
}

/** At a run's end (company, project, dispatch, loop): register every plan file the run changed and
 *  send each content version the operator has not had — at most `maxPerRun` cards; the last one
 *  names how many more wait in `/plans`. Each file is its own unit (ADR-0010): one that throws is
 *  reported and the rest still go. */
export async function onRunEndPlans(deps: PlanDeps, run: PlanRun): Promise<void> {
  const toSend: Registered[] = [];
  for (const path of changedPlanFiles(run.folder, run.startSha, deps.cfg.paths, deps.git)) {
    try {
      const content = readPlan(run.folder, path, deps.cfg.maxBytes);
      if (content === undefined) continue;
      const r = register(deps, run, path, content);
      if (unsent(deps, r)) toSend.push(r);
    } catch (e) {
      faults.report("plans.runEnd", e, { project: run.project, folder: run.folder, path });
    }
  }
  const cap = deps.cfg.maxPerRun;
  for (const [i, r] of toSend.slice(0, cap).entries()) {
    try {
      await sendPlan(deps, r, run, i === cap - 1 ? toSend.length - cap : 0);
    } catch (e) {
      faults.report("plans.runEnd", e, { project: run.project, folder: run.folder, path: r.plan.path });
    }
  }
}

/** A worker's own `send_file` (`path` relative to the folder). A plan path is sent through the
 *  registry, so the operator gets each version once — a card that cannot be posted now is left to
 *  the run end, never sent twice as a plain file. Anything else (not a plan path, nowhere to post,
 *  a finished plan) is not handled here and the caller sends it as a plain file. */
export async function offerPlanFile(deps: PlanDeps, p: PlanRun & { path: string }): Promise<{ handled: false } | { handled: true; text: string }> {
  if (!deps.postPlan || !deps.cfg.send) return { handled: false };
  if (!deps.cfg.paths.some((g) => new Bun.Glob(g).match(p.path))) return { handled: false };
  const content = readPlan(p.folder, p.path, deps.cfg.maxBytes);
  if (content === undefined) return { handled: false };
  switch (await sendPlan(deps, register(deps, p, p.path, content), p)) {
    case "sent":
      return { handled: true, text: `sent plan ${p.path}` };
    case "already":
      return { handled: true, text: `already sent: ${p.path} — this version reached the operator` };
    case "failed":
      return { handled: true, text: `could not post the plan card for ${p.path} now — the engine sends it at the end of this run` };
    case "off":
      return { handled: false };
  }
}

/** Close the plan's open decision with the action taken, and re-derive its thread. */
function answerCard(deps: PlanDeps, plan: PlanRow, action: PlanAction): void {
  const dec = plan.decisionId ? deps.ledger.decisionById(plan.decisionId) : undefined;
  if (dec?.status === "open") deps.ledger.resolveDecision(dec.id, PLAN_LABELS[action]);
  const trace = deps.trace;
  if (trace && plan.threadId !== undefined) faults.guard("plans.refreshThread", () => trace.refreshThread(plan.threadId!));
}

/** An operator tap (Telegram, web, a command). The plan moves only here and on the checkbox count.
 *  `version`: the card's version — a tap on an older card than the newest sent is refused. */
export async function applyPlanAction(deps: PlanDeps, planId: number, action: PlanAction, version?: number): Promise<{ ok: boolean; text: string }> {
  const { ledger } = deps;
  const plan = ledger.planById(planId);
  if (!plan) return { ok: false, text: `no plan #${planId}` };
  if (version !== undefined && version !== plan.version) return { ok: false, text: `this card is v${version} — the newest is v${plan.version}; use that card` };
  if (plan.status === "done" || plan.status === "abandoned") return { ok: false, text: `this plan is already ${plan.status === "done" ? "done" : "dropped"}` };
  // The card's buttons are the rule on every surface: an action its status does not offer is refused.
  if (!planActions(plan.status).includes(action)) {
    if (action === "approve") return { ok: false, text: `already ${plan.status}` };
    if (action === "execute") return { ok: false, text: `already executing${plan.todoId !== undefined ? ` as #${plan.todoId}` : ""}` };
    return { ok: false, text: `a plan that is ${plan.status} cannot be ${action === "done" ? "marked done" : "changed here"}` };
  }
  switch (action) {
    case "changes":
      return { ok: true, text: "Reply to the plan with your changes — they go to the worker that wrote it." };
    case "approve":
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
      const launcher = deps.todo?.launcher();
      if (!deps.todo || !launcher) return { ok: false, text: "the todo queue is unavailable — Execute needs it" };
      const cause = plan.decisionId ? ledger.decisionById(plan.decisionId)?.cause : undefined;
      // Marked before the await, so a second tap meanwhile is refused instead of queueing twice. After
      // it, only status and todo are written over a fresh read (a run end may have moved the plan).
      ledger.upsertPlan({ ...plan, status: "executing" });
      const setStatus = (patch: Pick<PlanRow, "status"> & Partial<Pick<PlanRow, "todoId">>) => {
        const now = ledger.planById(plan.id);
        if (now) ledger.upsertPlan({ ...now, ...patch });
      };
      const brief = deps.cfg.executeBrief.replaceAll("{path}", plan.path);
      let text: string;
      try {
        // Returns once the todo is queued or its run has started — never after the run (dispatch runs in the background).
        text = await deps.todo.submit({ project: plan.folder, brief, workClass: "interactive", cause, planId: plan.id }, launcher.deps, launcher.replyChat);
      } catch (e) {
        setStatus({ status: plan.status });
        throw e;
      }
      const todo = ledger.todoForPlan(plan.id);
      if (!todo || todo.status === "cancelled") {
        setStatus({ status: plan.status }); // refused or held: nothing runs, the plan stays where it was
        return { ok: false, text };
      }
      setStatus({ status: "executing", todoId: todo.id });
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
