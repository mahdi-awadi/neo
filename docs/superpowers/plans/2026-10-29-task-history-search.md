---
approval: required
---
# Task history with hybrid (meaning + exact) search — plan

Spec: `docs/superpowers/specs/2026-10-29-task-history-search-design.md` (ADR-0066, proposed).
Branch `feat/history-search` from `dev` (worktree `/home/neo-wt-history`, removed when done). TDD per task;
`bunx tsc --noEmit` and `bun test` green before each commit. Built on dev only: no merge, no restart.

Why approval: a new always-on Docker service (the local embedder, about 2.5 GB RAM under its cap), a new
data file with its own backup, a native SQLite extension, and new worker tools.

- [ ] 1. **Dependency + store** — add `sqlite-vec` (exact version, its `getLoadablePath()`); `history/store.ts`:
   history.db schema (chunks, FTS5 unicode61 remove_diacritics 2, vec0 cosine, watermarks, remembered,
   schema version), extension load that fails soft to keyword-only. Tests: schema, round-trip, missing
   extension → keyword-only, reopen keeps watermarks.
- [ ] 2. **Chunker + normalizer** (pure) — size/overlap, Arabic normalization for the FTS copy, sha/ref
   extraction. Tests incl. a 100 KB result and Arabic with diacritics.
- [ ] 3. **Sources + firewall** — orders, todos, results/digests (messages kinds), plans (row + file),
   attention items/notes, operator messages, remembered; watermark per source; skip customer/tainted/
   unknown source; secret scan per chunk. Tests per source and per firewall rule.
- [ ] 4. **Embedder client** — HTTP (TEI `/embed`), API key from env, timeout, batch, dims check; a fake for
   tests. Tests: success, timeout, wrong dims, 401, down.
- [ ] 5. **Indexer** — `indexTick`: single-flight, keyword first then bounded embed batch; backfill = the
   same path from 0; `history_embed_error` events. Tests: freshness, no double index, embedder down then up.
- [ ] 6. **Hybrid search** — `fuse.ts` (RRF k=60, exact-id boost), three lists, filters, hits with sources.
   Tests: acceptance 1–4 with the deterministic fake embedder; id-only query makes no embed call.
- [ ] 7. **Remember** — store + refusal rules. Tests.
- [ ] 8. **Wiring** — config `history` (+ docs/CONFIG.md), daemon tick (heartbeat), `history_search` + `remember`
   MCP tools for own-work sessions (never tainted), tool card `docs/tools/history-search.md`, dispatch
   preamble line. Tests: tool registration rules, tainted brief has none.
- [ ] 9. **Embedder service** — `tools/history/compose.yml` (TEI CPU image pinned by digest, 127.0.0.1:8088,
   `--api-key ${HISTORY_EMBEDDER_KEY}`, mem cap, model cache volume, healthcheck), `history.env`,
   `install.ts` (up/health/down, generates the dev key into `.env` chmod 600 if missing). Test: compose
   validates; the port is loopback; no key value in tracked files.
- [ ] 10. **Console + Telegram** — console "History" search (query, project, dates, kinds; hits with source
   links and `via` chips) via `GET /api/history`; Telegram `/find <query>`. AR + EN keys, LTR ids. Tests.
- [ ] 11. **Backup** — daily `VACUUM INTO data/backups/history-<date>.db`, keep N. Test.
- [ ] 12. **Docs** — ADR-0066 accepted (as built), CONTEXT.md (done in design), CONFIG.md, HISTORY.md,
   HANDOFF.md, the tool card.
- [ ] 13. **Verify** — full suite; bring the embedder up (`install.ts`), backfill a copy of the ledger (never the
   live file), run the operator's example queries in AR and EN and record the top hits; phone-width
   screenshots of the console search in AR and EN; independent code review; `/security-review` (new HTTP
   route, tool input, a native extension, a new service).

Operator steps after the merge + restart: `bun tools/history/install.ts` (pulls the image and the model,
about 2.3 GB, then the backfill runs by itself).
