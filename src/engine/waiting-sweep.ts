// The waiting sweep (ADR-0045): the hourly pass over WAITING threads. Deterministic — no AI decides
// here. It re-derives the threads (ADR-0038 settles what it can), finds the decisions whose repository
// moved since they were last judged (only those need a worker), closes a decision only on evidence it
// checks itself (a commit or a tracked file newer than the question — the ADR-0043 pattern), and
// builds the one operator reminder, printed only when the list changed. `tools/threads/sweep.ts` is
// the CLI over it; the `waiting-sweep` loop runs `check` as its goal.
import { createHash } from "node:crypto";
import { hasCommit, type GitRunner } from "./git-read";
import type { Ledger } from "./ledger";

/** Config `waitingSweep` (docs/CONFIG.md). */
export interface WaitingSweepCfg {
  /** A decision kept open is judged again only after this long, and only if its repo moved. */
  rejudgeAfterMs: number;
  /** Most threads the reminder lists before "…and N more". */
  reminderMaxLines: number;
  /** A question older than this many days is overdue (ADR-0054): listed first with its age, and the
   *  reminder is sent once more when it crosses the line. */
  escalateAfterDays: number;
}

export const DEFAULT_WAITING_SWEEP_CFG: WaitingSweepCfg = { rejudgeAfterMs: 6 * 3_600_000, reminderMaxLines: 15, escalateAfterDays: 3 };

/** Parse the config value; a missing or bad field keeps its default. */
export function readWaitingSweepCfg(raw: unknown): WaitingSweepCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_WAITING_SWEEP_CFG };
  for (const k of Object.keys(out) as Array<keyof WaitingSweepCfg>) {
    const v = r[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

export interface SweepDeps {
  ledger: Pick<Ledger, "threadsByState" | "threadById" | "decisionSettleFacts" | "decisionSettleFactsByIds" | "listOpenDecisions" | "decisionById" | "supersedeDecision" | "markPlanDoneByCard" | "getMeta" | "setMeta">;
  /** Re-derive one thread (trace.refreshThread: ADR-0038 settle, then the state rule). */
  refresh: (threadId: number) => void;
  git: GitRunner;
  now: () => number;
  cfg: WaitingSweepCfg;
  /** A thread's message ref (`m7nk8`). */
  ref: (threadId: number) => string;
}

/** One open decision — of a WAITING thread, or with no thread at all (ADR-0054) — with what the sweep
 *  needs to judge it. */
export interface WaitingDecision {
  id: string;
  /** None: the decision is older than the trace spine (or an escalation with no cause). */
  threadId?: number;
  threadUpdatedAt: number;
  project?: string;
  folder?: string;
  question: string;
  createdAt: number;
  /** A plan card: it follows its plan (ADR-0036); an evidence close marks the plan done (ADR-0054). */
  plan: boolean;
  /** The repository the decision's folder is in, when it is in one. */
  repo?: string;
  /** Newest commit on any ref of `repo`, ms. */
  latestCommitAt?: number;
}

/** A judgement kept in meta `waitingSweep.judged`: when, against which repo state, and the ask. */
export interface Judged {
  at: number;
  commitAt: number;
  ask: string;
  /** Set when `check` offered the decision to the worker; `keep` (a verdict) clears it. */
  offeredAt?: number;
}

export const JUDGED_KEY = "waitingSweep.judged";
const REMINDER_KEY = "waitingSweep.reminder";
const PAGE = 100;

function judgedMap(deps: SweepDeps): Record<string, Judged> {
  const v = deps.ledger.getMeta(JUDGED_KEY)?.value;
  return v && typeof v === "object" ? (v as Record<string, Judged>) : {};
}

/** Every WAITING thread, newest-updated first (threadsByState pages oldest-first by updated_at). */
function waitingThreads(deps: SweepDeps) {
  const seen = new Map<number, ReturnType<SweepDeps["ledger"]["threadsByState"]>[number]>();
  let since: number | undefined;
  for (;;) {
    const page = deps.ledger.threadsByState("waiting", { ...(since !== undefined ? { since } : {}), limit: PAGE });
    const fresh = page.filter((t) => !seen.has(t.id));
    for (const t of fresh) seen.set(t.id, t);
    if (page.length < PAGE || fresh.length === 0) break;
    since = Math.max(...page.map((t) => t.updatedAt));
  }
  return [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
}

/** The repository a folder is in. A removed worktree falls back to the repo it was made from. */
function repoOf(git: GitRunner, folder: string): string | undefined {
  const top = git(folder, ["rev-parse", "--show-toplevel"])?.trim();
  if (top) return top;
  const i = folder.indexOf("/.worktrees/");
  return i > 0 ? git(folder.slice(0, i), ["rev-parse", "--show-toplevel"])?.trim() || undefined : undefined;
}

/** Seconds-since-epoch text from git → ms; undefined when git said nothing usable. */
function gitTime(out: string | undefined): number | undefined {
  const n = Number(out?.trim().split("\n")[0]);
  return out && Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

/** The open decisions of every WAITING thread, newest thread first. Git is asked once per repo. */
export function waitingDecisions(deps: SweepDeps): WaitingDecision[] {
  const repos = new Map<string, { repo?: string; latest?: number }>();
  const repoFacts = (folder: string) => {
    let r = repos.get(folder);
    if (!r) {
      const repo = repoOf(deps.git, folder);
      r = repo ? { repo, latest: gitTime(deps.git(repo, ["log", "--all", "-1", "--format=%ct"])) } : {};
      repos.set(folder, r);
    }
    return r;
  };
  const out: WaitingDecision[] = [];
  for (const t of waitingThreads(deps)) {
    const f = deps.ledger.decisionSettleFacts(t.id);
    for (const d of [...f.open].sort((a, b) => a.createdAt - b.createdAt)) {
      const row = deps.ledger.decisionById(d.id);
      const facts = d.folder ? repoFacts(d.folder) : {};
      out.push({
        id: d.id,
        threadId: t.id,
        threadUpdatedAt: t.updatedAt,
        ...(row?.project ? { project: row.project } : t.project ? { project: t.project } : {}),
        ...(d.folder ? { folder: d.folder } : {}),
        question: d.question,
        createdAt: d.createdAt,
        plan: f.planOf[d.id] !== undefined,
        ...(facts.repo ? { repo: facts.repo } : {}),
        ...(facts.latest !== undefined ? { latestCommitAt: facts.latest } : {}),
      });
    }
  }
  // Decisions with no thread are judged too (ADR-0054): nothing else would ever look at them again.
  const loose = deps.ledger.listOpenDecisions().filter((d) => !d.cause);
  const lf = deps.ledger.decisionSettleFactsByIds(loose.map((d) => d.id));
  for (const d of loose) {
    const facts = d.folder ? repoFacts(d.folder) : {};
    out.push({
      id: d.id,
      threadUpdatedAt: d.createdAt,
      ...(d.project ? { project: d.project } : {}),
      ...(d.folder ? { folder: d.folder } : {}),
      question: d.question,
      createdAt: d.createdAt,
      plan: lf.planOf[d.id] !== undefined,
      ...(facts.repo ? { repo: facts.repo } : {}),
      ...(facts.latest !== undefined ? { latestCommitAt: facts.latest } : {}),
    });
  }
  return out;
}

/** A decision needs a worker's judgement: never judged, or its repo moved since and the last
 *  judgement is old enough. A decision outside a repository never does. A plan card does (ADR-0054):
 *  evidence that it was built marks its plan done. */
export function needsJudging(d: WaitingDecision, j: Judged | undefined, cfg: WaitingSweepCfg, now: number): boolean {
  if (!d.repo) return false;
  if (!j) return true;
  return d.latestCommitAt !== undefined && d.latestCommitAt > j.commitAt && now - j.at >= cfg.rejudgeAfterMs;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The operator reminder: one line per thread, capped; "" when nothing waits. The fingerprint covers
 *  every decision and ask, so any change (new, closed, re-asked) makes a new reminder. */
export function reminder(list: WaitingDecision[], judged: Record<string, Judged>, cfg: WaitingSweepCfg, ref: (threadId: number) => string, now: number = Date.now()): { text: string; fingerprint: string } {
  if (list.length === 0) return { text: "", fingerprint: "" };
  const overdueAt = now - cfg.escalateAfterDays * DAY_MS;
  const overdue = (d: WaitingDecision) => d.createdAt <= overdueAt;
  // One line per thread; a decision with no thread is its own line, named by its id.
  const groups = new Map<string, { label: string; ds: WaitingDecision[] }>();
  for (const d of list) {
    const key = d.threadId !== undefined ? `t${d.threadId}` : `d${d.id}`;
    const g = groups.get(key) ?? { label: d.threadId !== undefined ? ref(d.threadId) : `#${d.id.slice(0, 8)}`, ds: [] };
    g.ds.push(d);
    groups.set(key, g);
  }
  // Overdue first, oldest first (ADR-0054); the rest keep their order.
  const oldest = (ds: WaitingDecision[]) => Math.min(...ds.map((d) => d.createdAt));
  const ordered = [...groups.values()]
    .map((g, i) => ({ ...g, i, at: oldest(g.ds), late: g.ds.some(overdue) }))
    .sort((a, b) => (a.late === b.late ? (a.late ? a.at - b.at : a.i - b.i) : a.late ? -1 : 1));
  const lines = ordered.map(({ label, ds, at, late }) => {
    const lead = ds.find((d) => judged[d.id]?.ask) ?? ds[0]!;
    const more = ds.length > 1 ? ` (+${ds.length - 1} more)` : "";
    const age = late ? `⚠ ${Math.floor((now - at) / DAY_MS)}d ` : "";
    return `• ${age}${label} ${lead.project ?? "-"} — ${clip(judged[lead.id]?.ask || lead.question, 120)}${more}`;
  });
  const shown = lines.slice(0, cfg.reminderMaxLines);
  const rest = lines.length - shown.length;
  const text = [`⏳ Waiting on you (${lines.length}):`, ...shown, ...(rest > 0 ? [`…and ${rest} more`] : [])].join("\n");
  // The overdue flag is in the fingerprint, the age is not: crossing the line re-sends once, then quiet.
  const fingerprint = createHash("sha256")
    .update(list.map((d) => `${d.threadId ?? "-"}:${d.id}:${judged[d.id]?.ask ?? ""}:${overdue(d) ? "late" : ""}`).sort().join("\n"))
    .digest("hex");
  return { text, fingerprint };
}

const DAY_MS = 86_400_000;

/** The loop's goal. Re-derive every WAITING thread, then: decisions to judge → not met (a worker
 *  runs); none → met, and `out` is the reminder when it changed (else ""). */
export function check(deps: SweepDeps): { met: boolean; out: string; toJudge: WaitingDecision[] } {
  for (const t of waitingThreads(deps)) deps.refresh(t.id);
  const list = waitingDecisions(deps);
  const judged = judgedMap(deps);
  const now = deps.now();
  const toJudge = list.filter((d) => needsJudging(d, judged[d.id], deps.cfg, now));
  // Keep only the judgements of decisions still on the list, and mark the ones offered to the worker
  // as judged now (keeping any earlier ask): a worker that judges nothing must not block the
  // reminder for the rest of the run, nor be paid for again before `rejudgeAfterMs` (ADR-0045).
  const live = new Set(list.map((d) => d.id));
  const kept: Record<string, Judged> = Object.fromEntries(Object.entries(judged).filter(([id]) => live.has(id)));
  for (const d of toJudge) kept[d.id] = { at: now, commitAt: d.latestCommitAt ?? 0, ask: judged[d.id]?.ask ?? "", offeredAt: now };
  if (toJudge.length || Object.keys(kept).length !== Object.keys(judged).length) deps.ledger.setMeta(JUDGED_KEY, kept, now);
  if (toJudge.length) return { met: false, out: "", toJudge };
  const r = reminder(list, kept, deps.cfg, deps.ref, now);
  const last = deps.ledger.getMeta(REMINDER_KEY)?.value as { fingerprint?: string } | undefined;
  if (r.fingerprint === (last?.fingerprint ?? "")) return { met: true, out: "", toJudge };
  deps.ledger.setMeta(REMINDER_KEY, { fingerprint: r.fingerprint }, now);
  return { met: true, out: r.text, toJudge };
}

/** The one open decision (in a WAITING thread) an 8+-character id prefix names. */
function findOne(deps: SweepDeps, id8: string): WaitingDecision | string {
  const key = id8.trim().toLowerCase();
  const hits = key.length >= 8 ? waitingDecisions(deps).filter((d) => d.id.toLowerCase().startsWith(key)) : [];
  if (hits.length === 1) return hits[0]!;
  return hits.length === 0 ? `no open decision #${key} to judge` : `#${key} names ${hits.length} decisions — give more of the id`;
}

const SHA = /^[0-9a-f]{7,40}$/;

/** Close a decision on evidence the engine checks: a commit (exists, newer than the question) or a
 *  tracked file last changed after the question. Supersedes it with the reason and evidence, cancels
 *  the todos parked on it, re-derives its thread. A plan card follows its plan (ADR-0036): the evidence
 *  marks the PLAN done, then the card closes (ADR-0054). */
export function closeWithEvidence(
  deps: SweepDeps,
  id8: string,
  ev: { commit?: string; file?: string },
  reason: string,
): { ok: true; thread: string; todosCancelled: number[] } | { ok: false; why: string } {
  const d = findOne(deps, id8);
  if (typeof d === "string") return { ok: false, why: d };
  if ((ev.commit === undefined) === (ev.file === undefined)) return { ok: false, why: "give exactly one of --commit or --file" };
  const why = reason.trim();
  if (why.length < 10 || why.length > 300) return { ok: false, why: "reason must be 10–300 characters" };
  const repo = d.repo;
  if (!repo) return { ok: false, why: `${d.folder ?? "its folder"} is not in a git repository` };
  let label: string;
  if (ev.commit !== undefined) {
    const sha = ev.commit.trim().toLowerCase();
    if (!SHA.test(sha)) return { ok: false, why: "commit must be a hex sha" };
    if (!hasCommit(repo, sha, deps.git)) return { ok: false, why: `commit ${sha} is not in ${repo}` };
    const at = gitTime(deps.git(repo, ["show", "-s", "--format=%ct", sha]));
    if (at === undefined || at <= d.createdAt) return { ok: false, why: `commit ${sha} is older than the question` };
    label = `commit ${sha}`;
  } else {
    const path = ev.file!.trim();
    // A pathspec glob or magic (`*`, `:(glob)…`, `:/`) would match any tracked file and turn "this
    // file changed" into "anything changed": refuse it, and read the path literally anyway.
    if (/[*?[\]:\\]/.test(path)) return { ok: false, why: "file must be a plain path (no wildcards or pathspec magic)" };
    if (!path || path.startsWith("/") || path.startsWith("-") || path.split("/").includes("..")) return { ok: false, why: "file must be a path inside the repository" };
    if (deps.git(repo, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path]) === undefined) return { ok: false, why: `file ${path} is not tracked in ${repo}` };
    const at = gitTime(deps.git(repo, ["--literal-pathspecs", "log", "-1", "--format=%ct", "--", path]));
    if (at === undefined || at <= d.createdAt) return { ok: false, why: `file ${path} was last changed before the question` };
    label = `file ${path}`;
  }
  if (d.plan && deps.ledger.markPlanDoneByCard(d.id, `${why} (${label})`, deps.now()) === undefined) {
    return { ok: false, why: "its plan no longer awaits approval — it closes with its plan (/plans)" };
  }
  const { todosCancelled } = deps.ledger.supersedeDecision(d.id, `${d.plan ? "plan done" : "done"} by later work: ${why} (${label})`, deps.now());
  const judged = judgedMap(deps);
  if (judged[d.id]) {
    delete judged[d.id];
    deps.ledger.setMeta(JUDGED_KEY, judged, deps.now());
  }
  if (d.threadId !== undefined) deps.refresh(d.threadId);
  return { ok: true, thread: d.threadId !== undefined ? deps.ref(d.threadId) : "no thread", todosCancelled };
}

/** Record that a worker judged a decision still open, with the one-line ask the reminder shows. */
export function keepJudged(deps: SweepDeps, id8: string, ask: string): { ok: true } | { ok: false; why: string } {
  const d = findOne(deps, id8);
  if (typeof d === "string") return { ok: false, why: d };
  const text = ask.replace(/\s+/g, " ").trim();
  if (text.length < 5 || text.length > 160) return { ok: false, why: "ask must be 5–160 characters" };
  const judged = judgedMap(deps);
  judged[d.id] = { at: deps.now(), commitAt: d.latestCommitAt ?? 0, ask: text };
  deps.ledger.setMeta(JUDGED_KEY, judged, deps.now());
  return { ok: true };
}
