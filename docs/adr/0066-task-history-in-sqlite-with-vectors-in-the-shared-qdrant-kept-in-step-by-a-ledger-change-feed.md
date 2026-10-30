# Task history: SQLite holds the text and the word index, the shared Qdrant holds only vectors, and a ledger change feed keeps them in step

**Status:** accepted (as built, 2026-10-30). Built on the branch `feat/history-search` (plan tasks 1–18).
The section "As built" at the end lists each change that the code made to this ADR and the spec. The live
verify step (plan task 20) fills in the measured numbers. Revision 1 chose sqlite-vec.
Revision 2 followed the operator ruling in note #500. Revision 3 decides each store again with facts
measured on 2026-10-29, adds the sync design, and proposes a ledger backup as a separate operator decision.
The ops consumer guide exists (`agent/desks/ops/shared-infra/CONSUMERS.md`). Related: ADR-0020 (project memory), ADR-0024 (security), ADR-0032 (shared Docker services), ADR-0043
(secret shapes), ADR-0062 (secrets through env), ADR-0065 (attention classes), the customer firewall.

## Context

Operator order (2026-10-29): Neo needs a searchable long-term memory of every task. Finding past work must
not depend on the recall of an AI. Search must work by meaning ("the thing about bus seats not freeing
up"), in Arabic and English, and by exact ids (todo #, sha, PNR). Every hit must cite its source.

Facts checked on 2026-10-29 (read-only):

- **Shared Qdrant** v1.19.0 (`shared-qdrant`, 127.0.0.1:6333, memory limit 1 GiB, 179 MiB in use)
  answers Neo's key. `GET /collections` lists only `neo_history`: green, 0 points, 1,024 dims, cosine,
  payload on disk, no payload indexes. The key is an HS256 JWT with one claim,
  `access: [{collection: "neo_history", access: "rw"}]`, and no expiry. Other collections, and
  `neo_history_verify`, answer 403. The ops tests (ops plan, Task 1, done) show that the key can upsert
  points and create payload indexes, and cannot create collections. A new collection needs an ops request
  and changes the key, and the daemon must then reload (operator permission). Ops takes a Qdrant snapshot
  every day, keeps 7, and passed a restore drill.
- **Shared Postgres** 18.6 has pgvector 0.8.7 and pg_trgm. Neo has no role and no database there. The ops
  guide gives Neo "Qdrant only".
- **Shared Meilisearch** v1.33.0 runs. Neo has no key.
- **The ledger** (`data/ledger.db`, 398 MB plus a 169 MB WAL) holds about 598,000 messages. About 586,000
  of them are streamed worker lines. The task-level text is small:
  - 2,527 dispatched orders (13 MB). Most of this text is the standing preamble and the codebase-memory
    block that the engine adds to each brief.
  - 928 todos, 1,792 done outcomes (6 MB), 1,643 digests, 418 plans, 517 attention items, 965 decisions
    and 5,905 operator messages.
  - In total, about 15,000 to 25,000 chunks.
- **What the ledger deletes.** Only retention deletes rows. It deletes done and cancelled todos past the
  newest 1,000 (924 exist now), resolved attention items after `keepResolvedDays` (30 days, notes 180
  days) and closed decisions past the newest 5,000. It also deletes events, tool actions, routes and
  delivered inbox rows. It never deletes messages, orders, outcomes, plans or threads.
- **Customer work is not marked by `orders.source`.** The customer path records its orders with
  `source: "neo"` and the chat `-3` (`CUSTOMER_CHAT`, `ingress.ts`). The ledger holds 16 such orders (inbox
  drafts, the newest from today). No order has `source: "customer"`.
- **Results.** Result and digest messages have no `order_id`. The result of an order is
  `outcomes.summary`.
- **Arabic in FTS5.** The `unicode61` tokenizer, also with `remove_diacritics 2`, cuts an Arabic word at
  each haraka: `المَقاعِدُ` gives the tokens `الم`, `قاع` and `د`. A word with a prefix (`والمقاعد`) does
  not match `المقاعد` or `مقاعد`. Arabic-Indic digits do not match ASCII digits. Measured with Bun 1.3.11
  (SQLite 3.51.2). The ledger's `messages_fts` has this fault today.
- **No backup routine.** No Neo SQLite file has a routine backup. `migrate()` writes one `.bak-v<N>` copy
  before a migration. Eleven one-off ledger copies (3.1 GB) are in `data/`. The ledger file has mode 0644
  in a 0755 folder, so each local account can read it.
- **Host.** 31 GB RAM, 16 GB available, 7 GB of 15 GB swap in use, 8 CPUs, 78 GB disk free (81 % used).

## Operator rulings

- Note #498 (2026-10-29): use a richer service when it is up, and fall back to SQLite when it is not. In
  the operator's words: "Neo is smart: whenever they're ready we use them." Any outside index is a
  derived copy that Neo can build again.
- Note #500 (2026-10-29): "we want to use the same DB Dockers; we change their settings to be fully shared
  by other projects." Keep: the SQLite ledger as the source of truth, an FTS fallback when the shared
  service is down, re-sync on recovery, a local bge-m3 embedder, no customer text, no secrets.

## Decision

### 1. Vectors go to the shared Qdrant, collection `neo_history`

| | Shared Qdrant | Shared Postgres + pgvector |
|---|---|---|
| Correctness | Filter-aware HNSW on payload indexes, exact scan below the full-scan threshold. | HNSW or exact scan. pgvector 0.8 iterative scans prevent short filtered results. |
| Scale | Built for nearest-neighbour search. 30,000 × 1,024 dims is small. | Also fine at 30,000 rows. |
| Words and vectors in one store | No. Not necessary: the words stay local (Decision 2). | Possible, but the words must stay local for the down state, so the gain is lost. |
| Operations | Provisioned and checked today: key, collection, access rules. A new collection needs ops and a new key. | Not provisioned. Needs a role, a database, credentials, a reload and a second migration system in Neo. |
| Backup | Ops snapshot every day, newest 7, drill passed. Neo can also refill it from `history.db`. | Ops `pg_dump` every day, newest 7. Equal. |
| Security | JWT limited to `neo_history` by name. Checked: other names give 403. | Own role and database, not superuser. Equal. |
| Client | HTTP with `fetch`. No new package. | `Bun.sql` is built in. Equal. |

Qdrant is the choice. It is ready today and it is the purpose-built engine. The one strong point of
Postgres (words and vectors in one transaction) does not apply, because the word index must stay in
process. Postgres becomes the better choice only if model changes become frequent: in Qdrant each new
vector size needs an ops collection and a new key.

### 2. Words (keyword search) stay in SQLite FTS5, in `data/history.db`

| | Shared Meilisearch | Shared Postgres FTS | SQLite FTS5 in `history.db` |
|---|---|---|---|
| Answers when the shared services are down | No | No | Yes, in process |
| Credentials that Neo has | None (guide: no Meili) | None | None needed |
| Arabic | Article (ال) split, harakat removal, digit folding, typo tolerance | Snowball `arabic` stemmer, one language for each `tsvector` | `unicode61` breaks words at harakat (measured). Neo's normalizer and light stemmer correct this before indexing. |
| Same ranking when a service is down | No: the fallback ranks differently | No | Yes, one ranking |
| Text leaves Neo | Yes, the full text | Yes, the full text | No |

SQLite FTS5 is the choice. Neo normalizes Arabic itself (`normalize.ts`) and adds Arabic light stems
(`arabic-stem.ts`, the Light10 rules that Lucene's Arabic stemmer uses). English gets the FTS5 `porter`
tokenizer. A shared keyword service needs the full text of Neo's briefs, but the shared services must
hold only vectors.

### 3. The index unit is a task-level source row

A source row is cut into chunks of about 1,200 characters with 150 characters of overlap. The sources:

- **todo** (`project_todos`): the brief, without the engine's boilerplate. Title: `todoLabel`.
- **order** (`orders` on the dispatch and side-lane chats, only when the order has no todo): the task text
  without the engine's boilerplate. Orders on operator chats repeat the operator's message, so they are
  not a source.
- **result** (`outcomes`): the summary of each order that ended `done`, `error` or `failed`. The
  `interrupted` rows are bookkeeping and are skipped.
- **digest** and **message** (`messages`): progress digests and the operator's own lines.
- **plan** (`plans`): the title and the text of the plan file.
- **note** (attention items of source `note`): title, body, refs, answer and resolution.
- **attention** (attention items of source `github` and `git`): the plain title and its facts. Engine,
  restart and skillify items restate rows that history already holds, so they are not a source.
- **decision** (`decisions`): the question, the card's context and options, and the answer.
- **remembered**: explicit "remember this" entries, stored only in `history.db`.

The 586,000 streamed worker lines stay in the ledger's `messages_fts`. Search reads them as one more
keyword list ("lines"). They are not embedded.

### 4. Sync: a ledger change feed

1. **Change feed.** Ledger migration v17 adds the table `history_feed (id, tbl, key, op, at)`. AFTER
   INSERT, UPDATE and DELETE triggers on the source tables write one row for each change. A trigger has no
   constraint that can fail. The `messages` trigger fires only for operator lines and digests (a `WHEN`
   clause), so the streamed-line path does not change. The `attention_items` triggers fire only for the
   indexed sources and only for text columns, so `last_seen` updates make no rows. The indexer reads the
   feed in id order from its own cursor (stored in `history.db`). It never writes to the ledger. A daemon
   step keeps the newest `history.feedKeep` rows (default 200,000).
2. **Backfill and reconcile are one path.** The path walks each source table in key order and extracts
   each row. It compares a hash of the extract with `history.db` and indexes the rows that changed. It runs
   at the first start (the backfill), when the feed has a gap (rows pruned before the indexer read them),
   and once a week as a safety net. The weekly run also deletes Qdrant points that `history.db` does not
   know (orphans).
3. **Updates.** An update extracts the row again. A chunk with the same text hash keeps its vector and its
   Qdrant point. A changed chunk gets a new vector, or a stored vector with the same text hash, and the
   same point id is overwritten. Chunks past the new end are deleted in `history.db` and in Qdrant.
4. **Deletes: history is the archive.** The ledger deletes rows only by retention. History keeps those
   entries, marks them archived (`gone_at`), and keeps them searchable. A hit on such an entry says that
   the ledger no longer has the row. History exists to answer "what did we do" after the ledger forgets.
   Retention exists only to keep the hot ledger tables small. History removes an entry in three cases
   only:
   - The operator uses `forget`. A tombstone then stops a reconcile from adding the entry again.
   - The firewall verdict changes to "excluded". The firewall wins over the archive.
   - The config turns the source kind off.
5. **Point ids.** A point id is a UUID made from SHA-256 of `model tag + ref + chunk seq`. The same chunk
   gets the same id on each run, so an upsert is idempotent and a re-upload overwrites, never duplicates.
6. **Model and dimension changes.** Each vector carries a model tag: model id, dimensions and revision.
   The code derives the tag, so nobody types it. The tag is part of the local key (`vectors`), part of the
   point id, and the payload field `m`. A query filters on the active tag, so search never mixes models.
   To change the model, the operator sets `history.next`. The indexer then embeds all text with the next
   model as well (a second embedder container, only during the change) and uploads its points. At full
   coverage, the operator makes it the active model (config and reload). The old points and vectors are
   deleted after `retireAfterDays`. A model with other dimensions needs a new collection, which ops makes
   on request with a new key.
7. **Collection loss and drift.** Each indexer pass reads the collection info and the exact count of
   active-tag points, and compares the count with the upload marks in `history.db`. If the collection is
   empty or much smaller, the indexer clears the marks for the tag and uploads the stored vectors again.
   It does not embed again. It also creates the payload indexes again. If the collection is missing or
   the key is refused, meaning search is off and an attention item asks the operator to act.
8. **When a service is down.** The engine never stops, and search always answers from `history.db`.

   | State | Indexing | Search |
   |---|---|---|
   | Embedder down, slow, or the wrong model | Chunks are stored and keyword-searchable. They wait for a vector. | Keyword only. The reply says why. |
   | Qdrant down or the key refused | Vectors are made and kept in `history.db`. Uploads wait. | Keyword only. The reply says why. |
   | Both down | Chunks are stored. | Keyword only. |
   | Backfill not complete | As normal. | Meaning search covers part. The reply gives the coverage. |

   On recovery, the indexer embeds the waiting chunks and uploads the waiting vectors in bounded batches.
   Nothing is lost, because each chunk is written to `history.db` first.
9. **Credentials and addresses, enforced in code.**
   - The Qdrant URL and key come only from `SHARED_QDRANT_URL` and `SHARED_QDRANT_API_KEY` through the
     engine's env loader. The embedder key comes from `HISTORY_EMBEDDER_KEY`. No key goes into a log, an
     event, argv or a tracked file.
   - Both URLs must be loopback (`127.0.0.1`, `::1`, `localhost`). The engine refuses other hosts.
   - The collection must start with `neo_` and be in `history.vectors.allowedCollections` (default
     `["neo_history"]`). The engine refuses other names.
   - The key must be a JWT whose `access` claim names only allowed collections. The engine refuses a plain
     API key and a global `access` value. Neo never needs an admin key.
   - Qdrant receives only the vector and the payload fields `project`, `kind`, `at` and `m`. The request
     builder refuses any other field and any long string. Neo creates the payload indexes on its own
     collection: `project`, `kind` and `m` (keyword), `at` (integer, range).

### 5. A local embedder in Docker

text-embeddings-inference (TEI, the `cpu-1.9` line, pinned by digest) serves `BAAI/bge-m3` (1,024 dims,
8,192-token context, strong Arabic retrieval) at a pinned revision. It listens on `127.0.0.1:8088`. The
API key reaches the container through `API_KEY` in its environment, never argv. Limits: 4 GB memory (the
verify step tunes it), 3 CPUs, low CPU shares, so a backfill does not slow the host. The adapter reads
`/info` and refuses vectors from a model id or revision that the config does not name. No text goes to a
hosted embedding API. The verify step compares bge-m3 with `Qwen/Qwen3-Embedding-0.6B` (also 1,024 dims,
also served by TEI) on an Arabic and English eval set. bge-m3 stays the default unless the eval shows a
clear gain.

### 6. Hybrid search, one seam

`TaskHistory` (`src/engine/history/`) has four methods: `search`, `remember`, `indexTick` and `forget`
(and `close` for the lifecycle). Search runs up to four lists and fuses them with reciprocal rank fusion
(k = 60):

- **exact**: ids in the query (`#884`, a sha, a decision id, a PNR-like code). These hits rank first.
- **meaning**: Qdrant nearest neighbours for the active tag, with the filters.
- **words**: FTS5 in `history.db` (bm25), normalized and stemmed.
- **lines**: the ledger's `messages_fts`, worker lines only, with the firewall filters.

The filters (project, since, until, kinds) apply in each list before fusion. Hits with the same text
collapse into one hit that names the other refs. Each hit cites its ref, kind, project, date, title, the
todo and order, the thread, the commits it names and the plan path. Each reply states the mode: meaning
on, partial (with coverage), off (with the reason), or skipped (a query that is only ids makes no embed
call).

### 7. The firewall holds, fail closed

- An order is excluded when its chat is `-3`, its `source` is not `neo`, or its thread started from
  `ingress`. It is also excluded when an ancestor order (by `parent_order_id`, up to 8 levels) is
  excluded or missing.
- Outcomes, todos, plans and decisions follow their order. A todo without an order and without a thread
  waits until it has one of them.
- A message is excluded when its chat is `-3` or its thread started from `ingress`. Engine-written user
  lines (`surface = 'engine'`) are not operator text and are not a source.
- The inbox database is never opened by the history code. Tainted briefs are chat `-3` orders.
- A row that the rules cannot classify is skipped and counted.
- A chunk that matches a secret shape (`findSecret`, ADR-0043) is not stored. The pass counts it, and an
  event names the ref and the pattern, never the text.
- Prompt-injection phrases and `<system-reminder` tags are made harmless in stored text. The worker tool
  shows hits as quoted data, not as instructions.

### 8. `history.db` gets a snapshot backup

`history.db` holds two things that exist nowhere else: archived rows and remembered entries. A Neo
snapshot job copies it once a day: `VACUUM INTO` from a read-only connection in a child process, so the
daemon's event loop never waits. The job checks the copy (`PRAGMA integrity_check`), compresses it, writes
a manifest (SHA-256, sizes, row counts), keeps a rotation (newest 8, then one each day for 7 days, then one
each week for 4 weeks) and runs a restore drill each week. A failure alerts the operator. The folder is
`/var/backups/neo` (mode 0700). The disk-cleanup kit protects this folder. The same job can take the
ledger: that is the separate decision below.

## Separate operator decision: the ledger backup (proposal only, no change in this plan)

| Option | What it gives | Cost and risk |
|---|---|---|
| **A. Snapshot job (recommended)** | Add `data/ledger.db`, `admin.db`, `inbox.db` and `trust.db` to the job of Decision 8, every 6 hours for the ledger. Restore point at most 6 hours old. | One config change. Each ledger run reads about 400 MB and writes one compressed copy (its size is measured on the first run), in a child process. |
| B. Litestream sidecar | Continuous WAL copy, restore point about 1 second old, restore to a point in time. | The Litestream tips tell a high-write app to turn its WAL autocheckpoint off. Then the ledger's WAL size depends on a sidecar. Its replica sits on the same disk. |
| C. Move the ledger to shared Postgres | Ops `pg_dump` every day. | `ledger.ts` is 2,431 lines of synchronous bun:sqlite behind a synchronous `Ledger` interface. A Postgres client is asynchronous, so every caller changes. The SQL uses SQLite-only features (FTS5, `INSERT OR REPLACE`, rowid pages, triggers). The tests use in-memory SQLite. The engine stops when Postgres stops. The backup gain is zero: also one copy each day. |

Recommendation: **A**. Also set mode 0600 on the data files and 0700 on `data/`, and delete the one-off
`.bak-*` copies after two restore drills pass. B becomes the right upgrade when the operator approves an
off-host target (S3-compatible, for example Cloudflare R2). That is an outside service and a cost, so it
is a further decision. The backup folder is `/var/backups/neo`, beside the ops folder
`/var/backups/shared-infra`. A project note asks ops to list it and to include it in any off-host copy.

## Alternatives rejected

- **sqlite-vec in a Neo-only file** (revision 1, measured: KNN over 30,000 × 1,024 dims in 47 ms).
  Overruled by note #500: one shared vector service for all projects. A second vector path beside Qdrant
  is two implementations of one job.
- **Shared Postgres + pgvector for vectors.** See Decision 1: not provisioned, a second migration system,
  and its main gain does not apply.
- **Shared Meilisearch or Postgres FTS for words.** See Decision 2: no answer when down, no credentials,
  a second ranking, and the full text in a shared service.
- **Meilisearch hybrid mode as the whole search.** Same reasons. Meilisearch also cannot host a model, so
  it calls the same embedder.
- **Qdrant sparse vectors or its server-side BM25 for the word half.** The word index must answer when
  Qdrant is down. Server-side BM25 also needs the text in the request.
- **History tables inside `ledger.db`.** The ledger is the hot path of the engine. A separate file can be
  rebuilt, backed up and restored on its own.
- **Polling with watermarks instead of a change feed.** `project_todos` has no `updated_at`, the
  `last_seen` of an attention item changes on each scan, and polling cannot see deletes. The feed is exact.
- **Mirror the ledger's deletes.** Then retention erases the history that the operator wants to keep.
- **Vectors only in Qdrant, no local copy.** Then a lost collection needs a full new embed (CPU hours).
  The local copy (4 KB for each chunk) makes recovery an upload.
- **Chunk text in the Qdrant payload.** It copies Neo's briefs into a service that other projects share.
  Hits read their text from `history.db` by point id.
- **A second collection for the verify step (`neo_history_verify`).** It needs ops and a new key, so a
  daemon reload. The verify step uses `neo_history` with a separate model tag and deletes those points.
- **The embedding model inside the daemon** (transformers.js, ONNX in Bun). CPU-heavy work and 2+ GB of
  memory in the engine process, and native-addon risk. A capped container isolates both.
- **Ollama for bge-m3.** No API key on its HTTP port, and a general model runtime is more surface than an
  embedding server.
- **A hosted embedding API.** It sends project and operator text to a third party.
- **`multilingual-e5-small` or `-base`.** Lighter, but weaker Arabic retrieval. A config option if memory
  gets tight.
- **Embedding the 586,000 streamed lines.** Hours of CPU, gigabytes of vectors, and worse results. The
  existing keyword index covers them.
- **Keyword search only.** It cannot find "bus seats not freeing up" when the work said "capacity is not
  released on cancellation".

## Consequences

- Neo uses the shared Qdrant for meaning search only, never for keyword search. Neo adds one container
  (the embedder, at most 4 GB under its cap) and one data file with a snapshot backup.
- Ledger migration v17 adds the change feed and its triggers. It runs at the next daemon start, after the
  automatic `.bak-v16` copy. The indexer, the backfill and the worker tools start with that restart.
- `neo_history` will hold about 25,000 to 35,000 points (about 120 MB of float32 vectors). The memory
  limit of `shared-qdrant` is 1 GiB. Ops can choose int8 scalar quantization or on-disk vectors for the
  collection.
- A vector is not plain text, but it is not secret-proof: published attacks can rebuild part of a text
  from its embedding. Only Neo's key and the ops admin key can read the collection.
- A key rotation by ops (ops plan, Task 8) turns meaning search off until the daemon reloads. Keyword
  search continues.
- The first backfill embeds about 15,000 to 25,000 chunks on CPU. It takes hours. Meaning search reports
  partial coverage until it is complete.

## As built (2026-10-30)

The code follows the decisions above. These are the changes that the build made, read from the code and
the commit messages of plan tasks 1–18 (`eea1bad..7b7f52d` on `feat/history-search`). The operator guide
is `docs/history.md`. The config reference is `docs/CONFIG.md` ("Task history", "Snapshot backup").

### Changes to the decisions

- **Consult runs: the questions and answers are indexed, the runs are not.** A consult question and its
  answer live on a project note (an `attention_items` row with source `note`), and every note is a `note:`
  entry: title, body, refs, the answer and the resolution (`sources.ts`, no firewall step, because a note is
  operator or worker text). The consult run itself records its order on `CONSULT_CHAT`, which equals
  `CUSTOMER_CHAT` (`-3`): the firewall excludes that order, its descendants and their results, and the
  worker-lines list leaves out chat `-3`, so the run's own brief, result and streamed lines are not
  indexed. A consult run can use `history_search`. It does not get `remember`.
- **`forget` of a remembered entry (`mem:N`) keeps no tombstone.** A remembered entry exists only in
  `history.db`, so the code deletes its row and nothing can add it again. Only a ledger-backed ref gets a
  tombstone. A `line:` ref (a ledger worker line) cannot be forgotten: it is not stored in the history.
- **The seam has a fifth method, `status()`.** The admin command and the attention producer read it: the
  newest pass, the two service states, the coverage of each model tag, the queued point deletes and the
  writer lock.
- **A writer lock in `history.db`.** One process at a time indexes. A lock older than
  `store.lockStaleMs` (3 minutes, three heartbeats) can be taken over. A pass that finds the lock held by
  another process does nothing (`locked`).
- **Backfill pacing.** When a pass leaves work that can go on now, the next pass starts after
  `indexer.busyPauseMs` (200 ms), not at the next heartbeat. "Can go on" means feed rows or a reconcile;
  embeds only while the embedder is up; uploads and deletes only while Qdrant is up. A pass that moved
  nothing, or found the lock held, starts no follow-up. New bounds for one pass: `indexer.reconcileRows`,
  `indexer.embedBatchesPerPass` and `indexer.uploadBatchesPerPass`.
- **A corrupt `history.db` is moved aside.** At start, the daemon renames it (and its `-wal` and `-shm`
  files) to `history.db.corrupt-<UTC time>` and sends one alert. A stand-in seam then answers
  `history_unavailable` on every surface until a snapshot is restored and the daemon reloads. The engine
  keeps running.
- **`rescan-secrets` forgets whole entries.** The admin command walks every stored chunk and title with
  today's secret finder. For each entry with a match, it forgets the whole entry (all its chunks and
  points), not only the chunk. It also drops each stored commit that the kept chunks and the title no
  longer give. The reason names the pattern, never the text. `--dry-run` only lists the refs.
- **The embedder container runs as the image's default user (root).** The named volume
  `neo-embedder-models` is created owned by root, and TEI writes the model download into it. The
  container has `cap_drop: [ALL]`, `no-new-privileges`, a pids limit, memory and CPU caps, and a port on
  `127.0.0.1` only. A non-root user is a later hardening step (a pre-owned volume).
- **The embedder health check is a TCP connect.** `/health` needs the bearer key, and the key must not be
  in a health-check command. `install.ts` checks `/health`, `/info` and one test embed with the key.
- **Pinned versions.** TEI `cpu-1.9` resolved to `cpu-1.9.4`, pinned by digest in
  `tools/history/embedder.env`. `BAAI/bge-m3` is pinned at Hub commit `5617a9f61b02…`. The engine default
  `history.embedder.revision` names the same commit, and a test checks that the two match.
- **Model retirement with other dimensions.** The indexer deletes an old tag's points from the active
  collection. When the new model has other dimensions (a new collection), the old collection keeps its
  points. Ask ops to delete the old collection after the change.
- **Telegram `/forget` reason.** The console needs a reason. In Telegram the reason is optional. With no
  reason, the code records "forgotten by the operator in Telegram" (or "in the console" from the console
  chat box). Nothing is removed until the operator taps the Forget button.
- **The console chat box also takes `/find`, `/remember` and `/forget`.** It shares the rate-limit
  session `console` with the History tab. `/forget` there shows the entry and links it in the History tab.
- **Attention items.** `history_off` (needs you) names the operator step from the config names.
  `history_degraded` (housekeeping) appears only after `degradedAlertMinutes`. `backup_failed` (needs you)
  names the job's path and code. Each resolves itself on recovery. After a restart, open items are kept
  until the first pass reports.
- **Change-feed prune.** The prune runs at most once an hour. It also runs when `history.enabled` is
  `false`, so the feed never grows without a limit.
- **Ledger fix in migration v17.** `endInterruptedOrders` now counts the `RETURNING` rows. With the feed
  triggers, `bun:sqlite`'s `.changes` also counts the rows that the triggers write.
- **More search and embedder tunables.** `search.exactBoost`, `search.maxQueryChars` (500, a longer query
  is refused, not cut), `search.maxTerms` (12) and `search.fullCoverage` (0.99, below it the mode is
  `partial`); `embedder.backoffMs` and `embedder.backoffMaxMs` (429 and 503 back-off, `Retry-After` wins).
- **The vector-index guards are stricter than the request rule.** A payload string over 64 characters, a
  wrong vector length or a non-UUID point id is refused before the request. The JWT payload is decoded to
  check the `access` claim, never verified and never printed.
- **The dispatch preamble.** One sentence for `history_search` ("Done before? `history_search` first.").
  The build (e3ca3e0) made room by dropping "highest effort" from the planner rule and "background" from
  "(background Bash". Both are operator standing rules, so the review restored them word for word and
  took the room from neutral wording ("Neo sends it", "rejected options", "via", "docs this task touches").
  The preamble with the longest codebase-memory line is 4,992 characters (limit 5,000).
- **Shared code, not copies.** `cronDueBetween` moved to `trigger.ts`. `fileStamp` lives in
  `backup/rotate.ts`. `parseEnvFile` moved to `tools/lib/env-file.ts` (the browser kit uses it too).
  `vacuumCopy` (the snapshot's read-only copy) is also the admin `copy-ledger`. The reserved chat ids moved
  to the leaf module `chats.ts`.
- **Backup failure codes.** Besides the codes in `docs/backup.md`, a child can fail with `error`,
  `child_failed`, `spawn_failed` or `bad_args`.
- **Admin and eval tools.** `tools/history/admin.ts` (`status`, `copy-ledger`, `backfill`, `verify-clean`,
  `forget`, `rescan-secrets`) and `tools/history/eval.ts` (recall@k, MRR, p50 and p95 for words only,
  meaning only and hybrid). `backfill --verify` uploads under the tag `<tag>~verify` and refuses a
  collection that holds points of another tag.

### Review fixes (2026-10-30)

Two reviews of `feat/history-search` and the live verify found these; each has a test.

- **Point ids are derived** as Decision 4.5 says, as a UUID v5 (RFC 4122 name-based, SHA-1 as the RFC
  requires; not a security use) of model tag, ref and chunk seq, not SHA-256. Ids stored before this are
  moved by a saved walk (`points.rederived`): the point gets its derived id and is sent again, and the old
  id is queued for deletion.
- **Commits come only from kept text.** A sha-shaped value on a line the secret finder matches (a hex key
  in `token: …`), or in a chunk dropped for a secret, is never a commit.
- **Worker lines follow the same rules as entries:** a line with a secret shape is left out, an injection
  phrase in the snippet or title is quoted, and the line's thread and order lineage go through the firewall.
- **Customer-driven briefs in a live session (rule `customer_delivery`).** Dispatch may deliver a
  customer-driven brief into an operator's live session. The history tools refuse in a session marked
  customer-driven, and the firewall excludes a run's result, and the plans of that run, when an order it
  excludes was made for the same folder while the run was live. Not covered by a ledger fact: plans with
  only a thread, and the output of an operator-opened session. The full fix is a dispatch policy (never
  deliver a customer-driven brief into a session that is not fenced for it), left to the operator.
- **Payloads stay fresh.** A change of an entry's `at`, project or kind sends its kept points again (no
  new embed).
- **The weekly sweep re-sends lost points.** After the orphan pass it asks Qdrant which uploaded points it
  holds (`POST /points` by id) and sends the missing ones again, also above the drift ratio.
- **Forget holds for the whole work.** Forgetting a todo, its order or its result tombstones all three; a
  tombstone spreads to the rest of the same work when the indexer meets it (a todo pruned by retention no
  longer comes back as its order).
- **Boilerplate recount.** The first and the weekly reconcile count paragraphs into `boilerplate_next`
  (`history.db` v2, additive), which replaces the counts when the count ends. A feed gap before the first
  reconcile ends restarts the first one, so no row is counted twice.
- **Backup folder and leftovers.** An existing `backup.dir` is used only when it holds nothing but backup
  files (`dir_not_dedicated` otherwise, and its mode is never changed). The schedule deletes a killed
  child's temp files before each child.
- **`install.ts`** gives `docker compose` the validated settings in its environment and no env file.
- **Bounds.** The `remember` window drops ended sessions; a project name over 128 characters (or with a
  slash or control character) is refused by the seam; worker `history_search` is limited per session
  (`search.perSessionMinute`, 30).
- **Explicit services.** The daemon hands the attention producer the two service states, not the pass
  report.
- **A search never waits behind an embed batch.** The query is embedded only when the meaning list is used
  (not with meaning weight 0, not for lines only, not with the shared index off). While the indexer has an
  embed request in flight, a search answers at once without meaning search (`off: embedder_busy`).
- **Console in Arabic.** A hit date is digits only (`YYYY-MM-DD`) in its LTR isolate; the forget dialog
  isolates the title and the ref.
- **Verify fix: a rejected key is not a missing collection.** A 401/403 on the collection info asks the
  collection list: a list that refuses the key too, or names the collection, gives `vectors_key_rejected`
  ("ask ops to reissue the key, then reload"); a 404, or a list without it, gives `collection_missing`.
- **Verify fix: the writer lock lives through a long pass.** A pass renews the lock before each write
  and each outside call (not only at its start), so a 4–6 minute pass keeps it under `lockStaleMs`
  (180 s); after a long wait it writes only if it still holds the lock, else it stops (`locked`).
- **Verify fix: the embed batch adapts to a slow host.** A timed-out batch is halved (down to one chunk)
  and its first chunks sent again, never the same batch twice; after `indexer.embedGrowAfter` (4)
  successes in a row it doubles back toward `embedder.batch`.

### Measured (filled by the verify step)

Plan task 20 writes these numbers. Until then they are open.

- Embedder memory at idle and at peak; the final `NEO_EMBEDDER_MEM` (peak + 25 %): TODO
- Backfill of the ledger copy: chunks, total time, chunks per second, CPU, upload time: TODO
- Eval, bge-m3: recall@5 and MRR for words only, meaning only and hybrid (Arabic and English): TODO
- Eval, `Qwen/Qwen3-Embedding-0.6B` on the same set, and the model kept: TODO
- Tuned `vectors.minScore` and `search.weights`: TODO
- Query latency p50 and p95, keyword-only and hybrid (50 queries): TODO
- Down drills (`embedder_down`, `vectors_down`, drift re-upload with zero embed calls): TODO
- Points in `neo_history` after the first live backfill: TODO
