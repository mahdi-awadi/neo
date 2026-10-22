import { test, expect } from "bun:test";
import { findMdPaths, mdFileHref } from "../src/frontends/web/md-links";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";

const paths = (s: string) => findMdPaths(s).map((m) => m.path);

test("an absolute .md path in plain text or as the whole inline code is found, with its offsets", () => {
  const s = "See /home/learning/notes/how-neo-works.md for details";
  expect(findMdPaths(s)).toEqual([{ start: 4, end: 41, path: "/home/learning/notes/how-neo-works.md" }]);
  expect(paths("/home/learning/notes/how-neo-works.md")).toEqual(["/home/learning/notes/how-neo-works.md"]);
});

test("several paths, upper-case .MD, and Arabic letters in a name", () => {
  expect(paths("a /x/README.MD and /home/p/docs/ملاحظات.md")).toEqual(["/x/README.MD", "/home/p/docs/ملاحظات.md"]);
});

test("sentence punctuation and brackets around the path are not part of it", () => {
  expect(paths("Wrote /home/p/a.md.")).toEqual(["/home/p/a.md"]);
  expect(paths("(/home/p/a.md), then")).toEqual(["/home/p/a.md"]);
  expect(paths('"/home/p/a.md": done')).toEqual(["/home/p/a.md"]);
  expect(paths("الملف /home/p/a.md، جاهز")).toEqual(["/home/p/a.md"]);
});

test("not a link: URLs, relative paths, other extensions, .md.bak, hidden and .. segments", () => {
  expect(paths("https://github.com/x/y/README.md")).toEqual([]);
  expect(paths("docs/plan.md")).toEqual([]);
  expect(paths("./docs/plan.md")).toEqual([]);
  expect(paths("/home/p/a.txt /home/p/a.mdx")).toEqual([]);
  expect(paths("/home/p/a.md.bak")).toEqual([]);
  expect(paths("/home/p/.git/notes.md /home/p/.env.md")).toEqual([]);
  expect(paths("/home/p/../q/a.md")).toEqual([]);
  expect(paths("word/home/p/a.md")).toEqual([]);
});

test("repeated calls find the same paths (no regex state leaks between calls)", () => {
  const s = "/home/p/a.md and /home/p/b.md";
  expect(paths(s)).toEqual(["/home/p/a.md", "/home/p/b.md"]);
  expect(paths(s)).toEqual(["/home/p/a.md", "/home/p/b.md"]);
});

test("the link targets /md-file with the path encoded", () => {
  expect(mdFileHref("/home/p/a b&c.md")).toBe("/md-file?path=%2Fhome%2Fp%2Fa%20b%26c.md");
});

test("the link's tooltip is in both catalogues", () => {
  expect(en.files.download).toBeTruthy();
  expect(ar.files.download).toBeTruthy();
  expect(ar.files.download).not.toBe(en.files.download);
});
