# Task history: hybrid search on the host's shared Qdrant, with SQLite as source of truth and fallback

**Status:** proposed, revised by operator ruling (2026-10-29, note #500); plan awaiting approval; wiring
waits for ops' shared-services consumer guide (ops todo #914). Related: ADR-0020 (project memory),
ADR-0032 (shared Docker services), ADR-0024 (security), ADR-0062 (secrets through env), the customer
firewall.

## Context

Operator order (2026-10-29): Neo needs a searchable long-term memory of every task, so finding past work
does not depend on an AI's recall. Search must work by meaning ("the thing about bus seats not freeing
up"), not only exact words, in Arabic and English, and by exact ids (todo #, sha, PNR).

Measured on this host (2026-10-29, read-only):

- **Ledger volume.** 597,000 messages, but about 585,000 are streamed worker lines (`text` and `progress`,
  about 160 MB). The task-level text is small: 2,966 orders, 913 todos, about 1,400 results,
  1,636 digests, 416 plans, 497 attention items and notes, 5,888 operator messages. That is roughly 15,000
  to 30,000 chunks.
- **Existing search.** `messages_fts` (FTS5, unicode61) indexes every message; `searchMessages` uses it.
  Neo memory (`memory-recall.ts`) is a per-folder FTS index over daily logs, off by default.
- **Host.** 32 GB RAM, 17 GB available, 8 GB of swap already in use, 8 CPUs. Disk 97 GB free.
- **Search services on the host** (`docker ps`): `adminli-ai-qdrant` (127.0.0.1:6333, `qdrant/qdrant:latest`)
  and `eticket-meilisearch` (v1.33, internal port), each owned by one project today. No embedding service
  runs (no TEI, Ollama or Infinity).

## Operator ruling (2026-10-29, note #500)

> "We want to use the same DB Dockers; we change their settings to be fully shared by other projects."

The first version of this ADR rejected borrowing adminli's Qdrant or eticket's Meilisearch (lifecycle
coupling, credentials owned by another project, data isolation on a public host) and chose sqlite-vec in
a Neo-only file. The operator overruled that: ops is converting the Qdrant and Meilisearch containers into
**ops-owned shared infrastructure** (ops todo #914): an ops-owned compose file, a shared network,
per-project scoped keys and daily backups. That conversion is what answers the three concerns, so this ADR
now depends on it (preconditions below).

## Decision

1. **The index unit is a task, not a streamed line.** Sources: orders (brief), todos (summary), final
   results and progress digests, plans (row + plan file text), attention items and project notes,
   operator messages, remembered entries. Each is cut into chunks (about 1,200 characters, 150 overlap)
   with its source ref, project, kind and date; commit shas found in the text are stored as facts. The
   585,000 streamed lines stay in `messages_fts`, which the search reuses as one more keyword list.
2. **SQLite is the source of truth and the always-on search.** `data/history.db` (beside the ledger, never
   inside it) holds every chunk, its FTS5 index (unicode61, diacritics removed), the chunk's vector as a
   plain blob, the per-source watermarks and the remembered entries. It keeps entries after the ledger
   prunes its rows, so it gets a daily on-host snapshot (`VACUUM INTO`, newest N kept). Keyword search
   always answers from here, whatever the shared services do.
3. **Vectors live in the shared Qdrant**, in Neo's own collection (`neo_history`, cosine, 1,024 dims; payload
   `project`, `kind`, `at`, `ref` with payload indexes for the filters), reached with Neo's own scoped JWT
   key that can touch only `neo_*` collections. Qdrant is a **derived, rebuildable copy**: each chunk in
   `history.db` records whether its vector is in Qdrant; a lost or recreated collection is rebuilt by
   uploading the stored vectors again (no re-embedding).
4. **Meilisearch is not used for now.** Keyword search must keep working when the shared services are down,
   so it stays in SQLite FTS5; Neo's fusion (below) then ranks the same way in both states. Meilisearch's
   own hybrid mode would duplicate the keyword half with a different ranking, and it cannot host a model —
   it would call the same embedder. It stays an option behind the same `VectorIndex`/search seam if its
   typo tolerance proves needed for Arabic queries.
5. **A local embedder in Docker**: text-embeddings-inference (CPU image, digest-pinned) serving
   `BAAI/bge-m3` (multilingual, strong Arabic retrieval, 1,024 dimensions, 8k context), loopback only, API
   key from `.env`, memory cap. Neither shared store hosts a model, so Neo runs this one; if ops offers a
   shared embedder later, it is a config URL change. No third-party embedding API by default.
6. **"Use it when it is ready" (note #498), one adapter per outside service.** The embedder and Qdrant are
   each probed every indexer tick and used only while they answer. Embedder down: new chunks are stored
   and keyword-searchable, and wait for a vector. Qdrant down: search is keyword-only (SQLite FTS5 +
   `messages_fts`); vectors keep being stored locally. On recovery, the waiting work re-syncs (embed the
   chunks without vectors; upload the vectors not yet in Qdrant). Nothing outside SQLite is ever needed to
   answer a search.
7. **Hybrid search, one seam**: `historySearch({ query, project?, since?, until?, kinds?, limit })` runs the
   Qdrant KNN (with the payload filters), the history FTS and `messages_fts`, fuses them with reciprocal
   rank fusion (k = 60) and returns hits with their source ref and a snippet. An exact id in the query
   (`#884`, a sha, a PNR) is matched literally and ranks first. Surfaces: the `history_search` and
   `remember` worker tools, a console search mode and Telegram `/find`.
8. **The firewall holds.** Customer-source orders, inbox mail and tainted briefs are never indexed (fail
   closed: an unknown source is skipped). A secret-shaped string is never stored. Qdrant receives only the
   vector and the payload fields Neo filters on (project, kind, date, ref) — the text stays in SQLite, so
   a shared service never holds Neo's briefs.

## Preconditions from the ops conversion (wiring waits for the consumer guide)

- A URL the daemon can reach: Neo runs on the host (systemd), not in a container, so it needs a
  `127.0.0.1` port (or a documented host route) — a Docker-network-only address will not do.
- Neo's own key, scoped to `neo_*` collections (Qdrant JWT RBAC), stored in Neo's `.env` under a name ops
  documents; never adminli's or a global admin key.
- The image pinned (not `:latest`), loopback-only ports, the API key required, daily backups.
- Until the guide exists, Neo's history runs keyword-only (SQLite), which is a supported state.

## Alternatives rejected

- **sqlite-vec in a Neo-only file** (the first choice; it works here: 30,000 × 1,024-d, KNN 47 ms).
  Overruled by the operator (note #500): one shared vector service for all projects instead of one store
  per project. Keeping it as a second vector path beside Qdrant would be two implementations of one job.
- **A Neo-owned Qdrant or Meilisearch container.** Same ops weight as the shared one, and the operator wants
  the shared services.
- **Meilisearch as the main search** (its hybrid mode): see Decision 4.
- **ClickHouse, Temporal, project Postgres (pgvector).** ClickHouse is an analytics store, Temporal a
  workflow engine; pgvector would put Neo's cross-project history inside one project's database. Not used.
- **Vectors only in Qdrant (no local copy).** A lost collection would then need a full re-embed (CPU hours);
  the 4 KB per chunk kept in SQLite makes recovery an upload.
- **Chunk text in the Qdrant payload.** Convenient for snippets, but it would copy Neo's briefs into a
  service other projects share; the text is read back from SQLite by ref instead.
- **A hosted embedding API.** Sends project and operator text to a third party; ruled out by the order.
- **`multilingual-e5-small/base`.** Lighter, weaker Arabic retrieval than bge-m3; a config option if RAM
  gets tight.
- **Embedding every streamed line.** 585,000 mostly tool-noise lines: hours of CPU, gigabytes of vectors and
  worse results. Keyword search over them already exists.
- **Keyword search only.** Cannot find "bus seats not freeing up" when the work said "capacity is not
  released on cancellation".

## Consequences

- Neo depends on ops' shared Qdrant for meaning search, never for keyword search. One more Neo container
  (the embedder, about 2.5 GB RAM at most under its cap) and one more data file with its own snapshot.
- Finding while checking: the ledger itself has no routine backup (only the one-off `.bak-v<N>` copy a
  migration makes); out of this ADR's scope and reported separately.
- Restart-gated: the indexer starts with the daemon; the backfill runs once after the restart.
