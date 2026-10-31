# A sent file is recorded with its own copy, and the console serves only that copy

**Status:** proposed (2026-10-31). Spec: `docs/superpowers/specs/2026-10-31-sent-files-in-console.md`. Plan:
`docs/superpowers/plans/2026-10-31-sent-files-in-console.md`. Related: ADR-0019 (plan cards), ADR-0025 (safe
Markdown), ADR-0026 (staged attachments), ADR-0036 (plan gate), ADR-0046 (`/md-file`), ADR-0065 (pins),
ADR-0067 (task history), ADR-0071 (plan read before approval; its "plans the console cannot serve" limit ends
here), ADR-0022 (the service worker never caches personal content), ADR-0040/0068 (disk kit, disk guard).

## Context

Operator order (2026-10-31): every file Neo sends (plans, specs, reports, any `send_file`) reaches Telegram, but
the web console cannot open or download it. Root cause, checked in the code: **a sent file is a surface event,
not an engine record.**

- `send_file` hands the bytes to the `sendFile` port of the surface whose deps started the run
  (`pipeline.ts:716-718`, `dispatch.ts:1817`). Telegram's port only calls `sendDocument` (`telegram.ts:574-575`).
  The todo queue launches every release it starts itself with Telegram's deps (`telegram.ts:578-583`), so most
  project files never reach the console. The web port keeps the path in an in-memory token map (`web-channel.ts:242-250`),
  which a restart empties; `GET /file` then answers 404 (`web.ts:380-388`).
- The only durable trace is a text line of kind `file` holding the caption or the base name
  (`dispatch.ts:2033-2035`): no path, no hash, nothing the console could open.
- Plan cards go to Telegram only (`telegram.ts:1288-1301`). The console reads the live plan file through
  `/md-file`, only in a pin's Review sheet, only inside `mdFiles.roots` (ADR-0071 limit), and it shows the file
  as it is now, not the version on the card.
- The operator bus has no file line (`operator-bus.ts:16-19`). Loops have no `send_file` tool
  (`loops.ts:528-532`). A bot cannot read a chat's history, and Neo never stored a Telegram `file_id`.

## Decision

1. **Record first, then deliver.** One engine seam, `SentFiles` (`src/engine/sent-files.ts`), copies the file,
   classifies it and writes one ledger row for every file the engine sends to the operator: a worker's
   `send_file` and each plan card's document. The console listens to the records. Telegram receives the
   stored copy, so all three hold the same bytes. A daemon-built Telegram file poster (like the plan poster)
   replaces the per-surface `sendFile` port, so a file reaches both surfaces whatever surface started the run.
2. **A new ledger table, `sent_files` (migration v19).** Its own row per sent file, linked to the thread, the
   trace line, the order and the plan version, with its Telegram deliveries as JSON.
3. **A content-addressed copy, written before delivery.** `data/sent-files/<aa>/<sha256>` (folder 0700, files
   0600). The original path and its stat are kept only to report the original's state (`unchanged`,
   `ticked` for a plan whose checkboxes moved, `changed`, `deleted`, `unknown`). The original is never served.
   Caps: `sentFiles.maxBytes` (a larger file is refused, with an honest tool result), `storeMaxBytes` and
   `keepDays` (eviction, never an open plan's copy). A copy that cannot be made never blocks a send: Telegram
   gets the original and the record says "not kept".
4. **The ref is 128 random bits** (`f` + 22 base64url characters). The integer id stays in the server; the hash
   is never a URL. Every route needs the admin session, and the ref is the only way to name a file.
5. **The type is decided once, when the copy is made: the extension and the bytes must agree.** Our own small
   signature table for the types we show; anything else, or a disagreement, is download-only.
6. **Viewers.** Markdown: the one safe renderer (`mdToHtml`, ADR-0025) under `mdFiles.viewMaxBytes`. Text and
   code (HTML and XML included, as their source): escaped text with the existing highlighter, the head of a large
   file. Images: `<img>`. SVG: `<img>` only. PDF: the browser's viewer in a new tab. Video and audio: native
   players with HTTP Range. Everything else: download only.
7. **Headers.** `nosniff`, CORP `same-origin`, `Referrer-Policy: no-referrer`, `private, no-cache` with the
   sha256 as a strong ETag, `Accept-Ranges: bytes`, one-range `206`/`416`, `HEAD`, `304`. A
   `Content-Security-Policy: sandbox; default-src 'none'; …` on every byte response except PDF (a `sandbox` or
   `object-src 'none'` policy can stop the browsers' built-in PDF viewers; PDF keeps `nosniff`, CORP and the
   verified signature). SVG and every download are `attachment`; a non-viewable file is
   `application/octet-stream`. A `Sec-Fetch-Site` of `same-site` or `cross-site` is refused.
8. **Where it shows.** The feed (a row per record, a thumbnail for a small image), the thread (a chip under the
   file or plan line, and a Files section), the item sheet (a plan's Review renders the version on its card; a
   decision lists its thread's files), the project page (Files), and History search hits. Files get no pin kind:
   the strip is for what only the operator can move.
9. **Backfill: plan cards only.** For each plan card already sent, the copy comes from the current file or from
   a git blob of that path whose review hash equals the card's. Older `send_file` lines say "sent before the
   console kept files". From now on each Telegram delivery stores its message id (a reply joins the thread) and
   its `file_id`.
10. **History.** A `file` source (ref `file:<file ref>`) indexes the name, the caption and the text of a kept
    text file, under the same firewall as plans. A plan card's file is not indexed twice. Removing a file forgets
    its entry.

## Rejected alternatives

- **Columns on `messages`:** the busiest table; a file sent without a trace has no line; one file has several
  deliveries. **`events`:** retention prunes it. **`plans`:** plans only. **A separate SQLite file:** the record
  joins threads, orders and plans, so it belongs in the ledger.
- **Reference only (path + sha256):** worktrees and `/tmp` are removed daily (worktree rule, disk kit Tier A), so
  most files would read "deleted" within a day; serving a path re-opens a symlink race and needs a re-hash per
  Range request. **Reference for large files (hybrid serving):** a stat fingerprint per request and an open file
  descriptor kept across a streamed body; the size cap is the simpler rule.
- **Blobs in SQLite:** `bun:sqlite` has no incremental blob I/O, so each Range request loads the whole file;
  the backups grow. **An object store (MinIO, R2):** none runs on this host; a credential and a network hop for a
  local cache of files that already live in repositories and in Telegram.
- **A sequential id with the session only:** a leaked URL names every other file. **The sha256 as the URL:** the
  hash of a known file is guessable.
- **Extension only:** a renamed HTML file becomes a "PNG". **Bytes only:** a text file has no signature. **The
  `file-type` package:** broad detection we do not need, and a dependency chain; anything unknown is a download.
- **HTML in a sandboxed iframe, a server-side SVG sanitizer, or SVG as download only:** the first two are new
  surfaces to keep safe; `<img>` already gives SVG a script-free sandbox, and the source view covers HTML.
- **pdf.js in the console:** a large second renderer; the platforms' own viewers are enough.
- **Mirror files on the operator bus:** each sender would have to remember to mirror; the record is the one
  fan-out.
- **A global Files tab; file pins.** The feed, the threads, the project pages and History cover it.
- **Backfill from transcripts, `tool_actions` or forwarded Telegram messages:** the bytes are not there, the rows
  are pruned, or the chat gets spam.

## Consequences

- Restart-gated: migration v19 (additive; the automatic `data/ledger.db.bak-v18`), the routes, the console
  bundle, the posters, the heartbeat step (housekeeping and the plan backfill).
- Disk: the store is capped (default 2 GiB, 180 days) under `data/`, which the disk kit protects. It is not in the
  snapshot backup: it is a copy of files that also live in repositories and in Telegram.
- Telegram now also gets files from runs the console started. A caption is cut at 1,024 characters. A file over
  50 MiB gets a console link instead of the document.
- `send_file` refuses secret-named files (`isSecretName`), paths inside `.git`, and files over `maxBytes`. The
  customer path says it cannot send instead of "sent".
- ADR-0071's plans outside `mdFiles.roots` can be read, for every plan sent after the build or backfilled.
- `GET /file?token=` is removed. `sentFiles.enabled: false` and a reload give Telegram-only delivery again.
