# Console feed: rich, safe rendering of worker output

**Order (operator, 2026-10-07):** tables and other worker output must show styled and in colour. A
`cat > x <<EOF` heredoc showed as prose: `#` comments became bold headings, and indentation and line
breaks were lost.

## Root cause
1. `mdToHtml` (src/engine/format.ts) is a hand-written regex subset: no real lists, headings shown as
   bold lines, no column alignment, no language on fenced code.
2. Engine step lines carry raw shell and output (`🔓 auto-approved: risky shell command: <full command>`,
   `↳ <tool output>`, `🔧 Bash: <command>`). `web-channel.ts` sends every line through `mdToHtml` as
   prose, so a `# comment` becomes a heading.
3. Thread history (`messageHtml` in app.ts) shows `esc(m.content)`: no formatting at all.

## Design (one seam)
- `mdToHtml(md, { target })` stays the one Markdown renderer. It parses with `marked`'s GFM lexer and
  renders the tokens itself for two targets: `web` (full HTML) and `telegram` (the b/i/code/pre/a
  subset, tables as an aligned `<pre>`). Every text node is escaped; no raw HTML from the input ever
  reaches the output; links are http(s)/mailto only.
- `feedLine(text) → { html, tone }` (src/engine/feed-line.ts) is the web seam. It recognises the
  engine's step lines (tool, result, error result, auto-approval) and renders their payload as a code
  block (`bash` for shell commands; `diff` when the output looks like a diff). Every other line is
  Markdown. `tone` ∈ tool | result | error | warn | done | approval | info | "" drives the colour.
- The server renders once: live `message` events, thread history rows and escalation reasons.
- The client (`web/code-blocks.ts`) only enhances: highlight.js on code blocks as they scroll into
  view (IntersectionObserver, size cap), plus a copy button. Strings come from the catalogues.

## Acceptance criteria
1. GFM tables: bordered, zebra rows, horizontal scroll in a wrapper, columns aligned by `:--:`
   markers; columns whose body cells are all numbers are right-aligned.
2. Headings, ordered/unordered/task lists, bold, italic, strike, links, inline code render as HTML.
3. Fenced code → `<pre class="code" data-lang>` with whitespace kept; highlighted lazily; copy button.
4. A step line's shell command or output is a code block, never Markdown prose (the heredoc repro).
5. Rows are coloured by tone; diff lines (+/−) are coloured; light and dark themes; contrast ≥ 4.5:1.
6. In the Arabic UI, code and tables stay LTR; numbers in prose are an isolated LTR run.
7. XSS: `<script>`, `<img onerror>`, `javascript:` links, quotes in hrefs and a hostile fence info
   string all render inert.
8. Telegram output keeps its current shape (existing tests stay green).
9. Long feeds stay fast: only visible blocks are highlighted; blocks over 20k chars are not.

## Not in scope
Write/Edit file contents are not in the feed (the milestone carries only the file name).

## Follow-up (todo #70, 2026-10-07)
The two operator screenshots (Activity heredoc, Threads ClickHouse result) came from the running
master, which predates this spec; the ledger rows behind them render correctly on this design and are
now pinned as tests. Three gaps remained:
10. **Aligned output stays aligned.** `toolResultPreview` trimmed the first line's indentation, so a
    ClickHouse PrettyCompact table (header indented over the `1.` column) lost its alignment. It now
    drops only blank lines around the output.
11. **JSON output is coloured.** A result that opens like a JSON object or array gets `data-lang=json`.
    It is read from the opening only, because the engine cuts long results short (`…`) and a cut
    document does not parse. `[security] warn` and `[1/3] building` stay plain.
12. **Long blocks fold.** A block over `COLLAPSE_LINES` (16) lines starts at that height with a fade
    and a toggle (`code.expand` with the count / `code.collapse`, AR+EN, `aria-expanded`). It still
    scrolls sideways while folded. Folding is client-side, display only.
