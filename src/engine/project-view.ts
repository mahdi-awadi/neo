/** The project dashboard's read model (spec §9, P6): one view of a project — what runs now, its
 *  queue, git and GitHub state, open decisions, plans, attention items, recent threads, restart-gated
 *  work (Neo only) and health. The web Projects tab, `/project <name>` and the company's `sessions`
 *  tool all read it. Git facts are read LIVE through git-read (bounded, never throws); everything else
 *  comes from the ledger and the registry. Each part is its own unit (ADR-0010): a part that fails is
 *  reported and left empty — projectView never throws. Plain code, no AI. */
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Ledger, PlanStatus, ThreadState, AttentionSeverity, AttentionSource } from "./ledger";
import type { Registry } from "./registry";
import type { SessionInfo } from "../types";
import type { SessionState } from "./liveness";
import { aheadOf, parseWorktrees, uncommittedFrom, type GitRead, type GitResult } from "./git-read";
import type { ProjectCfg } from "./producers/git";
import type { ScanMeta } from "./producers/scan";
import { activeTodos, type DashTodo } from "./dashboard";
import { describeSession, stateOf } from "./session-status";
import { listOpen } from "./attention";
import { attentionActions, type AttentionAction } from "./attention-actions";
import { msgRef } from "./trace";
import { faults } from "./fault";

/** Recent threads a project view lists (spec §9). */
const THREADS_SHOWN = 10;
/** Plans a project view lists (open ones, newest first). */
const PLANS_SHOWN = 10;
/** Open decisions a project view lists. */
const DECISIONS_SHOWN = 20;

const SEP = "\u001f";

export type ProjectHealth = "ok" | "attention" | "down" | "unknown";

/** What `probe:<project>` holds (written by the deployed-version/health probe, P6 6.3). */
export interface ProbeMeta {
  at: number;
  ok: boolean;
  error?: string;
}

export interface ThreadSummary {
  id: number;
  ref: string;
  title: string;
  state: ThreadState;
  updatedAt: number;
}

export interface AttentionItemView {
  id: number;
  source: AttentionSource;
  kind: string;
  severity: AttentionSeverity;
  title: string;
  detail?: string;
  url?: string;
  /** Since the item was first seen. */
  ageMs: number;
  todoId?: number;
  actions: AttentionAction[];
}

export interface RestartGatedItem {
  key: string;
  title: string;
  detail?: string;
}

/** Live git facts; a field whose read failed is absent and `error` names it. */
export interface ProjectGit {
  branch?: string;
  /** Short sha and subject of HEAD. */
  lastCommit?: string;
  lastCommitAt?: number;
  /** Commits on the checked-out branch ahead of its upstream (0 when detached; absent with no upstream). */
  unpushed?: number;
  /** The checked-out branch has no upstream, or its upstream is gone: nothing says what is pushed. */
  noUpstream?: true;
  /** Uncommitted files (the one rule: HANDOFF.md is not work). */
  dirty?: number;
  /** The first configured drift pair (`projects.<name>.driftPairs`). */
  drift?: { from: string; to: string; ahead: number };
  /** Other linked worktrees: not the main checkout, not this folder, not prunable (folder gone). */
  worktrees?: number;
  /** Only when `deployedVersionUrl` is configured (filled by the 6.3 probe). */
  undeployed?: number;
  error?: string;
}

export interface ProjectGithub {
  prs: number;
  ciFailed: number;
  issues: number;
  alerts: number;
  /** The last scan in which every read worked. */
  scannedAt?: number;
  error?: string;
}

export interface ProjectPlan {
  id: number;
  title: string;
  /** Unchanged when the file is gone (spec §11.7). */
  status: PlanStatus;
  steps: string;
  ref?: string;
  fileMissing?: true;
  /** One line for every surface: title, status, steps, "file missing". */
  line: string;
}

export interface ProjectView {
  name: string;
  folder: string;
  now: { state: SessionState; line: string; thread?: ThreadSummary } | null;
  queue: DashTodo[];
  git: ProjectGit;
  github: ProjectGithub;
  decisions: Array<{ id: string; question: string; ageMs: number; ref?: string }>;
  plans: ProjectPlan[];
  attention: AttentionItemView[];
  threads: ThreadSummary[];
  restartGated?: RestartGatedItem[];
  health: ProjectHealth;
}

/** The list form (no git facts): what the project list and the `sessions` tool line show. */
export interface ProjectSummary {
  name: string;
  folder: string;
  state?: SessionState;
  line?: string;
  queue: number;
  attention: Record<AttentionSeverity, number>;
  health: ProjectHealth;
}

export interface ProjectViewDeps {
  ledger: Ledger;
  registry: Registry;
  /** The bounded git reader (createGitRead with github.callTimeoutMs). */
  read: GitRead;
  /** config `projects`. */
  projects: Record<string, ProjectCfg>;
  /** Neo's own repo: its view carries the restart-gated work. */
  neoFolder: string;
}

/** The health rule (spec §9): `down` when a configured healthUrl's last probe failed; `attention`
 *  when a high item is open; `unknown` with no data at all; else `ok`. */
export function projectHealth(i: { healthUrl?: string; probe?: ProbeMeta; high: number; hasData: boolean }): ProjectHealth {
  if (i.healthUrl && i.probe?.ok === false) return "down";
  if (i.high > 0) return "attention";
  if (!i.hasData) return "unknown";
  return "ok";
}

/** The folder a project name means (name = the folder's basename): Neo itself, a session's folder, a
 *  folder the ledger has orders for, else a queued todo's (a new project not run yet). Undefined: the
 *  engine knows no such project. */
export function projectFolder(d: Pick<ProjectViewDeps, "ledger" | "registry" | "neoFolder">, name: string): string | undefined {
  if (basename(d.neoFolder) === name) return d.neoFolder;
  const s = d.registry.list().find((x) => basename(x.order.folder) === name);
  if (s) return s.order.folder;
  return d.ledger.folderNamed(name);
}

/** One part of a view, contained: a throw is reported and the part falls back. */
function part<T>(component: string, project: string, fn: () => T, fallback: T): T {
  const r = faults.guard(`projectView.${component}`, fn, { project });
  return r === undefined ? fallback : r;
}

function threadSummary(t: { id: number; title: string; state: ThreadState; updatedAt: number }): ThreadSummary {
  return { id: t.id, ref: msgRef(t.id), title: t.title, state: t.state, updatedAt: t.updatedAt };
}

/** The facts both forms share. */
function common(d: Omit<ProjectViewDeps, "read">, name: string, folder: string, now: number) {
  const session = part("session", name, () => d.registry.findByFolder(folder), undefined);
  const queue = part("queue", name, () => activeTodos(d.ledger, folder), []);
  const open = part("attention", name, () => listOpen(d.ledger, { project: name, now }), []);
  const threads = part("threads", name, () => d.ledger.listThreads({ project: name }, { limit: THREADS_SHOWN }).rows.map(threadSummary), []);
  const scan = part("scanMeta", name, () => d.ledger.getMeta(`gh:${name}`)?.value as ScanMeta | undefined, undefined);
  const health = part(
    "health",
    name,
    () => {
      const probeRow = d.ledger.getMeta(`probe:${name}`);
      const raw = probeRow?.value as ProbeMeta | undefined;
      const probe = raw && typeof raw.ok === "boolean" ? raw : undefined;
      const anyTodo = queue.length > 0 || d.ledger.listTodos({ folder, limit: 1 }).length > 0;
      const hasData = !!session || anyTodo || open.length > 0 || !!scan || !!probeRow || threads.length > 0;
      return projectHealth({ healthUrl: d.projects[name]?.healthUrl, probe, high: open.filter((r) => r.severity === "high").length, hasData });
    },
    "unknown" as ProjectHealth,
  );
  return { session, queue, open, threads, scan, health };
}

/** The list form: no git reads, sync. Undefined for a project the engine does not know. */
export function projectSummary(d: Omit<ProjectViewDeps, "read">, name: string, now: number): ProjectSummary | undefined {
  const folder = part("folder", name, () => projectFolder(d, name), undefined);
  if (!folder) return undefined;
  const c = common(d, name, folder, now);
  const attention: Record<AttentionSeverity, number> = { high: 0, normal: 0, low: 0 };
  for (const r of c.open) attention[r.severity]++;
  return {
    name,
    folder,
    ...(c.session ? sessionNow(d.registry, c.session, now, name) : {}),
    queue: c.queue.length,
    attention,
    health: c.health,
  };
}

function sessionNow(registry: Registry, s: SessionInfo, now: number, name: string): { state: SessionState; line: string } {
  return part("now", name, () => ({ state: stateOf(registry, s, now), line: describeSession(registry, s, now) }), { state: "idle" as SessionState, line: "" });
}

/** The full view of one project. Undefined for a project the engine does not know. Never throws. */
export async function projectView(d: ProjectViewDeps, name: string, now: number): Promise<ProjectView | undefined> {
  const folder = part("folder", name, () => projectFolder(d, name), undefined);
  if (!folder) return undefined;
  const c = common(d, name, folder, now);
  const cfg = d.projects[name] ?? {};

  let nowPart: ProjectView["now"] = null;
  if (c.session) {
    const s = c.session;
    const thread = part(
      "nowThread",
      name,
      () => {
        const cause = d.registry.causeOf(s.id) ?? d.registry.lastCauseOf(s.id);
        const t = cause ? d.ledger.threadById(cause.threadId) : undefined;
        return t ? threadSummary(t) : undefined;
      },
      undefined,
    );
    nowPart = { ...sessionNow(d.registry, s, now, name), ...(thread ? { thread } : {}) };
  }

  const github = part(
    "githubView",
    name,
    (): ProjectGithub => {
      const n = (k: string) => c.scan?.counts?.[k] ?? 0;
      return {
        prs: n("pr_open") + n("pr_review_requested"),
        ciFailed: n("ci_failed"),
        issues: n("issue_open"),
        alerts: n("dependabot") + n("code_scanning") + n("secret_scanning"),
        ...(c.scan?.lastGoodAt !== undefined ? { scannedAt: c.scan.lastGoodAt } : {}),
        ...(c.scan?.error ? { error: c.scan.error } : {}),
      };
    },
    { prs: 0, ciFailed: 0, issues: 0, alerts: 0 },
  );

  const decisions = part(
    "decisions",
    name,
    () =>
      d.ledger
        .openDecisionsFor(name, folder, DECISIONS_SHOWN)
        .map((x) => ({ id: x.id, question: x.question, ageMs: now - x.createdAt, ...(x.cause ? { ref: msgRef(x.cause.threadId) } : {}) })),
    [],
  );

  const plans = part(
    "plans",
    name,
    () =>
      d.ledger
        .openPlans(name, PLANS_SHOWN)
        .map((p): ProjectPlan => {
          const missing = !existsSync(join(p.folder, p.path));
          const steps = `${p.stepsDone}/${p.stepsTotal}`;
          return {
            id: p.id,
            title: p.title,
            status: p.status,
            steps,
            ...(p.threadId !== undefined ? { ref: msgRef(p.threadId) } : {}),
            ...(missing ? { fileMissing: true as const } : {}),
            line: `${p.title} — ${p.status} ${steps}${missing ? " · file missing" : ""}`,
          };
        }),
    [],
  );

  const attention = part(
    "attentionView",
    name,
    () =>
      c.open.map((r): AttentionItemView => ({
        id: r.id,
        source: r.source,
        kind: r.kind,
        severity: r.severity,
        title: r.title,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        ...(r.url !== undefined ? { url: r.url } : {}),
        ageMs: now - r.firstSeen,
        ...(r.todoId !== undefined ? { todoId: r.todoId } : {}),
        actions: attentionActions(r),
      })),
    [],
  );

  const isNeo = resolve(folder) === resolve(d.neoFolder);
  const restartGated = isNeo
    ? part(
        "restartGated",
        name,
        () => c.open.filter((r) => r.source === "restart").map((r): RestartGatedItem => ({ key: r.key, title: r.title, ...(r.detail !== undefined ? { detail: r.detail } : {}) })),
        [],
      )
    : undefined;

  return {
    name,
    folder,
    now: nowPart,
    queue: c.queue,
    git: await gitFacts(d.read, folder, cfg),
    github,
    decisions,
    plans,
    attention,
    threads: c.threads,
    ...(restartGated ? { restartGated } : {}),
    health: c.health,
  };
}

/** One read that never throws (a throwing reader is a failed read). */
async function safe(p: () => Promise<GitResult>): Promise<GitResult> {
  try {
    return await p();
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

/** The live git facts of a folder: each failed read leaves its field out and is named in `error`. */
export async function gitFacts(read: GitRead, folder: string, cfg: ProjectCfg): Promise<ProjectGit> {
  const g = (args: string[]) => safe(() => read.git(folder, args));
  const pair = cfg.driftPairs?.[0];
  const [head, last, status, prefix, wl, drift] = await Promise.all([
    g(["rev-parse", "--abbrev-ref", "HEAD"]),
    g(["log", "-1", `--format=%h${SEP}%s${SEP}%ct`]),
    g(["status", "--porcelain", "--untracked-files=all"]),
    g(["rev-parse", "--show-prefix"]),
    g(["worktree", "list", "--porcelain"]),
    pair ? g(["rev-list", "--count", `${pair[1]}..${pair[0]}`]) : Promise.resolve(undefined),
  ]);
  const out: ProjectGit = {};
  const failed: string[] = [];
  let firstErr: string | undefined;
  const fail = (field: string, r: GitResult | undefined) => {
    failed.push(field);
    firstErr ??= r?.err || undefined;
  };

  const branch = head.ok ? head.out.trim() : undefined;
  if (branch) out.branch = branch;
  else fail("branch", head);

  if (last.ok && last.out.trim()) {
    const [sha, subject, ct] = last.out.trim().split(SEP);
    out.lastCommit = `${sha} ${subject ?? ""}`.trim();
    if (ct && Number.isFinite(Number(ct))) out.lastCommitAt = Number(ct) * 1000;
  } else if (!last.ok) fail("lastCommit", last);

  if (branch === "HEAD") out.unpushed = 0; // detached: nothing to push from
  else if (branch) {
    const t = await g(["for-each-ref", `--format=%(upstream:short)${SEP}%(upstream:track,nobracket)`, `refs/heads/${branch}`]);
    const line = t.ok ? t.out.split("\n").find(Boolean) : undefined;
    if (line === undefined) fail("unpushed", t); // no such ref (e.g. an ambiguous name): not read, never 0
    else {
      const [upstream, track] = line.split(SEP);
      if (!upstream || (track ?? "").includes("gone")) out.noUpstream = true;
      else out.unpushed = aheadOf(track ?? "");
    }
  } else fail("unpushed", head);

  if (status.ok && prefix.ok) out.dirty = uncommittedFrom(status.out, prefix.out.trim()).length;
  else fail("dirty", status.ok ? prefix : status);

  if (pair && drift) {
    const n = Number(drift.out.trim());
    if (drift.ok && Number.isFinite(n)) out.drift = { from: pair[0], to: pair[1], ahead: n };
    else fail("drift", drift);
  }

  if (wl.ok) {
    const real = (p: string) => {
      try {
        return realpathSync(p); // git prints real paths; a symlinked folder must still match itself
      } catch {
        return resolve(p);
      }
    };
    const self = real(folder);
    out.worktrees = parseWorktrees(wl.out)
      .slice(1) // the main checkout (git lists it first, from any worktree)
      .filter((w) => !w.prunable && !w.bare && existsSync(w.path) && real(w.path) !== self).length;
  } else fail("worktrees", wl);

  if (failed.length) out.error = `could not read: ${failed.join(", ")}${firstErr ? ` (${firstErr})` : ""}`;
  return out;
}
