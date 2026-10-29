---
approval: required
---
# Task history with hybrid (meaning + exact) search — plan

Spec: `docs/superpowers/specs/2026-10-29-task-history-search-design.md` (ADR-0066, proposed; revised by the
operator's ruling in note #500: vectors in the host's **shared Qdrant**, SQLite as source of truth and
always-on keyword search). Branch `feat/history-search` from `dev` (worktree `/home/neo-wt-history`, removed
when done). TDD per task; `bunx tsc --noEmit` and `bun test` green before each commit. Built on dev only:
no merge, no restart.

Why approval: a new always-on Docker service (the local embedder, about 2.5 GB RAM under its cap), Neo
becoming a consumer of the shared Qdrant, a new data file with its own backup, and new worker tools.

**Gate:** tasks 1–8 and 10–12 need nothing from ops and are built first (the Qdrant adapter against a fake
and Qdrant's documented REST API). Task 9's live wiring (the URL, the key's `.env` name, the network) waits
for ops' shared-services consumer guide (ops todo #914). Until then the history runs keyword-only, which is
a supported state; the verify step runs meaning search live once the guide exists.

- [ ] 1. **Store** — `history/store.ts`: history.db schema (chunks with text, FTS5 unicode61 remove_diacritics 2,
   the vector blob, an `in_qdrant` flag, watermarks, remembered, schema version). Tests: schema, round-trip,
   reopen keeps watermarks and flags.
- [ ] 2. **Chunker + normalizer** (pure) — size/overlap, Arabic normalization for the FTS copy, sha/ref
   extraction. Tests incl. a 100 KB result and Arabic with diacritics.
- [ ] 3. **Sources + firewall** — orders, todos, results/digests (messages kinds), plans (row + file),
   attention items/notes, operator messages, remembered; watermark per source; skip customer/tainted/
   unknown source; secret scan per chunk. Tests per source and per firewall rule.
- [ ] 4. **Embedder adapter** — HTTP (TEI `/embed`), API key from env, timeout, batch, dims check, a health
   probe per tick ("use it when ready", note #498): down → chunks wait; back → re-sync. A fake for tests.
   Tests: success, timeout, wrong dims, 401, down then up (waiting chunks embedded).
- [ ] 5. **Vector index adapter** — `VectorIndex` interface; `QdrantIndex` (REST: ensure `neo_history` +
   payload indexes on project/kind/at, upsert in batches, filtered search, delete, health probe, collection
   count); `NoVectorIndex` (not configured / not answering). Only the vector and `ref/project/kind/at`
   leave Neo, never text. Tests against a fake Qdrant server: upsert/search/filter, 401/403 → keyword-only,
   down then up (pending vectors uploaded), collection missing (recreated, refilled from SQLite, no re-embed),
   refuses a collection name without the `neo_` prefix.
- [ ] 6. **Indexer** — `indexTick`: single-flight; keyword-index first, then a bounded embed batch, then a
   bounded upload batch, each only while its service answers; backfill = the same path from 0;
   `history_embed_error` / `history_vectors_error` events. Tests: freshness, no double index, each service
   down then up.
- [ ] 7. **Hybrid search** — `fuse.ts` (RRF k=60, exact-id boost), three lists (Qdrant KNN when up, history FTS,
   `messages_fts`), filters, hits with sources (text read back from SQLite by ref). Tests: acceptance 1–4
   with fake embedder + fake Qdrant; Qdrant down → keyword-only results; id-only query makes no embed call.
- [ ] 8. **Remember** — store + refusal rules. Tests.
- [ ] 9. **Wiring** — config `history` (+ docs/CONFIG.md; `vectors.url` empty by default = keyword-only),
   daemon tick (heartbeat), `history_search` + `remember` MCP tools for own-work sessions (never tainted),
   tool card `docs/tools/history-search.md`, dispatch preamble line. Tests: tool registration rules,
   tainted brief has none. **Live Qdrant values (URL, key name, network) from ops' consumer guide.**
- [ ] 10. **Embedder service** — `tools/history/compose.yml` (TEI CPU image pinned by digest, 127.0.0.1:8088,
   `--api-key ${HISTORY_EMBEDDER_KEY}`, mem cap, model cache volume, healthcheck), `history.env`,
   `install.ts` (up/health/down, generates the dev key into `.env` chmod 600 if missing). Test: compose
   validates; the port is loopback; no key value in tracked files.
- [ ] 11. **Console + Telegram** — console "History" search (query, project, dates, kinds; hits with source
   links and `via` chips; a "keyword only" note while meaning search is down) via `GET /api/history`;
   Telegram `/find <query>`. AR + EN keys, LTR ids. Tests.
- [ ] 12. **Backup** — daily `VACUUM INTO data/backups/history-<date>.db`, keep N. Test.
- [ ] 13. **Docs** — ADR-0066 accepted (as built), CONTEXT.md, CONFIG.md, HISTORY.md, HANDOFF.md, the tool card.
- [ ] 14. **Verify** — full suite; bring the embedder up (`install.ts`); backfill a copy of the ledger (never the
   live file) into a test `neo_history_verify` collection on the shared Qdrant (removed after); run the
   operator's example queries in AR and EN and record the top hits; stop the embedder and Qdrant access and
   show keyword-only answers; phone-width screenshots of the console search in AR and EN; independent code
   review; `/security-review` (new HTTP route, tool input, a new service, a shared-service client).

Operator steps after the merge + restart: `bun tools/history/install.ts` (pulls the embedder image and the
model, about 2.3 GB) and Neo's scoped Qdrant key placed per ops' guide; the backfill then runs by itself.
