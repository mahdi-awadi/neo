# The console renders worker output from GFM tokens, server-side, in one renderer

**Status:** accepted (2026-10-07) · extends ADR-0017 (the bundled console). (0024 is reserved by the
security-checks branch.)

Worker output reached the console as hand-parsed Markdown. Engine step lines that carry shell
commands were parsed as prose, and thread history was not formatted at all. We keep **one** renderer,
`mdToHtml` in src/engine/format.ts, but it now parses with `marked`'s GFM lexer and walks the tokens
itself for two targets (web, Telegram). A small seam, `feedLine()`, classifies the engine's own step
lines and renders their payload as code. The server renders once; the browser only highlights
visible code blocks (highlight.js core + a few languages) and adds copy buttons.

## Considered options
- **Keep extending the regex parser.** Rejected: lists, nesting, alignment and escaping rules are
  exactly what a maintained GFM lexer already gets right.
- **marked's own HTML renderer + a sanitizer (DOMPurify).** Rejected: marked passes raw HTML through
  by design. Rendering the tokens ourselves means the only tags in the output are ones we emit, so it
  is safe by construction, and the same walk produces the Telegram subset.
- **Render Markdown in the browser.** Rejected: thread history, the live feed and escalations would
  each need it. The server already renders feed lines once, and Telegram shares the module.
- **Highlight on the server (shiki/highlight.js in Bun).** Rejected: highlighting every line of a long
  history costs CPU and bytes for blocks nobody scrolls to. Lazy client highlighting is cheaper.
- **Tag step lines at their source (structured events).** Better long term, but step lines travel as
  strings through dispatch, pipeline, the operator bus and Telegram. Their prefixes are already a
  contract (`isToolStepLine`), so `feedLine` reads that contract in one place.

## Consequences
- Two new pinned dependencies: `marked`, `highlight.js` (core plus registered languages only).
- Telegram output is produced by the same token walk; its tests pin the old shape.
- Restart-gated, like every console change.
