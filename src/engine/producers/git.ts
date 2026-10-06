/** The git producer (ADR-0018, spec §7): what a project's repo shows that needs the operator —
 *  commits not pushed, a tracked branch with no upstream, uncommitted work with no session on it, a
 *  long-idle unmerged branch, a configured branch pair drifting apart, a linked worktree left idle.
 *  Read through git-read (bounded, never throws); each read that fails marks its kinds failed so the
 *  scan keeps their rows (no false resolve). No repo or branch name is in code (AC5.6). */
import type { AttentionDraft } from "../ledger";
import { uncommittedFrom, type GitRead } from "../git-read";

export const GIT_KINDS = ["unpushed", "no_upstream", "dirty", "stale_branch", "drift", "worktree"] as const;
export type GitKind = (typeof GIT_KINDS)[number];

/** Per-project config (config.json `projects.<name>`, spec §7). */
export interface ProjectCfg {
  /** Branches that matter: they must have an upstream; the first is the base for "merged"/"stale". */
  trackedBranches?: string[];
  /** `[a, b]`: a ahead of b by N commits is drift. */
  driftPairs?: Array<[string, string]>;
  /** The GitHub issue label that marks Neo's issues (default "neo"). */
  issueLabel?: string;
  /** Kinds never raised for this project. */
  ignoreKinds?: string[];
  deployedVersionUrl?: string;
  healthUrl?: string;
}

export interface GitScanInput {
  folder: string;
  project: string;
  cfg: ProjectCfg;
  staleBranchDays: number;
  worktreeIdleHours: number;
  now: number;
  /** Is a session working in this folder right now? (Its uncommitted work is in progress.) */
  sessionIn(folder: string): boolean;
  /** The last time Neo worked in a folder (an order), if any. */
  lastWorkAt(folder: string): number | undefined;
  /** The open `dirty` item was raised high (left after a todo): keep it high. */
  dirtyHigh: boolean;
  /** …and keep its title and detail (the todo and its thread link, spec §8.6). */
  dirtyKeep?: { title: string; detail?: string };
}

const SEP = "\u001f";
const DAY = 86_400_000;
const HOUR = 3_600_000;

interface Ref {
  branch: string;
  upstream: string;
  ahead: number;
  gone: boolean;
  at: number;
}

export async function gitDrafts(read: GitRead, i: GitScanInput): Promise<{ drafts: AttentionDraft[]; failed: Set<GitKind>; tracked: string[] }> {
  const drafts: AttentionDraft[] = [];
  const failed = new Set<GitKind>();
  const at = { project: i.project, folder: i.folder, source: "git" as const, severity: "normal" as const };
  const draft = (d: Omit<AttentionDraft, "project" | "folder" | "source" | "severity" | "kind"> & { kind: GitKind; severity?: AttentionDraft["severity"] }): void =>
    void drafts.push({ ...at, ...d });
  const fail = (...k: GitKind[]): void => k.forEach((x) => failed.add(x));

  const head = await read.git(i.folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const refsOut = await read.git(i.folder, ["for-each-ref", "refs/heads", `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(upstream:track,nobracket)${SEP}%(committerdate:unix)`]);
  const current = head.ok ? head.out.trim() : undefined;
  // What matters: the configured branches, else the remote's default branch, else the checked-out one.
  // Never "nothing" by accident: with no branch known, the kinds that need one are failed, not resolved.
  const originHead = await read.git(i.folder, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const remoteDefault = originHead.ok ? originHead.out.trim().replace(/^origin\//, "") : undefined;
  const tracked = i.cfg.trackedBranches?.length ? i.cfg.trackedBranches : remoteDefault ? [remoteDefault] : current && current !== "HEAD" ? [current] : [];
  const base = tracked[0];
  if (!base) fail("no_upstream", "stale_branch");
  let refs: Ref[] | undefined;
  if (!head.ok || !refsOut.ok) fail("unpushed", "no_upstream", "stale_branch");
  else {
    refs = refsOut.out.split("\n").filter(Boolean).map((l) => {
      const [branch, upstream, track, at] = l.split(SEP);
      return { branch: branch!, upstream: upstream ?? "", ahead: Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0), gone: (track ?? "").includes("gone"), at: Number(at) * 1000 };
    });
    for (const r of refs) {
      if (r.upstream && r.ahead > 0) draft({ kind: "unpushed", key: r.branch, title: `${r.branch} is ${r.ahead} commit(s) ahead of ${r.upstream}` });
    }
    // A repo with no remote at all has nothing to push to: no_upstream would only be noise.
    const remotes = await read.git(i.folder, ["remote"]);
    if (!remotes.ok) fail("no_upstream");
    for (const b of remotes.ok && remotes.out.trim() ? tracked : []) {
      const r = refs.find((x) => x.branch === b);
      if (r && (!r.upstream || r.gone)) draft({ kind: "no_upstream", key: b, title: r.gone ? `${b}: its upstream is gone` : `${b} has no upstream (never pushed)` });
    }
  }

  // Merged into the base: those are done, never stale; a worktree on one can go.
  let merged: Set<string> | undefined;
  if (base) {
    const m = await read.git(i.folder, ["for-each-ref", "--merged", base, "--format=%(refname:short)", "refs/heads"]);
    if (m.ok) merged = new Set(m.out.split("\n").filter(Boolean));
  }
  if (refs && base) {
    if (!merged || !refs.some((r) => r.branch === base)) fail("stale_branch");
    else {
      for (const r of refs) {
        if (merged.has(r.branch) || tracked.includes(r.branch) || i.now - r.at <= i.staleBranchDays * DAY) continue;
        draft({ kind: "stale_branch", key: r.branch, title: `${r.branch}: no commit for ${Math.floor((i.now - r.at) / DAY)} days, not merged into ${base}` });
      }
    }
  }

  // While a session works here its changes are work in progress: an open item is kept as it is.
  if (i.sessionIn(i.folder)) fail("dirty");
  else {
    const status = await read.git(i.folder, ["status", "--porcelain", "--untracked-files=all"]);
    const prefix = await read.git(i.folder, ["rev-parse", "--show-prefix"]);
    if (!status.ok || !prefix.ok) fail("dirty");
    else {
      const n = uncommittedFrom(status.out, prefix.out.trim()).length; // the one rule (HANDOFF.md is not work)
      if (n > 0) {
        const keep = i.dirtyHigh ? i.dirtyKeep : undefined;
        draft({ kind: "dirty", key: i.folder, severity: i.dirtyHigh ? "high" : "normal", title: keep?.title ?? `${n} uncommitted file(s), no session working on them`, ...(keep?.detail ? { detail: keep.detail } : {}) });
      }
    }
  }

  for (const [a, b] of i.cfg.driftPairs ?? []) {
    if (!refs) {
      fail("drift");
      break;
    }
    if (!refs.some((r) => r.branch === a) || !refs.some((r) => r.branch === b)) continue; // not here: nothing to compare
    const c = await read.git(i.folder, ["rev-list", "--count", `${b}..${a}`]);
    if (!c.ok) {
      fail("drift");
      continue;
    }
    const n = Number(c.out.trim());
    if (n > 0) draft({ kind: "drift", key: `${a}..${b}`, title: `${a} is ${n} commit(s) ahead of ${b}` });
  }

  const wl = await read.git(i.folder, ["worktree", "list", "--porcelain"]);
  if (!wl.ok) fail("worktree");
  else {
    const blocks = wl.out.split("\n\n").map((b) => b.trim()).filter(Boolean).slice(1); // the first is the main checkout
    for (const b of blocks) {
      const path = /^worktree (.+)$/m.exec(b)?.[1];
      const sha = /^HEAD (\w+)$/m.exec(b)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(b)?.[1];
      if (!path || !sha || i.sessionIn(path)) continue;
      const ct = await read.git(i.folder, ["log", "-1", "--format=%ct", sha]);
      const last = Math.max(i.lastWorkAt(path) ?? 0, ct.ok ? Number(ct.out.trim()) * 1000 : 0);
      if (last === 0) continue; // no time known: never a made-up idle age
      if (i.now - last <= i.worktreeIdleHours * HOUR) continue;
      const ws = await read.git(path, ["status", "--porcelain"]);
      const ref = branch ? refs?.find((r) => r.branch === branch) : undefined;
      const facts = {
        path,
        branch: branch ?? null,
        dirty: ws.ok ? ws.out.trim().length > 0 : null,
        merged: branch && merged ? merged.has(branch) : null,
        pushed: ref ? !!ref.upstream && ref.ahead === 0 && !ref.gone : null,
      };
      draft({ kind: "worktree", key: path, title: `worktree ${path}${branch ? ` (${branch})` : ""} idle ${Math.floor((i.now - last) / HOUR)}h`, detail: JSON.stringify(facts) });
    }
  }

  const ignore = new Set(i.cfg.ignoreKinds ?? []);
  return { drafts: drafts.filter((d) => !ignore.has(d.kind)), failed, tracked };
}

/** Config `projects` (config.json): per-project scan settings by project name; malformed fields drop. */
export function readProjectsCfg(raw: unknown): Record<string, ProjectCfg> {
  const out: Record<string, ProjectCfg> = {};
  if (!raw || typeof raw !== "object") return out;
  const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const pairs = Array.isArray(r.driftPairs) && r.driftPairs.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "string")) ? (r.driftPairs as Array<[string, string]>) : undefined;
    const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
    out[name] = {
      ...(strings(r.trackedBranches) ? { trackedBranches: strings(r.trackedBranches) } : {}),
      ...(pairs ? { driftPairs: pairs } : {}),
      ...(str(r.issueLabel) ? { issueLabel: str(r.issueLabel) } : {}),
      ...(strings(r.ignoreKinds) ? { ignoreKinds: strings(r.ignoreKinds) } : {}),
      ...(str(r.deployedVersionUrl) ? { deployedVersionUrl: str(r.deployedVersionUrl) } : {}),
      ...(str(r.healthUrl) ? { healthUrl: str(r.healthUrl) } : {}),
    };
  }
  return out;
}
