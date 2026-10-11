# One compose box for every message field, and every line takes its own direction

**Status:** accepted (2026-10-11) · extends ADR-0025 (the rich feed) and ADR-0026 (attachments in the
composer).

The console composer was a single-line `<input>`. It dropped the line breaks of a pasted message,
and the operator could not type a second line. The other fields that take a brief behaved
differently from one screen to the next. Separately, the operator's own text in the feed (typed
here, or mirrored from Telegram) rendered with the page direction. A multi-line Arabic message
therefore read left-to-right: the bullets sat on the left, and each line's punctuation landed on the
wrong end.

Two decisions:

1. **One compose box.** Every field that takes a message or a brief is a
   `<textarea data-compose="send|text">`. One delegated binding (`bindComposeBoxes`, in
   `web/compose-box.ts`) gives all of them the same behaviour:
   - On a desktop, Enter sends and Shift+Enter (or Alt+Enter) adds a new line.
   - On a touch screen, Enter adds a new line and the Send button sends.
   - Ctrl/Cmd+Enter sends everywhere.
   - An IME composition keeps its Enter.
   - `data-compose="text"` boxes (the customer reply draft, the loop prompt) never send on Enter.
   - The box grows to its CSS `max-height`, then scrolls.
   - A send "clicks" what a click would: the form's submit, or the `data-compose-submit` button next
     to the box. There is no second send path.
2. **Every line takes its own direction.** The operator's own text renders one `dir="auto"` block per
   line (`web/text-lines.ts`). The server's web Markdown gives `dir="auto"` to every paragraph,
   heading, list item and quote. It also gives `dir="auto"` to each top-level line of a paragraph
   (`format.ts`, `topLevelLines`). Numbers in Arabic text stay an LTR run through one shared helper
   (`engine/bidi.ts`), which both the server and the browser bundle use.

## Considered options
- **Fix each screen's input on its own.** Rejected: the brief fields drift apart again. The operator
  must learn which box sends on Enter.
- **A contenteditable editor.** Rejected: paste would bring in HTML and the editor would need its own
  sanitising. A textarea keeps plain text and its line breaks by itself.
- **`dir="auto"` on the message container only.** Rejected: the first strong letter of the whole
  message decides the direction for every line, so a message that starts in Arabic shows its English
  lines right-to-left too.
- **`dir="auto"` on lists.** Rejected: `dir=auto` skips children that have their own `dir`, so a list
  of `dir=auto` items always resolves LTR and puts the indent on the wrong side. Each item has its own
  direction, and the CSS indents each item on its own start side (`margin-inline-start`).
- **Split a paragraph at every `<br>`.** Rejected: a `<br>` inside bold text would cut the element in
  half. Only top-level line breaks split. A tag that spans lines keeps its `<br>`.

## Consequences
- Line breaks already survived the server (`/msg` trims only the ends, `parseOrder` matches across
  lines, the Telegram echo is plain text). A test now pins this behaviour.
- The Telegram target of `mdToHtml` is unchanged. Telegram clients pick the direction of each
  paragraph themselves.
- The console has no plan "Changes" reply box and no decision-answer box yet (`planAction` refuses
  "changes" on the web). When one is added, it must be a compose box.
- The bundle version is its content hash (ADR-0023), so the changed bundle is served under a new
  `/app.js?v=` URL. Restart-gated, like every console change.
