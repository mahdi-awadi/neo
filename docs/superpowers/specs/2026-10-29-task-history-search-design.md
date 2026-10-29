# Task history with hybrid (meaning + exact) search — design (ADR-0066)

Operator order 2026-10-29: a searchable long-term memory of every task, so finding past work never depends
on AI recall. Natural-language search ("the thing about bus seats not freeing up"), Arabic and English,
plus exact ids. Every hit names its source so the operator can check it.

**Revised by operator ruling (note #500):** vectors go to the host's **shared Qdrant** (ops-owned after ops
todo #914), not a Neo-only sqlite-vec store. SQLite (`history.db`) stays the source of truth and the
always-on keyword search. Connection details wait for ops' consumer guide.

## What exists (reuse, do not duplicate)

- `messages_fts` (FTS5 over every message) and `ledger.searchMessages` — the console's thread search.
- Neo memory (`memory-recall.ts`): per-folder FTS over daily logs, `safeFtsQuery` (quotes FTS operators,
  OR mode, stop words). Reused for the keyword query builder.
- `scanMemoryText` (secret shapes), `todoLabel` (todo summary), `explainAttention` (item plain title),
  `openSqlite` (the ledger's connection idioms), `tools/browser/` (a digest-pinned, loopback-only Docker
  service with `install.ts` and an env file) — the embedder copies that pattern.

## The seam

`src/engine/history/` — one module boundary, a small interface:

```ts
interface TaskHistory {
  /** Hybrid search: shared-Qdrant KNN (when up) + history FTS + messages_fts, fused (RRF k=60), filtered. */
  search(q: HistoryQuery): Promise<HistoryHit[]>;
  /** Save a "remember this" entry; returns its ref. Refused for a secret-shaped or empty text. */
  remember(e: { text: string; project?: string; by: "operator" | "worker" | "company" }): { ok: true; ref: string } | { ok: false; error: string };
  /** One indexer pass: read new source rows past each watermark, chunk, keyword-index, embed the chunks
   *  that have no vector yet, upload the vectors not yet in Qdrant (bounded batches; each step only while
   *  its service answers). Never throws; reports counts. */
  indexTick(now: number): Promise<IndexReport>;
}
interface HistoryQuery { query: string; project?: string; since?: number; until?: number; kinds?: HistoryKind[]; limit?: number }
interface HistoryHit {
  ref: string;            // "order:<uuid>" | "todo:884" | "plan:12" | "note:470" | "msg:991" | "mem:3"
  kind: HistoryKind;      // order | todo | result | digest | plan | note | message | remembered
  project?: string; at: number;
  title: string;          // the todo summary / plan title / note title
  snippet: string;        // the matched chunk, cut
  commits: string[];      // shas the source names
  path?: string;          // a plan file path
  via: Array<"meaning" | "words" | "exact">;  // which lists found it
}
```

Parts behind it: `chunker.ts` (pure), `sources.ts` (ledger row → entries, with the firewall filter),
`store.ts` (history.db: chunks with their text, FTS5, the vector blob and an `in_qdrant` flag, watermarks,
remembered), `embedder.ts` (health-checked adapter over the local embedder), `vector-index.ts` (the
`VectorIndex` interface; `QdrantIndex` over the shared Qdrant REST API: ensure collection + payload
indexes, upsert, delete, filtered search, health probe; `NoVectorIndex` when it is not configured or not
answering), `fuse.ts` (pure RRF + exact-id boost). Both adapters follow "use it when ready" (note #498):
used while they answer, dropped silently when they do not, re-synced on recovery.

What Qdrant holds: per chunk, the vector and the payload Neo filters on (`ref`, `project`, `kind`, `at`).
Never the text — hits read their text back from SQLite by ref, so a shared service never holds Neo's
briefs. Meilisearch is not used (ADR-0066, Decision 4).

## Config (`history` in config.json; secrets in `.env`)

`enabled` (default true), `dbPath` (`data/history.db`), `tickMs` (30 s), `embedBatch` (32),
`embedder: { url: "http://127.0.0.1:8088", model: "BAAI/bge-m3", dims: 1024, timeoutMs }`,
`vectors: { url: "", collection: "neo_history", timeoutMs, uploadBatch }` (the URL from ops' consumer
guide), `chunkChars` (1200), `chunkOverlap` (150), `backup: { keep: 7 }`. `.env`: `HISTORY_EMBEDDER_KEY`
and Neo's scoped Qdrant key under the name ops documents. With `embedder.url` or `vectors.url` empty,
search is keyword-only (a supported mode, not an error) — the state until the guide exists.

## Acceptance criteria

1. **Meaning search, both languages.** With entries "capacity is not released when a booking is
   cancelled" (EN) and an Arabic brief about seats not freed after cancellation, the query "bus seats not
   freeing up" returns both in the top 3 (tested with a deterministic fake embedder that maps known
   paraphrases close; a live check against bge-m3 is recorded in the verify step).
2. **Exact ids rank first.** `#884`, a 7–40 char sha, a PNR-like token find their source first (`exact`).
3. **Every hit cites its source**: ref, kind, project, date, title; commits named in it; plan path.
4. **Filters**: project, since/until, kinds — applied to all three lists before fusion.
5. **Freshness**: a new order, result, plan, note or message is keyword-searchable after the next tick
   and meaning-searchable after its batch is embedded and uploaded. Watermarks survive a restart; nothing
   is indexed twice.
6. **Backfill**: one background pass over all history, resumable (watermarks), throttled by `embedBatch`.
7. **Fail-soft and re-sync**: embedder down, slow or wrong dims → chunks wait, `history_embed_error` event;
   Qdrant down, 401/403 or slow → search is keyword-only, `history_vectors_error` event, vectors kept in
   SQLite; on recovery the waiting chunks are embedded and the vectors not in Qdrant uploaded. A missing or
   recreated collection is re-created and refilled from SQLite (no re-embed). history.db unreadable → the
   tool says so. The engine never stops.
8. **Firewall**: customer-source orders, inbox mail and tainted briefs are never indexed; a row whose
   source is unknown is skipped; a secret-shaped chunk is not stored (counted in the report).
9. **Remember**: `remember` stores an entry that the next search finds; empty or secret-shaped text refused.
10. **Surfaces**: `history_search` + `remember` MCP tools for the chief of staff and workers (own-work
    sessions only, never a tainted brief); console "History" search mode with filters and source links;
    Telegram `/find <query>`. AR + EN catalogue keys; ids, dates and shas LTR in RTL.
11. **Embedder service**: `tools/history/compose.yml` + `install.ts` (like `tools/browser/`): image pinned by
    digest, `127.0.0.1` only, `--api-key` from `.env`, memory cap, model cache volume, health check.
12. **Shared Qdrant as a consumer**: Neo creates and uses only `neo_*` collections with its own scoped key;
    it never reads another project's collection and never needs an admin key. Only vectors and the four
    payload fields leave Neo.
13. **Backup**: a daily `VACUUM INTO data/backups/history-<date>.db`, newest `keep` kept.

## Edge cases

- A huge result (100 KB): chunked; only chunks are stored, each ≤ chunkChars.
- Arabic with diacritics and tatweel: normalized for FTS (remove_diacritics 2; tatweel stripped) — the
  stored snippet keeps the original text.
- A model change (dims differ): a new collection (`neo_history_<dims>`) is filled in the background, then
  swapped in; keyword search keeps working throughout.
- The shared Qdrant is recreated by ops (empty): detected by the probe (collection missing or count far
  below the `in_qdrant` total), every flag reset, refilled from SQLite.
- The ledger prunes events: entries already in history stay (it is the archive).
- A query that is only an id: the exact list decides; no embedding call.
- Concurrency: the indexer is single-flight; a tick that is still running skips the next one.

## Not in scope

Embedding the 585,000 streamed worker lines (keyword search covers them); a ledger backup routine
(finding reported separately); hosted embedding providers (a config option later, off by default);
running or configuring the shared Qdrant/Meilisearch (ops todo #914 owns that).
