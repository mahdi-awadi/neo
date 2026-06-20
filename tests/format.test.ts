import { test, expect } from "bun:test";
import { mdToHtml } from "../src/engine/format";

test("plain text passes through unchanged", () => {
  expect(mdToHtml("hi from worker")).toBe("hi from worker");
});

test("escapes HTML-special characters", () => {
  expect(mdToHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
});

test("**bold** becomes <b> (the reported case)", () => {
  expect(mdToHtml("**What's in it (Phase 1):**")).toBe("<b>What's in it (Phase 1):</b>");
});

test("inline `code` becomes <code>", () => {
  expect(mdToHtml("run `ls -l` now")).toBe("run <code>ls -l</code> now");
});

test("# headers become bold lines", () => {
  expect(mdToHtml("## Title here")).toBe("<b>Title here</b>");
});

test("- and * bullets become •", () => {
  expect(mdToHtml("- one\n- two")).toBe("• one\n• two");
});

test("fenced code blocks become <pre> with escaped contents", () => {
  expect(mdToHtml("```\nif a < b {}\n```")).toBe("<pre>if a &lt; b {}</pre>");
});

test("links become anchors (http/https only)", () => {
  expect(mdToHtml("see [docs](https://x.com/y)")).toBe('see <a href="https://x.com/y">docs</a>');
});

test("a script injection is neutralised, not rendered", () => {
  expect(mdToHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("newlines are preserved", () => {
  expect(mdToHtml("a\nb")).toBe("a\nb");
});
