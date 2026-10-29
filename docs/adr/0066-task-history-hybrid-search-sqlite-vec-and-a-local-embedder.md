# Task history: hybrid search in its own SQLite file (sqlite-vec + FTS5), a local embedder in Docker

**Status:** proposed (2026-10-29; plan awaiting approval). Related: ADR-0020 (project memory), ADR-0032
(shared Docker services), ADR-0024 (security), ADR-0062 (secrets through env), the customer firewall.

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
- **sqlite-vec in Bun.** `vec0.so` 0.1.9 loads into `bun:sqlite` here. 30,000 vectors of 1,024
  dimensions: insert 0.8 s, one cosine KNN query 47 ms.

## Decision

1. **The index unit is a task, not a streamed line.** Sources: orders (brief), todos (summary), final
   results and progress digests, plans (row + plan file text), attention items and project notes,
   operator messages, remembered entries. Each is cut into chunks (about 1,200 characters, 150 overlap)
   with its source ref, project, kind and date; commit shas found in the text are stored as facts. The
   585,000 streamed lines stay in `messages_fts`, which the search reuses as one more keyword list.
2. **Its own database file, `data/history.db`**, opened beside the ledger. It holds the chunks, an FTS5
   index (unicode61, diacritics removed) and a `vec0` table (sqlite-vec, cosine). It is the long-term
   archive (it keeps entries after the ledger prunes its rows), so it gets a daily on-host snapshot
   (`VACUUM INTO`, the newest N kept; config `history.backup`). The
   ledger never loads the extension, so a missing or broken `vec0.so` can never stop the ledger or the
   daemon from starting: search falls back to keywords.
3. **A local embedder in Docker**: Hugging Face text-embeddings-inference (CPU image, digest-pinned)
   serving `BAAI/bge-m3` (multilingual, strong Arabic retrieval, 1,024 dimensions, 8k context), bound to
   `127.0.0.1` only, with an API key from `.env`, a memory cap and no other network once the model is
   cached. Provider, URL, model, dimensions and batch size are config (`history.embedder`); a model
   change re-embeds in the background. No third-party embedding API by default.
4. **An indexer in the daemon**: a watermark per source (the last row id it read), polled on an interval;
   new rows are chunked and keyword-indexed at once, then embedded in batches. The embedder down or slow
   never blocks the engine and never loses a row: chunks wait with no vector and are picked up later. A
   one-time backfill runs the same path from watermark 0, in the background.
5. **Hybrid search, one seam**: `historySearch({ query, project?, since?, until?, kinds?, limit })` runs
   the vector KNN, the history FTS and `messages_fts`, fuses them with reciprocal rank fusion (k = 60),
   applies the filters and returns hits with their source ref and a snippet. An exact id in the query
   (`#884`, a sha, a PNR) is also matched literally and ranks first. Surfaces: the `history_search` and
   `remember` worker tools, a console search mode and Telegram `/find`.
6. **The firewall holds.** Orders with `source: "customer"`, inbox mail and tainted briefs are never
   indexed (fail closed: a row with an unknown source is skipped). A secret-shaped string is never stored
   (the existing secret scan runs on every chunk).

7. **"Use it when it is ready" (operator, note #498).** SQLite is always on and always answers:
   `history.db` (FTS5 + sqlite-vec) is the search, built from the ledger. Everything outside it is behind
   a health-checked adapter that is used only while it answers and is dropped silently when it does not:
   the embedder is probed each tick; while it is down, new chunks wait without vectors and search is
   keyword-only; when it is back, the waiting chunks are embedded (re-sync). The vector part sits behind a
   small `VectorIndex` interface, so a richer backend could later be added as a derived, rebuildable copy
   synced from `history.db` — not built now, because nothing on this host is a fit (below).

## Using what already runs on this host (note #498, checked with `docker ps` 2026-10-29)

- **adminli's Qdrant (`adminli-ai-qdrant`, 127.0.0.1:6333).** Rejected. Lifecycle: it belongs to adminli and
  was recreated today, which drops any collection Neo kept there; it runs `qdrant/qdrant:latest` (not
  pinned). Credentials: Neo would hold adminli's API key, a secret another project owns and rotates.
  Isolation: Neo's history holds every project's briefs and results; stored in adminli's database it is
  readable by adminli's app and workers, and it was reachable from the internet today. Speed: at about
  30,000 chunks sqlite-vec already answers in 47 ms.
- **eticket's Meilisearch (`eticket-meilisearch` v1.33).** Rejected for the same lifecycle, credential and
  isolation reasons (eticket's master key, eticket's workers). Its native hybrid search is real (keyword
  with typo tolerance + vectors from a REST embedder), but it would still call the same local embedder and
  adds nothing FTS5 + sqlite-vec + RRF does not give at this size. A Neo-owned Meilisearch is the same ops
  weight as a Neo-owned Qdrant (below) — rejected for now; the `VectorIndex` seam leaves the door open.
- **eticket's ClickHouse, Temporal (+ its Postgres).** Add nothing to search: ClickHouse is an analytics
  store (its vector functions need a full copy of the data in another project's database); Temporal is a
  workflow engine. Not used.
- **Project Postgres instances (eticket, contantme, wasilni; prod-postgres is off limits).** pgvector there
  would put Neo's cross-project history inside one project's database — rejected (isolation).
- **An embedder already on the host.** None runs (no TEI, Ollama or Infinity container); `adminli-ai`
  exposes no embedding port. So Neo runs its own small loopback embedder; if one appears later, it is a
  config URL change behind the same health-checked adapter.

## Alternatives rejected

- **Qdrant in Docker.** A second always-on service (about 0.5–1 GB RAM with this data), its own
  snapshots and backups, its own API key and port to secure on a public host (adminli's Qdrant was
  reachable from the internet today), and a network hop per query. Its strengths (sharding, many millions
  of vectors, filtering at scale) are not needed for about 30,000 chunks, where sqlite-vec answers in 47 ms.
- **pgvector.** Neo has no Postgres of its own; putting the engine's history into a project's Postgres
  breaks project isolation, and a new Postgres for this is the same ops weight as Qdrant.
- **The vectors inside the ledger.** One file, but the ledger would then load a native extension at
  every open: a broken `vec0.so` would stop the daemon booting, and the 415 MB ledger would grow with
  derived data.
- **A hosted embedding API.** Sends project and operator text to a third party; ruled out by the order.
- **`multilingual-e5-small/base`.** Lighter (about 0.5–1.2 GB), but weaker Arabic retrieval than bge-m3;
  kept as a config option if RAM gets tight.
- **Embedding every streamed line.** 585,000 mostly tool-noise lines: hours of CPU, about 2.4 GB of
  vectors, and worse results. Keyword search over them already exists.
- **Keyword search only (FTS5).** Cannot find "bus seats not freeing up" when the work said "capacity is
  not released on cancellation". That is the operator's point.

## Consequences

- One more Docker service (the embedder, about 2.5 GB RAM at most under its cap) and one more data file,
  with its own daily snapshot. Finding while checking: the ledger itself has no routine backup (only the
  one-off `.bak-v<N>` copy a migration makes); that is out of this ADR's scope and reported separately.
- Restart-gated: the indexer starts with the daemon; the backfill runs once after the restart.
