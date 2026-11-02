import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMdFilesCfg, resolveMdFile, type MdFilesCfg } from "../src/engine/md-file";

// A readable root with good and bad files, and an outside folder the symlinks point into.
let root = "";
let outside = "";
let cfg: MdFilesCfg;
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "neo-mdfile-")));
  root = join(base, "work");
  outside = join(base, "outside");
  mkdirSync(join(root, "proj", "notes"), { recursive: true });
  mkdirSync(join(root, "proj", ".git"), { recursive: true });
  mkdirSync(join(root, "proj", "dir.md"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "proj", "notes", "how-neo-works.md"), "# How Neo works\n");
  writeFileSync(join(root, "proj", "README.MD"), "upper case\n");
  writeFileSync(join(root, "proj", "notes", "data.txt"), "not markdown\n");
  writeFileSync(join(root, "proj", ".env"), "dotenv fixture\n");
  writeFileSync(join(root, "proj", ".env.md"), "dotenv fixture\n");
  writeFileSync(join(root, "proj", ".git", "notes.md"), "git internals\n");
  writeFileSync(join(root, "proj", "big.md"), "x".repeat(2048));
  writeFileSync(join(outside, "foreign.md"), "outside\n");
  writeFileSync(join(outside, "plain.txt"), "outside txt\n");
  symlinkSync(join(outside, "foreign.md"), join(root, "proj", "escape.md"));
  symlinkSync(join(root, "proj", "notes", "data.txt"), join(root, "proj", "fake.md"));
  symlinkSync(outside, join(root, "proj", "linkdir"));
  cfg = { roots: [root], maxBytes: 1024, viewMaxBytes: 1024 };
});

test("a regular .md file inside a readable root is read, with its real path and name", () => {
  const r = resolveMdFile(join(root, "proj", "notes", "how-neo-works.md"), cfg);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(new TextDecoder().decode(r.bytes)).toBe("# How Neo works\n");
  expect(r.name).toBe("how-neo-works.md");
  expect(r.real).toBe(join(root, "proj", "notes", "how-neo-works.md"));
});

test("the .md check ignores case", () => {
  expect(resolveMdFile(join(root, "proj", "README.MD"), cfg).ok).toBe(true);
});

test("a file outside every root is refused (403)", () => {
  const r = resolveMdFile(join(outside, "foreign.md"), cfg);
  expect(r).toMatchObject({ ok: false, status: 403 });
});

test("a symlink inside a root that points outside is refused (403)", () => {
  expect(resolveMdFile(join(root, "proj", "escape.md"), cfg)).toMatchObject({ ok: false, status: 403 });
  expect(resolveMdFile(join(root, "proj", "linkdir", "foreign.md"), cfg)).toMatchObject({ ok: false, status: 403 });
});

test("a symlink named .md that points to a non-.md file is refused (403)", () => {
  expect(resolveMdFile(join(root, "proj", "fake.md"), cfg)).toMatchObject({ ok: false, status: 403 });
});

test("a file that is not .md is refused (403)", () => {
  expect(resolveMdFile(join(root, "proj", "notes", "data.txt"), cfg)).toMatchObject({ ok: false, status: 403 });
});

test(".env, .env.md and hidden folders are refused (403)", () => {
  expect(resolveMdFile(join(root, "proj", ".env"), cfg)).toMatchObject({ ok: false, status: 403 });
  expect(resolveMdFile(join(root, "proj", ".env.md"), cfg)).toMatchObject({ ok: false, status: 403 });
  expect(resolveMdFile(join(root, "proj", ".git", "notes.md"), cfg)).toMatchObject({ ok: false, status: 403 });
  expect(resolveMdFile("/root/.claude/CLAUDE.md", { roots: ["/"], maxBytes: 1024, viewMaxBytes: 1024 })).toMatchObject({ ok: false, status: 403 });
});

test("a relative path, a .. or . segment, or a NUL is refused (400)", () => {
  expect(resolveMdFile("proj/notes/how-neo-works.md", cfg)).toMatchObject({ ok: false, status: 400 });
  expect(resolveMdFile(`${root}/proj/notes/../notes/how-neo-works.md`, cfg)).toMatchObject({ ok: false, status: 400 });
  expect(resolveMdFile(`${root}/proj/./notes/how-neo-works.md`, cfg)).toMatchObject({ ok: false, status: 400 });
  expect(resolveMdFile(`${root}/proj/notes/how-neo-works.md\0.md`, cfg)).toMatchObject({ ok: false, status: 400 });
  expect(resolveMdFile("", cfg)).toMatchObject({ ok: false, status: 400 });
});

test("a missing file, or a directory named .md, is not found (404)", () => {
  expect(resolveMdFile(join(root, "proj", "nope.md"), cfg)).toMatchObject({ ok: false, status: 404 });
  expect(resolveMdFile(join(root, "proj", "dir.md"), cfg)).toMatchObject({ ok: false, status: 404 });
});

test("a file over the size cap is refused (413)", () => {
  expect(resolveMdFile(join(root, "proj", "big.md"), cfg)).toMatchObject({ ok: false, status: 413 });
  expect(resolveMdFile(join(root, "proj", "big.md"), { ...cfg, maxBytes: 4096 }).ok).toBe(true);
});

test("a root that does not exist is skipped; no valid root refuses everything", () => {
  const p = join(root, "proj", "notes", "how-neo-works.md");
  expect(resolveMdFile(p, { ...cfg, roots: ["/nonexistent-neo-root", root] }).ok).toBe(true);
  expect(resolveMdFile(p, { ...cfg, roots: ["/nonexistent-neo-root"] })).toMatchObject({ ok: false, status: 403 });
});

test("readMdFilesCfg: defaults to [workRoot], 2 MiB and a 256 KiB render cap; a bad value keeps the default", () => {
  const V = 256 * 1024;
  expect(readMdFilesCfg(undefined, "/home")).toEqual({ roots: ["/home"], maxBytes: 2 * 1024 * 1024, viewMaxBytes: V });
  expect(readMdFilesCfg({ roots: ["/srv/a", "relative", 5], maxBytes: 10, viewMaxBytes: 5 }, "/home")).toEqual({ roots: ["/srv/a"], maxBytes: 10, viewMaxBytes: 5 });
  expect(readMdFilesCfg({ roots: [], maxBytes: -1, viewMaxBytes: 0 }, "/home")).toEqual({ roots: ["/home"], maxBytes: 2 * 1024 * 1024, viewMaxBytes: V });
  expect(readMdFilesCfg({ roots: "/x", maxBytes: 1.5 }, "/w")).toEqual({ roots: ["/w"], maxBytes: 2 * 1024 * 1024, viewMaxBytes: V });
});
