/** Plan registry (ADR-0019, spec §10): find plan/spec files a run changed, register each one in the
 *  ledger, send each new version to the operator once, and move its status on operator taps and on
 *  deterministic facts. Plain code over git and the filesystem — no AI. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Cause, Ledger, PlanGate, PlanRow, PlanStatus } from "./ledger";
import { PAGE_MAX } from "./ledger";
import { git as defaultGit } from "./dispatch-report";
import { faults } from "./fault";
import type { Trace } from "./trace";
import type { TodoQueue } from "./todo-queue";
import type { Registry } from "./registry";
import { finishedUnit, isSpec, judgeExecute, planSteps, specRefs, verdictText, type Progress } from "./plan-execute";
import { classifyPlan } from "./plan-gate";
import { reviewQuestion } from "./plan-review";

/** Spec default for config `plans.paths`. */
export const DEFAULT_PLAN_PATHS: string[] = ["docs/**/plans/**/*.md", "docs/**/specs/**/*.md", "specs/**/*.md", "plans/**/*.md"];

export type { GitRunner } from "./git-read";
import type { GitRunner } from "./git-read";

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
  const steps = planSteps(md);
  return { total: steps.length, done: steps.filter((s) => s.done).length };
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

/** Upsert the plan by (folder, path). Its `sha256` is the `reviewHash`, so `isNewVersion` = a new row
 *  or changed text; ticking checkboxes only updates the step count. A new version resets status to
 *  draft only from draft/sent; an approved/executing/done plan that is edited keeps its status while
 *  sha, title and steps update. */
export function registerPlan(
  ledger: Ledger,
  p: { project: string; folder: string; path: string; content: string; cause?: Cause; orderId?: string; gate?: PlanGate },
): { plan: PlanRow; isNewVersion: boolean } {
  const sha256 = reviewHash(p.content);
  const prev = ledger.planByPath(p.folder, p.path);
  const isNewVersion = !prev || prev.sha256 !== sha256;
  const steps = countSteps(p.content);
  const base = { project: p.project, folder: p.folder, path: p.path, title: planTitle(p.content, p.path), sha256, stepsTotal: steps.total, stepsDone: steps.done };
  if (prev && !isNewVersion) {
    // Same text: only progress (ticked steps) can have moved, and a gate a pre-ADR-0036 row lacked.
    const gate = prev.gate ?? p.gate;
    if (prev.stepsDone === steps.done && prev.stepsTotal === steps.total && gate === prev.gate) return { plan: prev, isNewVersion: false };
    return { plan: ledger.upsertPlan({ ...prev, stepsTotal: steps.total, stepsDone: steps.done, ...(gate ? { gate } : {}) }), isNewVersion: false };
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
    gate: p.gate ?? prev?.gate,
    heldAt: prev?.heldAt,
    doneSha: prev?.doneSha,
    cardChatId: prev?.cardChatId,
    cardMessageId: prev?.cardMessageId,
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
  /** Regex sources (case-insensitive) for steps a worker must not do alone. A plan whose only
   *  unticked steps match is done for Execute (ADR-0034). */
  gatedStepPatterns: string[];
  /** A live session that ticked a plan within this many minutes is executing it (ADR-0034). */
  activeWindowMinutes: number;
  /** When a plan is big and waits for the operator's approval (ADR-0036). */
  approval: PlanApprovalCfg;
}

/** Config `plans.approval` (ADR-0036): a plan with more tasks or steps than these, or a line matching
 *  one of `patterns` (case-insensitive regex sources), waits for Approve & build. */
export interface PlanApprovalCfg {
  maxTasks: number;
  maxSteps: number;
  patterns: string[];
}

export const DEFAULT_PLANS_CFG: PlansCfg = {
  paths: DEFAULT_PLAN_PATHS,
  send: true,
  maxBytes: 1_000_000,
  executeBrief: "Execute the plan at {path} task by task. Tick each step's checkbox in the file when it is done.",
  maxPerRun: 3,
  gatedStepPatterns: [
    "\\bpush(es|ed|ing)?\\b",
    "\\bdeploy",
    "\\brestart",
    "\\breload",
    "\\bpublish",
    "\\bask (the )?operator\\b",
    "\\boperator('s)? (approval|permission|decision|sign-off)\\b",
    "\\(operator\\)",
  ],
  activeWindowMinutes: 30,
  approval: {
    maxTasks: 4,
    maxSteps: 20,
    patterns: [
      "\\bmigrat(e|es|ed|ion|ions)\\b",
      "\\b(auth|authentication|authorization|login|passwords?|permissions?)\\b",
      "\\b(payments?|finance|financial|money|wallets?|invoices?|refunds?|billing|balances?)\\b",
      "\\b(deploy|deployment|production)\\b",
      "\\b(delete|deletes|deletion|purge|truncate|drop (table|column|database))\\b",
    ],
  },
};

/** Config `plans` from config.json: each well-typed field is kept, anything else is the default. */
export function readPlansCfg(raw: unknown): PlansCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const positive = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d);
  const d = DEFAULT_PLANS_CFG;
  return {
    // Globs are also git pathspecs (`:(glob)`), which have no `{a,b}` alternation.
    paths: Array.isArray(r.paths) && r.paths.length > 0 && r.paths.every((p) => typeof p === "string" && p.length > 0 && !/[{}]/.test(p)) ? (r.paths as string[]) : d.paths,
    send: typeof r.send === "boolean" ? r.send : d.send,
    maxBytes: positive(r.maxBytes, d.maxBytes),
    executeBrief: typeof r.executeBrief === "string" && r.executeBrief.trim() ? r.executeBrief : d.executeBrief,
    maxPerRun: positive(r.maxPerRun, d.maxPerRun),
    gatedStepPatterns: regexList(r.gatedStepPatterns) ?? d.gatedStepPatterns,
    activeWindowMinutes: positive(r.activeWindowMinutes, d.activeWindowMinutes),
    approval: readApproval(r.approval, d.approval, positive),
  };
}

/** Config `plans.approval`: each well-typed field is kept, anything else is the default. */
function readApproval(raw: unknown, d: PlanApprovalCfg, positive: (v: unknown, d: number) => number): PlanApprovalCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { maxTasks: positive(r.maxTasks, d.maxTasks), maxSteps: positive(r.maxSteps, d.maxSteps), patterns: regexList(r.patterns) ?? d.patterns };
}

/** A list of valid regex sources, else undefined (one bad entry keeps the whole default). */
function regexList(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && p.length > 0)) return undefined;
  try {
    for (const p of v as string[]) new RegExp(p, "i");
    return v as string[];
  } catch {
    return undefined;
  }
}

/** What the operator can do with a plan — the ONE definition of each button (ADR-0036); Telegram, the
 *  console and the API all take these:
 *  - `approve` — **Approve & build**: a worker held on the plan resumes and builds it; with none held
 *    it is an Execute (ADR-0034: judged, queued once).
 *  - `changes` — the operator's next message goes back to the worker that wrote it.
 *  - `stop` — a small plan the worker is building: drop it and stop the project's live session.
 *  - `done` — mark a building plan finished.  `drop` — abandon it.
 *  - `execute` — Approve & build's engine verb, kept for old cards and the API; no card shows it.
 *  - `anyway` — Run anyway: an Execute that skips only the done check, offered on a "done" reply. */
export type PlanAction = "approve" | "changes" | "execute" | "anyway" | "stop" | "done" | "drop";

/** The button label of each action. The console's English catalogue (`threads.planAction`) has the
 *  same labels (a test keeps them equal). */
export const PLAN_LABELS: Record<PlanAction, string> = {
  approve: "Approve & build",
  changes: "Changes",
  execute: "Execute",
  anyway: "Run anyway",
  stop: "Stop",
  done: "Done",
  drop: "Drop",
};

/** Where a plan is, as the operator sees it (ADR-0036): `awaiting` = sent and waiting for Approve &
 *  build; `info` = a small plan sent for information while the worker builds it. */
export type PlanState = "draft" | "awaiting" | "info" | "approved" | "building" | "done" | "dropped";

/** A row without a gate (sent before ADR-0036) waits for the operator, as it did. */
export function planState(p: Pick<PlanRow, "status" | "gate">): PlanState {
  switch (p.status) {
    case "draft":
      return "draft";
    case "sent":
      return p.gate === "info" ? "info" : "awaiting";
    case "approved":
      return "approved";
    case "executing":
      return "building";
    case "done":
      return "done";
    case "abandoned":
      return "dropped";
  }
}

/** The buttons a plan offers, in card order. A finished plan offers none. */
export function planActions(p: Pick<PlanRow, "status" | "gate">): PlanAction[] {
  switch (planState(p)) {
    case "draft":
    case "approved":
      return ["approve", "drop"];
    case "awaiting":
      return ["approve", "changes", "drop"];
    case "info":
      return ["stop"];
    case "building":
      return ["done", "drop"];
    default:
      return [];
  }
}

export function isPlanAction(s: string): s is PlanAction {
  return s in PLAN_LABELS;
}

/** One card as a frontend draws it: the caption and the buttons (`plan:<id>:<version>:<action>`). */
export interface PlanCard {
  planId: number;
  version: number;
  caption: string;
  actions: PlanAction[];
}

/** The frontend half of a send: post the file (`path` is absolute) as one card for content version
 *  `rec.version` (its taps carry it, so an older card cannot act on newer content). Returns where it
 *  landed; undefined = not posted. */
export type PostPlan = (
  rec: { planId: number; project: string; folder: string; status: PlanStatus; version: number; actions: PlanAction[] },
  path: string,
  caption: string,
) => Promise<{ chatId: number; messageId: number } | undefined>;

/** The frontend half of a state change (ADR-0036): redraw a posted card in place — its caption and
 *  buttons. True when the message was edited. */
export type EditPlanCard = (at: { chatId: number; messageId: number }, card: PlanCard) => Promise<boolean>;

export interface PlanDeps {
  ledger: Ledger;
  cfg: PlansCfg;
  /** Absent (the customer path, a test) → plans are registered, never sent. */
  postPlan?: PostPlan;
  /** Absent → cards are not redrawn (the console still reads the ledger). */
  editPlan?: EditPlanCard;
  trace?: Trace;
  git?: GitRunner;
  /** For Execute (ADR-0008): the todo it queues runs through the project's queue. */
  todo?: TodoQueue;
  /** For Execute (ADR-0034): live sessions that may already be executing the plan; Stop interrupts one. */
  registry?: Registry;
}

/** The plan deps of a run's deps (pipeline or dispatch): one place, so both build them alike. */
export function planDepsFrom(d: { ledger: Ledger; postPlan?: PostPlan; editPlan?: EditPlanCard; trace?: Trace; todo?: TodoQueue; registry?: Registry }, cfg: PlansCfg | undefined): PlanDeps {
  return { ledger: d.ledger, cfg: cfg ?? DEFAULT_PLANS_CFG, postPlan: d.postPlan, editPlan: d.editPlan, trace: d.trace, todo: d.todo, registry: d.registry };
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
  /** The size guard moved this run to big (ADR-0072): each new plan version waits for the operator,
   *  whatever its text says. */
  forceApproval?: boolean;
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

/** Whether the engine recorded this plan done from its file alone (ADR-0035): done, yet it never
 *  reached the operator and no Execute ran it. Only this kind of done reopens when its file changes. */
function seenDone(plan: PlanRow): boolean {
  return plan.status === "done" && plan.version === 0 && plan.todoId === undefined;
}

/** A version's gate (ADR-0036): big → `approval`, else `info`. A plan that names a spec the operator
 *  already approved is `info` — one approval covers the design unit (ADR-0034 rule 4). */
function gateOf(deps: PlanDeps, folder: string, path: string, content: string): PlanGate {
  if (!classifyPlan(content, deps.cfg).big) return "info";
  const approved = (p: string) => {
    const row = deps.ledger.planByPath(folder, p);
    return !!row && (row.status === "approved" || row.status === "executing" || row.status === "done");
  };
  return !isSpec(path) && specRefs(content).some(approved) ? "info" : "approval";
}

/** What `register` did: the row, the unit's progress when it is finished, and whether the plan's
 *  state changed so its card must be redrawn. */
interface Registered {
  plan: PlanRow;
  finished?: Progress;
  changed?: boolean;
}

/** Register the file. A new version gets its gate (ADR-0036). A plan the operator never received is
 *  judged by its file (ADR-0035): finished → recorded done and never sent; a recorded-done one that
 *  has work again → draft, sent as usual. A plan the operator has (sent, approved, building) whose
 *  file is finished becomes done at the commit it was seen at (ADR-0036). */
function register(deps: PlanDeps, run: PlanRun, path: string, content: string): Registered {
  const { ledger } = deps;
  const prev = ledger.planByPath(run.folder, path);
  const fresh = !prev || prev.sha256 !== reviewHash(content) || !prev.gate;
  const gate = fresh ? (run.forceApproval ? "approval" : gateOf(deps, run.folder, path, content)) : prev.gate;
  let { plan } = registerPlan(ledger, { project: run.project, folder: run.folder, path, content, cause: run.cause, orderId: run.orderId, gate });
  // Revised into a small plan: nobody waits on it any more.
  if (plan.heldAt !== undefined && plan.gate === "info") plan = ledger.upsertPlan({ ...plan, heldAt: undefined });
  const unsentDraft = plan.status === "draft" && plan.version === 0;
  const finished = plan.status === "abandoned" || (plan.status === "done" && !seenDone(plan)) ? undefined : finishedUnit(deps.cfg, run.folder, path, content, deps.git);
  if (unsentDraft || seenDone(plan)) {
    if (!finished) return { plan: plan.status === "done" ? ledger.upsertPlan({ ...plan, status: "draft" }) : plan };
    if (!unsentDraft) return { plan, finished };
    const data = { project: plan.project, planId: plan.id, path, done: finished.done, total: finished.total, gated: finished.gated };
    ledger.recordEvent("plan_seen_done", { folder: run.folder, orderId: run.orderId, cause: run.cause, data });
    console.log(`[plans] ${join(run.folder, path)} first seen finished (${finished.done}/${finished.total}) — recorded done, not sent`);
    return { plan: ledger.upsertPlan({ ...plan, status: "done" }), finished };
  }
  if (!finished || plan.status === "done") return { plan };
  const doneSha = headSha(run.folder, deps.git)?.slice(0, 7);
  const done = ledger.upsertPlan({ ...plan, status: "done", ...(doneSha ? { doneSha } : {}) });
  ledger.recordEvent("plan_done", { folder: run.folder, orderId: run.orderId, cause: run.cause, data: { project: plan.project, planId: plan.id, path, commit: doneSha } });
  answerCard(deps, done, "done");
  return { plan: done, finished, changed: true };
}

/** Whether a send of this version would post a card (it is not finished and not already sent). */
function unsent(deps: PlanDeps, plan: PlanRow): boolean {
  return !!deps.postPlan && deps.cfg.send && plan.status !== "done" && plan.status !== "abandoned" && plan.sentSha256 !== plan.sha256;
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
async function sendPlan(deps: PlanDeps, plan: PlanRow, run: PlanRun, more = 0): Promise<SendOutcome> {
  if (!deps.postPlan || !deps.cfg.send || plan.status === "done" || plan.status === "abandoned") return "off";
  const key = `${plan.folder}\0${plan.path}\0${plan.sha256}`;
  if (plan.sentSha256 === plan.sha256 || posting.has(key)) return "already";
  posting.add(key);
  try {
    return await postVersion(deps, plan, run, deps.postPlan, more);
  } finally {
    posting.delete(key);
  }
}

/** The state line under a card's caption (Telegram is English; the console reads `planState`). */
function stateLine(deps: PlanDeps, plan: PlanRow): string {
  switch (planState(plan)) {
    case "awaiting": {
      const content = readPlan(plan.folder, plan.path, deps.cfg.maxBytes);
      const why = content ? classifyPlan(content, deps.cfg).reasons.join("; ") : "";
      return `⏸ waiting for your approval${why ? ` — ${why}` : ""}`;
    }
    case "info":
      return "ℹ️ small change — the worker is building it";
    case "approved":
      return "✅ approved — Approve & build starts it";
    case "building":
      return `🔨 building${plan.todoId !== undefined ? ` as todo #${plan.todoId}` : ""}`;
    case "done":
      return `✅ done${plan.doneSha ? ` · ${plan.doneSha}` : ""} · ${plan.stepsDone}/${plan.stepsTotal} steps`;
    case "dropped":
      return "✖ dropped";
    case "draft":
      return "";
  }
}

/** A card's caption: the plan line (`planCaption`) and its state line. */
export function cardCaption(deps: PlanDeps, plan: PlanRow, version = plan.version, more = 0): string {
  const ref = deps.trace && plan.threadId !== undefined ? deps.trace.ref(plan.threadId) : undefined;
  const line = stateLine(deps, plan);
  return `${planCaption(plan, version, ref, more)}${line ? `\n${line}` : ""}`;
}

/** Redraw the plan's newest card in place (ADR-0036): its caption and buttons follow the plan. The
 *  console reads the ledger, so its thread is refreshed. Best-effort: a failed edit is reported. */
export async function refreshCard(deps: PlanDeps, plan: PlanRow): Promise<void> {
  const trace = deps.trace;
  if (trace && plan.threadId !== undefined) faults.guard("plans.refreshThread", () => trace.refreshThread(plan.threadId!));
  if (!deps.editPlan || plan.cardChatId === undefined || plan.cardMessageId === undefined) return;
  try {
    await deps.editPlan({ chatId: plan.cardChatId, messageId: plan.cardMessageId }, { planId: plan.id, version: plan.version, caption: cardCaption(deps, plan), actions: planActions(plan) });
  } catch (e) {
    faults.report("plans.refreshCard", e, { project: plan.project, planId: plan.id });
  }
}

/** Open the plan's tracked review decision on its posted card: an `approval` card waits for the
 *  operator (reminded; a reply is the change request). An `info` card has none. */
function openReview(deps: PlanDeps, plan: PlanRow, at: { chatId: number; messageId: number }, run: Pick<PlanRun, "orderId" | "chatId" | "cause">): string {
  const id = deps.ledger.openDecision({
    kind: "decision",
    project: plan.project,
    folder: plan.folder,
    orderId: run.orderId,
    chatId: run.chatId,
    question: reviewQuestion(plan.path, plan.title),
    options: planActions({ status: "sent", gate: "approval" }).map((a) => PLAN_LABELS[a]),
    cause: run.cause,
  });
  deps.ledger.setDecisionMessage(id, at.chatId, at.messageId);
  return id;
}

async function postVersion(deps: PlanDeps, plan: PlanRow, run: PlanRun, postPlan: PostPlan, more: number): Promise<SendOutcome> {
  const { ledger, trace } = deps;
  const cause = run.cause;
  const version = plan.version + 1;
  const status = plan.status === "draft" ? "sent" : plan.status;
  const shown = { ...plan, status, threadId: plan.threadId ?? cause?.threadId };
  const caption = cardCaption(deps, shown, version, more);
  const actions = planActions(shown);
  const posted = await postPlan({ planId: plan.id, project: plan.project, folder: plan.folder, status, version, actions }, join(plan.folder, plan.path), caption);
  if (!posted) return "failed";
  // The older card no longer acts: it says what replaced it (ADR-0036).
  const before = ledger.planById(plan.id) ?? plan;
  if (deps.editPlan && before.cardChatId !== undefined && before.cardMessageId !== undefined) {
    const old = { chatId: before.cardChatId, messageId: before.cardMessageId };
    const superseded = `${planCaption(before, before.version)}\n↪ superseded by v${version}`;
    await deps.editPlan(old, { planId: before.id, version: before.version, caption: superseded, actions: [] }).catch((e) => faults.report("plans.supersede", e, { planId: before.id }));
  }
  // Re-read after every await: only the send's own fields change. A tap or a run end may have moved
  // the plan meanwhile (dropped it, or turned an `info` plan into one that waits), so the review
  // decision and the card follow the row as it is now, not as it was posted.
  const now = ledger.planById(plan.id) ?? plan;
  const previous = now.decisionId ? ledger.decisionById(now.decisionId) : undefined;
  const final = { ...now, status: now.status === "draft" ? ("sent" as const) : now.status };
  const waits = planState(final) === "awaiting" || planState(final) === "approved";
  const decisionId = waits ? openReview(deps, now, posted, run) : undefined;
  const sent = ledger.upsertPlan({
    ...final,
    decisionId,
    cardChatId: posted.chatId,
    cardMessageId: posted.messageId,
    sentAt: Date.now(),
    sentSha256: plan.sha256,
    version,
  });
  // The older card's question moved to this one (ADR-0053): closed with the reason, and a todo parked
  // on it now waits on the new card. Closing it re-derives its own thread, which may be another one.
  if (previous?.status === "open") ledger.supersedeDecision(previous.id, `replaced by plan card v${version}`, Date.now(), decisionId ? { moveParkedTo: decisionId } : {});
  if (planState(sent) !== planState(shown) || sent.status !== shown.status) await refreshCard(deps, sent);
  ledger.recordEvent("plan_sent", { folder: plan.folder, orderId: run.orderId, cause, data: { project: plan.project, planId: plan.id, path: plan.path, version, gate: plan.gate } });
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
 *  names how many more wait in `/plans`. A plan that became done gets its card redrawn. Every plan
 *  the run left unfinished waits for Approve & build — an `info` card included (ADR-0036): nobody is
 *  building it now. Each file is its own unit (ADR-0010): one that throws is reported and the rest
 *  still go. */
export async function onRunEndPlans(deps: PlanDeps, run: PlanRun): Promise<void> {
  const toSend: PlanRow[] = [];
  for (const path of changedPlanFiles(run.folder, run.startSha, deps.cfg.paths, deps.git)) {
    try {
      const content = readPlan(run.folder, path, deps.cfg.maxBytes);
      if (content === undefined) continue;
      let { plan, changed } = register(deps, run, path, content);
      // The run is over, so nobody builds an unfinished plan now: it waits for Approve & build.
      if (plan.gate === "info" && (plan.status === "draft" || plan.status === "sent")) {
        const posted = plan.status === "sent" && plan.cardChatId !== undefined && plan.cardMessageId !== undefined;
        const decisionId = posted ? openReview(deps, plan, { chatId: plan.cardChatId!, messageId: plan.cardMessageId! }, run) : plan.decisionId;
        plan = deps.ledger.upsertPlan({ ...plan, gate: "approval", decisionId });
        changed = posted;
      }
      if (changed) await refreshCard(deps, plan);
      if (unsent(deps, plan)) toSend.push(plan);
    } catch (e) {
      faults.report("plans.runEnd", e, { project: run.project, folder: run.folder, path });
    }
  }
  // Post until `cap` cards have landed; the one that would be the last carries the count still
  // waiting (those after it, and those whose post failed), so a failed post passes the note on.
  const cap = deps.cfg.maxPerRun;
  let landed = 0;
  let missed = 0;
  for (let i = 0; i < toSend.length && landed < cap; i++) {
    const plan = toSend[i]!;
    try {
      const out = await sendPlan(deps, plan, run, landed === cap - 1 ? toSend.length - i - 1 + missed : 0);
      if (out === "sent") landed++;
      else if (out === "failed") missed++;
    } catch (e) {
      missed++;
      faults.report("plans.runEnd", e, { project: run.project, folder: run.folder, path: plan.path });
    }
  }
}

/** A plan file a running worker just wrote (ADR-0036; `path` relative to the folder): registered now,
 *  its card sent now (not at the run end), and the row returned so the watch can hold a big one.
 *  Undefined when it is not a readable plan. The send is detached; `sent` settles when it is done. */
export function notePlanWritten(deps: PlanDeps, run: PlanRun, path: string): { plan: PlanRow; sent: Promise<boolean> } | undefined {
  const content = readPlan(run.folder, path, deps.cfg.maxBytes);
  if (content === undefined) return undefined;
  const { plan, changed } = register(deps, run, path, content);
  // Settles true when this version's card is with the operator (posted now, or already).
  const sent = (async () => {
    if (changed) await refreshCard(deps, plan);
    if (unsent(deps, plan)) return (await sendPlan(deps, plan, run)) === "sent" || deps.ledger.planById(plan.id)?.sentSha256 === plan.sha256;
    return deps.ledger.planById(plan.id)?.sentSha256 === plan.sha256;
  })().catch((e) => {
    faults.report("plans.written", e, { project: run.project, folder: run.folder, path });
    return false;
  });
  return { plan, sent };
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
  const { plan, finished, changed } = register(deps, p, p.path, content);
  // Recorded done from its file (ADR-0035): no card and no plain file either.
  if (finished && seenDone(plan)) return { handled: true, text: `already done: ${p.path} — ${finished.done}/${finished.total} steps ticked; recorded as done, not sent to the operator` };
  if (changed) await refreshCard(deps, plan);
  switch (await sendPlan(deps, plan, p)) {
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

/** Close the plan's open decision with the action taken, and re-derive its thread. A todo parked on the
 *  card (ADR-0029) is released first: the plan is now built as its own todo, done or dropped, so that
 *  wait is over — it is cancelled with the reason, never left waiting on a closed card (ADR-0053). */
function answerCard(deps: PlanDeps, plan: PlanRow, action: PlanAction): void {
  const dec = plan.decisionId ? deps.ledger.decisionById(plan.decisionId) : undefined;
  if (dec?.status === "open") {
    const row = deps.ledger.planById(plan.id) ?? plan;
    const reason = row.status === "executing" && row.todoId !== undefined ? `plan executing as #${row.todoId}` : `plan ${planState(row)}`;
    for (const t of deps.ledger.listTodos({ statuses: ["waiting"], limit: PAGE_MAX })) {
      if (t.waitingOn === dec.id) deps.ledger.updateTodo(t.id, { status: "cancelled", endedAt: Date.now(), result: reason, waitingOn: null });
    }
    deps.ledger.resolveDecision(dec.id, PLAN_LABELS[action]);
  }
  const trace = deps.trace;
  if (trace && plan.threadId !== undefined) faults.guard("plans.refreshThread", () => trace.refreshThread(plan.threadId!));
}

/** What a plan action answers. `offer: "anyway"`: the reply offers Run anyway (a done plan).
 *  `resume`: Approve & build on a plan a worker is held on — the frontend answers this decision with
 *  `answer` through its decision-answer path, which resumes that same worker (ADR-0036). */
export interface PlanActionResult {
  ok: boolean;
  text: string;
  offer?: "anyway";
  resume?: { decisionId: string; answer: string };
}

/** The brief a held worker resumes with on Approve & build. */
export function approvalAnswer(cfg: PlansCfg, path: string): string {
  return `Approved by the operator. ${cfg.executeBrief.replaceAll("{path}", path)}`;
}

/** An operator tap (Telegram, web, a command). The plan moves only here and on the checkbox count.
 *  `version`: the card's version — a tap on an older card than the newest sent is refused.
 *  `canResume`: the caller can answer a decision and resume its worker (Telegram, the console). */
export async function applyPlanAction(deps: PlanDeps, planId: number, action: PlanAction, version?: number, opts: { canResume?: boolean } = {}): Promise<PlanActionResult> {
  const { ledger } = deps;
  const plan = ledger.planById(planId);
  if (!plan) return { ok: false, text: `no plan #${planId}` };
  if (version !== undefined && version !== plan.version) return { ok: false, text: `this card is v${version} — the newest is v${plan.version}; use that card` };
  const builds = action === "approve" || action === "execute" || action === "anyway";
  // Building acts on the text the operator read: refused when the file changed after the newest card
  // and that version has not reached them yet (held back by the cap, or its post failed). Only while
  // a new card can still come: with sending off, there is nothing to wait for.
  if (builds && deps.postPlan && deps.cfg.send && plan.sentSha256 !== undefined && plan.sentSha256 !== plan.sha256) {
    return { ok: false, text: `the plan changed after its newest card (v${plan.version}) — wait for the new card, or see /plans` };
  }
  if (plan.status === "done" || plan.status === "abandoned") return { ok: false, text: `this plan is already ${plan.status === "done" ? "done" : "dropped"}` };
  // The card's buttons are the rule on every surface: an action its state does not offer is refused.
  if (!planActions(plan).includes(builds ? "approve" : action)) {
    if (builds) return { ok: false, text: plan.status === "executing" ? `already building${plan.todoId !== undefined ? ` as #${plan.todoId}` : ""}` : "the worker is building it — Stop cancels it" };
    return { ok: false, text: `a plan that is ${planState(plan)} cannot be ${action === "done" ? "marked done" : action === "stop" ? "stopped" : "changed here"}` };
  }
  switch (action) {
    case "changes":
      return { ok: true, text: "Reply to the plan with your changes — they go to the worker that wrote it." };
    case "done":
      return settle(deps, plan, "done", action, "Marked done");
    case "drop":
      return settle(deps, plan, "abandoned", action, "Dropped");
    case "stop": {
      const live = deps.registry?.findByFolder(plan.folder);
      if (live?.status === "running") void deps.registry!.getControl(live.id)?.interrupt();
      return settle(deps, plan, "abandoned", action, live?.status === "running" ? `Stopped — ${live.name} interrupted` : "Stopped");
    }
    case "approve": {
      // A worker held on this plan resumes and builds it: the frontend answers its decision.
      const dec = plan.decisionId ? ledger.decisionById(plan.decisionId) : undefined;
      if (opts.canResume && plan.heldAt !== undefined && dec?.status === "open") {
        const building = ledger.upsertPlan({ ...plan, status: "executing", heldAt: undefined });
        ledger.recordEvent("plan_approved", { folder: plan.folder, data: { planId: plan.id, path: plan.path, resumed: true } });
        await refreshCard(deps, building);
        return { ok: true, text: "Approved — the worker that wrote it builds it now", resume: { decisionId: dec.id, answer: approvalAnswer(deps.cfg, plan.path) } };
      }
      return executePlan(deps, plan, false);
    }
    case "execute":
    case "anyway":
      return executePlan(deps, plan, action === "anyway");
  }
}

/** A tap that ends the plan's review: the new status, the decision closed, the card redrawn. */
async function settle(deps: PlanDeps, plan: PlanRow, status: PlanStatus, action: PlanAction, text: string): Promise<PlanActionResult> {
  const row = deps.ledger.upsertPlan({ ...plan, status });
  answerCard(deps, plan, action);
  await refreshCard(deps, row);
  return { ok: true, text };
}

/** Execute (ADR-0034): judge it first. Only a `run` verdict queues a todo, for the plan row of the
 *  folder that runs it (registered if that folder never sent the plan). Every other verdict is a reply
 *  that says why nothing new started. */
async function executePlan(deps: PlanDeps, plan: PlanRow, anyway: boolean): Promise<PlanActionResult> {
  const { ledger } = deps;
  const launcher = deps.todo?.launcher();
  if (!deps.todo || !launcher) return { ok: false, text: "the todo queue is unavailable — Execute needs it" };
  const verdict = judgeExecute(deps, plan, { anyway });
  if (verdict.kind !== "run") {
    ledger.recordEvent("plan_execute_refused", { folder: plan.folder, data: { planId: plan.id, path: plan.path, verdict: verdict.kind } });
    return { ok: false, text: verdictText(verdict), ...(verdict.kind === "done" ? { offer: "anyway" as const } : {}) };
  }
  let target = plan;
  if (verdict.folder !== plan.folder || verdict.path !== plan.path) {
    const content = readPlan(verdict.folder, verdict.path, deps.cfg.maxBytes);
    if (content === undefined) return { ok: false, text: `cannot read ${join(verdict.folder, verdict.path)} — nothing started` };
    const known = ledger.planByPath(verdict.folder, verdict.path);
    target = registerPlan(ledger, { project: known?.project ?? deps.registry?.findByFolder(verdict.folder)?.name ?? basename(verdict.folder), folder: verdict.folder, path: verdict.path, content }).plan;
  }
  const rows = target.id === plan.id ? [plan] : [plan, target];
  const cause = plan.decisionId ? ledger.decisionById(plan.decisionId)?.cause : undefined;
  // Marked before the await, so a second tap meanwhile is refused instead of queueing twice. After
  // it, only status and todo are written over a fresh read (a run end may have moved the plan).
  const before = rows.map((r) => ({ id: r.id, status: r.status }));
  for (const r of rows) ledger.upsertPlan({ ...r, status: "executing" });
  const setStatus = (patch: (id: number) => Pick<PlanRow, "status"> & Partial<Pick<PlanRow, "todoId">>) => {
    for (const { id } of before) {
      const now = ledger.planById(id);
      if (now) ledger.upsertPlan({ ...now, ...patch(id) });
    }
  };
  const restore = () => setStatus((id) => ({ status: before.find((b) => b.id === id)!.status }));
  const brief = deps.cfg.executeBrief.replaceAll("{path}", target.path);
  let text: string;
  try {
    // Returns once the todo is queued or its run has started — never after the run (dispatch runs in the background).
    text = await deps.todo.submit({ project: verdict.folder, brief, workClass: "interactive", cause, planId: target.id }, launcher.deps, launcher.replyChat);
  } catch (e) {
    restore();
    throw e;
  }
  const todo = ledger.todoForPlan(target.id);
  if (!todo || todo.status === "cancelled") {
    restore(); // refused or held: nothing runs, the plan stays where it was
    return { ok: false, text };
  }
  setStatus(() => ({ status: "executing", todoId: todo.id }));
  answerCard(deps, plan, "execute");
  for (const { id } of before) {
    const row = ledger.planById(id);
    if (row) await refreshCard(deps, row);
  }
  const where = verdict.notes.length ? ` — ${verdict.notes.join("; ")}` : "";
  return { ok: true, text: `Executing ${target.path} as todo #${todo.id}${where}` };
}

/** `/plans [project]`: newest first, bounded — state (as on the card), checked steps, project, title,
 *  thread ref, path. */
export function renderPlans(ledger: Ledger, trace: Trace | undefined, project?: string): string {
  const rows = ledger.listPlans(project, 20);
  if (!rows.length) return project ? `No plans for ${project} yet.` : "No plans yet.";
  const lines = rows.map((p) => {
    const ref = trace && p.threadId !== undefined ? ` · ${trace.ref(p.threadId)}` : "";
    return `#${p.id} · ${planState(p)} · ${p.stepsDone}/${p.stepsTotal} · ${p.project} · ${p.title}${ref}\n  ${p.path}`;
  });
  return `📄 Plans${project ? ` — ${project}` : ""} (newest first):\n${lines.join("\n")}`;
}
