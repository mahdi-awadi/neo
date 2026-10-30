---
approval: required
---
# Task history with hybrid (meaning + words + exact) search — plan

Spec: `docs/superpowers/specs/2026-10-29-task-history-search-design.md`. ADR:
`docs/adr/0066-task-history-in-sqlite-with-vectors-in-the-shared-qdrant-kept-in-step-by-a-ledger-change-feed.md`
(proposed, revision 3). Terms: `CONTEXT.md` (Task history, History entry, Archived entry, Forget, Change
feed, Keyword-only mode, Embedder, Model tag, Snapshot backup).

Branch `feat/history-search` from `dev`, worktree `/home/neo-wt-history` (remove the folder when the work
is merged). Each task is TDD: write the failing tests first, then the code, then make `bunx tsc --noEmit`
and `bun test` green, then make one commit for the task. Start long test runs in the background and poll
them. After the verify step and the reviews, merge into `dev`, never into `master`. Do not restart the
daemon. The restart is the operator's.

**Why approval:**

- a ledger migration (v17: a change feed with triggers on the source tables)
- a new always-on Docker service (the embedder, at most 4 GB under its cap)
- Neo as a consumer of the shared Qdrant
- a new data file with its own backup job
- new worker tools, three new console routes and three Telegram commands

**Nothing waits for ops.** The collection, the key and the consumer guide exist (checked on 2026-10-29).
The build needs no ops step. The ops notes at the end are information for ops.

**Order.** Tasks 1–3 are pure or local. Task 4 changes the ledger. Tasks 5–10 build the engine part on
fakes. Task 11 wires it into the daemon. Tasks 12–17 add the surfaces, the service and the backup. Task 18
adds the commands for the verify step. Task 19 is the docs. Task 20 is the live verify step.

---

- [x] **1. Arabic normalizer and light stemmer** (pure)
  - Create: `src/engine/history/normalize.ts`, `src/engine/history/arabic-stem.ts`,
    `tests/history-normalize.test.ts`.
  - Tests first:
    - One case for each normalization rule of the spec:
      - harakat, Quranic marks and tatweel
      - `أ إ آ ٱ` → `ا`, `ى` → `ي`, `ة` → `ه`, `ی` → `ي`, `ک` → `ك`
      - Arabic-Indic and Persian digits, presentation forms (NFKC)
      - zero-width and bidi format characters, Latin lowercase
    - The offset map: a match on the normalized text maps to the right original range when harakat sit
      inside the word.
    - Idempotence: `normalize(normalize(x))` equals `normalize(x)`. Empty input gives empty output.
    - Stems: `والمقاعد` → `مقاعد`, `المقاعد` → `مقاعد`, `بالحجز` → `حجز`, `الحجوزات` → `حجوز`. Short
      words do not change (the length limits). Latin tokens do not change.
  - Build: `normalize(text)`, `normalizeWithMap(text)` → `{ text, map }`, `arabicStems(text)` (the stems
    of the Arabic-script tokens, joined by spaces). No I/O.
  - Done when: the unit part of AC14 passes.

- [x] **2. Chunker and extractors** (pure)
  - Create: `src/engine/history/chunker.ts`, `src/engine/history/extract.ts`,
    `tests/history-chunker.test.ts`, `tests/history-extract.test.ts`.
  - Tests first:
    - Chunker: the size and the overlap. The cut prefers a paragraph end, then a line end, then a sentence
      end (`. ! ? ؟ ۔`), then a grapheme boundary. An emoji and an Arabic word with marks are never split.
      `minChars` and `maxPerRef` (cut with a flag). A 100 KB result.
    - Shas: `dev 479236d` and a 40-character sha are found. UUID parts, `#ffffff`, hex runs longer than 40,
      all-digit tokens and all-letter tokens are not.
    - Query ids: `#884`, `todo 884`, `plan 12`, `note 470`, `#ab12cd34`, a UUID, an `m…` ref and a PNR-like
      code.
    - Engine blocks: each recognizer removes the output of the real builder. The test calls
      `briefWithProjectDocs("")`, `codebaseMemoryLine({ project: "x" })`, `codebaseMemoryLine({})`,
      `lanePreamble(...)`, `teamLeadPreamble("")` and the memory-snapshot and handoff-note builders.
      `extract.ts` itself does not import `dispatch.ts`.
    - The continuation wrapper (`CONTINUATION_MARK` … `Original brief:`) unwraps to the original brief.
    - Paragraph hashes use the normalized text. Boilerplate removal works with a given set of hashes.
  - Done when: these tests pass, and a text change in a builder breaks a test.

- [x] **3. The `history.db` store**
  - Create: `src/engine/history/migrations.ts`, `src/engine/history/store.ts`,
    `tests/history-store.test.ts`.
  - Tests first:
    - A new file has the spec schema at version 1 (FTS5 with `contentless_delete=1` and the porter
      tokenizer) and mode 0600. A reopen keeps the cursor, the state and the lock.
    - `putSource` with chunks: an unchanged `text_hash` keeps the chunk id. A changed chunk replaces its FTS
      row. Removed seqs delete their chunk and FTS rows and give back their point ids.
    - FTS search on `body` and `stems` in bm25 order, with the filters through the join to `sources`.
    - Vectors by text hash and tag. Point marks: the list to upload, mark uploaded, clear the marks of a
      tag, the ids of a tag. The `pending_deletes` queue.
    - `remembered` with the duplicate check on project and text hash. Tombstones. Boilerplate counts.
      `markGone`. The coverage query.
    - A live lock is seen by a second opener. A corrupt file gives a typed error.
  - Build: every SQL statement is parameterized. Migrations run through
    `migrate(db, { path, migrations })` (reuse, with its `.bak-v<N>` copy).
  - Done when: these tests pass.

- [x] **4. Ledger change feed (migration v17) and the history reads**
  - Create: `src/engine/chats.ts` (move `SUB_CHAT`, `CUSTOMER_CHAT` and `SIDE_CHAT` here, and let
    `dispatch.ts` re-export them), `tests/ledger-history-feed.test.ts`.
  - Modify: `src/engine/ledger-migrations.ts` (v17), `src/engine/ledger.ts` (the new methods and their row
    types), `tests/ledger-migrations.test.ts`.
  - Tests first:
    - A v16 file with rows (made with migrations 1–16) migrates to v17, writes `.bak-v16`, and has the table
      and the triggers.
    - Through the real `Ledger` API, each of these writes gives a feed row:
      - `recordOrder` (insert and re-record), `recordOutcome` (insert and replace).
      - `addTodo`, and `updateTodo` for each watched column. The todo prune gives `d`.
      - `upsertPlan`.
      - `insertAttention` and `updateAttention` for `note`, `github` and `git`. `pruneAttention` gives `d`.
      - `openDecision`, `resolveDecision`, `supersedeDecision`. The decision prune gives `d`.
      - `insertMessage` for an operator line and for a digest. `setMessageThread` on an operator line.
    - These writes give no feed row:
      - `updateTodo` of `position` only
      - an `engine` attention item, and an update of `last_seen` only
      - an engine-surface user line, and a worker `text` or `progress` line
    - `historyFeed` pages in id order. `historyFeedBounds`. `pruneHistoryFeed(keep)`.
    - `historyRows` for each table gives the columns that `sources.ts` needs. `historyScan` pages in key
      order.
    - `historyLineage`: a chain of three orders, a `CUSTOMER_CHAT` root, a missing parent, the depth cap.
    - `searchWorkerLines` gives only worker `text` and `progress` lines. It gives no `CUSTOMER_CHAT` line
      and no line on an `ingress` thread. It applies the project and date filters. A malformed query
      gives `[]`.
    - `EXPLAIN QUERY PLAN` of the feed read uses the primary key.
  - Done when: these tests and the full ledger suite pass. The migration runs only at the next restart.

- [x] **5. Sources and the firewall**
  - Create: `src/engine/history/firewall.ts`, `src/engine/history/sources.ts`,
    `tests/history-sources.test.ts`, `tests/history-firewall.test.ts`.
  - Tests first:
    - One extraction test for each kind of the spec table: text, title, project, `at` and meta (todo,
      order, thread, path, commits). The hash stays the same for the same text and changes with the text.
    - These rows are not sources: an order with a todo, an order on an operator chat, an `interrupted`
      outcome, an engine-surface user line.
    - Plan files: a file inside the folder is read. A symlink out of the folder is not read. A missing file
      keeps the last text and sets `fileMissing`. A file larger than `planMaxBytes` is cut and flagged.
    - Notes, attention items (through `explainAttention`) and decisions (spec, options, answer) compose
      their text as the spec says.
    - Firewall exclusions:
      - a `CUSTOMER_CHAT` order, its child and its grandchild
      - a row on an `ingress` thread, and a message on `CUSTOMER_CHAT`
      - an order with a missing parent, and a chain deeper than 8
    - A todo with no order and no thread waits. An unknown table is skipped and counted.
    - A secret-shaped chunk is dropped, and the event names the pattern, not the text. A secret-shaped
      title is replaced. An injection phrase is made harmless and the chunk is flagged.
    - Static: no file under `src/engine/history/` imports `inbox`.
  - Done when: AC12 passes, and the extraction parts of AC3 and AC6 pass.

- [x] **6. Embedder adapter**
  - Create: `src/engine/history/embedder.ts`, `tests/fixtures/fake-tei.ts` (`Bun.serve` on port 0),
    `tests/history-embedder.test.ts`.
  - Tests first:
    - Loopback check: `127.0.0.1`, `::1` and `localhost` pass. Other hosts give `config_refused`.
    - No key in the environment gives `not_configured`. The request has the bearer header.
    - `/info` with the right model and revision gives up. A wrong one gives `embedder_wrong_model`, and no
      vector from it is kept.
    - Embed success with the dims check. 401 and 403 give `embedder_refused`. A timeout gives
      `embedder_slow`. 413 splits the batch. 429 and 503 give a back-off. A wrong vector length is refused.
    - Connection refused gives `embedder_down`, and the next probe after a restart of the fake gives up.
    - The query cache stops a second call for the same query.
    - A marker key never shows in an error or a reason.
  - Done when: the adapter part of AC20 and the embedder states of AC9 pass.

- [x] **7. Vector index adapter (Qdrant)**
  - Create: `src/engine/history/vector-index.ts`, `tests/fixtures/fake-qdrant.ts`,
    `tests/history-vector-index.test.ts`.
  - Tests first:
    - These configs are refused before any request (the fake counts zero requests):
      - a URL that is not loopback
      - a collection without `neo_`, or outside `allowedCollections`
      - a key that is not a JWT, a JWT with a global `access`, a JWT that names another collection
    - `probe` reads the collection info and the count for a tag. 401 or 403 on the info gives
      `collection_missing`. 401 or 403 on other calls gives `vectors_refused`. A timeout gives
      `vectors_slow`.
    - `ensureIndexes` sends the four index requests (`project`, `kind` and `m` as keyword, `at` as integer
      with range). A second call sends the same requests and gives no error.
    - `upsert` sends `wait=true` and only `id`, `vector` and `payload { project, kind, at, m }`. An extra
      payload key, a string longer than 64 characters or a wrong vector length throws before the request.
    - `delete` by ids. `deleteTag` by the filter on `m`. `search` with the filters (`m`, `project`, `kind`
      any, `at` range) and `with_payload: false`. `scrollIds` pages.
    - `NoVectorIndex` answers `off`. A marker key never shows in an error or a log line.
  - Done when: AC13 and the adapter part of AC10 pass.

- [x] **8. The indexer**
  - Create: `src/engine/history/indexer.ts`, `tests/history-indexer.test.ts` (an in-memory ledger from
    `openLedger(":memory:")`, a temp `history.db`, and the fakes of tasks 6 and 7).
  - Tests first:
    - Freshness: a new todo is keyword-searchable after one pass, and has a point after its embed and
      upload batches. A second pass does no work.
    - Feed mapping: an order change touches its order, result and todo entries. A todo that gets an
      `order_id` removes the order entry.
    - Updates: only changed chunks get a new vector. The same point id is overwritten. Removed chunks go to
      `pending_deletes` and then to Qdrant.
    - Archive: a pruned todo gets `gone_at` and stays searchable. A firewall verdict that changes to
      excluded removes the entry. A tombstone stops both the feed and the reconcile.
    - Reconcile: a feed gap starts it. It continues from its saved position when the store opens again.
      The weekly run deletes orphan ids (the fake holds extra ids).
    - Down states: with the embedder down, the chunks wait, and the state and `since` are set. When it is
      up again, the backlog drains. With Qdrant down, the vectors are kept and the uploads wait. When it is
      up again, the backlog drains.
    - Drift: an emptied fake collection gives cleared marks, `ensureIndexes`, a re-upload and zero embed
      calls.
    - Model change: with `next` set, both tags are embedded and uploaded. After `retireAfterDays`,
      `deleteTag` runs for the old tag and its local vectors are deleted.
    - Bounds: no transaction covers more than `sliceRows` source rows. Two calls at the same time run one
      pass. A live lock from another process stops the indexer. A query in flight delays the next embed
      batch. Events carry counts only.
  - Done when: the indexer parts of AC5 to AC11 pass, and AC24 passes for the indexer events.

- [x] **9. Search**
  - Create: `src/engine/history/exact.ts`, `src/engine/history/fuse.ts`, `src/engine/history/snippet.ts`,
    `src/engine/history/search.ts`, `src/engine/history/stopwords.json` (Arabic and English),
    `tests/history-fuse.test.ts`, `tests/history-search.test.ts`.
  - Tests first:
    - Fuse: the RRF sums and the weights, and exact hits first. On a tie, the newer hit comes first. Equal
      text collapses into one hit with `alsoIn`. The limit applies.
    - Exact: `todo:884` resolved directly, a sha prefix through an FTS prefix query, a decision id prefix,
      a PNR-like code.
    - AC1 with a fake embedder: the English entry and the Arabic paraphrase are in the top 3.
    - AC2, AC3 and AC4. A spy on each list makes sure that each one gets the filters.
    - Modes: `on`, `partial` with its coverage, `off` with each reason, and `skipped` for an id-only query
      (zero embed calls). A failed list does not stop the other lists.
    - Arabic: `مقاعد` finds `والمقاعدُ`. `١٢٣` finds `123`. The highlight lands on the original text with
      its harakat.
    - Query checks: empty, stop words only, more than 500 characters, an unknown kind, `since` after
      `until`. An unreadable `history.db` gives `ok: false`. The `history_search` event has no query text.
  - Done when: AC1–AC4 and AC14 pass, and the search side of AC9 passes.

- [x] **10. Remember and forget**
  - Create: `src/engine/history/index.ts` (the factory and the methods),
    `tests/history-remember-forget.test.ts`.
  - Tests first:
    - `remember` gives a `mem:` ref that the words list finds at once.
    - `remember` refuses: empty text, text below `minChars`, text over `maxChars`, a secret shape (the
      error names the pattern), an injection phrase or invisible characters (the `scanMemoryText` reason).
    - The same text in the same project gives the same ref. The rate limit applies to each session.
    - `forget` deletes the chunks, their FTS rows, the vectors that no other chunk uses, and the points.
      With Qdrant down, the points wait in `pending_deletes` and go out on the next pass.
    - The tombstone stops a reconcile from adding a ledger-backed ref again. An unknown ref gives
      `ok: false`. Both events carry no text.
  - Done when: AC15 and AC16 pass.

- [ ] **11. Factory, config and daemon wiring**
  - Create: `src/engine/history/cfg.ts`, `tests/history-cfg.test.ts`,
    `tests/history-daemon-wiring.test.ts`.
  - Modify:
    - `src/config.ts`: the `history` and `backup` readers.
    - `src/daemon.ts`: open the history when it is enabled. Add the heartbeat steps `history` (through
      `faults.contain`, which keeps the newest `IndexReport`) and `history.feedPrune`. Close the store on
      shutdown. Put `history` in the deps of the operator surfaces.
    - `config.example.json`, `docs/CONFIG.md` (the `history` and `backup` sections).
  - Tests first:
    - `readHistoryCfg` defaults. Each wrong value keeps the default. The `next` checks. Each
      `allowedCollections` entry must start with `neo_`.
    - Disabled: no store opens and no tool is attached.
    - A corrupt `history.db`: the engine starts, the file moves to `history.db.corrupt-<time>`, one alert
      goes out, and the tools say that history is not available.
    - A failing heartbeat step never throws out of the tick.
  - Done when: the heartbeat part of AC5 and the engine part of AC9 pass.

- [ ] **12. Worker tools**
  - Create: `docs/tools/history-search.md` (a tool card with frontmatter like `project-notes.md`),
    `tests/history-tools.test.ts`.
  - Modify: `src/engine/dispatch.ts` (the tools `history_search` and `remember`, `history` in
    `ConsultToolDeps`, one preamble sentence), `src/engine/ingress.ts` (strip `history`), and a test that
    pins the preamble text, if one exists.
  - Tests first:
    - The attachment matrix: the company session and a project worker get both tools. A consult run gets
      `history_search` only. An ingress run, and the deps that it gives its dispatches, get no tool. A
      tainted run has no MCP.
    - The reply: the mode line, numbered hits, and the data line at the end. Wrong input gives a text error.
    - `remember` takes `by` and `cause` from the session, not from the arguments. The rate limit applies.
    - The preamble has the sentence. `tools_for("search past work")` finds the card.
  - Done when: AC17 passes.

- [ ] **13. Console History tab**
  - Create: `src/frontends/web/history.ts` (the panel), `tests/console-history.test.ts`.
  - Modify:
    - `src/frontends/web.ts`: `GET /api/history`, `POST /api/history/remember`, `POST /api/history/forget`.
    - `src/frontends/web/app.ts` (the tab) and `src/frontends/web/index.html` (the styles).
    - `src/frontends/web/locales/en/console.json` and `locales/ar/console.json`: `tabs.history`,
      `history.*`, and `att.kind.*` and `att.why.*` for the three new attention kinds.
  - Tests first:
    - API checks: the query length, the kinds list, the dates and the limit clamp. A bad value answers 400
      with a reason. No session answers 401. Each answer is `no-store`. The POST routes have the same
      guards as the other console POST routes. Forget needs a reason.
    - Rendering: the hit card fields, the banner for each mode, the empty, loading and error states, the
      confirm dialog for forget.
    - In Arabic, ids, dates, shas and counts are in `<bdi dir="ltr">`.
    - A CSS test for the phone width (like `console-responsive.test.ts`).
    - The i18n parity test and the no-literal-strings test pass.
  - Done when: AC18 passes. The screenshots come in task 20.

- [ ] **14. Telegram `/find`, `/remember`, `/forget`**
  - Modify: `src/engine/commands.ts` (three commands, `later` for the async work),
    `src/frontends/telegram.ts` (the forget button), `tests/commands.test.ts` and the Telegram callback
    tests.
  - Tests first:
    - Parsing of `p:`, `k:`, `since:` and `until:`. An empty command gives the usage text.
    - A reply has at most 4,096 characters: fewer hits and the console link. The mode line.
    - Numbers stay LTR in Arabic lines (`numbersLtr`).
    - `/remember` saves, and refuses with the reason.
    - `/forget` shows the entry and the button. The callback forgets and answers with the counts. A
      callback from another chat is ignored.
  - Done when: AC19 passes.

- [ ] **15. Embedder service**
  - Create: `tools/history/compose.yml`, `tools/history/embedder.env`, `tools/history/install.ts`,
    `tools/lib/env-file.ts` (move `parseEnvFile` here), `tests/history-embedder-service.test.ts`.
  - Modify: `tools/browser/install.ts` (import `parseEnvFile`), `tools/disk/defaults.json` (protect
    `^/var/backups/neo(/|$)` and the `neo-embedder` volume), `.gitignore`
    (`tools/history/embedder.local.env`).
  - Tests first:
    - The settings parser needs a digest-pinned image, a valid loopback port, and valid memory and CPU
      values.
    - The compose file binds `127.0.0.1` and sets `mem_limit` equal to `memswap_limit`, `cpus`,
      `cpu_shares: 256`, `cap_drop: [ALL]`, `no-new-privileges`, a TCP health check and the model volume.
    - `API_KEY: ${HISTORY_EMBEDDER_KEY:?…}` is under `environment`, never in `command`. No key value is in
      `tools/history/`.
    - The key writer adds `HISTORY_EMBEDDER_KEY=` once, keeps the other lines, sets mode 0600 and prints
      nothing.
    - The compose arguments (`-p neo-embedder`, the env-file order) and `--down`. The browser service tests
      stay green.
  - Build: at build time, pull the `cpu-1.9` image and copy its RepoDigest into `embedder.env`. Put the
    bge-m3 revision (a commit sha on the Hub) into `embedder.env`. `install.ts` gives the key to
    `docker compose` only in the environment of that child process. It waits for `/health` with the
    bearer key, does one test embed (1,024 dims), and prints the endpoint, the model and the caps.
  - Done when: AC20 passes.

- [ ] **16. Snapshot backup job (for `history.db`)**
  - Create: `src/engine/backup/cfg.ts`, `src/engine/backup/rotate.ts` (pure), `src/engine/backup/run.ts`
    (child entry), `src/engine/backup/drill.ts` (child entry), `src/engine/backup/schedule.ts` (the
    heartbeat step), `docs/backup.md` (the runbook), `tests/backup-rotate.test.ts`,
    `tests/backup-run.test.ts`, `tests/backup-schedule.test.ts`.
  - Modify: `src/config.ts`, `src/daemon.ts`.
  - Tests first:
    - UTC names format and parse. The rotation keeps the newest 8, then one each day for 7 days, then one
      each week for 4 weeks, and never touches other files.
    - `run.ts` on a temp WAL database while a writer writes: the snapshot passes `integrity_check`, and the
      gzip opens to the same counts. The manifest has its fields. The modes are 0600 and 0700.
    - Low free space (an injected `statfs`) gives exit 1. A corrupt copy (injected) gives exit 1 with a
      reason.
    - `drill.ts` restores and compares the counts. A mismatch fails.
    - The schedule: it runs once for each cron slot and one at a time. A timeout ends the child. A failure
      gives the event, one alert for each failure streak and the attention item. A success clears it.
    - The child gets paths as argv entries, and no shell.
  - Build: the default list is `[{ path: "data/history.db", cron: "41 3 * * *" }]`. The ledger is not in
    the list (ADR-0066, separate decision). The runbook says: before a restore, move the old file and its
    `-wal` and `-shm` files aside.
  - Done when: AC21 passes.

- [ ] **17. Attention items for history and backup**
  - Create: `tests/history-attention.test.ts`.
  - Modify: `src/engine/producers/engine.ts` (drafts from the newest `IndexReport` and the backup state),
    `src/engine/needs-you.ts` (`history_off` and `backup_failed` are needs-you, `history_degraded` is
    housekeeping), `src/engine/attention-facts.ts` (the facts for the reason text).
  - Tests first:
    - Each off reason gives `history_off` with the step to take.
    - `history_degraded` comes only after `degradedAlertMinutes`.
    - Each item resolves itself on recovery. The `backup_failed` cycle works.
    - The classes are right. The catalogue keys exist in both languages.
  - Done when: AC22 passes.

- [ ] **18. Admin CLI and eval harness**
  - Create: `tools/history/admin.ts` (`status`, `copy-ledger`, `backfill`, `forget`, `rescan-secrets`,
    `verify-clean`), `tools/history/eval.ts` (recall@5 and MRR), `tools/history/eval-set.json` (the schema
    and two sample rows, the real set comes in task 20), `tests/history-admin.test.ts`,
    `tests/history-eval.test.ts`.
  - Tests first:
    - `copy-ledger` opens the source read-only and uses `VACUUM INTO`. It refuses a target inside `data/`
      and a file that exists.
    - `backfill` needs a `--db` outside `data/`. With `--verify`, it uses the verify tag (`<tag>~verify`)
      and refuses to start when the collection holds points of another tag.
    - `verify-clean` deletes by the filter `m = <verify tag>` and then requires a count of 0.
    - `rescan-secrets` forgets each stored chunk that `findSecret` matches now.
    - The metric math on fixtures.
    - Each command goes through the engine code: no raw SQL, and no `curl` with the key.
  - Done when: these tests pass, and task 20 can run with these commands only.

- [ ] **19. Docs**
  - Modify: ADR-0066 (status "accepted (as built)" and an "As built" section with the measured numbers),
    `CONTEXT.md`, `docs/CONFIG.md`, `docs/HISTORY.md`, `HANDOFF.md`, `docs/tools/history-search.md`,
    `docs/backup.md`.
  - Create: `docs/history.md` (the operator guide: search tips, the modes, forget, the model-change
    procedure, the down states).
  - Done when: each doc matches the code.

- [ ] **20. Verify (live, before the merge)**
  1. Run `bunx tsc --noEmit` and `bun test` in the background. Both must be green.
  2. Run `bun tools/history/install.ts`. Record the memory of `neo-embedder` at idle and at its peak during
     step 5. Set `NEO_EMBEDDER_MEM` to the peak plus 25 %.
  3. Run `bun tools/history/admin.ts copy-ledger --to /home/neo-wt-history/tmp/ledger-copy.db`. Never use
     the live file.
  4. Use `neo_history` with the verify tag as the target. Reason: the key cannot create collections, and a
     `neo_history_verify` collection needs ops and a new key, so a daemon reload. `neo_history` stays
     unused until the restart, and `backfill --verify` refuses to start if another tag holds points.
  5. Run `admin.ts backfill --ledger tmp/ledger-copy.db --db tmp/history-verify.db --verify`. Record the
     chunks, the time, the chunks for each second, the CPU and the upload time.
  6. Write `tools/history/eval-set.json` from the copy: at least 20 queries (10 Arabic, 10 English), each
     with its expected refs. Include "the thing about bus seats not freeing up" and its Arabic form.
  7. Run `bun tools/history/eval.ts` for words only, meaning only and hybrid. Then run the same set with
     `Qwen/Qwen3-Embedding-0.6B` (a temporary second container on another port, with its own verify tag).
     Keep bge-m3 unless Qwen3 gains at least 5 points of recall@5 without more than 25 % more memory or
     time. Tune `minScore` and the list weights. Record all numbers.
  8. Run 50 queries. Record p50 and p95 for keyword-only and for hybrid (AC23).
  9. Down drills: stop `neo-embedder` (keyword-only, `embedder_down`), then start it (the waiting chunks
     are embedded). Use a test config with a wrong Qdrant port (`vectors_down`). Delete the verify-tag
     points (drift: a re-upload with zero embed calls).
  10. Run the console on a dev port on `127.0.0.1` against the verify store. Take screenshots at 360 px in
      Arabic and English: results, the mode banner, the empty state and the forget dialog.
  11. Run `admin.ts verify-clean`. Make sure that the verify-tag count is 0 and that `neo_history` is
      empty again. Delete the `tmp/` files.
  12. Ask the `planner` subagent for the final review against the spec. Run `requesting-code-review` and
      `/security-review` (new HTTP routes, tool inputs, a new Docker service, a shared-service client, file
      reads outside the repo, a child process).
  13. Write the numbers into ADR-0066 ("As built") and `HANDOFF.md`. Merge into `dev`.

---

## Operator steps

1. Approve this plan (the plan card).
2. After the merge into `dev`, run `bun tools/history/install.ts`. It pulls the embedder image and the
   model (about 2.3 GB) and writes `HISTORY_EMBEDDER_KEY` into `.env`.
3. Restart the daemon (your permission). Ledger migration v17 runs after its `.bak-v16` copy. Then the
   backfill starts by itself, and meaning search reports partial coverage for some hours. If you restart
   before step 2, search is keyword-only, and the `history_off` item names step 2.
4. Decide the ledger backup (ADR-0066, a separate decision). Option A is recommended.

## Ops notes (information, nothing blocks)

1. `neo_history` will hold about 25,000 to 35,000 points (about 120 MB of float32 vectors).
   `shared-qdrant` has a 1 GiB memory limit and used 179 MiB on 2026-10-29. Ops can choose int8 scalar
   quantization or on-disk vectors for the collection. Neo makes its four payload indexes itself.
2. Neo will write snapshots to `/var/backups/neo` (root, 0700). Please list the folder in the backup
   inventory and include it in any off-host copy.
3. Only for a later model with other dimensions: Neo will ask for a new `neo_*` collection and a new key.
4. When ops rotates the Qdrant secret (ops plan, Task 8), tell the operator. The daemon must reload to read
   the new key. Keyword search continues until then.
