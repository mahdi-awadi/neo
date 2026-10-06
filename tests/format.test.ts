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

test("renders the real worker report shape (# header column, |---| separator, prose around it)", () => {
  // The exact repro: a '#' first column, a ragged '|---|---|' separator, surrounding ## headings.
  const report = [
    "## Completion status",
    "",
    "| # | Title | Layer | Status | What's left |",
    "|---|-------|-------|--------|-------------|",
    "| 53 | api endpoint | flutter | Not started | wire it up |",
    "| 52 | Account deletion | flutter | DONE | — |",
    "",
    "## Verdict",
    "Completed: NO",
  ].join("\n");
  const tg = mdToHtml(report, { tables: "pre" });
  expect(tg).toContain("<pre>");
  expect(tg).not.toContain("|"); // every pipe consumed into the aligned <pre> — none left raw
  expect(tg).toContain("Account deletion");
  expect(tg).toContain("<b>Verdict</b>"); // prose around the table still renders
});

test("detects a separator with alignment colons (:--: / :--)", () => {
  const tg = mdToHtml("| L | R |\n| :-- | --: |\n| a | b |", { tables: "pre" });
  expect(tg).toContain("<pre>");
  expect(tg).not.toContain("|");
});

// --- chunkMarkdown: table-aware source splitting so tables survive chunking ---
import { chunkMarkdown } from "../src/engine/format";

const isSep = (l: string) => /-/.test(l) && /^[\s:|-]+$/.test(l.trim());

test("chunkMarkdown: text with no table splits on line boundaries like a plain chunker", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `row-${i}`);
  const chunks = chunkMarkdown(lines.join("\n"), 40);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  expect(chunks.join("\n").split("\n")).toEqual(lines); // order-preserving, lossless
});

test("chunkMarkdown: a table smaller than the budget is kept whole with its surrounding prose", () => {
  const table = "| City | Region |\n|------|--------|\n| Baghdad | Central |\n| Erbil | North |";
  const chunks = chunkMarkdown(`Intro line\n${table}\nOutro line`, 4096);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toContain("Intro line");
  expect(chunks[0]).toContain("| Baghdad | Central |");
});

test("chunkMarkdown: an over-budget table is split on row boundaries, header+separator repeated on each piece", () => {
  const header = "| id | note |";
  const sep = "|----|------|";
  const rows = Array.from({ length: 40 }, (_, i) => `| ${i} | ${"detail ".repeat(4)} |`);
  const table = [header, sep, ...rows].join("\n");
  const chunks = chunkMarkdown(table, 200);

  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(200);
    const cl = c.split("\n");
    // Each chunk starts with the header row immediately followed by the separator, so mdToHtml
    // detects it as a table again — no orphaned body rows.
    expect(cl[0]).toBe(header);
    expect(isSep(cl[1]!)).toBe(true);
  }
  // No body row is lost: every original row appears in exactly one chunk.
  for (const row of rows) expect(chunks.filter((c) => c.includes(row)).length).toBe(1);
});

// --- escaping + plain-text fallback: a message full of metacharacters must never fail to send ---
import { deliverChunked } from "../src/engine/format";

test("mdToHtml escapes MarkdownV2/HTML metacharacters without throwing", () => {
  // Every Telegram MarkdownV2 special char + the HTML-significant trio, all in one line.
  const meta = "_ * [ ] ( ) ~ ` > # + - = | { } . ! < & > done";
  const html = mdToHtml(meta, { tables: "pre" });
  // The HTML-significant chars are escaped (so parse_mode HTML can't break or inject).
  expect(html).toContain("&lt;");
  expect(html).toContain("&amp;");
  expect(html).toContain("&gt;");
});

test("a styled line full of metacharacters still sends via the plain-text fallback", async () => {
  // Simulate Telegram rejecting the rich markup (html=true → not ok); plain text (html=false) is
  // accepted. deliverChunked must fall back so the message is delivered, never dropped.
  const sent: Array<{ body: string; html: boolean }> = [];
  const send = async (body: string, html: boolean) => {
    sent.push({ body, html });
    return html ? { ok: false } : { ok: true, id: 7 };
  };
  const accent = accentPrefix("alert"); // "🔴 " — the Feature-2 style prefix, on the first chunk
  const text = "build _broke_ on `main` <deploy> at 50% & [stage] — retry? {now}";
  const firstId = await deliverChunked(send, text, accent + "#eticket_v3 ");

  expect(firstId).toBe(7); // delivered
  const plain = sent.find((s) => !s.html);
  expect(plain).toBeDefined();
  // The raw text and the accent both survive in the plain body (never dropped, never mangled).
  expect(plain!.body).toContain("build _broke_ on `main`");
  expect(plain!.body.startsWith("🔴 #eticket_v3 ")).toBe(true);
});

import { accentPrefix } from "../src/engine/priority";

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

import { snippetHtml, SNIPPET_OPEN, SNIPPET_CLOSE } from "../src/engine/format";

test("snippetHtml: the text is escaped; only the match markers become <mark>", () => {
  const s = `a <b>[x]</b> ${SNIPPET_OPEN}fare${SNIPPET_CLOSE} & more`;
  expect(snippetHtml(s)).toBe("a &lt;b&gt;[x]&lt;/b&gt; <mark>fare</mark> &amp; more");
});
