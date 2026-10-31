---
approval: required
---
# Sent files in the console — implementation plan (ADR-0073)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to carry out this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** every file the engine sends the operator — a worker's `send_file` and every plan card's document — is
recorded with its own copy and shown in the web console where it was sent (feed, thread, item sheet, project page,
History), with a viewer per type and a Download button. Files are served only to the admin session, only from a
record, never by path, with HTTP Range. A file that changed or was deleted after it was sent says so.

**Spec:** `docs/superpowers/specs/2026-10-31-sent-files-in-console.md` · **ADR:**
`docs/adr/0073-a-sent-file-is-recorded-with-its-own-copy-and-the-console-serves-only-that-copy.md` · **Terms:**
`CONTEXT.md` ("Files sent to the operator").

**Architecture:**
- Two pure modules: `file-kind.ts` (the view and served type, extension and bytes agreeing) and `http-range.ts`.
- One file-system module, `sent-files-store.ts`: the content-addressed store (streamed copy + sha256, confinement
  re-checked on the opened descriptor, temp + fsync + rename).
- One seam, `sent-files.ts` (`SentFiles`): copy → record → link → deliveries; the read model (cards, lists, the
  sheet's view, the original's state, the bytes); remove; the heartbeat `tick` (retention, cap, orphans, and the
  plan backfill in `sent-files-backfill.ts`).
- The senders call the seam: `sendProjectFile` (`send_file`) and `postVersion` (plan cards). One daemon-built
  Telegram file poster replaces the per-surface `sendFile` port. The web channel listens to the records.
- One HTTP module, `web-files.ts`, for `/api/files*`; one console module, `web/sent-file.ts`, of pure renderers.
- Ledger v19 adds `sent_files` and its history feed triggers. History gains the `file` source.

**Tech:** Bun + TypeScript, bun:sqlite, `node:fs/promises` and `node:crypto` (streamed sha256), `Bun.file().slice()`
for Range bodies, grammy `InputFile(path, filename)`, the existing `mdToHtml`, the highlight.js enhancer,
i18next catalogues, `playwright-core` with the cached Chromium. No new dependency.

**Why it needs approval:** a ledger migration (v19); new HTTP routes that serve files on a public host; what
Telegram receives changes (files from console-started runs, a console link for files over 50 MiB, cut captions);
`send_file` gains refusals (secret names, `.git`, size); a data-retention policy for copies (spec §14, the
operator's question); disk use under `data/`.

## Global constraints

- **Reuse:** `resolveMdFile`'s rules are not copied — `isSecretName` from `tools/security/guard.ts`; `mdToHtml`
  (web target) for Markdown; `reviewHash` and `register` from `plans.ts`; `createGitRead` for the backfill;
  `createCodeEnhancer` / `enhanceCode` for text; the `#tdsheet` dialog, `act()`, `toast()`, `ltr()`, `iso()`,
  `FMT`, `.acts.stick`; `faults.guard/contain/report`; `ledger.recordEvent`; `trace.bindChannel`;
  `ledger.rememberRoute`; the `rfc5987` helper (moved, not copied); `tools/console-demo` and the e2e pattern of
  `tests/console-pins-mobile.e2e.test.ts`.
- **No hardcoding:** every cap, limit, age and path is in `config.sentFiles` (spec §4), the Markdown render cap is
  `mdFiles.viewMaxBytes`, the history cap is `history.sources.fileMaxBytes`. Console words are in the AR and EN
  catalogues; numbers, sizes, times, refs and paths are LTR isolates.
- **A send never fails because of the store:** no copy → `not_kept`, Telegram gets the original. **Serving fails
  closed:** no `kept` record → 404/410.
- **TDD for every task:** the failing test first (named after its spec AC), then the code. `bunx tsc --noEmit` and
  `bun test` stay green. Run long checks in the background and read them before you end (ADR-0055); never wrap a
  test in `timeout`. Commit after each task on `dev` (commit messages end with the model's own `Co-Authored-By`).
  Do not merge, push or restart: those are the operator's (ADR-0069, ADR-0054).

## Task 0: Measure, read-only (no code)

- [ ] Make a read-only ledger copy outside `data/`: `bun tools/history/admin.ts copy-ledger --to /tmp/neo-files-measure/ledger.db`.
- [ ] On the copy: `SELECT count(*) FROM messages WHERE kind = 'file'`; `SELECT count(*), sum(steps_total) FROM plans
  WHERE sent_sha256 IS NOT NULL`; the size of each sent plan file that still exists (`stat`), and how many still match
  their card (`reviewHash`) — the backfill's tier-1 hit rate.
- [ ] Write the numbers into the ADR's "As built" section in Task 16 (the store's start size, the backfill's reach).
  Delete the copy (`rm -r /tmp/neo-files-measure`).

## Task 1: The view and type of a file (`file-kind.ts`)

**Files:** create `src/engine/file-kind.ts`; test `tests/file-kind.test.ts`.

- [ ] Step 1: failing tests (spec AC 12), from byte fixtures built in the test (no binary files in git):
  - each row of spec §3.1: a 1×1 PNG, JPEG `FF D8 FF E0`, `GIF89a`, `RIFF....WEBPVP8 `, an `ftypavif` box, an SVG
    with an XML declaration and a comment before `<svg`, `%PDF-1.7` after 3 junk bytes, `ftypisom`, `ftypqt  `,
    `1A 45 DF A3 … webm`, `ID3`, `ftypM4A `, `OggS`, `RIFF....WAVE`, `fLaC`;
  - `report.md` → markdown, `text/plain; charset=utf-8`; `main.go` → text, lang `go`; `Makefile` → text, lang
    `makefile`; `notes` (no extension) → text without lang; `page.html` → text, lang `html`; `x.svg` without
    `<svg` → text, lang `svg`;
  - disagreements → `download`, `application/octet-stream`: `shot.png` holding `<html>`, `a.pdf` without `%PDF-`,
    `a.txt` with a NUL, `a.txt` with an invalid UTF-8 byte, `a.mp4` holding PNG bytes, `x.svgz`, `x.zip`, `x.docx`;
  - `isTextHead`: a UTF-8 BOM is fine; a multi-byte character cut at the end of the head is fine.
- [ ] Step 2: implement the extension table and the signature checks as data; `fileKind`, `isTextHead`,
  `SNIFF_BYTES`.
- [ ] Step 3: green; commit `feat(files): the view and type of a sent file, from its name and bytes agreeing (ADR-0073)`.

## Task 2: HTTP Range (`http-range.ts`)

**Files:** create `src/engine/http-range.ts`; test `tests/http-range.test.ts`.

- [ ] Step 1: failing tests (spec AC 15, the parser): `bytes=0-99` (size 1000) → 0–99; `bytes=0-99999` → 0–999;
  `bytes=100-` → 100–999; `bytes=-50` → 950–999; `bytes=-5000` → 0–999; `bytes=-0` → unsatisfiable;
  `bytes=1000-` → unsatisfiable; any range on size 0 → unsatisfiable; `bytes=5-1` → full; `bytes=0-1,4-5` → full;
  `items=0-1` → full; `bytes=abc` → full; `bytes=99999999999999999999-` → full; spaces around `=` and `-` are
  accepted; `If-Range` equal to the strong ETag → partial, another ETag or a date → full; no header → full.
- [ ] Step 2: implement `parseRange`.
- [ ] Step 3: green; commit `feat(files): one-range HTTP Range parsing (ADR-0073)`.

## Task 3: Ledger v19 — the sent-file record

**Files:** `src/engine/ledger-migrations.ts` (`sentFiles`, version 19 "sent files"), `src/engine/ledger.ts` (types
`SentFileRow`, `NewSentFile`, `SentFileState`, `Delivery`; the methods of spec §10), `src/engine/chats.ts`
(`WEB_CHAT = 0`, `ENGINE_CHAT = -4`, `isReservedChat`), `src/engine/trace.ts` and `src/frontends/web.ts` (take their
constants from `chats.ts`). Tests: `tests/ledger-migrations.test.ts`, `tests/sent-files-ledger.test.ts`.

- [ ] Step 1: failing tests (spec AC 34, §10):
  - pin the migration-18 test to `MIGRATIONS.filter((x) => x.version <= 18)` (and its expected `to: 18`), so it
    still proves 17 → 18;
  - a v18 ledger with rows migrates to 19 with the same row counts and `ledger.db.bak-v18`; reopening runs nothing;
    the table, the five indexes and the two triggers exist; an insert writes one `history_feed` row (`sent_files`,
    the file ref, `u`); an update of `state` writes one; an update of `deliveries` or `msg_id` writes none;
  - `insertSentFile` → `sentFileByRef`/`sentFileById` round trip (JSON `origStat` and `deliveries`); a second row
    with the same `(plan_id, plan_version)` or the same `ref` throws; `setSentFileLine`, `addSentFileDelivery`
    (appends), `setSentFileState` (several ids, reason, time); `sentFilesForMessages`; `listSentFiles` by project, by
    thread, newest first, with `beforeId` and `limit` clamped to `PAGE_MAX`; `sentFileForPlan`; `sentFilesBySha`;
    `keptCopies` (sha256, size, newest kept `created_at`, `openPlan` true when a `plan` record's plan is not `done`
    or `abandoned`); `plansToBackfill(afterId, limit)` (sent plans with no record for their version);
  - `isReservedChat` is true for 0, -2, -3, -4, -5 and false for a user id and a supergroup id; `ENGINE_CHAT_ID`
    and `WEB_CHAT_ID` equal the `chats.ts` values.
- [ ] Step 2: implement the migration (spec §10's DDL; the feed triggers use v17's `now` expression) and the
  methods; move the two constants.
- [ ] Step 3: green; commit `feat(files): ledger v19 — one record per sent file (ADR-0073)`.

## Task 4: The file store (`sent-files-store.ts`)

**Files:** create `src/engine/sent-files-store.ts`; test `tests/sent-files-store.test.ts` (temp folders under the
test temp root, ADR-0042).

- [ ] Step 1: failing tests (spec AC 5, 9, 10):
  - `openFileStore` makes `dir` (0700) and `dir/tmp`; a `dir` that is a symlink → `{ unavailable }`;
  - `put` copies to `<dir>/<aa>/<sha256>` (0600) with the right sha256, size and head; the same bytes again keep one
    copy; `copy: false` hashes and writes nothing;
  - refusals: a missing file, a folder, a FIFO (`mkfifo`), a file over `maxBytes` (checked by fstat, before reading),
    a symlink whose target leaves the folder (opened with `O_NOFOLLOW`: refused), and a path whose parent folder is
    swapped for a symlink to an outside folder after the caller's check (the `/proc/self/fd` real path is outside →
    `outside`);
  - a file truncated between open and read (a test seam that shrinks it after fstat) → `moved`;
  - a write error (a test seam that makes the writer throw after the first chunk) → `{ failed: "store_failed" }`
    with the full sha256, no copy and no temp file left;
  - `putBytes`, `path` (only with the right size), `drop`, `list`, `sweepTemp` (only files older than the given age).
- [ ] Step 2: implement with `fs.promises.open` (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`), `readlink("/proc/self/fd/<fd>")`,
  `fstat`, a streamed read of exactly the fstat size into `createHash("sha256")` and a temp `FileHandle`, `sync()`,
  `rename`. No `/proc` → `outside` (fail closed).
- [ ] Step 3: green; commit `feat(files): a content-addressed store that copies only what it confined (ADR-0073)`.

## Task 5: The seam (`sent-files.ts`)

**Files:** create `src/engine/sent-files.ts` (`SentFilesCfg`, `DEFAULT_SENT_FILES_CFG`, `readSentFilesCfg`,
`createSentFiles`, the card builder); modify `src/config.ts` (`NeoConfig.sentFiles`, read in `loadConfig`). Tests:
`tests/sent-files.test.ts`, one case in `tests/config.test.ts`.

- [ ] Step 1: failing tests (spec AC 5, 8, 9, 10, 11, 16, 17, 19, 20):
  - `readSentFilesCfg(undefined)` equals spec §4; each bad field keeps its default; `loadConfig` exposes `sentFiles`;
  - `copy`: `.git/config` → `git_internal`; `.env`, `.env.local`, `id_rsa`, `credentials.json`, `certs/x.pem` →
    `secret`; `.env.example` and `.github/workflows/ci.yml` copy; a `noCopy` glob → `kept: false`, `policy`; a store
    over `storeMaxBytes` → evicts an eligible copy first, else `store_full`; each refusal writes one
    `sent_file_refused` event without content;
  - `record`: a `kept` row with a fresh ref (`^f[A-Za-z0-9_-]{22}$`), the card (no path, no id, no hash); the caption
    is kept up to `TELEGRAM_MAX` characters; the listeners hear the card once; a listener that throws is reported and
    the others still hear it; a second `record` of the same plan version returns the existing card;
  - `linkLine`, `noteDelivery` (the card's `telegram` follows the newest delivery), `forMessages`, `forPlan`,
    `list` (project, thread, `before` ref, `bad_cursor`);
  - `view`: Markdown under `mdViewMaxBytes` → `html` (a raw `<script>` is text; `![x](http://e/x.png)` is a link,
    not an `<img>`); over it → `text` + `truncated`; text over `textMaxBytes` → the head cut after a newline;
    image/pdf/video → no body; the original's state for each case of spec §7 (unchanged; touched with the same
    bytes → unchanged; changed; ticked for a plan; deleted; folder gone; over `hashCheckMaxBytes` with the same size
    → unknown; a path that now leaves the folder → changed, and the file is never opened);
  - `blob`: kept → the copy's path and type; not kept, evicted, removed → 410 with the reason; unknown → 404; a copy
    deleted by hand → 410 and the record becomes `evicted` (`missing`);
  - `remove`: `removed`; the copy deleted only when no other `kept` record has the hash; `forget("file:<file ref>",
    …)` called when given; a second remove → `already removed`.
- [ ] Step 2: implement. The card's `threadRef` uses `msgRef` from `trace.ts`; `thumb` follows spec §3.4.
- [ ] Step 3: green; commit `feat(files): the sent-files seam — copy, record, read, remove (ADR-0073)`.

## Task 6: `send_file` goes through the seam

**Files:** `src/engine/dispatch.ts` (`sendProjectFile(deps, req, hooks)`, the `send_file` tool and its description,
`DispatchDeps`: remove `sendFile`, add `files` and `postFile`), `src/engine/pipeline.ts` (`PipelineDeps` the same),
`src/engine/ingress.ts` (`files: undefined, postFile: undefined`). The old per-surface port goes in this task, so
the type check stays green: `src/engine/web-channel.ts` (remove `deps.sendFile`, `deliverFile`, the token map,
`getFile`, `_testSendFile`), `src/frontends/telegram.ts` (remove the bot's `sendFile` dep), `src/frontends/web.ts`
(remove `GET /file`). Until Task 7 wires the poster, a send reaches only the record; nothing runs live before the
restart. Tests: create `tests/send-file.test.ts`; update `tests/dispatch.test.ts` (the `sendProjectFile` test moves
to the new signature), `tests/plans-send.test.ts` (its `send_file` test), `tests/trace-dispatch.test.ts` (its
`PipelineDeps` rig), `tests/web-channel.test.ts` (the old `sendFile` test goes; Task 10 adds its replacement).

- [ ] Step 1: failing tests (spec AC 1 engine half, 3, 4, 5, 6, 7):
  - with a seam and a fake `postFile`: one record, one listener call, `postFile` got the copy's path and the original
    name; the `file` line's id is linked; the fake's `messageId` is bound with `trace.bindChannel` and remembered as a
    route for `req.route`; the result texts of spec §3.5 for `sent`, `link` and `failed`;
  - every refusal of spec AC 5 returns its text, records nothing and never calls `postFile`;
  - no `files` and a `postFile` → the original is posted (`enabled: false`); neither → `not sent: this run cannot send
    files to the operator`;
  - the tool through `neoMcpServers`: the description names Telegram and the web console, the refusals and the cap;
    the `ingressToolDeps` tool set answers the customer-path text;
  - a plan path still goes through `offerPlanFile` and makes no `send_file` record.
- [ ] Step 2: implement spec §3.5 (`send_file`); the tool passes `route: { sessionId, folder, project }` when the run
  has a session id.
- [ ] Step 3: green (the whole suite: other tests built `PipelineDeps` with `sendFile`); commit `feat(files): send_file
  records the file first, then delivers it (ADR-0073)`.

## Task 7: One Telegram file poster, and the daemon's wiring

**Files:** `src/frontends/telegram.ts` (`createFilePoster`; `createPlanPoster` uses `rec.fileName` and returns
`fileId`; the bot's pipeline deps take `files` and `postFile` from the engine deps),
`src/engine/plans.ts` (`PostPlan`'s `rec.fileName?`, its result's `fileId?`), `src/daemon.ts` (`createSentFiles`,
`createFilePoster` with `target = (cid) => isReservedChat(cid) ? admin.adminId() : cid`, both passed to
`startTelegram`, `webDeps.engine` and the loops' `planDepsFrom`; the heartbeat step `["sentFiles", () =>
files?.tick(Date.now())]`; a startup line `  files     -> <dir> (cap …, keep … days)` or `OFF`). Tests: create
`tests/telegram-files.test.ts`; update `tests/telegram-plans.test.ts`.

- [ ] Step 1: failing tests (spec AC 1 Telegram half, 2, 3, 8), with a fake `Api`:
  - `sendDocument` gets `InputFile(path, name)` and a caption cut to 1,024 characters with `…`; the delivery is
    `sent` with `message_id` and `document.file_id`; a reserved chat id goes to the admin DM; no admin → `failed`;
  - a size over `telegramMaxBytes` → `sendMessage` with the name, the size (LTR digits) and
    `<consoleUrl>/#file=<ref>`; no URL → the text without a link; delivery `link`;
  - an API error → `failed` with the first line of the error, and one `faults.report("telegram.sendFile")`;
  - the plan poster names the document `rec.fileName` and returns `fileId`.
- [ ] Step 2: implement; wire the daemon (no test for `daemon.ts` itself; `bunx tsc --noEmit` checks the wiring).
- [ ] Step 3: green; commit `feat(files): one Telegram file poster for every sent file (ADR-0073)`.

## Task 8: Plan cards record their document

**Files:** `src/engine/plans.ts` (`PlanDeps.files`, `planDepsFrom`, `postVersion`). Tests: `tests/plans-send.test.ts`,
create cases in `tests/sent-files.test.ts` if needed.

- [ ] Step 1: failing tests (spec AC 21, 22):
  - a posted card → one `plan` record with the plan id and the new version, the `plan` line's id, and a delivery with
    the card's chat, message and file ids; the poster got the copy and `fileName`;
  - a post that fails → no record; the run end's retry of the same version → one record;
  - the file changed after registration: call `notePlanWritten` (it registers at once and posts asynchronously),
    write new content to the file before awaiting its `sent` promise (the copy's first `await` is the file open, so
    the copy reads the new text), then await: the plan is registered again from the copied text; `plans.sha256`,
    `sent_sha256` and the record's `review_sha256` agree; the card's caption is the new text's;
  - without `deps.files`: today's behaviour and today's tests, unchanged.
- [ ] Step 2: implement spec §3.5 (plan cards).
- [ ] Step 3: green; commit `feat(files): a plan card's document is a recorded sent file (ADR-0073)`.

## Task 9: The HTTP routes (`web-files.ts`)

**Files:** create `src/frontends/web-files.ts` (`filesRoute`, `fileHeaders`, `FILE_CSP`, `rfc5987` moved from
`web.ts`); `src/frontends/web.ts` (route `/api/files` and `/api/files/*` to it; `/md-file` imports `rfc5987`);
`src/frontends/web/sw-rules.ts` (drop `/file`, update the comment); `src/engine/web-channel.ts` (`files`, `file`,
`fileBlob`, `removeFile`). Tests: create `tests/web-files.test.ts`; update `tests/console-pwa.test.ts`
(`/api/files/x/raw` is ignored, `/file` no longer listed).

- [ ] Step 1: failing tests (spec AC 13–19), through `createWebApp().fetch` with a seeded seam:
  - 401 without a session on all five routes; 404 for `f123`, `../x`, `fAAAA…` unknown; 403 for `Sec-Fetch-Site:
    same-site` and `cross-site` on view, raw and download, and 200 for `same-origin`, `none` and no header;
  - the header table per view (image, svg, pdf, video, text, markdown, download); download always `attachment` and
    `application/octet-stream`; `nosniff`, CORP, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-cache`,
    `ETag: "<sha256>"`, `Accept-Ranges: bytes` on each; no CSP on PDF; an Arabic name has the `_` ASCII form and the
    exact `filename*`;
  - Range: 206 with `Content-Range` and the right bytes; 416 with `bytes */<size>`; two ranges → 200; `If-Range`
    mismatch → 200; `If-None-Match` → 304; HEAD → no body and `Content-Length`;
  - 410 for not kept, evicted and removed; the view JSON for each (200, with the state);
  - the list route: rows newest first, `project`, `thread`, `before`, 400 `bad_cursor`;
  - remove: a POST with `Sec-Fetch-Site: cross-site` → 403 (the global rule); same-origin → `{ ok: true }`; raw → 410;
  - audit: one `sent_file_access` per view, download, remove and first raw request; none for `Range: bytes=500-`.
- [ ] Step 2: implement; the body is `Bun.file(path).slice(start, end + 1)`.
- [ ] Step 3: green; commit `feat(files): /api/files — the record's copy, with Range, to the admin session only (ADR-0073)`.

## Task 10: The web channel shows records (feed, thread, item, project)

**Files:** `src/engine/web-channel.ts` (`WebEvent` `file` = `{ file, name, url, project?, threadId? }`; the
`onRecorded` listener; `thread()` attaches `file` to messages and adds `files`; `item()`; `project()`),
`src/engine/needs-you-detail.ts` (`PlanCardView.sentFile`, `DecisionView.files`; deps gain `files`),
`src/engine/project-view.ts` (`ProjectView.files`, `filesNext`). Tests: `tests/web-channel.test.ts`,
`tests/console-needs-you.test.ts`, `tests/console-projects.test.ts` (or their engine tests).

- [ ] Step 1: failing tests (spec AC 1 web half, 24, 25, 26, 23 server half):
  - a record made by any sender (a seam shared by a Telegram-style and a web-style channel) emits one `file` event
    on the web channel, with `name` and `url`, and it is replayed to a later subscriber (the replay window);
  - `thread()`: a `file` line and a `plan` line carry their cards; a `file` line with no record carries none; `files`
    lists the thread's records;
  - `item("dec:<plan card>")` has `plan.sentFile` when the card version has a kept record; a decision has `files`
    (newest 5 of its thread);
  - `project(name)` has `files` (newest `projectFiles`) and `filesNext`.
- [ ] Step 2: implement.
- [ ] Step 3: green; commit `feat(files): the console channel shows each sent file where it was sent (ADR-0073)`.

## Task 11: The console's file renderers and the catalogues

**Files:** create `src/frontends/web/sent-file.ts`; `src/frontends/web/locales/{en,ar}/console.json` (`files.*`,
`pj.sect.files`, `threads.files`, `history.kind.file`). Tests: create `tests/console-files.test.ts`;
`tests/console-i18n.test.ts` (parity is automatic; add a check that every `FileView` has `files.kind.<view>` and every
state and original has its line).

- [ ] Step 1: failing tests (spec AC 30, and the markup of AC 24–27), with a fake `Fmt`:
  - `formatBytes`: 0 → `0 B`, 1536 → `1.5 KB`, 10 MiB → `10 MB`, with Latin digits, inside `ltr()`;
  - `fileRowHtml`: a button with `data-act="file-open"`, `data-ref`, the escaped name in `<bdi dir="auto">`, the kind
    chip, the size and time as LTR isolates, the caption `dir="auto"`, a lazy thumbnail only when `thumb`, an
    `aria-label`; a hostile name (`<img onerror>`, `"`) stays text;
  - `fileChipHtml`, `fileStateHtml` (each state and reason), `originalHtml` (each original state), `deliveryHtml`;
  - the keys used by the module exist in both catalogues with the same placeholders.
- [ ] Step 2: implement; write the AR and EN strings (simple, short; units `B/KB/MB/GB` in both, LTR).
- [ ] Step 3: green; commit `feat(files): the console's file rows, chips and state lines, AR and EN (ADR-0073)`.

## Task 12: The console's file sheet and placements, driven by a mobile e2e

**Files:** `tools/console-demo/demo.ts` (always a `SentFiles` seam over a temp store, so the console has its routes;
`startConsoleDemo(port, { files: true })` also seeds, and only then: `ConsoleDemo.files`, `ConsoleDemo.ready` (the
seed's promise), `ConsoleDemo.fileRefs`; the seed goes through the real `sendProjectFile` with a fake `postFile`,
under a web thread "Send me the reports" in project `neo`. Without the option the demo is unchanged, so
`console-pins-mobile` and `console-sizes-mobile` keep their exact seeds, and the first plan pin keeps testing the
`/md-file` fallback); `src/frontends/web/app.ts` (feed `file` events, `openFile`, `renderFileSheet` and
the viewers, Remove, thread chips and Files section, plan rows' View, the item sheet's plan block and decision files,
the project Files section with paging, `#file=` in `openFromHash`, the History `file` hit); `src/frontends/web/index.html`
(CSS); create `tests/console-files-mobile.e2e.test.ts`.

- [ ] Step 1: extend the demo. Seeded in `<work>/neo/out/`: `report.md` (a heading, a table, a fenced code block, a
  `<script>` line, an image link), `report-ar.md` (Arabic with numbers), `shot.png` (a real 8×8 PNG from bytes in the
  demo), `logo.svg` (with `<script>window.__svg=1</script>` and `onload`), `spec.pdf` (a minimal valid PDF text),
  `demo.webm` (the WebM signature and filler: the test checks the player and Range, not playback), `server.log` (300
  lines), `big.log` (over `textMaxBytes`), `page.html`, `data.zip` (`PK\x03\x04`), `changed.md` (edited after it is
  sent), `gone.txt` (deleted after it is sent); a second plan, `docs/superpowers/plans/2026-10-31-reports.md`, with
  its own card decision whose question does not contain "Plan waiting for your approval" (the pins e2e finds its
  plan row by that text), recorded as its card's version through the seam (`copy`, then `record` with
  `plan: { id, version: 1 }`), then its file edited. The strip then holds four pins (at most `PIN_SHOWN`).
- [ ] Step 2: failing e2e (spec AC 24–28, 31), at 390 px with `PHONE`, skipped when Chromium is not installed
  (`chromium.executablePath()` missing, as in `console-pins-mobile`). Each test starts its own demo:
  `demo = startConsoleDemo(0, { files: true }); await demo.ready;` and stops it after. The shared Docker browser
  (ADR-0032) cannot reach `127.0.0.1`, so this runs with the local `playwright-core` and the cached Chromium only:
  1. the feed shows one row per seeded file; the PNG row's thumbnail has `naturalWidth > 0`; every row is ≥ 44 px high;
     screenshot `files-feed-390`;
  2. `report.md` opens rendered (`.fview h3.mh` or the renderer's heading), `script` count 0, the image link is an
     `<a>`; the sheet has no sideways scroll; Download's `href` ends `/download` and a fetch returns `attachment` and
     `application/octet-stream`; the action bar is inside the viewport; screenshot `files-md-390`;
  3. `logo.svg` shows as an `<img>` with `naturalWidth > 0` and `window.__svg` stays undefined; a fetch of its raw URL
     has `attachment` and a CSP with `sandbox`;
  4. `spec.pdf`: Open has `target="_blank"` to `/raw`; a fetch with `Range: bytes=0-99` → 206, `content-range: bytes
     0-99/<size>`, `application/pdf`, no CSP; `demo.webm`: a `video[controls][playsinline]` with `src` ending `/raw`; a
     fetch with `Range: bytes=10-` → 206;
  5. `server.log` shows a `pre.code` with the fold toggle and the copy button; `big.log` shows the truncated note;
     `page.html` shows its source as text (`h1` count 0 inside `.fview`);
  6. `changed.md` says the file changed since it was sent and still shows the sent text; `gone.txt` says it was
     deleted and still shows its text;
  7. `data.zip` says the type is not shown here, with Download;
  8. Threads tab → the seeded thread: one chip per file line, the Files section lists all; screenshot `files-thread-390`;
  9. the plan pin's Review renders the version on the card (the text before the edit) with the "changed since this
     card was sent" line;
  10. Projects → `neo`: Files (N) lists the newest files;
  11. `#file=<ref>` opens the sheet; a well-formed unknown ref (`f` + 22 characters) gives the "not here" toast;
  12. Remove on `server.log`: the confirm is accepted, the sheet shows the removed state, a raw fetch → 410;
  13. Arabic (`neo_lang=ar`): the sheet's buttons are Arabic (تنزيل …), `document.dir` is `rtl`, the size and the
      time in a row are inside `[dir=ltr]`, `report-ar.md`'s numbers are LTR runs; screenshots `files-feed-ar-390`,
      `files-sheet-ar-390`.
- [ ] Step 3: implement the DOM (spec §3.9) and the CSS until the e2e is green. Run it in the background with
  `NEO_SHOTS_DIR=/tmp/neo-files-shots` and look at every screenshot (EN and AR) before the commit.
- [ ] Step 4: green (`bun test` with the e2e); commit `feat(files): the console's file sheet, viewers and file lists,
  with a mobile e2e (ADR-0073)`.

## Task 13: Housekeeping — retention, cap, orphans

**Files:** `src/engine/sent-files.ts` (`tick` → housekeeping at most once per `housekeepEveryMs`, single-flight).
Tests: `tests/sent-files.test.ts` (an injected clock).

- [ ] Step 1: failing tests (spec AC 32): a copy whose newest record is older than `keepDays` is dropped and its
  records are `evicted` (`retention`); one an open plan names stays; over the cap, the oldest goes first down to 90 %;
  a copy younger than `minKeepDays` stays; a `kept` record with no copy on disk becomes `evicted` (`missing`); an
  unnamed copy older than `orphanGraceMs` is deleted and a younger one stays; temp files older than one hour are
  deleted; one `sent_files_housekeep` event; a second `tick` within `housekeepEveryMs` does nothing; a `tick` while
  one runs returns at once; an error is one fault and the next tick runs again.
- [ ] Step 2: implement spec §8.1.
- [ ] Step 3: green; commit `feat(files): the file store keeps its cap and its age (ADR-0073)`.

## Task 14: Backfill of the plan cards already sent

**Files:** create `src/engine/sent-files-backfill.ts`; `src/engine/sent-files.ts` (`tick` runs a batch until done).
Tests: `tests/sent-files-backfill.test.ts` (a temp git repo; the async git reader with the real `git`).

- [ ] Step 1: failing tests (spec AC 33): a sent plan whose current file matches `sent_sha256` (after ticking a box)
  → a kept, backfilled record with `at = sent_at`, the card's `plan` line (found by its bound chat and message id) and
  a delivery; a plan whose file changed after the card, with the card's version in an older commit → kept from git; a
  plan whose version is nowhere → no record; a missing folder → no record and no git call; `plansPerTick` bounds a
  tick; the meta cursor survives a new seam over the same ledger; `done` stops the work; a second run adds nothing.
- [ ] Step 2: implement spec §8.2 with `createGitRead({ timeoutMs: github.callTimeoutMs })`.
- [ ] Step 3: green; commit `feat(files): plan cards sent before the update get their copy when it still exists (ADR-0073)`.

## Task 15: History — the `file` source

**Files:** `src/engine/history/defaults.ts` (`SOURCE_KINDS` + `file`; `sources.fileMaxBytes`),
`src/engine/history/store.ts` (`HistoryKind`), `src/engine/history/indexer.ts` (`TABLES`, `REF_PREFIXES`,
`KINDS_OF`), `src/engine/history/sources.ts` (`SHAPES`, `EXTRACT.sent_files`, the copy read through a `SourceCtx`
reader), `src/engine/ledger.ts` (`HistoryRowMap.sent_files`, `HISTORY_SOURCES.sent_files`),
`src/frontends/web/history.ts` (a `file` hit links `#file=<fileRef>`), `src/daemon.ts` (the seam's `forget`). Tests:
create `tests/history-files.test.ts`; the existing history tests stay green.

- [ ] Step 1: failing tests (spec AC 29): a kept `send_file` Markdown record is `file:<file ref>` with the name, the caption
  and the text (a chunk with a secret shape is dropped); a `plan` record → `none`; a `removed` record → `none`; an
  `evicted` record keeps its entry; a record of a chat `-3` order or an ingress thread → excluded; the feed rows of
  Task 3 are read by the indexer; the History tab's hit markup links `#file=`; `remove` forgets the entry.
- [ ] Step 2: implement spec §9.
- [ ] Step 3: green; commit `feat(files): sent files are searchable in the task history (ADR-0073)`.

## Task 16: Docs, security scan, final review

**Files:** `docs/CONFIG.md` (a "Sent files (`sentFiles`) — ADR-0073" section and the history kind), `docs/HISTORY.md`
(an entry), ADR-0073 (status accepted, built on dev, restart-gated; an "As built" section with the commits, the
Task 0 numbers and any change from the spec), CONTEXT.md (only if the build changed a term).

- [ ] Run `bunx tsc --noEmit` and `bun test` in the background; read both to the end; both green.
- [ ] Run `/security-scan` on the branch (file serving and input handling). Fix every new high or critical finding.
  Never edit `.security/baseline.json`.
- [ ] Ask the `planner` subagent for the final review against the spec (each AC, the security section, the e2e
  screenshots in both languages). Fix its findings, each with a test; record them in "As built".
- [ ] Commit `docs(files): config, history and ADR-0073 accepted (ADR-0073)`. Tick every step of this plan.

## Ops notes (restart-gated; the operator's steps)

- **Done means live (ADR-0054).** All of this is restart-gated: migration v19, the routes, the posters, the console
  bundle and the heartbeat step. Report it as "built on dev, not live" until the running build contains it.
- **Before the restart:** check free disk (`df -h /home/neo`): `migrate()` writes `data/ledger.db.bak-v18` with
  `VACUUM INTO` (about the ledger's size, ~0.4–0.6 GB). The older one-off `.bak-*` copies can be deleted after a
  restore drill (ADR-0067's recommendation; the operator's call).
- **The restart** is the operator's (never restart without permission). The boot log shows the new `files` line.
- **After the restart, verify live** (record the results in ADR-0073 "As built"):
  1. a `send_file` from a project started on Telegram → in Telegram, in the console feed, in its thread; the sheet
     opens on the phone; Download works;
  2. a plan card → in the feed; the pin's Review shows the card's version;
  3. a PDF and a video on the phone (iOS Range); an image thumbnail;
  4. the backfill event and the counts (`sentFiles.backfill` meta); the store's size (`du -sh data/sent-files`);
  5. a Telegram reply to a sent document joins its thread.
- **Disk:** the store is under `data/` (protected by the disk kit's `^/home/neo/data` pattern), capped at
  `storeMaxBytes` (2 GiB) and `keepDays` (180). It is not in the snapshot backup. The disk guard (ADR-0068) is
  unchanged. Watch `sent_files_housekeep` events in the first week.
- **Rollback:** `sentFiles.enabled: false` in `config.json` and a reload → Telegram-only delivery. The v19 table
  stays (additive); the copies stay until the setting is turned on again or the folder is deleted.
- **The operator's question** (spec §14): keep copies of all files for 180 days (recommended), or exclude chosen
  folders with `sentFiles.noCopy`, or a shorter `keepDays`. The defaults apply until answered.
- **Push:** none during the task (ADR-0069); ask once at the end.
