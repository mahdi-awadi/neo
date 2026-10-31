// ADR-0072: the guard measures a run's own change with git (spec §5.3, AC 9 — the measure part), from the
// one run baseline the commit finish shares (ADR-0037). Temp git repos made by the test.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runBaseline } from "../src/engine/commit-finish";
import { measureRunChange } from "../src/engine/size-guard";
import { compileSizeRules, DEFAULT_SIZES_CFG } from "../src/engine/order-size";
import { DEFAULT_PLAN_PATHS } from "../src/engine/plans";

const RULES = () => compileSizeRules(DEFAULT_SIZES_CFG, "p", DEFAULT_PLAN_PATHS);

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** A repo with `src/a.ts` (2 lines) and `src/b.ts` committed; returns the folder and its start sha. */
function repo(): { dir: string; start: string } {
  const dir = mkdtempSync(join(tmpdir(), "neo-sm-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "a\nb\n");
  writeFileSync(join(dir, "src", "b.ts"), "x\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return { dir, start: sh(dir, "rev-parse", "HEAD") };
}
const measure = (dir: string, start: string | undefined, extra: Partial<Parameters<typeof measureRunChange>[0]> = {}) =>
  measureRunChange({ folder: dir, startSha: start, baseline: runBaseline(dir), rules: RULES(), ...extra });

test("a committed and an uncommitted change since the start are both counted, with numstat lines", () => {
  const { dir, start } = repo();
  const baseline = runBaseline(dir);
  writeFileSync(join(dir, "src", "a.ts"), "a\nc\nd\n"); // 1 deleted, 2 added
  sh(dir, "commit", "-qam", "work");
  writeFileSync(join(dir, "src", "b.ts"), "y\n"); // 1 deleted, 1 added, uncommitted
  const m = measureRunChange({ folder: dir, startSha: start, baseline, rules: RULES() })!;
  expect([...m.files.entries()].sort()).toEqual([["src/a.ts", 3], ["src/b.ts", 2]]);
  expect(m.lines).toBe(5);
  expect(m.created.size).toBe(0);
  expect(m.services.size).toBe(0);
});

test("a new untracked file counts its lines and is created; a binary file is a file with 0 lines", () => {
  const { dir, start } = repo();
  const baseline = runBaseline(dir);
  writeFileSync(join(dir, "src", "new.ts"), "1\n2\n3");
  writeFileSync(join(dir, "src", "blob.bin"), Buffer.from([0, 1, 2, 0, 10]));
  const m = measureRunChange({ folder: dir, startSha: start, baseline, rules: RULES() })!;
  expect(m.files.get("src/new.ts")).toBe(3);
  expect(m.files.get("src/blob.bin")).toBe(0);
  expect([...m.created].sort()).toEqual(["src/blob.bin", "src/new.ts"]);
  // A committed binary file too.
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "files");
  const m2 = measureRunChange({ folder: dir, startSha: start, baseline, rules: RULES() })!;
  expect(m2.files.get("src/blob.bin")).toBe(0);
  expect(m2.files.get("src/new.ts")).toBe(3);
  expect(m2.created.has("src/new.ts")).toBe(true);
});

test("a rename counts both paths; a deletion counts", () => {
  const { dir, start } = repo();
  const baseline = runBaseline(dir);
  sh(dir, "mv", "src/b.ts", "src/c.ts");
  rmSync(join(dir, "src", "a.ts"));
  const m = measureRunChange({ folder: dir, startSha: start, baseline, rules: RULES() })!;
  expect([...m.files.keys()].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  expect(m.files.get("src/a.ts")).toBe(2);
});

test("a path dirty before the run and untouched is not counted; touched again, it is", () => {
  const { dir, start } = repo();
  writeFileSync(join(dir, "src", "a.ts"), "operator's edit\n");
  writeFileSync(join(dir, "src", "local.ts"), "untracked before the run\n");
  const baseline = runBaseline(dir);
  expect(measureRunChange({ folder: dir, startSha: start, baseline, rules: RULES() })!.files.size).toBe(0);
  writeFileSync(join(dir, "src", "a.ts"), "operator's edit, then the worker's longer change\n");
  const m = measureRunChange({ folder: dir, startSha: start, baseline, rules: RULES() })!;
  expect([...m.files.keys()]).toEqual(["src/a.ts"]);
});

test("ignored paths (docs/**, *.md) are not counted; services come from Dockerfile folders", () => {
  const { dir, start } = repo();
  const baseline = runBaseline(dir);
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "x.ts"), "doc\n");
  writeFileSync(join(dir, "README.md"), "readme\n");
  mkdirSync(join(dir, "services", "core-service", "api"), { recursive: true });
  mkdirSync(join(dir, "ui", "agency-ui"), { recursive: true });
  writeFileSync(join(dir, "services", "core-service", "Dockerfile"), "FROM x\n");
  writeFileSync(join(dir, "ui", "agency-ui", "Containerfile"), "FROM y\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "services");
  const base2 = runBaseline(dir);
  const start2 = sh(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "services", "core-service", "api", "h.go"), "package api\n");
  writeFileSync(join(dir, "ui", "agency-ui", "page.tsx"), "x\n");
  writeFileSync(join(dir, "src", "a.ts"), "shared\n");
  const m = measureRunChange({ folder: dir, startSha: start2, baseline: base2, rules: RULES() })!;
  expect([...m.files.keys()].sort()).toEqual(["services/core-service/api/h.go", "src/a.ts", "ui/agency-ui/page.tsx"]);
  expect([...m.services].sort()).toEqual(["services/core-service", "ui/agency-ui"]);
  // The first measure: the Dockerfiles are part of the change; the docs and the README are not.
  const first = measureRunChange({ folder: dir, startSha: start, baseline, rules: RULES() })!;
  expect([...first.files.keys()].some((p) => p.startsWith("docs/") || p.endsWith(".md"))).toBe(false);
});

test("a folder inside a repo measures its own paths, folder-relative", () => {
  const { dir, start } = repo();
  const sub = join(dir, "src");
  const baseline = runBaseline(sub);
  writeFileSync(join(dir, "src", "a.ts"), "changed\n");
  writeFileSync(join(dir, "top.ts"), "outside the folder\n");
  const m = measureRunChange({ folder: sub, startSha: start, baseline, rules: RULES() })!;
  expect([...m.files.keys()]).toEqual(["a.ts"]);
});

test("a repository with no commit at the start diffs against the empty tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-sm-empty-"));
  sh(dir, "init", "-q", "-b", "main");
  const baseline = runBaseline(dir);
  writeFileSync(join(dir, "a.ts"), "1\n2\n");
  sh(dir, "add", "a.ts");
  const m = measure(dir, undefined, { baseline })!;
  expect(m.files.get("a.ts")).toBe(2);
  expect(m.created.has("a.ts")).toBe(true);
});

test("a folder outside git → undefined; a git that fails → undefined", () => {
  const plain = mkdtempSync(join(tmpdir(), "neo-sm-nogit-"));
  writeFileSync(join(plain, "x.ts"), "x\n");
  expect(measure(plain, undefined)).toBeUndefined();
  const { dir, start } = repo();
  expect(measure(dir, start, { git: () => undefined })).toBeUndefined();
  // Only the diff fails: still undefined, never a partial measure.
  const { git } = require("../src/engine/git-read") as typeof import("../src/engine/git-read");
  expect(measure(dir, start, { git: (f, a) => (a[0] === "diff" ? undefined : git(f, a)) })).toBeUndefined();
  expect(measure(dir, start, { git: (f, a) => (a[0] === "ls-files" ? undefined : git(f, a)) })).toBeUndefined();
});

test("runBaseline: outside git → undefined; inside, own() is true for clean paths and changed dirty ones", () => {
  expect(runBaseline(mkdtempSync(join(tmpdir(), "neo-sm-nogit-")))).toBeUndefined();
  const { dir } = repo();
  writeFileSync(join(dir, "src", "a.ts"), "dirty\n");
  const b = runBaseline(dir)!;
  expect(b.root.length).toBeGreaterThan(0);
  expect(b.own("src/a.ts")).toBe(false);
  expect(b.own("src/b.ts")).toBe(true);
  writeFileSync(join(dir, "src", "a.ts"), "dirty and changed again\n");
  expect(b.own("src/a.ts")).toBe(true);
});
