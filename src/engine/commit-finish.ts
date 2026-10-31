// The commit finish (ADR-0037): a dispatch run that settles with its OWN changes still uncommitted is
// asked ONCE, in the same still-open session, to commit them (or say why not), then end. While that
// follow-up runs, every worktree of the repository (keyed by its git common dir, ADR-0034) is held, so
// no queued todo starts on top of the files. Deterministic: git status, file stats and globs — no AI.
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git, headOf } from "./git-read";
import { uncommittedIn } from "./dispatch-report";
import { repoOf } from "./plan-execute";

/** Config `commitFinish` (docs/CONFIG.md). */
export interface CommitFinishCfg {
  /** Off switch. Default true. */
  enabled: boolean;
  /** Bun globs on repo-relative paths that are never the run's own changes (engine-owned files). */
  ignore: string[];
  /** The longest a commit finish holds its repository's other worktrees (a run whose interrupt
   *  hangs must not wedge every queue of the repository). Default 30 min. */
  holdMaxMs: number;
}

export const DEFAULT_COMMIT_FINISH_CFG: CommitFinishCfg = {
  enabled: true,
  ignore: ["HANDOFF.md", "**/HANDOFF.md", "data/handoffs/**"],
  holdMaxMs: 30 * 60_000,
};

/** Parse the config value; any field with a bad type keeps its default (fail closed). */
export function readCommitFinishCfg(raw: unknown): CommitFinishCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_COMMIT_FINISH_CFG;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    ignore: Array.isArray(r.ignore) && r.ignore.every((x) => typeof x === "string") ? (r.ignore as string[]) : d.ignore,
    holdMaxMs: typeof r.holdMaxMs === "number" && Number.isFinite(r.holdMaxMs) && r.holdMaxMs > 0 ? r.holdMaxMs : d.holdMaxMs,
  };
}

/** Files named in one message, at most this many (the rest as a count). */
const FILES_SHOWN = 20;

function fileList(files: string[]): string {
  return files.slice(0, FILES_SHOWN).join(", ") + (files.length > FILES_SHOWN ? ` (+${files.length - FILES_SHOWN} more)` : "");
}

/** The fixed follow-up (ADR-0037 §1). */
export function commitFinishBrief(files: string[]): string {
  return (
    `Your run ended with uncommitted changes: ${fileList(files)}. ` +
    "Finish now: run the project's checks that apply, then commit your work with a clear message (never `--no-verify`), " +
    "or, if a change must not be committed, say why. Then end."
  );
}

/** What the commit finish achieved, read from git after the run. */
export type CommitFinishOutcome = { kind: "committed"; head: string } | { kind: "clean" } | { kind: "still"; files: string[] };

/** The one line the run's result gains (ADR-0037 §5). */
export function commitFinishLine(o: CommitFinishOutcome): string {
  if (o.kind === "committed") return `committed by resume: ${o.head}`;
  if (o.kind === "clean") return "cleaned by resume (nothing committed)";
  return `still uncommitted after one resume: ${fileList(o.files)}`;
}

/** The git/file reads the commit finish makes — the seam tests may replace. */
export interface CommitFinishGit {
  /** Uncommitted repo-relative paths; undefined = not a repo or git failed. */
  status(folder: string): string[] | undefined;
  /** The repo's top-level folder. */
  root(folder: string): string | undefined;
  /** Full HEAD sha. */
  head(folder: string): string | undefined;
  /** `<short sha> <subject>` of HEAD. */
  headLine(folder: string): string | undefined;
  /** The repository key: its git common dir (a folder git cannot read is its own). */
  repoKey(folder: string): string;
  /** A path's working-tree fingerprint: size + mtime, or "gone". */
  fingerprint(path: string): string;
  /** Does git ignore the folder itself (ADR-0072: no baseline is right there)? Absent → not ignored. */
  ignored?(folder: string): boolean;
  /** Is the folder inside a repository by the file system (a `.git` in it or above), whether git can read it
   *  or not? It tells "not a repository" from "git failed" (ADR-0072). Absent → not a repository. */
  inRepo?(folder: string): boolean;
}

/** A `.git` (folder or file) in `folder` or a folder above it. */
function hasDotGit(folder: string): boolean {
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

export const realCommitFinishGit: CommitFinishGit = {
  status: uncommittedIn,
  root: (folder) => git(folder, ["rev-parse", "--show-toplevel"])?.trim() || undefined,
  head: (folder) => headOf(folder),
  headLine: (folder) => git(folder, ["log", "-1", "--format=%h %s"])?.trim() || undefined,
  repoKey: (folder) => repoOf(folder).key,
  fingerprint: (path) => {
    try {
      const s = statSync(path);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "gone";
    }
  },
  // check-ignore exits 0 (git returns "") when the folder is ignored; 1 or a failure gives undefined.
  ignored: (folder) => git(folder, ["check-ignore", "-q", "."]) !== undefined,
  inRepo: hasDotGit,
};

/** Repositories held by running commit finishes: key → each run's hold (two worktrees may both finish). */
type Hold = { done: Promise<void>; release: () => void };
const holds = new Map<string, Set<Hold>>();

/** True while a commit finish runs in any worktree of `folder`'s repository. */
export function commitFinishInFlight(folder: string, g: CommitFinishGit = realCommitFinishGit): boolean {
  return holds.size > 0 && holds.has(g.repoKey(folder));
}

/** Resolves once no commit finish holds `folder`'s repository. Never rejects. */
export async function awaitCommitFinish(folder: string, g: CommitFinishGit = realCommitFinishGit): Promise<void> {
  if (holds.size === 0) return;
  const key = g.repoKey(folder);
  for (let hs = holds.get(key); hs; hs = holds.get(key)) await Promise.all([...hs].map((h) => h.done));
}

export interface CommitFinish {
  /** At a settled end: the follow-up to send and the files it names (once per run), or undefined →
   *  close the run. */
  atSettle(): { brief: string; files: string[] } | undefined;
  /** True once the follow-up was sent. */
  nudged(): boolean;
  /** After the run: the outcome (undefined when no follow-up was sent). Releases the repository hold. */
  end(): CommitFinishOutcome | undefined;
}

/** A run's baseline (ADR-0037 §2, ADR-0072): the folder's dirty paths at the run's start, so only the
 *  run's own changes count. One per run, shared by the commit finish and the size guard. */
export interface RunBaseline {
  /** The repository's top-level folder. */
  root: string;
  /** Is this repo-relative path the run's own change: not dirty at the start, or changed since? */
  own(path: string): boolean;
}

/** What reading a run's baseline gave (ADR-0072): a baseline; none, rightly (the folder is not in a
 *  repository, or git ignores it); or a git that failed on a repository (a timeout, an error). */
export type BaselineRead =
  | { kind: "ok"; baseline: RunBaseline }
  | { kind: "none"; why: "not-git" | "ignored" }
  | { kind: "failed"; error: string };

/** Read `folder`'s baseline at the run's start, and say why there is none. */
export function readRunBaseline(folder: string, g: CommitFinishGit = realCommitFinishGit): BaselineRead {
  const root = g.root(folder);
  if (!root) return g.inRepo?.(folder) ? { kind: "failed", error: "git could not read the repository" } : { kind: "none", why: "not-git" };
  const dirty = g.status(folder);
  if (!dirty) return g.ignored?.(folder) ? { kind: "none", why: "ignored" } : { kind: "failed", error: "git status failed" };
  const print = (p: string) => g.fingerprint(join(root, p));
  const before = new Map<string, string>(dirty.map((p) => [p, print(p)]));
  return { kind: "ok", baseline: { root, own: (p) => before.get(p) !== print(p) } };
}

/** Record `folder`'s baseline. Call at the run's start. Undefined when git cannot read the folder (not a
 *  repository, a folder git ignores, a failed read): then nothing is the run's own change by git. */
export function runBaseline(folder: string, g: CommitFinishGit = realCommitFinishGit): RunBaseline | undefined {
  const r = readRunBaseline(folder, g);
  return r.kind === "ok" ? r.baseline : undefined;
}

/** Create one run's commit finish from the run's baseline (`runBaseline`, taken at the run's start), so
 *  only the run's own changes count at its end (ADR-0037 §2). */
export function createCommitFinish(
  folder: string,
  cfg: CommitFinishCfg,
  g: CommitFinishGit = realCommitFinishGit,
  baseline: RunBaseline | undefined = cfg.enabled ? runBaseline(folder, g) : undefined,
): CommitFinish {
  const matchers = cfg.ignore.map((p) => new Bun.Glob(p));
  const root = cfg.enabled ? baseline?.root : undefined;
  /** The run's own changes now; undefined when git cannot read the folder. */
  const own = (): string[] | undefined => {
    const all = g.status(folder);
    if (!all) return undefined;
    return all.filter((p) => !matchers.some((m) => m.match(p)) && baseline!.own(p));
  };
  let sent = false;
  /** Release this run's repository hold (idempotent). */
  const drop = (): void => {
    if (!hold) return;
    const hs = holds.get(hold.key);
    hs?.delete(hold.h);
    if (hs?.size === 0) holds.delete(hold.key);
    hold.h.release();
    hold = undefined;
  };
  let headAtSend: string | undefined;
  let hold: { key: string; h: Hold } | undefined;
  return {
    atSettle() {
      if (!root || sent) return undefined;
      const files = own();
      if (!files?.length) return undefined;
      sent = true;
      headAtSend = g.head(folder);
      const key = g.repoKey(folder);
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      const h = { done, release };
      holds.set(key, (holds.get(key) ?? new Set()).add(h));
      hold = { key, h };
      // Bounded: past holdMaxMs the other worktrees go on (the run's own folder stays busy anyway).
      const timer = setTimeout(() => drop(), cfg.holdMaxMs);
      timer.unref?.();
      void done.then(() => clearTimeout(timer));
      return { brief: commitFinishBrief(files), files };
    },
    nudged: () => sent,
    end() {
      drop();
      if (!sent) return undefined;
      const files = own() ?? [];
      if (files.length) return { kind: "still", files };
      const head = g.head(folder);
      return head && head !== headAtSend ? { kind: "committed", head: g.headLine(folder) ?? head.slice(0, 7) } : { kind: "clean" };
    },
  };
}
