# Sent files in the console — design spec (ADR-0073)

**Operator order (2026-10-31):** every file Neo sends the operator (every plan, spec, report and `send_file`
attachment) goes to Telegram, but the web console cannot open or download it. Make every sent file visible in the
console, in the same stream, thread or item where it was sent, with a click to view (Markdown rendered, images
inline, PDF and video in the browser) and a Download button. Serve files only to the admin session, only from a
record of what was actually sent, never by path. Stream large files (HTTP Range). A file that changed or was
deleted after it was sent shows that state. Phone at 390 px, EN + AR, numbers LTR.

ADR: `docs/adr/0073-a-sent-file-is-recorded-with-its-own-copy-and-the-console-serves-only-that-copy.md` · Plan:
`docs/superpowers/plans/2026-10-31-sent-files-in-console.md` · Terms: `CONTEXT.md` ("Files sent to the operator").

## 1. Root cause (checked in the code, 2026-10-31, branch `dev` at `6defc75`)

| Send path | What happens today | Why the console cannot open it |
|---|---|---|
| `send_file` in a run that Telegram started (operator message, `/open`, the company) | `sendProjectFile` (`dispatch.ts:1784-1820`) → `deps.sendFile` → `bot.api.sendDocument` (`telegram.ts:574-575`). The port is bound when the run starts (`runConfigFor`, `pipeline.ts:716-718`). | Nothing is sent to the web, and the operator bus has no file line (`operator-bus.ts:16-19`). |
| `send_file` in a dispatched todo | A dispatch the company starts at once uses the company run's deps; every release the queue starts itself (a queued todo after the one before it, the tick, a resume, a restart) launches with Telegram's deps (`telegram.ts:578-583`). | Same as above: most project files never reach the console. |
| `send_file` in a run the console started | `deliverFile` (`web-channel.ts:244-250`) keeps the path in an in-memory map and emits `{type:"file", url:"/file?token=…"}`. | The map is emptied by every restart (`GET /file` → 404, `web.ts:380-388`); the event lives only in the replay window. Telegram gets nothing. |
| The thread of any `send_file` | One trace line of kind `file`, text = the caption or the base name (`dispatch.ts:2033-2035`). | No path, hash or link: the thread shows a word with nothing to open (`app.ts:1199-1207`). |
| Plan card (ADR-0019) | `postVersion` (`plans.ts:522-569`) → `createPlanPoster` → `sendDocument` to the Decisions chat (`telegram.ts:1288-1301`). | No feed row. The thread's Plans section shows a relative path with no link (`app.ts:1251-1264`); the project page lists plans without a link (`app.ts:1450-1457`). Only a pinned plan's Review reads the file, live, through `/md-file`, and only inside `mdFiles.roots` (ADR-0071 limit); it shows the file as it is now, not the card's version. |
| Reports | A report is a file a worker sends with `send_file` (the company's `agent/outbox/` habit) — the rows above — or a text result, which the bus already mirrors. | As above. |
| Loop results | Loop workers get no `send_file` tool (`loops.ts:528-532`); their text results are mirrored (`loop-mirror.ts`); their plans go through the plan poster. | Loop plans: as "plan card". |
| Telegram history | Every Telegram document comes from the two calls above (workers cannot run the Telegram plugin, ADR-0064). | A bot cannot read a chat's history, and Neo never stored a `file_id`, so old Telegram files cannot be fetched back. |

Smaller defects on the same paths: a caption over 1,024 characters fails `sendDocument` (no cut); the customer
path's `send_file` answers "sent" while no port is wired (`dispatch.ts:1817-1819`); `/file` has no `nosniff`, no
RFC 5987 name, no Range and no audit; `send_file` sends `.env` or a key file if a worker asks.

**One cause:** a sent file is a surface event, not an engine record. **One fix:** record first (a copy and a
ledger row), then deliver; the console reads the record, Telegram gets the record's copy.

## 2. The model

- **Sent file:** a file the engine sends to the operator: a worker's `send_file`, or the document of a plan card.
- **Sent-file record:** its row in `sent_files` (§10). Written once per send. Never deleted; its state changes.
- **File ref:** `f` + 22 base64url characters (16 random bytes from `crypto.getRandomValues`). The only name the
  console, the routes and the task history use. Route pattern `^f[A-Za-z0-9_-]{22}$`. The integer id never leaves
  the server; neither the id nor the sha256 is ever part of a URL.
- **File store:** `sentFiles.dir` (default `data/sent-files`), content-addressed: `<dir>/<sha256[0:2]>/<sha256>`.
  One copy per content. Temp files in `<dir>/tmp/`.
- **State:** `kept` (the copy is in the store), `not_kept` (no copy: `store_full`, `store_failed`, `policy`),
  `evicted` (the copy was dropped: `retention`, `store_cap`, `missing`), `removed` (the operator removed it).
- **View** (decided once, from the copy): `markdown`, `text`, `image`, `svg`, `pdf`, `video`, `audio`,
  `download`.
- **Original:** the file at `folder/rel_path`. The console reports its state — `unchanged`, `ticked` (a plan
  whose only change is checkbox marks), `changed`, `deleted`, `unknown` — and never serves it.
- **Delivery:** one Telegram receipt: `{ surface: "telegram", status: "sent" | "link" | "failed", chatId?,
  messageId?, fileId?, reason?, at }`.

## 3. The seams and their interfaces

### 3.1 `src/engine/file-kind.ts` (pure)

```ts
export type FileView = "markdown" | "text" | "image" | "svg" | "pdf" | "video" | "audio" | "download";
export interface FileKind { view: FileView; mime: string; lang?: string }
export const SNIFF_BYTES = 8192;
/** The view and the served type of a file from its name and its first bytes. The extension and the bytes must
 *  agree for every view but `download`; a disagreement is `download` with `application/octet-stream`. */
export function fileKind(name: string, head: Uint8Array): FileKind;
/** UTF-8 without NUL in `head` (a sequence cut at the end of `head` is allowed; a UTF-8 BOM is allowed). */
export function isTextHead(head: Uint8Array): boolean;
```

| View | Extensions | The bytes must show | Served type |
|---|---|---|---|
| image | `png` | `89 50 4E 47 0D 0A 1A 0A` | `image/png` |
| image | `jpg`, `jpeg` | `FF D8 FF` | `image/jpeg` |
| image | `gif` | `GIF87a` or `GIF89a` | `image/gif` |
| image | `webp` | `RIFF` … `WEBP` at 8 | `image/webp` |
| image | `avif` | `ftyp` at 4, brand `avif` or `avis` | `image/avif` |
| svg | `svg` | text; `<svg` within the head, after an optional BOM, XML declaration, comments or doctype | `image/svg+xml` |
| pdf | `pdf` | `%PDF-` within the first 1,024 bytes | `application/pdf` |
| video | `mp4`, `m4v` | `ftyp` at 4, a brand other than `qt`, `M4A`, `avif`, `avis` | `video/mp4` |
| video | `mov` | `ftyp` at 4, brand `qt  ` | `video/quicktime` |
| video | `webm` | `1A 45 DF A3` and `webm` in the head | `video/webm` |
| audio | `mp3` | `ID3`, or a frame sync `FF E?`/`FF F?` | `audio/mpeg` |
| audio | `m4a` | `ftyp` at 4, brand `M4A ` | `audio/mp4` |
| audio | `ogg`, `oga`, `opus` | `OggS` | `audio/ogg` |
| audio | `wav` | `RIFF` … `WAVE` at 8 | `audio/wav` |
| audio | `flac` | `fLaC` | `audio/flac` |
| markdown | `md`, `markdown` | text | `text/plain; charset=utf-8` |
| text | `txt log csv tsv json jsonl ndjson yaml yml toml ini cfg conf sql ts tsx mts js jsx mjs cjs go py sh bash zsh rs java kt swift rb php css scss less html htm xhtml xml diff patch proto graphql gql mdx` and names `Dockerfile`, `Makefile`, `LICENSE`, `README` | text | `text/plain; charset=utf-8`, `lang` from the extension or name |
| text | any other name, not a known binary extension | text | `text/plain; charset=utf-8`, no `lang` |
| download | everything else (`zip`, `docx`, `xlsx`, `exe`, `heic`, …), and every disagreement | — | `application/octet-stream` |

HTML, XHTML and XML are `text`: the console shows their source, never the page. `svgz` is `download`.

### 3.2 `src/engine/http-range.ts` (pure)

```ts
export type RangeAsk = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };
/** One `bytes=` range of a representation of `size` bytes (RFC 9110 §14). Several ranges, another unit or a
 *  malformed value → full (a server may ignore Range). `ifRange` that is not the strong `etag` → full. */
export function parseRange(header: string | null, size: number, ifRange?: string | null, etag?: string): RangeAsk;
```

`bytes=0-99` → 0–99 (end clamped to `size - 1`); `bytes=100-` → 100 to the end; `bytes=-50` → the last 50 (all
when `size < 50`); `bytes=-0`, a start at or past `size`, and any range on an empty file → unsatisfiable; start
after end → full; a value that is not a safe integer → full.

### 3.3 `src/engine/sent-files-store.ts` (the file store; file system only)

```ts
/** `path`: the copy (absent with `copy: false`, or when writing failed: `failed`). */
export interface Stored { sha256: string; size: number; head: Uint8Array; stat: { dev: number; ino: number; size: number; mtimeMs: number }; path?: string; failed?: "store_failed" }
export type StoreRefusal = { refused: "not_found" | "not_a_file" | "outside" | "too_large" | "moved" | "unreadable"; detail?: string };
export interface FileStore {
  /** Open `abs` (a real path the caller confined to `folder`) with O_RDONLY|O_NOFOLLOW|O_NONBLOCK; read the
   *  descriptor's real path from /proc/self/fd and refuse it unless it is inside the real `folder`; fstat:
   *  a regular file of at most `maxBytes`. Then stream exactly fstat's size: every chunk feeds the sha256; unless
   *  `copy` is false, it is also written to a temp file (0600) that is fsynced and renamed to its content
   *  address (an existing copy is kept). A write error stops the writing, never the hashing (`failed`). A file
   *  that ends early is `moved`. */
  put(abs: string, folder: string, o: { maxBytes: number; copy: boolean }): Promise<Stored | StoreRefusal>;
  /** The same from bytes in memory (a plan version read from git). */
  putBytes(bytes: Uint8Array): Promise<Stored>;
  /** The copy's path when it exists with that size (lstat: a regular file), else undefined. */
  path(sha256: string, size: number): string | undefined;
  drop(sha256: string): void;
  /** Every copy on disk (sha256, size, mtime), for the cap and the orphan sweep. */
  list(): Array<{ sha256: string; size: number; mtimeMs: number }>;
  /** Delete temp files older than `olderMs`; returns how many. */
  sweepTemp(olderMs: number, now: number): number;
}
/** Make `dir` (0700) and `dir/tmp`; refuse a `dir` that is a symlink or not a folder (the seam then runs with no copies). */
export function openFileStore(dir: string): FileStore | { unavailable: string };
```

The store path is built only from a validated hex sha256 (`^[0-9a-f]{64}$`), never from request input.

### 3.4 `src/engine/sent-files.ts` (the seam)

```ts
export interface SentFileSend {
  abs: string;                 // real path, confined to `folder` by the caller
  folder: string;              // real path of the project folder
  origin: "send_file" | "plan";
  caption?: string;            // at most TELEGRAM_MAX characters are kept
  project?: string;
  cause?: Cause;
  orderId?: string;
  plan?: { id: number; version: number };
}

/** A file copied for sending, not yet recorded. `deliverPath` is what a poster sends: the copy, or the original
 *  when no copy was kept (`notKept` says why). */
export interface CopiedFile {
  send: SentFileSend; name: string; relPath: string; sha256: string; size: number;
  kind: FileKind; deliverPath: string; kept: boolean; notKept?: "store_full" | "store_failed" | "policy";
  origStat: { dev: number; ino: number; size: number; mtimeMs: number };
  /** origin plan: the copied text and its reviewHash (plans.ts). */
  text?: string; reviewSha256?: string;
}

export type CopyRefusal = "not_found" | "not_a_file" | "outside" | "secret" | "git_internal" | "too_large" | "moved" | "unreadable";

export interface SentFileCard {
  ref: string; name: string; view: FileView; size: number; at: number;
  origin: "send_file" | "plan"; state: SentFileState; reason?: string;
  caption?: string; project?: string; threadId?: number; threadRef?: string;
  plan?: { id: number; version: number; decisionId?: string };
  telegram?: Delivery["status"];
  backfilled?: true;
  /** An image (not SVG) that is kept and at most `thumbMaxBytes`: the feed may show it inline. */
  thumb?: true;
}

export interface SentFileView extends SentFileCard {
  mime: string; sha256: string;
  /** The original's absolute path (shown LTR; never served) and its state now. */
  path: string; original: "unchanged" | "ticked" | "changed" | "deleted" | "unknown";
  deliveries: Delivery[];
  /** markdown up to mdFiles.viewMaxBytes: mdToHtml(text, { target: "web" }). */
  html?: string;
  /** text, or markdown over the render cap: the head, up to sentFiles.textMaxBytes, cut after the last newline. */
  text?: string; lang?: string; truncated?: { shown: number };
  /** origin plan: the plan's state now (planState). */
  planState?: PlanState;
}

export interface SentFiles {
  readonly cfg: SentFilesCfg;
  /** Copy and classify; no row yet. A refusal names its reason; a copy the store could not keep is not a
   *  refusal (`kept: false`, deliver the original). */
  copy(send: SentFileSend): Promise<{ ok: true; file: CopiedFile } | { ok: false; refused: CopyRefusal; text: string }>;
  /** Write the record and tell the listeners (the console). `send_file`: right after the copy, before any
   *  delivery. A plan: only once its card is posted. Idempotent for a plan version (the unique index). */
  record(file: CopiedFile, links?: { msgId?: number; delivery?: Delivery; backfilled?: boolean; at?: number }): SentFileCard;
  linkLine(ref: string, msgId: number): void;
  noteDelivery(ref: string, d: Delivery): void;
  onRecorded(listener: (card: SentFileCard) => void): () => void;
  card(ref: string): SentFileCard | undefined;
  list(f: { project?: string; threadId?: number; before?: string; limit: number }): { rows: SentFileCard[]; next?: string } | { error: "bad_cursor" };
  forMessages(msgIds: number[]): Map<number, SentFileCard>;
  forPlan(planId: number, version: number): SentFileCard | undefined;
  /** The sheet's model; reads the copy (bounded) and the original's state (stat; a hash up to hashCheckMaxBytes). */
  view(ref: string): Promise<SentFileView | undefined>;
  /** What the byte routes may stream. */
  blob(ref: string): { ok: true; path: string; size: number; sha256: string; mime: string; view: FileView; name: string } | { ok: false; status: 404 | 410; reason: string };
  remove(ref: string, now: number): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** Housekeeping and the plan backfill (§8); single-flight; returns at once. */
  tick(now: number): void;
}

export function createSentFiles(deps: {
  ledger: Ledger; cfg: SentFilesCfg; mdViewMaxBytes: number; workRoot: string;
  events: (kind: string, data: Record<string, unknown>) => void;
  report: (component: string, err: unknown) => void;
  /** ADR-0067: a removed file's entry is forgotten (absent while history is off). */
  forget?: (ref: string, reason: string) => Promise<unknown>;
  /** The async git reader (createGitRead) for the backfill's second tier. */
  git?: GitRead;
  now?: () => number;
}): SentFiles;
```

`copy` checks, in this order: the relative path (from `folder`) has a `.git` segment → `git_internal`;
`isSecretName(relPath)` (the security kit's rule, reused from `tools/security/guard.ts`) → `secret`;
`sentFiles.noCopy` globs match the real path → copied with `copy: false` (`notKept: "policy"`); then the store's
`put` (§3.3). Before writing, when the copies on disk plus this size pass `storeMaxBytes`, the seam evicts
eligible copies (§8.1); still no room → `copy: false`, `notKept: "store_full"`. Each refusal writes the event
`sent_file_refused` (`reason`, `name`, `project`; never content).

### 3.5 The senders

**`send_file`** — `sendProjectFile(deps, req, hooks)` in `dispatch.ts`:

```ts
export interface SendFileDeps { files?: SentFiles; postFile?: PostFile; ledger?: Pick<Ledger, "rememberRoute">; trace?: Pick<Trace, "bindChannel"> }
export interface SendFileRequest { chatId: number; folder: string; path: string; caption?: string; project?: string; cause?: Cause; orderId?: string; route?: RouteTarget }
export async function sendProjectFile(deps: SendFileDeps, req: SendFileRequest, hooks?: {
  /** Write the thread's `file` line (caption or name) and return its id. */
  line?: (text: string) => number | undefined;
  plan?: { deps: PlanDeps; run: PlanRun };
}): Promise<string>;
```

Order: (1) the folder confinement, unchanged (`refused: … is outside project`, `not found`, `not a regular
file`); (2) a plan path → `offerPlanFile` (ADR-0019), unchanged; (3) no `files` → with `postFile`, the legacy
send of the original (the off switch); without it, `not sent: this run cannot send files to the operator`;
(4) `files.copy` (a refusal is the tool result); (5) `files.record` (the console has it now); (6) `hooks.line` →
`files.linkLine`; (7) `postFile` → `files.noteDelivery`; when the delivery has a message id: `trace.bindChannel`
(a Telegram reply joins the thread) and `ledger.rememberRoute(chat, messageId, req.route, cause)` (it reaches the
session). Results: `sent <path> (console and Telegram)`, `sent <path> (console; Telegram got a link: too large)`,
`sent <path> (console; Telegram failed: <reason>)`, `sent <path> (Telegram; the console could not keep a copy:
<reason>)`, `refused: <path> is a secret file — never send secrets`, `refused: <path> is inside .git`, `refused:
<path> is <size> — over the <cap> limit; send a smaller file`.

The `send_file` description says: the operator gets the file in Telegram and in the web console; secret files and
files inside `.git` are refused; at most `sentFiles.maxBytes`.

**Plan cards** — `postVersion` in `plans.ts`: with `deps.files`, it first copies the plan file (`origin: "plan"`,
`plan: { id, version: version + 1 }`). When the copied text's `reviewHash` is not `plan.sha256` (the file changed
after registration), it registers the copied text first (`register`), so the card, the record and
`plans.sent_sha256` describe the same bytes. `postPlan` gets `deliverPath` and `rec.fileName =
basename(plan.path)`. After a posted card and its `plan` trace line: `files.record(copied, { msgId: lineId,
delivery })`. A failed post records nothing (the copy is swept as an orphan, §8.1). Without `deps.files`: today.

### 3.6 Telegram

```ts
export type PostFile = (chatId: number, file: { path: string; name: string; caption?: string; size: number; ref?: string }) => Promise<Delivery>;
/** Built once by the daemon over the operator Bot API (the flood gate), like the plan poster. */
export function createFilePoster(api: Api, o: { target: (chatId: number) => number | undefined; telegramMaxBytes: number; consoleUrl?: string }): PostFile;
```

- `target`: a reserved chat (`isReservedChat`: web `0`, sub `-2`, customer `-3`, engine `-4`, side `-5`, all in
  `chats.ts`) → the admin DM; any other id as it is. No target → `failed` ("no operator chat").
- `size > telegramMaxBytes` → `sendMessage`: `📎 <name> (<size>) is too large for Telegram — open it in the web
  console: <consoleUrl>/#file=<ref>` (no URL configured: "… in the web console") → `link`.
- Else `sendDocument(chat, new InputFile(path, name), caption ? { caption: cut(caption, 1024) } : {})` → `sent`
  with `message_id` and `document.file_id`. An error → `faults.report("telegram.sendFile")` → `failed` with the
  error's first line.
- The plan poster uses `new InputFile(path, rec.fileName ?? basename(path))` and returns the `file_id` too.
- `PipelineDeps.sendFile` and `DispatchDeps.sendFile` are removed; both gain `files?: SentFiles` and
  `postFile?: PostFile`. The daemon passes the same two objects to the Telegram and the web engine deps, and to the
  loop's plan deps. `ingressToolDeps` sets both to `undefined`.

### 3.7 The web channel (`web-channel.ts`)

- The in-memory `files` map, `deliverFile`, `getFile` and `_testSendFile` are removed.
- `engine.files?.onRecorded(card => emit({ type: "file", file: card, name: card.name, url:
  "/api/files/<ref>/download", project: card.project, ...knownIds({ threadId: card.threadId }) }))`. `name` and
  `url` keep an older console bundle working until its page reloads.
- `thread(id)`: each message of kind `file` or `plan` gets `file?: SentFileCard` (`files.forMessages`); the view
  gains `files: SentFileCard[]` (`files.list({ threadId, limit: PAGE_MAX })`).
- `item(ref)`: a plan's `PlanCardView.sentFile` = `files.forPlan(plan.id, plan.version)`; a decision's
  `DecisionView.files` = the newest 5 of its thread.
- `project(name)`: `ProjectView.files` (newest `sentFiles.projectFiles`) and `filesNext`.
- New methods: `files(f)`, `file(ref)` (view), `fileBlob(ref)`, `removeFile(ref)` (it mirrors a notice to
  Telegram: `file <name> removed from the console`).

### 3.8 HTTP (`src/frontends/web-files.ts`, called by `web.ts` for `/api/files` and `/api/files/*`)

Every route needs the admin session (401 first). `<ref>` must match the pattern (404 otherwise, before any read).

| Route | Methods | `Sec-Fetch-Site` allowed | Answer |
|---|---|---|---|
| `/api/files?project=&thread=&before=<ref>&limit=` | GET | any (JSON, `no-store`) | `{ rows, next? }`; a bad `thread`/`limit` is ignored; an unknown `before` → 400 `bad_cursor` |
| `/api/files/<ref>` | GET | `same-origin` or absent | `SentFileView` JSON, `no-store`; 404 unknown |
| `/api/files/<ref>/raw` | GET, HEAD | `same-origin`, `none` or absent | the copy, by view (table below) |
| `/api/files/<ref>/download` | GET, HEAD | `same-origin`, `none` or absent | the copy as `application/octet-stream`, `attachment` |
| `/api/files/<ref>/remove` | POST | the global CSRF rule (ADR-0071) | `{ ok, text }` or `{ ok: false, error }` |

A refused `Sec-Fetch-Site` → 403. A ref that is not `kept` → 410 with the state's reason (`no-store`). A copy
missing on disk → 410, and the record becomes `evicted` (`missing`).

| View | `Content-Type` (raw) | `Content-Disposition` (raw) | `Content-Security-Policy` |
|---|---|---|---|
| image | the image type | `inline` | `FILE_CSP` |
| svg | `image/svg+xml` | `attachment` | `FILE_CSP` |
| pdf | `application/pdf` | `inline` | none (a `sandbox` or `object-src 'none'` policy can stop the browsers' built-in PDF viewers) |
| video, audio | their type | `inline` | `FILE_CSP` |
| markdown, text | `text/plain; charset=utf-8` | `inline` | `FILE_CSP` |
| download | `application/octet-stream` | `attachment` | `FILE_CSP` |

`FILE_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"`. Every
byte response also has: `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
`Referrer-Policy: no-referrer`, `Cache-Control: private, no-cache`, `ETag: "<sha256>"`, `Accept-Ranges: bytes`,
`Content-Length`, and the name as `filename="<ASCII, other characters as _>"; filename*=UTF-8''<RFC 5987>` (the
`rfc5987` helper moves here from `web.ts`). `If-None-Match` equal to the ETag → 304. Range (§3.2) → 206 with
`Content-Range: bytes a-b/size`, or 416 with `Content-Range: bytes */size`. HEAD → the same headers, no body. The
body is `Bun.file(path).slice(a, b + 1)`: streamed from disk, never read into memory.

**Audit:** the ledger event `sent_file_access` — `{ ref, action: "view" | "raw" | "download" | "remove", status,
range?, uid, session }` (the session as the first 12 hex of its sha256, like `md_file`). For `raw`: only a request
with no Range, or a range that starts at 0 (a player's first request), so a video does not write one event per
chunk.

`GET /file` is removed. `sw-rules.ts` drops its `/file` entry; `/api/files/*` is never handled by the service
worker (the existing `^/api/` rule).

### 3.9 The console

All words come from the catalogues; every size, time, version, ref, count and path is an LTR isolate (`ltr()`); a
file name is `<bdi dir="auto">`. Pure renderers in `src/frontends/web/sent-file.ts` (the `todo-size.ts` pattern:
`Fmt` in, markup out): `formatBytes`, `fileRowHtml`, `fileChipHtml`, `fileMetaHtml`, `fileStateHtml`,
`originalHtml`, `deliveryHtml`. The DOM in `app.ts`.

- **Feed row:** one button (≥ 44 px, `data-act="file-open"`): 📎, the name, the kind chip, the size, the project
  and the caption (two lines, dir auto). A `thumb` image adds `<img loading="lazy" decoding="async">` from `raw`,
  at most 180 px high, inside the row. A plan row with a card decision opens the item sheet (`dec:<id>`, ADR-0071);
  every other row opens the file sheet.
- **File sheet** (the existing `#tdsheet` dialog): the kind chip and the name; a meta line (project · size ·
  `clock(at)` · the thread ref as an Open thread link); the state line (not kept, evicted, removed, backfilled);
  the original's line; the Telegram line (`sent`: "also on Telegram"; `link`; `failed`); then the viewer:

  | View | Viewer |
  |---|---|
  | markdown | the server's HTML in `.tmsg .tx`, then `enhanceCode` |
  | text | `<pre class="code" data-lang>` filled with `textContent`, then `enhanceCode` (copy, fold, lazy colours); a truncated note |
  | image | `<img>` at most the sheet's width; a tap opens `raw` in a new tab (zoom) |
  | svg | `<img>` only (scripts never run in an image) |
  | pdf | "PDFs open in your browser's viewer" and **Open** (`raw`, `target="_blank" rel="noopener"`) |
  | video | `<video controls playsinline preload="metadata" src=raw>` at full width |
  | audio | `<audio controls preload="metadata" src=raw>` |
  | download | "This kind of file is not shown here" |

  A sticky action bar (`.acts.stick`): **Download** (`<a download href=download>`), **Open** (new tab, for image,
  pdf, video, audio, markdown and text), **Open thread**, **Review** (a plan with an open card), **Remove**
  (confirm; then the sheet shows the removed state). A not-kept, evicted or removed file shows its state and no
  viewer, Download or Open.
- **Thread:** a `file` or `plan` message with a record shows the chip under its line (a `file` line with a record
  shows only the chip: the chip carries the caption). A `file` line without a record says "sent before the console
  kept files — open it in Telegram". A **Files (N)** section after Plans. Each plan row gets **View** when its card
  version has a kept record.
- **Item sheet (ADR-0071):** a plan with `sentFile` (kept) renders `/api/files/<ref>` (the card's version), with
  the original's line ("changed since this card was sent", "only steps ticked", "deleted") and Download from
  `/download`; without it, today's `/md-file` view. A decision lists its thread's files (5 chips, then "all files
  in the thread").
- **Project page:** a **Files (N)** section after Plans: the newest `projectFiles`, then **Show older files**
  (`/api/files?project=&before=<ref>`).
- **Deep link:** `#file=<ref>` opens the sheet (`openFromHash`); an unknown ref → toast "This file is not here".
- **History tab:** a `file` hit opens the sheet (§9).
- **CSS** (`index.html`): `.filerow`, `.fthumb`, `.filechip`, `.fview img, .fview video {max-width:100%; height:
  auto}`, no sideways scroll at 390 px (code and tables scroll on their own).

## 4. Config (`sentFiles`, `docs/CONFIG.md`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false`: no records, no copies; Telegram gets the original (today's behaviour) |
| `dir` | `data/sent-files` | the file store (relative to the daemon's folder) |
| `maxBytes` | 104,857,600 (100 MiB) | a larger file is refused by `send_file` |
| `storeMaxBytes` | 2,147,483,648 (2 GiB) | the store's cap; eviction brings it to 90 % |
| `keepDays` | 180 | a copy whose newest record is older is evicted |
| `minKeepDays` | 7 | never evicted for the cap before this age |
| `noCopy` | `[]` | globs on the real path: recorded, never copied (`not_kept: policy`) |
| `textMaxBytes` | 524,288 | the text view's head |
| `thumbMaxBytes` | 2,097,152 | the feed shows an image inline up to this size |
| `telegramMaxBytes` | 52,428,800 (the Bot API limit) | larger: Telegram gets a console link |
| `hashCheckMaxBytes` | 20,971,520 | the original's state hashes files up to this size |
| `projectFiles` | 10 | files on the project page before "Show older files" |
| `housekeepEveryMs` | 3,600,000 | retention, cap and orphan sweep |
| `orphanGraceMs` | 86,400,000 | a copy no record names is deleted after this |
| `backfill.enabled` / `plansPerTick` / `gitMaxCommits` | `true` / 20 / 50 | §8.2 |

The Markdown render cap is the existing `mdFiles.viewMaxBytes` (one cap for every render on the engine thread). A
bad value keeps its default. History: `history.sources.fileMaxBytes` (262,144) and the kind `file` (§9).

## 5. Security

- **Who can read:** the admin session only (401 before anything). Single operator; the ref adds 128 bits so a
  leaked URL names one file; the internal id and the hash are never URLs (no IDOR, no guessing).
- **What can be read:** only a copy named by a `kept` record. No route takes a path. The store path comes from a
  validated hex hash. The store folder is checked at start (a real folder, not a symlink, 0700); copies are 0600.
- **What is copied:** only a regular file whose opened descriptor's real path is inside the project folder
  (`O_NOFOLLOW`, `/proc/self/fd`, after the existing `realpath` check), so a symlink swapped in after the check is
  refused. Never a secret-named file or a `.git` path. Never more than `maxBytes`. The customer path has no seam.
- **What the browser runs:** nothing from a file. Markdown goes through the one safe renderer (raw HTML is text,
  images become links, only http(s)/mailto links). Text is `textContent`. SVG only in `<img>`. HTML and XML are
  source text. Every byte response has `nosniff`; every response but PDF has the sandbox CSP; SVG and downloads are
  `attachment`; non-viewable files are `application/octet-stream`.
- **Who can embed or link:** CORP `same-origin`; `Sec-Fetch-Site` `same-site` (a sibling subdomain on this public
  host) and `cross-site` are refused; `Referrer-Policy: no-referrer`; remove is a POST under the CSRF rule.
- **Load:** copying and hashing are streamed and async; a Markdown render is capped; the original's hash is
  capped; lists are paged (`PAGE_MAX`); a Range body is a disk slice.
- **Disk:** capped store, eviction, refusals above `maxBytes`; a full disk never blocks a send.
- **Records and logs:** events carry the ref, the name, the reason and the size — never content. History drops a
  chunk with a secret shape (ADR-0067).
- Before done: `/security-scan` on the branch (upload, serving and input handling).

## 6. Where a file shows (summary)

| Surface | What | When |
|---|---|---|
| Feed | a row per record (thumbnail for a small image) | live; the replay window keeps it for a console that reconnects |
| Thread | a chip under the `file`/`plan` line; a Files section | always (ledger) |
| Item sheet | a plan's Review shows the card's version; a decision shows its thread's files | always |
| Project page | Files (N) | always |
| History | `file` hits | when history is on |
| Telegram | the document (or a console link when too large) | every send, whatever surface started the run |

No pin kind for files (the strip is for what only the operator can move); a plan needs no file pin, because its
pin's Review already shows the file.

## 7. Original state (the sheet)

`stat(folder/rel_path)` (lstat, then `realpath` must stay inside the real folder): missing, or the folder gone →
`deleted`. A path that now leaves the folder → `changed` (it is never read). Same `dev`, `ino`, `size` and `mtimeMs`
as at the copy → `unchanged`. Otherwise, when the size is at most `hashCheckMaxBytes`, an async streamed sha256:
equal → `unchanged`; different and the record is a plan whose current text has the same `reviewHash` →
`ticked`; else `changed`. Larger than the cap: a different size → `changed`, else `unknown`.

## 8. Housekeeping and backfill (`tick`, a heartbeat step)

### 8.1 Retention, cap, orphans (at most once per `housekeepEveryMs`)

1. **Age:** a copy whose newest `kept` record is older than `keepDays` and that no open plan names (a plan record
   whose plan is not `done` or `abandoned`) is dropped; its records become `evicted` (`retention`).
2. **Cap:** while the copies pass `storeMaxBytes`, the copy with the oldest newest record goes first, down to 90 %
   of the cap; never one younger than `minKeepDays` or one an open plan names (`store_cap`).
3. **Missing:** a `kept` record whose copy is not on disk becomes `evicted` (`missing`).
4. **Orphans:** a copy no `kept` record names, older than `orphanGraceMs`, is deleted (a failed plan post, a crash
   before the row). Temp files older than one hour are deleted.
5. One event `sent_files_housekeep` (`evicted`, `freedBytes`, `orphans`, `temp`, `totalBytes`). An error is one
   engine fault; the step returns at once (single-flight, like `backups.tick()`).

### 8.2 Plan backfill (until done; meta key `sentFiles.backfill` = `{ cursor, done, kept, fromGit, missed }`)

For each plan with `sent_sha256` and `version > 0` and no record for `(id, version)`, at most `plansPerTick` per
tick, by id:

1. The current file (`folder/path`, a regular file inside the folder, at most `plans.maxBytes`) whose `reviewHash`
   equals `sent_sha256` → copy and record (`backfilled`, `at = sent_at`, `msg_id` = the card's bound `plan` line
   from `messageByChannel(card_chat_id, card_message_id)`, the delivery from the card's chat and message ids).
2. Else, when the folder is a git work tree: `git log -n <gitMaxCommits> --format=%H -- <path>`, then `git show
   <sha>:<path>` for each commit, newest first, through the async reader (`createGitRead`, bounded by
   `github.callTimeoutMs`): the first blob whose `reviewHash` equals `sent_sha256` → `putBytes` and record.
3. Else nothing (the plan line keeps its "not kept" chip; Review falls back to `/md-file`).

Old `send_file` lines get no backfill: there is no path or hash to start from.

## 9. History (ADR-0067)

- A new source table `sent_files` (feed triggers in v19, keyed by the file ref), kind `file`, ref
  `file:<file ref>` (the internal id is not used, so it never leaves the server).
- A `plan` record → `none` (the plan source covers the plan). A `removed` record → `none` (its entry goes).
- Firewall: `anchoredVerdict({ orderId, threadId })`, like a plan; the customer chat and ingress threads are
  excluded.
- Text: the name, the caption, and, for a kept `markdown` or `text` copy of at most `history.sources.fileMaxBytes`,
  its text (chunks with a secret shape are dropped, as for every source). An `evicted` record keeps its entry.
- Meta: `thread`, `order`, `path` (the original), `fileRef`. A History tab hit of kind `file` opens the file sheet.
- `remove` calls `history.forget("file:<file ref>", "removed by the operator in the console")`.

## 10. Ledger v19 ("sent files", frozen once shipped)

```sql
CREATE TABLE sent_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('send_file', 'plan')),
  name TEXT NOT NULL, caption TEXT,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, view TEXT NOT NULL, lang TEXT,
  state TEXT NOT NULL CHECK (state IN ('kept', 'not_kept', 'evicted', 'removed')), state_reason TEXT, state_at INTEGER,
  project TEXT, folder TEXT NOT NULL, rel_path TEXT NOT NULL, orig_stat TEXT, review_sha256 TEXT,
  thread_id INTEGER, cause_msg_id INTEGER, msg_id INTEGER, order_id TEXT,
  plan_id INTEGER, plan_version INTEGER,
  deliveries TEXT, backfilled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sent_files_thread ON sent_files (thread_id, id);
CREATE INDEX idx_sent_files_project ON sent_files (project, id);
CREATE INDEX idx_sent_files_msg ON sent_files (msg_id);
CREATE INDEX idx_sent_files_sha ON sent_files (sha256, state);
CREATE UNIQUE INDEX idx_sent_files_plan ON sent_files (plan_id, plan_version) WHERE plan_id IS NOT NULL;
-- ADR-0067 change feed: an insert, and a change of name, caption, state, project or thread_id (rows are never deleted)
CREATE TRIGGER history_feed_sent_files_ai AFTER INSERT ON sent_files BEGIN INSERT INTO history_feed (tbl, key, op, at) VALUES ('sent_files', new.ref, 'u', <now ms>); END;
CREATE TRIGGER history_feed_sent_files_au AFTER UPDATE OF name, caption, state, project, thread_id ON sent_files
  WHEN old.name IS NOT new.name OR old.caption IS NOT new.caption OR old.state IS NOT new.state OR old.project IS NOT new.project OR old.thread_id IS NOT new.thread_id
  BEGIN INSERT INTO history_feed (tbl, key, op, at) VALUES ('sent_files', new.ref, 'u', <now ms>); END;
```

`<now ms>` is v17's expression. The feed key is the file ref (text, unique), so the history reads `sent_files`
by `ref` (`HISTORY_SOURCES.sent_files.key = "ref"`, `intKey: false`). `orig_stat` is JSON `{dev, ino, size, mtimeMs}`; `deliveries` is a JSON array of
`Delivery`. Ledger methods: `insertSentFile`, `sentFileByRef`, `sentFileById`, `sentFileForPlan`,
`sentFilesForMessages`, `listSentFiles`, `setSentFileLine`, `addSentFileDelivery`, `setSentFileState`, `keptCopies`
(sha256, size, newest kept record, whether an open plan names it), `sentFilesBySha`, `plansToBackfill`; the history
reads gain `sent_files` (`HistoryRowMap`, `HISTORY_SOURCES`).

## 11. Acceptance criteria

**Send paths (the root cause)**

1. `send_file` from a run started with Telegram's deps (an operator message, the todo launcher) and from one
   started by the console both: write one `sent_files` row, keep a copy whose sha256 equals the file's, emit one
   web `file` event, and post the Telegram document from the copy under the original name. A reserved reply chat
   (the console's `0`) posts to the admin DM.
2. A file over `telegramMaxBytes` (and at most `maxBytes`): Telegram gets the link line with the name, the size and
   `<publicUrl>/#file=<ref>`; the delivery is `link`; the console has the file.
3. A Telegram failure: the record exists, the delivery is `failed` with the reason, the tool result says so, one
   fault is reported.
4. The `file` line of the thread is linked (`msg_id`); the document's message id is bound to it, so a Telegram
   reply to the document joins the thread, and the route reaches the run's session.
5. Refused, with nothing recorded or posted and one `sent_file_refused` event: a path outside the folder, a missing
   file, a folder, a FIFO, `.env`, `.env.local`, `id_rsa`, `credentials.json`, `certs/x.pem`, `.git/config`, a file
   over `maxBytes`, and a symlink swapped in after the confinement check (the descriptor's real path is outside).
   `.env.example` and `.github/workflows/ci.yml` are sent.
6. The customer path (`ingressToolDeps`): `send_file` answers `not sent: this run cannot send files to the
   operator`; no row, no Telegram call.
7. `sentFiles.enabled: false`: no row and no copy; Telegram gets the original; the result says `sent <path>`.
8. A caption over 1,024 characters is cut with `…` on Telegram; the record keeps up to `TELEGRAM_MAX` characters.

**Store**

9. The same bytes sent twice: two records, one copy. A copy is `0600`, the store folder `0700`. The copy holds
   exactly the bytes of the size seen at open; a file that ends early is refused (`moved`).
10. A write error while copying: the record is `not_kept` (`store_failed`) with the file's full sha256; Telegram
    gets the original; no 500 anywhere.
11. Over `storeMaxBytes`: eligible copies are evicted first; when nothing can go, the record is `not_kept`
    (`store_full`) and Telegram gets the original. A `noCopy` match is `not_kept` (`policy`).

**Type and view**

12. `fileKind` follows §3.1 for each row of the table, and: a `.png` holding HTML → `download`; a `.pdf` without
    `%PDF-` → `download`; a `.txt` with a NUL or invalid UTF-8 → `download`; `page.html` → `text` (lang `html`); an
    `.svg` without an `<svg` root → `text`; `Makefile` → `text`; `x.zip` → `download`.

**HTTP**

13. Without a session every `/api/files*` route is 401. A malformed ref is 404 with no ledger read; an unknown one
    404. `Sec-Fetch-Site: same-site` or `cross-site` → 403 on the view, raw and download routes.
14. The raw headers follow the §3.8 table for each view; download is always `attachment` and
    `application/octet-stream`; every byte response has `nosniff`, CORP, `Referrer-Policy`, `Cache-Control`, the
    ETag and `Accept-Ranges`; only PDF lacks the CSP; the name has an ASCII and an RFC 5987 form.
15. `parseRange` and the routes: `bytes=0-99` → 206, `Content-Range: bytes 0-99/<size>`, 100 bytes; `bytes=100-`
    and `bytes=-50` are right; past the end → 416 with `bytes */<size>`; two ranges or garbage → 200 full;
    `If-Range` with another ETag → 200 full; `If-None-Match` equal → 304; HEAD → no body, `Content-Length` = size.
16. A `not_kept`, `evicted` or `removed` file: raw and download → 410 with the reason; the view → 200 with the state.
    A copy deleted by hand → 410 and the record becomes `evicted` (`missing`).
17. The view: Markdown through `mdToHtml` (a raw `<script>` is text, an image is a link); over
    `mdFiles.viewMaxBytes` → the text head with `truncated`; a text head is at most `textMaxBytes`, cut after a
    newline; the view has `path` and `original`.
18. One `sent_file_access` event per view, download, remove and first raw request, with ref, action, status, uid
    and the session hash; none per later Range chunk; never content.
19. Remove: the record becomes `removed`; the copy is deleted unless another `kept` record has the same sha256;
    `forget("file:<file ref>")` is called when history is on; raw → 410; a second remove → `already removed`.

**Original state**

20. `unchanged` (same stat; or a touched file with the same bytes), `changed`, `ticked` (a plan whose only change is
    checkbox marks), `deleted` (the file or its folder is gone), `unknown` (another stat, the same size, over
    `hashCheckMaxBytes`); a path that now leaves the folder → `changed`, never read.

**Plan cards**

21. A posted card version → one `plan` record (plan id and version, the `plan` line's id, the delivery with the
    card's chat, message and file ids); the poster got the copy and `fileName` = the plan's base name; a failed post
    → no record (the copy is an orphan); a second post of the same version → still one record.
22. A plan file changed between registration and posting is registered again from the copied text first; the card,
    the record and `plans.sent_sha256` describe the same text (`reviewHash`).
23. The item sheet of a plan pin renders the card version's copy and states its original; a plan in a folder
    outside `mdFiles.roots` with a record is rendered; a plan without a record uses `/md-file` as today.

**Console**

24. Every record emits one feed `file` event (with `name` and `url`); a `thumb` image shows inline; a row opens the
    file sheet; a plan row with a card decision opens the item sheet.
25. Thread: the chip under each `file`/`plan` line with a record; the "sent before the console kept files" note for a
    `file` line without one; the Files section; a plan row's View.
26. Project page: Files (N) with the newest `projectFiles` and Show older files.
27. The sheet per view as §3.9 (an SVG's script never runs; a PDF opens in a new tab; video and audio have native
    controls; download-only says so); the state, original and Telegram lines; Remove asks first.
28. `#file=<ref>` opens the sheet; an unknown ref gives the "not here" toast.
29. History: a kept text `send_file` record is a `file:<file ref>` entry with its name, caption and text; a plan record is
    not an entry; a record of an excluded order or thread is excluded; a History hit opens the sheet; remove
    forgets the entry.
30. The catalogues have `files.*`, `pj.sect.files`, `threads.files` and `history.kind.file` in EN and AR (the
    parity test is green); sizes, times, versions, refs, counts and paths are LTR isolates.
31. The mobile e2e (390 px, EN and AR, real Chromium, local harness): rows are at least 44 px high; the sheet never
    scrolls sideways (code and tables scroll on their own); the action bar is in view; an image fits the width;
    Arabic labels read Arabic and every size and time is `dir="ltr"`; screenshots with `NEO_SHOTS_DIR`.

**Housekeeping and backfill**

32. §8.1: retention by age, the cap down to 90 %, never a young copy or an open plan's copy, missing copies marked,
    orphans and old temp files deleted, one event, single-flight, an error is one fault.
33. §8.2: a matching current file → a kept, backfilled record with the card's line and delivery; else a matching
    git blob → kept from git; else nothing; at most `plansPerTick` per tick; the cursor survives a restart; done once;
    running again adds nothing.

**Build and docs**

34. `bunx tsc --noEmit` and `bun test` are green. The migration test for v18 pins its list to `version <= 18`; a v18
    ledger with rows migrates to 19 with the same counts and a `.bak-v18`. `/file`, `_testSendFile` and the per-surface
    `sendFile` are gone, with their tests replaced.
35. `docs/CONFIG.md` (`sentFiles`, the history kind), `docs/HISTORY.md`, CONTEXT.md (the terms), and ADR-0073 accepted
    with an "As built" section.

## 12. Edge cases

- **The same path sent again with new content:** two copies; the older record's original reads `changed`.
- **Zero bytes:** kept; the text view is empty; raw is 200 with no body; any Range → 416.
- **A file that grows while it is copied:** the copy has the size seen at open; a later send has the new bytes.
- **A name with quotes, newlines or Arabic:** escaped and isolated on screen; `_` in the ASCII header name, exact in
  `filename*`.
- **A hard link to a file outside the folder:** its real path is the in-folder name, so it is sent. The audience is
  the operator's own channel; noted, not blocked.
- **A worker sends a plan path with `send_file`:** the plan registry handles it (one `plan` record, no `send_file`
  record).
- **Two records share a copy and one is removed:** the copy stays for the other.
- **The console is closed at send time:** the replay window keeps the event; after a restart the thread and the
  project page still have the file.
- **A restart while copying:** the temp file is swept within an hour; no row exists.
- **The store folder is missing or a symlink at start:** one alert; every send is `not_kept` (`store_failed`) and goes
  to Telegram as today.
- **Disk full:** `not_kept`; Telegram gets the original; the disk guard alerts as today (ADR-0068).
- **Telegram not configured:** console only; no delivery.
- **Telegram's flood limit:** the poster waits through the operator API's gate, like the plan poster.
- **A plan in a removed worktree:** no backfill (no folder, no git there); Review falls back to `/md-file`, which may
  refuse it (ADR-0071's limit for old plans).
- **A thread the operator closed:** its files stay listed.
- **History off:** no source work; remove still works.
- **A ref collision:** the unique index refuses it; one retry with a new ref.
- **Phones:** iOS Safari plays video only with Range (served); Android Chrome hands a PDF to a PDF app.
- **An older console page:** the `file` event's `name` and `url` still give it a working Download link.

## 13. Out of scope

- `send_file` for loops (they have no tool today).
- The operator's own uploads (staged attachments) shown as files.
- Restoring an evicted copy from Telegram (the `file_id` is stored for it).
- Server-side thumbnails, PDF page previews, Office previews.
- A Telegram `/files` command; a global Files tab; file pins.
- Backing up the store; Codex workers (their `send_file` path is unchanged).

## 14. Operator question (non-blocking; the defaults apply until answered)

Sent files can be reports with production or customer data (for example a prod-ops export). The console keeps a
copy for `keepDays` (180) in `data/sent-files` (0600, a protected folder), next to the original that is already on
this host and the copy already in Telegram. **A (recommended):** keep copies of every file for 180 days. **B:** never
copy files from chosen folders (for example the prod-ops desk): set `sentFiles.noCopy`; those files reach Telegram
only, and the console shows their name as "not kept". **C:** a shorter `keepDays`.

## 15. Files

New: `src/engine/file-kind.ts`, `src/engine/http-range.ts`, `src/engine/sent-files-store.ts`,
`src/engine/sent-files.ts`, `src/engine/sent-files-backfill.ts`, `src/frontends/web-files.ts`,
`src/frontends/web/sent-file.ts`; tests `tests/file-kind.test.ts`, `tests/http-range.test.ts`,
`tests/sent-files-store.test.ts`, `tests/sent-files.test.ts`, `tests/sent-files-backfill.test.ts`,
`tests/send-file.test.ts`, `tests/telegram-files.test.ts`, `tests/web-files.test.ts`, `tests/console-files.test.ts`,
`tests/history-files.test.ts`, `tests/console-files-mobile.e2e.test.ts`.

Changed: `src/engine/ledger-migrations.ts` (v19), `src/engine/ledger.ts`, `src/engine/chats.ts` (`WEB_CHAT`,
`ENGINE_CHAT`, `isReservedChat`), `src/engine/trace.ts` and `src/frontends/web.ts` (their chat constants from
`chats.ts`), `src/engine/dispatch.ts`, `src/engine/pipeline.ts`, `src/engine/ingress.ts`, `src/engine/plans.ts`,
`src/engine/web-channel.ts`, `src/engine/needs-you-detail.ts`, `src/engine/project-view.ts`,
`src/engine/history/{defaults,store,indexer,sources}.ts`, `src/frontends/telegram.ts`, `src/frontends/web.ts`,
`src/frontends/web/{app.ts,index.html,sw-rules.ts,history.ts}`, `src/frontends/web/locales/{en,ar}/console.json`,
`src/config.ts`, `src/daemon.ts`, `tools/console-demo/demo.ts`; tests `tests/dispatch.test.ts`,
`tests/plans-send.test.ts`, `tests/trace-dispatch.test.ts`, `tests/web-channel.test.ts`, `tests/console-pwa.test.ts`,
`tests/ledger-migrations.test.ts`, `tests/telegram-plans.test.ts`, `tests/console-i18n.test.ts`, the history source
tests.

Docs: `docs/CONFIG.md`, `docs/HISTORY.md`, `CONTEXT.md`, `docs/adr/0073-…` (accepted after the build). `CLAUDE.md`
is not changed (it is at its size limit).
