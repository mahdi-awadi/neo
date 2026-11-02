import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  createCommitFinish,
  commitFinishInFlight,
  awaitCommitFinish,
  commitFinishBrief,
  commitFinishLine,
  readCommitFinishCfg,
  DEFAULT_COMMIT_FINISH_CFG,
} from "../src/engine/commit-finish";

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-cf-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "a\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}
const commitAll = (dir: string, msg = "work") => {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", msg);
};
const cfg = DEFAULT_COMMIT_FINISH_CFG;

test("AC2: a clean folder at the settle closes at once", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, cfg);
  expect(cf.atSettle()).toBeUndefined();
  expect(cf.nudged()).toBe(false);
  expect(cf.end()).toBeUndefined();
});

test("AC1: the run's own changes get ONE follow-up naming the files; never a second", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, cfg);
  writeFileSync(join(dir, "b.ts"), "new\n");
  writeFileSync(join(dir, "a.ts"), "changed\n");
  const brief = cf.atSettle()?.brief;
  expect(brief).toContain("Your run ended with uncommitted changes:");
  expect(brief).toContain("a.ts");
  expect(brief).toContain("b.ts");
  expect(brief).toContain("never `--no-verify`");
  expect(cf.nudged()).toBe(true);
  expect(cf.atSettle()).toBeUndefined(); // bounded: one follow-up per run
  cf.end();
});

test("AC2: a path dirty before the run and untouched is not the run's", () => {
  const dir = repo();
  writeFileSync(join(dir, "a.ts"), "operator's local edit\n");
  const cf = createCommitFinish(dir, cfg);
  expect(cf.atSettle()).toBeUndefined();
});

test("AC2: a pre-dirty path the run changed again IS the run's", () => {
  const dir = repo();
  writeFileSync(join(dir, "a.ts"), "operator's local edit\n");
  const cf = createCommitFinish(dir, cfg);
  writeFileSync(join(dir, "a.ts"), "operator's local edit, then the worker's longer change\n");
  expect(cf.atSettle()?.files).toEqual(["a.ts"]);
  cf.end();
});

test("AC2: ignored paths (the handoff notes) never count", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, cfg);
  writeFileSync(join(dir, "HANDOFF.md"), "note\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "HANDOFF.md"), "note\n");
  mkdirSync(join(dir, "data", "handoffs"), { recursive: true });
  writeFileSync(join(dir, "data", "handoffs", "x.md"), "note\n");
  expect(cf.atSettle()).toBeUndefined();
});

test("edge: a path the run deleted counts", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, cfg);
  rmSync(join(dir, "a.ts"));
  expect(cf.atSettle()?.files).toEqual(["a.ts"]);
  cf.end();
});

test("edge: not a git repo → no check", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-cf-nogit-"));
  const cf = createCommitFinish(dir, cfg);
  writeFileSync(join(dir, "x"), "x");
  expect(cf.atSettle()).toBeUndefined();
  expect(cf.end()).toBeUndefined();
});

test("AC4: outcome committed — clean and HEAD moved", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, cfg);
  writeFileSync(join(dir, "b.ts"), "new\n");
  cf.atSettle();
  commitAll(dir, "feat: b");
  const o = cf.end();
  expect(o).toMatchObject({ kind: "committed" });
  expect(commitFinishLine(o!)).toMatch(/^committed by resume: [0-9a-f]{7,} feat: b$/);
});

test("AC4: outcome cleaned — clean, HEAD did not move", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, cfg);
  writeFileSync(join(dir, "b.ts"), "new\n");
  cf.atSettle();
  rmSync(join(dir, "b.ts"));
  const o = cf.end();
  expect(o).toEqual({ kind: "clean" });
  expect(commitFinishLine(o!)).toBe("cleaned by resume (nothing committed)");
});

test("AC4: outcome still uncommitted — lists the files", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, cfg);
  writeFileSync(join(dir, "b.ts"), "new\n");
  cf.atSettle();
  const o = cf.end();
  expect(o).toEqual({ kind: "still", files: ["b.ts"] });
  expect(commitFinishLine(o!)).toBe("still uncommitted after one resume: b.ts");
});

test("AC5: while the follow-up runs, every worktree of the repo is held; end releases it", async () => {
  const dir = repo();
  const wt = join(mkdtempSync(join(tmpdir(), "neo-cf-wt-")), "wt");
  sh(dir, "worktree", "add", "-q", wt, "-b", "side");
  const other = repo();
  const cf = createCommitFinish(dir, cfg);
  expect(commitFinishInFlight(wt)).toBe(false);
  writeFileSync(join(dir, "b.ts"), "new\n");
  cf.atSettle();
  expect(commitFinishInFlight(dir)).toBe(true);
  expect(commitFinishInFlight(wt)).toBe(true); // same git common dir
  expect(commitFinishInFlight(other)).toBe(false);
  let released = false;
  const waiting = awaitCommitFinish(wt).then(() => void (released = true));
  await new Promise((r) => setTimeout(r, 5));
  expect(released).toBe(false);
  cf.end();
  await waiting;
  expect(released).toBe(true);
  expect(commitFinishInFlight(wt)).toBe(false);
  cf.end(); // a second end is harmless
});

test("the follow-up text is the fixed message and lists at most 20 files", () => {
  const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
  const t = commitFinishBrief(files);
  expect(t.startsWith("Your run ended with uncommitted changes: f0.ts, ")).toBe(true);
  expect(t).toContain("(+5 more)");
  expect(t).toContain("Finish now: run the project's checks that apply, then commit your work with a clear message (never `--no-verify`), or, if a change must not be committed, say why. Then end.");
});

test("AC6: readCommitFinishCfg — defaults, off switch, bad values fail closed to the default", () => {
  expect(readCommitFinishCfg(undefined)).toEqual(DEFAULT_COMMIT_FINISH_CFG);
  expect(readCommitFinishCfg({ enabled: false })).toEqual({ ...DEFAULT_COMMIT_FINISH_CFG, enabled: false });
  expect(readCommitFinishCfg({ enabled: "no", ignore: "x" })).toEqual(DEFAULT_COMMIT_FINISH_CFG);
  expect(readCommitFinishCfg({ ignore: ["dist/**", 3] })).toEqual(DEFAULT_COMMIT_FINISH_CFG);
  expect(readCommitFinishCfg({ ignore: ["dist/**"] }).ignore).toEqual(["dist/**"]);
  expect(DEFAULT_COMMIT_FINISH_CFG.enabled).toBe(true);
});

test("a disabled config never sends a follow-up", () => {
  const dir = repo();
  const cf = createCommitFinish(dir, { ...cfg, enabled: false });
  writeFileSync(join(dir, "b.ts"), "new\n");
  expect(cf.atSettle()).toBeUndefined();
});

test("review: the repository hold is bounded by holdMaxMs, so a hung run never wedges every worktree", async () => {
  const dir = repo();
  const cf = createCommitFinish(dir, { ...cfg, holdMaxMs: 30 });
  writeFileSync(join(dir, "b.ts"), "new\n");
  cf.atSettle();
  expect(commitFinishInFlight(dir)).toBe(true);
  await awaitCommitFinish(dir); // released by the bound, with no end()
  expect(commitFinishInFlight(dir)).toBe(false);
  expect(cf.end()).toEqual({ kind: "still", files: ["b.ts"] }); // the outcome is still read at the end
});
