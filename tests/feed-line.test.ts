// The console's rich feed (spec 2026-10-07, ADR-0025): Markdown for the web target, the engine's step
// lines as code, a colour tone per line, and no way for worker output to inject markup.
import { test, expect } from "bun:test";
import { mdToHtml } from "../src/engine/format";
import { feedLine, reasonHtml } from "../src/engine/feed-line";

const web = (md: string) => mdToHtml(md, { target: "web" });

// ── AC1: tables ──────────────────────────────────────────────────────────────────────────────────
test("a GFM table: scroll wrapper, header, alignment from the separator, numeric columns right-aligned", () => {
  const html = web("| Name | Note | Count | Price |\n|---|:-:|---|---|\n| gold | ok | 12 | 1,250.50 |\n| silver | low | 7 | 99 |");
  expect(html).toContain('<div class="tbl"><table class="md">');
  expect(html).toContain("<th>Name</th>");
  expect(html).toContain('<th class="al-c">Note</th>');
  expect(html).toContain('<th class="num">Count</th>'); // every body cell is a number
  expect(html).toContain('<td class="num">1,250.50</td>');
  expect(html).toContain("<td>gold</td>");
  expect(html).not.toContain("|---");
});

test("a mixed column stays start-aligned; an explicit --: wins", () => {
  const html = web("| a | b |\n|---|--:|\n| 1 | x |\n| y | z |");
  expect(html).toContain("<th>a</th>");
  expect(html).toContain('<th class="al-r">b</th>');
});

// ── AC2: Markdown blocks and inlines ──────────────────────────────────────────────────────────────
test("headings, lists, task lists, emphasis, links and inline code are real HTML", () => {
  const html = web("## Plan\n\n1. first\n2. second\n\n- [x] done\n- [ ] open\n\n**b** *i* ~~s~~ `c` [d](https://x.dev/a?b=1&c=2)");
  expect(html).toContain('<h4 class="mh">Plan</h4>');
  expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  expect(html).toContain('<li class="task"><input type="checkbox" disabled checked> done</li>');
  expect(html).toContain('<li class="task"><input type="checkbox" disabled> open</li>');
  expect(html).toContain("<strong>b</strong> <em>i</em> <del>s</del> <code>c</code>");
  expect(html).toContain('<a href="https://x.dev/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">d</a>');
});

test("a soft line break inside a paragraph is kept as a <br>", () => {
  expect(web("one\ntwo")).toBe("one<br>two"); // a lone paragraph needs no <p>
  expect(web("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
});

// ── AC3: fenced code ──────────────────────────────────────────────────────────────────────────────
test("fenced code keeps its whitespace and language, escaped", () => {
  const html = web("```ts\nif (a < b) {\n    go();\n}\n```");
  expect(html).toBe('<pre class="code" data-lang="ts"><code>if (a &lt; b) {\n    go();\n}</code></pre>');
});

test("a fence without a language has no data-lang value", () => {
  expect(web("```\nx\n```")).toBe('<pre class="code" data-lang=""><code>x</code></pre>');
});

// ── AC4: step lines are code, never prose (the operator's heredoc repro) ──────────────────────────
const HEREDOC = "cat > update-rules.sh <<EOF\n#!/usr/bin/env bash\n# Cache the Semgrep registry packs\nset -uo pipefail\nfor p in $packs; do\n  echo \"$p\"\ndone\nEOF\nchmod +x *.sh";

test("an auto-approved shell command renders as one bash code block with every line intact", () => {
  const { html, tone } = feedLine(`🔓 auto-approved: risky shell command: ${HEREDOC}`);
  expect(tone).toBe("approval");
  expect(html).toContain('<pre class="code" data-lang="bash"><code>cat &gt; update-rules.sh &lt;&lt;EOF\n#!/usr/bin/env bash\n# Cache the Semgrep registry packs\n');
  expect(html).toContain('\n  echo "$p"\n'); // indentation kept
  expect(html).not.toContain("<h"); // no `# comment` heading
  expect(html).not.toContain("<strong>");
});

test("a tool milestone: the tool as a label; a Bash command as code, a file as inline code", () => {
  const bash = feedLine("🔧 Bash: git status --short");
  expect(bash.tone).toBe("tool");
  expect(bash.html).toContain('<span class="tl">Bash</span>');
  expect(bash.html).toContain('<pre class="code" data-lang="bash"><code>git status --short</code></pre>');
  const write = feedLine("🔧 Write: lib.sh");
  expect(write.html).toBe('<span class="ti">🔧</span><span class="tl">Write</span> <code>lib.sh</code>');
  expect(feedLine("🔧 TodoWrite").html).toBe('<span class="ti">🔧</span><span class="tl">TodoWrite</span>');
});

test("a tool result is plain code output; an error result has the error tone; a diff is detected", () => {
  const out = feedLine("↳ total 8\n-rw-r--r-- 1 root root  16 .gitignore");
  expect(out.tone).toBe("result");
  expect(out.html).toContain('<pre class="code out" data-lang=""><code>total 8\n-rw-r--r-- 1 root root  16 .gitignore</code></pre>');
  expect(feedLine("⚠️ ↳ Exit code 1\nboom").tone).toBe("error");
  const diff = feedLine("↳ @@ -1,2 +1,2 @@\n-old\n+new");
  expect(diff.html).toContain('data-lang="diff"');
});

// The two operator screenshots (todo #70), as the ledger recorded them (messages 325890, 325543).
test("repro: an auto-approved heredoc is one bash block — # comments stay comments, indentation kept", () => {
  const line =
    "🔓 auto-approved: risky shell command: cat > update-rules.sh <<'EOF'\n#!/usr/bin/env bash\n" +
    "# Cache the Semgrep registry packs locally so per-edit scans are fast and work offline.\n" +
    'set -uo pipefail\nfor p in $packs; do\n  if curl -fsS -m 30 "https://semgrep.dev/c/p/$p"; then :; fi\ndone\nEOF';
  const r = feedLine(line);
  expect(r.tone).toBe("approval");
  expect(r.html).toContain('<pre class="code" data-lang="bash"><code>cat &gt; update-rules.sh');
  expect(r.html).toContain("\n# Cache the Semgrep registry packs");
  expect(r.html).toContain("\n  if curl -fsS");
  expect(r.html).not.toMatch(/<h\d|<strong>|<br>/);
});

test("repro: a ClickHouse box table result keeps every column and float as written, in one code block", () => {
  const box =
    "┌─action─────┬────n─┬─age_seconds_p50_p90_p95_p99───────────────────────┐\n" +
    "1. │ book       │  121 │ [186,682,1006,1158.7999999999997]                 │\n" +
    "2. │ revalidate │ 1150 │ [63,300.10000000000014,435.9499999999996,1082.12] │\n" +
    "   └────────────┴──────┴───────────────────────────────────────────────────┘";
  const r = feedLine(`↳ ${box}`);
  expect(r.tone).toBe("result");
  expect(r.html).toBe(`<span class="ti">↳</span><pre class="code out" data-lang=""><code>${box}</code></pre>`);
});

test("a JSON tool result is highlighted as json; text that only starts with a bracket is not", () => {
  expect(feedLine('↳ [\n {\n  "tag": "360-en-dark",\n  "total": 7\n }\n]').html).toContain('data-lang="json"');
  expect(feedLine('↳ {"ok":true}').html).toContain('data-lang="json"');
  // The engine cuts long results short ("…"): a cut JSON document is still JSON.
  expect(feedLine('↳ [\n {\n  "thread": {\n   "code": 6,\n   "tbl": true…').html).toContain('data-lang="json"');
  expect(feedLine("↳ [1/3] building").html).toContain('data-lang=""');
  expect(feedLine('↳ ["a", "b"]').html).toContain('data-lang="json"');
  expect(feedLine('↳ ["$x" = y]').html).toContain('data-lang=""'); // a shell test, not a string array
  expect(feedLine("↳ [security] semgrep packs cached").html).toContain('data-lang=""');
  expect(feedLine("↳ 42").html).toContain('data-lang=""'); // a bare scalar is not a JSON document
});

test("an escalation reason: a shell command is code, a path is inline code, anything else is text", () => {
  expect(reasonHtml("risky shell command: rm -rf /tmp/x")).toBe('risky shell command<pre class="code" data-lang="bash"><code>rm -rf /tmp/x</code></pre>');
  expect(reasonHtml("file write outside the project folder: /etc/x (folder: /home/a)")).toBe("file write outside the project folder: <code>/etc/x (folder: /home/a)</code>");
  expect(reasonHtml("unrecognized tool: <WebFetch>")).toBe("unrecognized tool: &lt;WebFetch&gt;");
});

// ── AC5: tones from the priority accents and markers ──────────────────────────────────────────────
test("every other line is Markdown, toned by its leading accent", () => {
  expect(feedLine("🔴 build failed").tone).toBe("error");
  expect(feedLine("⛔️ timed out").tone).toBe("error");
  expect(feedLine("❌ no").tone).toBe("error");
  expect(feedLine("⚠️ disk at 91%").tone).toBe("warn");
  expect(feedLine("✅ shipped").tone).toBe("done");
  expect(feedLine("🟢 done").tone).toBe("done");
  expect(feedLine("🔵 pick one").tone).toBe("info");
  const plain = feedLine("Read the module and mapped **9** families.");
  expect(plain.tone).toBe("");
  expect(plain.html).toContain("<strong>");
});

// ── AC6: numbers in prose are an isolated LTR run (attached in an Arabic line) ────────────────────
test("numbers in prose are wrapped as an LTR run; not inside code, links or entities", () => {
  const html = web("تم رفع 1,250 سجل في 10:30 — `v0.3.292` و [3](https://x.dev/3) & E2E");
  expect(html).toContain('<bdi dir="ltr" class="n">1,250</bdi>');
  expect(html).toContain('<bdi dir="ltr" class="n">10:30</bdi>');
  expect(html).toContain("<code>v0.3.292</code>");
  expect(html).toContain('<a href="https://x.dev/3"');
  expect(html).toContain("&amp; E2E"); // a digit inside a word stays as it is
  expect(web("line 4 at 10:30")).toBe("line 4 at 10:30"); // an LTR line is left untouched
});

// ── AC7: no markup injection ─────────────────────────────────────────────────────────────────────
test("hostile input renders inert", () => {
  const html = web(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://a.dev/"onmouseover="alert(1)) ![p](https://t.dev/p.png)\n\n```js" onclick="alert(1)\nx\n```',
  );
  expect(html).not.toMatch(/<(script|img)\b/i); // no live tags
  expect(html).not.toMatch(/<[^>]*\son\w+=/i); // no event-handler attribute on any emitted tag
  expect(html).not.toMatch(/href="javascript:/i);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain('data-lang="js"'); // the info string is cut to a safe language name
});

test("the step-line payload is escaped too", () => {
  expect(feedLine("↳ <b>hi</b>").html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  expect(feedLine('🔓 auto-approved: risky shell command: echo "<x>"').html).toContain('echo "&lt;x&gt;"');
});

// Review findings (2026-10-07).
test("underscores never emphasise: dunder names and paths keep their underscores (both targets)", () => {
  expect(web("rename __init__ in path/to/__tests__/x.ts and my_var_name")).toBe("rename __init__ in path/to/__tests__/x.ts and my_var_name");
  expect(mdToHtml("rename __init__ and _x_")).toBe("rename __init__ and _x_");
  expect(web("**bold** and *it*")).toBe("<strong>bold</strong> and <em>it</em>"); // asterisks still do
});

test("a text line over --- is a line and a rule, not a heading (setext)", () => {
  expect(mdToHtml("Title\n---\nnext")).toBe("Title\n———\nnext");
  expect(web("Title\n---\nnext")).toBe("<p>Title</p><hr><p>next</p>");
  expect(web("# Real")).toBe('<h3 class="mh">Real</h3>');
});

test("worker prose that starts with 🔧 or ↳ is not mistaken for a step line", () => {
  expect(feedLine("🔧 Fixed: the **login** bug\n- step two").tone).toBe("");
  expect(feedLine("🔧 Fixed: the **login** bug\n- step two").html).toContain("<strong>login</strong>");
  expect(feedLine("🔧 mcp tool: send_file").tone).toBe(""); // not one tool token
  expect(feedLine("🔧 send_file: report.md").tone).toBe("tool");
  expect(feedLine("🔧 Bash: cat > x <<EOF\n# c\nEOF").tone).toBe("tool"); // a shell command may span lines
});
