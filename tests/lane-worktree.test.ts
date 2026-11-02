// ADR-0057: a `code` side lane works in its own temporary git worktree on `side/<id>`, removed when it ends.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createLaneWorktree, endLaneWorktree, sweepLaneWorktrees } from "../src/engine/lane-worktree";

const sh = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).stdout.trim();
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-lanewt-")) + "/proj";
  spawnSync("mkdir", ["-p", dir]);
  sh(dir, "init", "-q", "-b", "dev");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}
const root = () => mkdtempSync(join(tmpdir(), "neo-lanes-"));

test("create: a worktree on side/<id> from the main checkout's branch HEAD", () => {
  const p = repo();
  const wt = createLaneWorktree(p, "12", root());
  if ("error" in wt) throw new Error(wt.error);
  expect(wt.branch).toBe("side/12");
  expect(wt.base).toBe("dev");
  expect(wt.baseSha).toBe(sh(p, "rev-parse", "HEAD"));
  expect(sh(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("side/12");
  expect(sh(p, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev"); // the main checkout is untouched
});

test("create: a detached main checkout is an error, never a guess", () => {
  const p = repo();
  sh(p, "checkout", "-q", "--detach");
  expect(createLaneWorktree(p, "1", root())).toMatchObject({ error: expect.stringContaining("detached") });
});

test("create: a retried lane whose side branch survived continues on it (its commits are kept)", () => {
  const p = repo();
  const r = root();
  const first = createLaneWorktree(p, "2", r);
  if ("error" in first) throw new Error(first.error);
  writeFileSync(join(first.path, "b.txt"), "b\n");
  sh(first.path, "add", "-A");
  sh(first.path, "commit", "-qm", "half");
  sh(p, "worktree", "remove", first.path); // e.g. a restart's boot sweep removed the clean worktree
  const again = createLaneWorktree(p, "2", r);
  if ("error" in again) throw new Error(again.error);
  expect(again.baseSha).toBe(first.baseSha); // counted from where the branch left dev
  expect(existsSync(join(again.path, "b.txt"))).toBe(true);
  expect(endLaneWorktree(p, again)).toMatchObject({ commits: 1, removed: true, branchDeleted: false });
});

test("end: no commits → worktree removed and branch deleted", () => {
  const p = repo();
  const wt = createLaneWorktree(p, "3", root());
  if ("error" in wt) throw new Error(wt.error);
  const end = endLaneWorktree(p, wt);
  expect(end).toMatchObject({ removed: true, commits: 0, branchDeleted: true });
  expect(existsSync(wt.path)).toBe(false);
  expect(sh(p, "branch", "--list", "side/3")).toBe("");
});

test("end: commits → worktree removed, branch kept for the merge todo", () => {
  const p = repo();
  const wt = createLaneWorktree(p, "4", root());
  if ("error" in wt) throw new Error(wt.error);
  writeFileSync(join(wt.path, "b.txt"), "b\n");
  sh(wt.path, "add", "-A");
  sh(wt.path, "commit", "-qm", "side work");
  const end = endLaneWorktree(p, wt);
  expect(end).toMatchObject({ removed: true, commits: 1, branchDeleted: false, branch: "side/4", base: "dev" });
  expect(sh(p, "branch", "--list", "side/4")).toContain("side/4");
});

test("end: uncommitted work → the worktree is kept and its paths returned (never --force)", () => {
  const p = repo();
  const wt = createLaneWorktree(p, "5", root());
  if ("error" in wt) throw new Error(wt.error);
  writeFileSync(join(wt.path, "c.txt"), "c\n");
  const end = endLaneWorktree(p, wt);
  expect(end).toMatchObject({ removed: false, dirty: ["c.txt"] });
  expect(existsSync(wt.path)).toBe(true);
});

test("sweep at boot: a clean orphan worktree is removed, a dirty one kept and reported, a live one untouched", () => {
  const p = repo();
  const r = root();
  const clean = createLaneWorktree(p, "6", r);
  const dirty = createLaneWorktree(p, "7", r);
  const live = createLaneWorktree(p, "8", r);
  if ("error" in clean || "error" in dirty || "error" in live) throw new Error("setup");
  writeFileSync(join(dirty.path, "d.txt"), "d\n");
  const out = sweepLaneWorktrees(r, new Set([live.path]));
  expect(out.removed).toEqual([clean.path]);
  expect(out.dirty).toEqual([{ path: dirty.path, paths: ["d.txt"] }]);
  expect(existsSync(live.path)).toBe(true);
});
