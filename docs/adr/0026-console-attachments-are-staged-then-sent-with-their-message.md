# Console attachments are staged, then sent with their message

**Status:** accepted (2026-10-07) · extends ADR-0017 (the bundled console) and ADR-0015 (the trace
spine). (0024 is reserved by the security-checks branch.)

A file attached in the console was uploaded and sent at once, as its own message. The operator's text
came as a second message, so the worker could not tell which message the file belonged to. Now an
upload only **stages** the file: it is saved to an inbox and the channel keeps an opaque token for it.
Send posts the text and the tokens together. The channel builds one message with
`withAttachments(text, files)`, the same function Telegram's caption + file path uses.

## Considered options
- **Upload everything in one multipart request on Send.** Rejected: Send would wait on the largest
  file, a failed file would fail the whole message, and the operator could not see a file fail before
  sending.
- **The client sends the saved path back in `/msg`.** Rejected: the browser would name server paths
  that go into a worker's prompt. An opaque, one-shot token keeps the paths on the server.
- **Keep the separate file message and link it to the text afterwards.** Rejected: the worker still
  gets two turns, and the first one has no instruction.
- **A second message format for the web.** Rejected: Telegram already joins a caption and a file;
  `withAttachments` is that one format, used by both surfaces.

## Consequences
- `/upload` no longer sends anything. Its client must call `/msg` with the token.
- A file removed from the composer is deleted. An abandoned staged file stays in the inbox, as every
  upload did before. Its token expires.
- A send that names an unknown or expired token is **refused whole** (409), and the composer keeps the
  text and the chips. Rejected: dropping the unknown token and sending the rest. The worker would get
  words that point at a missing file, or an empty prompt.
- Restart-gated, like every console change.
