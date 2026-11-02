# Console: attachments travel with their message

**Order (operator, 2026-10-07):** a file attached in the web console must go with the message it
belongs to. Today the worker gets a separate `📎 operator attached <file> at <path>` line, and the
operator's text comes as another message, or not at all. So the AI cannot tell which message a file
belongs to.

## Root cause
- The client uploads the moment a file is picked or pasted (`sendFile` in web/app.ts).
- `POST /upload` saves the file and calls `channel.send(...)` at once (src/frontends/web.ts). The
  text typed in the composer goes later, through `POST /msg`, as a second message.
- The thread composer has no attach button at all.
- Telegram already sends a caption and its file as one message (`intakeFile` in
  src/frontends/telegram.ts). It builds the text inline, so the web cannot reuse it.

## Design (one seam)
- **`withAttachments(text, files)`** (src/engine/files.ts) is the one place that writes a message with
  its files: the text, then a blank line, then `Attached files:` and one `- \`name\` at \`path\`` line
  per file. Telegram's caption path and the console both use it.
- **Staged attachment.** `POST /upload` only saves the file to an inbox and registers it in the web
  channel (`channel.stage`). It returns `{ token, name, size }`. Nothing is sent. The inbox is the
  thread's project folder when the upload names a thread with a folder. Otherwise it is the active
  project's folder, as before.
- **`POST /upload/discard { token }`** removes a staged file that the operator took out (×).
- **`POST /msg { text, threadId?, attachments?: token[] }`**: first `channel.check` runs. If a token
  is unknown or expired (a reload or the TTL forgot it), or the text is a slash line that is not an
  `/open` order, `/msg` answers 409 `{ error: "expired" | "command" }` and sends nothing. Otherwise the
  pipeline gets one message, `withAttachments(text, files)`. That is one trace inbound row and one
  prompt. Thread routing works as for any message. The tokens are used up (one-shot) only after the
  message is routed, so a thread "clarify" reply keeps them. The client never sends a server path.
- **Client (web/attachments.ts):** a pure staging model per composer (uploading → ready | failed,
  with progress). It decides when Send is allowed and builds the `/msg` body. app.ts only draws chips
  and runs the XHR uploads.

## Acceptance criteria
1. Picking or pasting a file stages a chip in the composer (name, size, ×). Nothing is sent before Send.
2. Text + files → one `/msg` → one ledger row and one prompt with the text and every file path.
3. Files and no text → one message with just the `Attached files:` list.
4. Each chip shows upload progress. A failed upload shows an error and a retry. Send is disabled while
   any upload is running.
5. × on a staged chip removes it and deletes the staged file. A used token cannot be used again.
6. The thread composer has the same attach flow. Its message joins the thread, and its files go to
   the thread's project inbox.
7. Telegram's caption + file builds its text with the same `withAttachments`.
8. All strings come from the EN+AR catalogues. Chips work at phone width, and RTL is correct (file
   names stay LTR runs).
9. A slash command with files is not run as a command. A slash line with files that is not an
   `/open` order is refused (409 `command`), because the pipeline would answer "not an order" and lose
   the files. An `/open` order carries its files in its task.
10. A refused send keeps the composer: the text and the chips stay, and a translated note says why.
    `expired` turns the chips to failed, so Retry uploads the kept file again.

## Edge cases
- An upload that finishes after the chip was removed is discarded on the server.
- A token from another console session works: the console has one operator.
- Staged entries expire after `STAGE_TTL_MS`. The file stays in the inbox, as every upload did before.
  A send that names an expired entry is refused whole (AC 10). It is never sent without the file.
- An upload refused for "no active project" shows that reason in the composer note.
- Telegram: the caption now comes before the file list, so a caption that is an `/open` order opens
  the project with the file. A caption that is another slash line gets the pipeline's "not an order"
  reply. The file stays saved in the inbox.

## Not in scope
Telegram albums (several photos in one post) still arrive as separate updates, one file each.
