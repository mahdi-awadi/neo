/** Read-only git queries (spec §7, ADR-0018): the one place the engine spawns `git` to READ a repo.
 *  Every call is bounded by a timeout and returns undefined on any failure (not a repo, git missing,
 *  timeout) — a caller treats undefined as "could not read", never as "nothing there". Writes (a
 *  worktree remove) are not here. P5 moves the remaining git spawns of the engine behind this module. */
import { spawnSync } from "node:child_process";

/** Bound on one git read — it must never hold up a report or a heartbeat. */
const GIT_TIMEOUT_MS = 5_000;

/** Runs one read-only git command in a folder; the seam tests inject. */
export type GitRunner = (folder: string, args: string[]) => string | undefined;

/** One bounded, read-only git query in `folder`; undefined on any failure. */
export function git(folder: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
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
