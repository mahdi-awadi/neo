// P5 Task 5.2 (spec §7): the git producer — read with git-read against temp repos with a bare remote.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createGitRead, type GitRead } from "../src/engine/git-read";
import { gitDrafts, type GitScanInput } from "../src/engine/producers/git";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const read = createGitRead({ timeoutMs: 10_000 });
const DAY = 86_400_000;

function sh(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: process.env.NEO_T_DATE ?? "", GIT_AUTHOR_DATE: process.env.NEO_T_DATE ?? "" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function commit(dir: string, file: string, msg: string, date?: string): void {
  writeFileSync(join(dir, file), msg);
  sh(dir, "add", file);
  if (date) process.env.NEO_T_DATE = date;
  try {
    sh(dir, "commit", "-q", "-m", msg);
  } finally {
    delete process.env.NEO_T_DATE;
  }
}
/** A repo on `main` with a bare origin, main pushed. */
function repo(): { dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "neo-pgit-"));
  made.push(root);
  const origin = join(root, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const dir = join(root, "gold");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "remote", "add", "origin", origin);
  commit(dir, "a.txt", "feat: first");
  sh(dir, "push", "-q", "-u", "origin", "main");
  return { dir, root };
}

const input = (dir: string, over: Partial<GitScanInput> = {}): GitScanInput => ({
  folder: dir, project: "gold", cfg: {}, staleBranchDays: 21, worktreeIdleHours: 12, now: Date.now(),
  sessionIn: () => false, lastWorkAt: () => undefined, dirtyHigh: false, ...over,
});
const kinds = async (i: GitScanInput, r: GitRead = read) => (await gitDrafts(r, i)).drafts.map((d) => `${d.kind}:${d.key}`).sort();

test("a clean, pushed repo raises nothing", async () => {
  const { dir } = repo();
  expect(await kinds(input(dir))).toEqual([]);
});

test("unpushed (branch ahead of its upstream), no_upstream (a tracked branch without one), dirty", async () => {
  const { dir } = repo();
  commit(dir, "b.txt", "fix: b");
  commit(dir, "c.txt", "fix: c");
  sh(dir, "checkout", "-q", "-b", "dev");
  writeFileSync(join(dir, "wip.txt"), "wip");
  const r = await gitDrafts(read, input(dir, { cfg: { trackedBranches: ["main", "dev"] } }));
  expect(r.drafts.map((d) => `${d.kind}:${d.key}`).sort()).toEqual(["dirty:" + dir, "no_upstream:dev", "unpushed:main"]);
  expect(r.drafts.find((d) => d.kind === "unpushed")!.title).toBe("main is 2 commit(s) ahead of origin/main");
  expect(r.drafts.find((d) => d.kind === "dirty")!.severity).toBe("normal");
  expect((await gitDrafts(read, input(dir, { dirtyHigh: true }))).drafts.find((d) => d.kind === "dirty")!.severity).toBe("high");
  expect(await kinds(input(dir, { sessionIn: (f) => f === dir }))).not.toContain("dirty:" + dir); // a session works there
});

test("drift (configured pair) and stale_branch (idle, unmerged)", async () => {
  const { dir } = repo();
  sh(dir, "checkout", "-q", "-b", "dev");
  commit(dir, "d.txt", "feat: d");
  sh(dir, "push", "-q", "-u", "origin", "dev");
  sh(dir, "checkout", "-q", "main");
  sh(dir, "checkout", "-q", "-b", "fix/old");
  commit(dir, "o.txt", "fix: old", "2026-01-01T00:00:00Z");
  sh(dir, "push", "-q", "-u", "origin", "fix/old");
  sh(dir, "checkout", "-q", "main");
  const r = await gitDrafts(read, input(dir, { cfg: { trackedBranches: ["main"], driftPairs: [["dev", "main"]] } }));
  const keys = r.drafts.map((d) => `${d.kind}:${d.key}`).sort();
  expect(keys).toEqual(["drift:dev..main", "stale_branch:fix/old"]);
  expect(r.drafts.find((d) => d.kind === "drift")!.title).toBe("dev is 1 commit(s) ahead of main");
});

test("a linked worktree with no session for worktreeIdleHours, with its clean/dirty and pushed/merged facts", async () => {
  const { dir, root } = repo();
  const wt = join(root, "gold-ota");
  sh(dir, "worktree", "add", "-q", "-b", "feat/ota", wt);
  const now = Date.now() + 13 * 3_600_000;
  const r = await gitDrafts(read, input(dir, { now }));
  const w = r.drafts.find((d) => d.kind === "worktree")!;
  expect(w).toMatchObject({ key: wt, severity: "normal" });
  expect(JSON.parse(w.detail!)).toMatchObject({ path: wt, branch: "feat/ota", dirty: false, merged: true });
  expect(await kinds(input(dir, { now, sessionIn: (f) => f === wt }))).toEqual([]);
  expect(await kinds(input(dir, { now: Date.now() }))).toEqual([]); // not idle long enough
  expect(await kinds(input(dir, { now, lastWorkAt: () => now - 3_600_000 }))).toEqual([]); // worked in an hour ago
});

test("a read that fails marks its kinds failed, never resolves them; ignoreKinds drops a kind", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "wip.txt"), "wip");
  const failing: GitRead = { git: async (f, a) => (a[0] === "status" ? { ok: false, out: "", err: "timeout" } : read.git(f, a)), gh: read.gh };
  const r = await gitDrafts(failing, input(dir));
  expect([...r.failed]).toEqual(["dirty"]);
  expect(await kinds(input(dir, { cfg: { ignoreKinds: ["dirty"] } }))).toEqual([]);
  const gone = await gitDrafts(read, input(join(dir, "nope")));
  expect(gone.failed.size).toBeGreaterThan(0);
  expect(gone.drafts).toEqual([]);
  void DAY;
});

test("the base is the remote's default branch; with no base known, stale/no_upstream are failed, not resolved", async () => {
  const { dir } = repo();
  sh(dir, "remote", "set-head", "origin", "main");
  sh(dir, "checkout", "-q", "-b", "feat/y");
  const r = await gitDrafts(read, input(dir));
  expect(r.tracked).toEqual(["main"]); // not the checked-out feat/y
  sh(dir, "remote", "set-head", "origin", "-d");
  sh(dir, "checkout", "-q", "--detach");
  const d = await gitDrafts(read, input(dir));
  expect(d.tracked).toEqual([]);
  expect([...d.failed].sort()).toEqual(["no_upstream", "stale_branch"]);
});

test("dirty reuses the uncommitted-files rule (HANDOFF.md is not work) and keeps the todo's title and thread link", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "HANDOFF.md"), "note");
  expect(await kinds(input(dir))).toEqual([]);
  writeFileSync(join(dir, "wip.txt"), "wip");
  const keep = { title: "3 uncommitted files after todo #4", detail: "thread m4g2 · files: a.ts" };
  const d = (await gitDrafts(read, input(dir, { dirtyHigh: true, dirtyKeep: keep }))).drafts.find((x) => x.kind === "dirty")!;
  expect(d).toMatchObject({ severity: "high", ...keep });
});

test("while a session works in the folder, an open dirty item is kept as it is (not resolved, not re-judged)", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "wip.txt"), "wip");
  const r = await gitDrafts(read, input(dir, { sessionIn: (f) => f === dir }));
  expect(r.drafts.map((d) => d.kind)).not.toContain("dirty");
  expect(r.kept.has("dirty")).toBe(true);
  expect(r.failed.has("dirty")).toBe(false); // on purpose, not a failed read: no scan error
});

test("a linked worktree whose folder was deleted by hand is not an item", async () => {
  const { dir, root } = repo();
  const wt = join(root, "gold-gone");
  sh(dir, "worktree", "add", "-q", "-b", "feat/gone", wt);
  rmSync(wt, { recursive: true, force: true });
  expect(await kinds(input(dir, { now: Date.now() + 13 * 3_600_000 }))).toEqual([]);
});
