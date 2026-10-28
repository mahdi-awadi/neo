// A `code` side lane's temporary git worktree (ADR-0057). It is created on a new `side/<key>` branch from
// the main checkout's current branch HEAD, under `lanes.worktreeRoot` (outside the work root, so no file
// watcher in the project sees it), and removed when the lane ends. Removal is never forced: uncommitted
// work keeps its worktree, and the caller raises it. A branch with commits stays for the merge todo.
import { mkdirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { branchOf, headOf, uncommittedFrom, type GitRunner } from "./git-read";

const GIT_TIMEOUT_MS = 60_000;

/** One bounded git command in `folder` that may change the repository; undefined on failure. */
export function gitWrite(folder: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return r.status === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

export interface LaneWorktree {
  /** The worktree folder: the lane session's own folder. */
  path: string;
  /** `side/<key>`. */
  branch: string;
  /** The main checkout's branch the worktree started from (the merge target). */
  base: string;
  /** The commit it started from. */
  baseSha: string;
}

/** Make the worktree for side lane `key` of `projectFolder`; an `error` (never a guess) when the main
 *  checkout is detached, the branch exists, or git fails. */
export function createLaneWorktree(projectFolder: string, key: string, root: string, run: GitRunner = gitWrite): LaneWorktree | { error: string } {
  const base = branchOf(projectFolder, run);
  const baseSha = headOf(projectFolder, run);
  if (!base || !baseSha) return { error: `cannot read the branch of ${projectFolder}` };
  if (base === "HEAD") return { error: `${projectFolder} has a detached HEAD — no branch to start a side branch from` };
  const branch = `side/${key}`;
  const path = join(resolve(root), `${basename(projectFolder)}-side-${key}`);
  try {
    mkdirSync(resolve(root), { recursive: true });
  } catch {
    return { error: `cannot create ${root}` };
  }
  // `--` ends options, so neither the branch nor the path is read as one.
  if (run(projectFolder, ["worktree", "add", "-b", branch, "--", path, baseSha]) === undefined) {
    return { error: `git worktree add failed for ${branch} (does the branch already exist?)` };
  }
  return { path, branch, base, baseSha };
}

export interface LaneWorktreeEnd {
  branch: string;
  base: string;
  /** Commits on the side branch after its start. */
  commits: number;
  removed: boolean;
  branchDeleted: boolean;
  /** Uncommitted paths that kept the worktree. */
  dirty?: string[];
}

/** End the lane: keep a dirty worktree; else remove it, and delete the branch when it has no commits. */
export function endLaneWorktree(projectFolder: string, wt: LaneWorktree, run: GitRunner = gitWrite): LaneWorktreeEnd {
  const count = Number(run(projectFolder, ["rev-list", "--count", `${wt.baseSha}..refs/heads/${wt.branch}`])?.trim() ?? "0") || 0;
  const status = run(wt.path, ["status", "--porcelain", "--untracked-files=all"]);
  const dirty = status === undefined ? undefined : uncommittedFrom(status, "");
  const base = { branch: wt.branch, base: wt.base, commits: count };
  if (status === undefined || (dirty && dirty.length)) {
    return { ...base, removed: false, branchDeleted: false, ...(dirty?.length ? { dirty } : {}) };
  }
  const removed = run(projectFolder, ["worktree", "remove", "--", wt.path]) !== undefined;
  const branchDeleted = removed && count === 0 && run(projectFolder, ["branch", "-d", "--", wt.branch]) !== undefined;
  return { ...base, removed, branchDeleted };
}

/** Boot: remove each clean worktree under `root` that no live lane uses; report the dirty ones. */
export function sweepLaneWorktrees(root: string, live: ReadonlySet<string>, run: GitRunner = gitWrite): { removed: string[]; dirty: Array<{ path: string; paths: string[] }> } {
  const removed: string[] = [];
  const dirty: Array<{ path: string; paths: string[] }> = [];
  let names: string[] = [];
  try {
    names = readdirSync(resolve(root));
  } catch {
    return { removed, dirty };
  }
  for (const name of names.sort()) {
    const path = join(resolve(root), name);
    if (live.has(path)) continue;
    const status = run(path, ["status", "--porcelain", "--untracked-files=all"]);
    if (status === undefined) continue; // not a git worktree: never touched
    const paths = uncommittedFrom(status, "");
    if (paths.length) {
      dirty.push({ path, paths });
      continue;
    }
    // Removed from its own repository (`git worktree remove` run inside it is refused by git, so ask
    // the main repository, found from the worktree's common dir).
    const common = run(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
    const mainRepo = common ? resolve(common, "..") : undefined;
    if (mainRepo && run(mainRepo, ["worktree", "remove", "--", path]) !== undefined) removed.push(path);
  }
  return { removed, dirty };
}
