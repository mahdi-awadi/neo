/** Read-only git and gh queries (spec §7, ADR-0018): the one place the engine spawns `git` or `gh` to
 *  READ a repo. Two forms: `createGitRead` (async, for the scans — bounded by `github.callTimeoutMs`,
 *  no prompts, no pager, never throws) and the small sync `git` (for the few reads inside sync code
 *  paths — a digest line, a stop point — bounded by a short constant). Undefined / ok:false means
 *  "could not read", never "nothing there". */
import { spawnSync } from "node:child_process";
import { exec as defaultExec } from "./update-sys";
import type { ExecResult } from "./updater";

/** Bound on one git read — it must never hold up a report or a heartbeat. */
const GIT_TIMEOUT_MS = 5_000;

/** Runs one read-only git command in a folder; the seam tests inject. */
export type GitRunner = (folder: string, args: string[]) => string | undefined;

/** One bounded, read-only git query in `folder`; undefined on any failure. */
export function git(folder: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return r.status === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The full HEAD sha. */
export function headOf(folder: string, run: GitRunner = git): string | undefined {
  return run(folder, ["rev-parse", "HEAD"])?.trim() || undefined;
}

/** The checked-out branch (`HEAD` when detached). */
export function branchOf(folder: string, run: GitRunner = git): string | undefined {
  return run(folder, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || undefined;
}

/** A commit: short sha and subject. */
export interface CommitLine {
  sha: string;
  subject: string;
}

const SEP = "\u001f"; // a field separator no subject contains

/** Commits reachable from HEAD but not from `since`, newest first, at most `limit`. Undefined when
 *  git fails (e.g. `since` is not in this repo any more). */
export function commitsAfter(folder: string, since: string, limit: number, run: GitRunner = git): CommitLine[] | undefined {
  const out = run(folder, ["log", `--max-count=${limit}`, `--format=%h${SEP}%s`, `${since}..HEAD`]);
  if (out === undefined) return undefined;
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split(SEP);
      return { sha: sha!, subject: subject ?? "" };
    });
}

/** Local branches not merged into `into`, each with its newest commit subject. Undefined on failure. */
export function unmergedBranches(folder: string, into: string, run: GitRunner = git): Array<{ branch: string; subject: string }> | undefined {
  const out = run(folder, ["for-each-ref", "--no-merged", into, `--format=%(refname:short)${SEP}%(subject)`, "refs/heads"]);
  if (out === undefined) return undefined;
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [branch, subject] = l.split(SEP);
      return { branch: branch!, subject: subject ?? "" };
    });
}

/** Does `sha` name a commit in this repo? Only meaningful once git is known to read the repo (a
 *  failed read and a missing commit look alike). */
export function hasCommit(folder: string, sha: string, run: GitRunner = git): boolean {
  return run(folder, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined;
}

/** Is `ancestor` contained in `of`? Both must exist (see hasCommit). */
export function isAncestor(folder: string, ancestor: string, of: string, run: GitRunner = git): boolean {
  return run(folder, ["merge-base", "--is-ancestor", ancestor, of]) !== undefined;
}

/** One async read: ok with its stdout, or not ok with stderr ("timeout" when it was killed). */
export interface GitResult {
  ok: boolean;
  out: string;
  err?: string;
}

/** The async read boundary the producers take (tests pass a fake). */
export interface GitRead {
  git(folder: string, args: string[]): Promise<GitResult>;
  /** `gh` runs in the folder, so it finds the repo from its remote. */
  gh(folder: string, args: string[]): Promise<GitResult>;
}

/** No terminal prompt (a missing credential fails at once), no optional index lock (a background
 *  `git status` must never make a working session's `git commit` fail on index.lock), no pager, no
 *  prompts from gh, no colour codes in the output. */
const READ_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GH_PAGER: "", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };

export function createGitRead(o: { timeoutMs: number; exec?: (cmd: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult> }): GitRead {
  const run = o.exec ?? defaultExec;
  const result = (r: ExecResult): GitResult =>
    r.code === 0 ? { ok: true, out: r.out } : { ok: false, out: r.out, err: r.code === 124 ? "timeout" : r.err.trim() };
  return {
    git: async (folder, args) => result(await run(["git", "-C", folder, ...args], { timeoutMs: o.timeoutMs, env: READ_ENV })),
    gh: async (folder, args) => result(await run(["gh", ...args], { cwd: folder, timeoutMs: o.timeoutMs, env: READ_ENV })),
  };
}

/** Commits ahead in a `%(upstream:track,nobracket)` value ("ahead 3, behind 1" → 3; "" → 0). */
export function aheadOf(track: string): number {
  return Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  head?: string;
  /** The short branch name; absent when detached. */
  branch?: string;
  /** git says it can be pruned (its folder is gone). */
  prunable: boolean;
  bare: boolean;
}

/** `git worktree list --porcelain` → its entries, in git's order: the main worktree first (git lists
 *  it first even when run from a linked one), then the linked ones. The one parser. */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap((b) => {
      const path = /^worktree (.+)$/m.exec(b)?.[1];
      if (!path) return [];
      const head = /^HEAD (\w+)$/m.exec(b)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(b)?.[1];
      return [{ path, ...(head ? { head } : {}), ...(branch ? { branch } : {}), prunable: /^prunable\b/m.test(b), bare: /^bare$/m.test(b) }];
    });
}

/** The handoff note is written FOR a reset, so it never counts as uncommitted work (ADR-0021). */
const HANDOFF_NOTE = "HANDOFF.md";

/** The uncommitted paths in `git status --porcelain --untracked-files=all` output (relative to the
 *  repo root; a rename counts as its new name), minus the folder's own HANDOFF.md — `prefix` is the
 *  folder inside its repo (`git rev-parse --show-prefix`). The one rule for "uncommitted work". */
export function uncommittedFrom(porcelain: string, prefix: string): string[] {
  const note = prefix + HANDOFF_NOTE;
  return porcelain
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!)
    .filter((p) => p !== note);
}
