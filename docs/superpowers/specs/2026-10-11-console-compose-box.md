# Console compose box and per-line direction — spec (2026-10-11)

Operator report: the console composer is a single-line input, and a pasted multi-line Arabic message
renders left-to-right in the feed (bullets on the left, punctuation on the wrong end). Design: ADR-0033.

## Root cause
- `#msg` and `#tmsg` were `<input>` elements. An input cannot hold a line break, and a paste flattens the lines.
- The operator's own lines (the optimistic row, the Telegram echo, thread history) were escaped text
  with no direction of their own, so they took the page direction.
- The server's web Markdown had no `dir` on its blocks. The feed set `dir="auto"` on the whole body, so
  the first letter of the message decided the direction for every line.

## Acceptance criteria
1. The main composer, the thread reply, the new-project task, and the inbox instructions and notes
   are multi-line compose boxes:
   - On a desktop, Enter sends and Shift+Enter adds a new line.
   - On a touch screen, Enter adds a new line and Send sends.
   - Ctrl/Cmd+Enter sends.
   - An IME Enter is left alone.
2. The customer draft and the loop prompt grow the same way, but Enter never sends.
3. A box grows with its text to its CSS max height, then scrolls. After a send it returns to one line.
4. A pasted multi-line text keeps every line break. The posted `/msg` body has the same lines.
5. Line breaks reach the worker brief (`/open` task) and the Telegram echo unchanged.
6. In the feed and in threads, each line of the operator's own text is its own `dir="auto"` block:
   - An Arabic line is RTL and an English line is LTR.
   - Numbers in Arabic text are an LTR isolate.
7. Worker Markdown on the web: each paragraph, heading, list item and quote, and each top-level line
   of a paragraph, has `dir="auto"`. An Arabic list item's bullet and indent sit on the right.
   Telegram output is unchanged.
8. One shared component, bound once. No per-screen key handling.
9. All new strings are in the EN and AR catalogues (`feed.composeHint`).

## Edge cases
- A `<br>` inside a tag (bold over two lines) does not split the paragraph.
- An empty line renders as an empty line.
- An empty box after a send does not size itself to a wrapped placeholder.
- A disabled Send (uploads pending) stays disabled on Enter.

## Verification
- Unit tests: `tests/console-compose.test.ts`, the updated `feed-line`, `console-rich-feed` and
  `console-responsive` tests, and the multi-line test in `web-channel.test.ts`.
- A Playwright check on desktop EN, desktop AR and phone AR. The script, the screenshots and
  `result.json` are in `/home/neo/.superpowers/evidence/2026-10-11-compose-box/`.
