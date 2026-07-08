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

const TABLE = "| City | Region |\n|------|--------|\n| Baghdad | Central |\n| Erbil | North |";

test("renders a Markdown table as an HTML <table> for the web", () => {
  const html = mdToHtml(TABLE);
  expect(html).toContain("<table");
  expect(html).toContain("<th>City</th>");
  expect(html).toContain("<td>Baghdad</td>");
  expect(html).toContain("<td>North</td>");
  expect(html).not.toContain("|---"); // no raw pipes left
});

test("renders a table as an aligned <pre> block for Telegram", () => {
  const tg = mdToHtml(TABLE, { tables: "pre" });
  expect(tg).toContain("<pre>");
  expect(tg).not.toContain("<table");
  expect(tg).toContain("Baghdad");
  expect(tg).toContain("City  "); // padded/aligned column
});

test("a table with surrounding prose keeps the prose and renders the table", () => {
  const html = mdToHtml(`Here is the market:\n${TABLE}\nThat's all.`);
  expect(html).toContain("Here is the market:");
  expect(html).toContain("<table");
  expect(html).toContain("That&#39;s all.".replace("&#39;", "'")); // apostrophe not escaped
});

// --- projectHashtag: clickable Telegram hashtags per project ---
import { projectHashtag } from "../src/engine/format";

test("projectHashtag: plain name", () => {
  expect(projectHashtag("waselni")).toBe("#waselni");
});

test("projectHashtag: hyphen becomes underscore (eticket-v3)", () => {
  expect(projectHashtag("eticket-v3")).toBe("#eticket_v3");
});

test("projectHashtag: lowercases and maps dots/spaces, collapsing repeats", () => {
  expect(projectHashtag("Tech Gate.online")).toBe("#tech_gate_online");
  expect(projectHashtag("a--b..c")).toBe("#a_b_c");
});

test("projectHashtag: leading digit gets p_ prefix", () => {
  expect(projectHashtag("3dprint")).toBe("#p_3dprint");
});

test("projectHashtag: too-short result gets p_ prefix", () => {
  expect(projectHashtag("x")).toBe("#p_x");
});

test("projectHashtag: trims stray edge underscores from sanitizing", () => {
  expect(projectHashtag("-neo-")).toBe("#neo");
});
