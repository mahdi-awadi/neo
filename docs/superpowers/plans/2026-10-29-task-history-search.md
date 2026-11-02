---
approval: required
---
# Task history with hybrid (meaning + words + exact) search — plan

Spec: `docs/superpowers/specs/2026-10-29-task-history-search-design.md`. ADR:
`docs/adr/0067-task-history-in-sqlite-with-vectors-in-the-shared-qdrant-kept-in-step-by-a-ledger-change-feed.md`
(proposed, revision 3). Terms: `CONTEXT.md` (Task history, History entry, Archived entry, Forget, Change
feed, Keyword-only mode, Embedder, Model tag, Snapshot backup). The tracked copy is on branch
`feat/history-search` at `eea1bad` (worktree `/home/neo-wt-history`); this file is the plan-card copy.

Branch `feat/history-search` from `dev`, worktree `/home/neo-wt-history` (remove the folder when the work
is merged). Each task is TDD: write the failing tests first, then the code, then make `bunx tsc --noEmit`
and `bun test` green, then make one commit for the task. Start long test runs in the background and poll
them. After the verify step and the reviews, merge into `dev`, never into `master`. Do not restart the
daemon. The restart is the operator's.

**Store choices (ADR-0067 rev 3):** vectors in the shared Qdrant (`neo_history`, provisioned, key checked
live today); keyword search in SQLite FTS5 inside `data/history.db` (works when shared services are down,
no credentials, text stays local; Neo normalizes Arabic itself); a ledger change feed (migration v17) keeps
the index in step with inserts, updates and deletes. Rejected: pgvector on the shared Postgres (Neo has no
role there; its one gain, words and vectors in one store, is lost because words must stay local); shared
Meilisearch (no key for Neo; remote keyword search fails when the service is down).

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

- [x] **1. Arabic normalizer and light stemmer** (pure) — `history/normalize.ts`, `arabic-stem.ts`: harakat,
  Quranic marks, tatweel, alef/yeh/teh-marbuta forms, Arabic-Indic digits, NFKC, invisible characters; an
  offset map back to the original text; stems (`والمقاعد` → `مقاعد`). Tests for each rule, idempotence, stems.
- [x] **2. Chunker and extractors** (pure) — paragraph/line/sentence cuts, never inside a grapheme; sha and
  query-id extraction; removal of the engine's own preamble blocks (tested against the real builders);
  continuation unwrapping; boilerplate paragraph hashes. A 100 KB result.
- [x] **3. The `history.db` store** — schema v1 (FTS5 contentless-delete, body + stems), mode 0600,
  `putSource` with stable chunk ids, vectors by text hash and model tag, upload marks, pending deletes,
  remembered entries, tombstones, coverage, a cross-process lock, typed corrupt-file error.
- [x] **4. Ledger change feed (migration v17) and the history reads** — a `history_feed` table with
  triggers on orders, outcomes, todos, plans, attention items (notes/github/git), decisions and operator /
  digest messages (not worker lines, not engine items); feed paging and pruning; history row reads and
  scans; order lineage for the firewall; `searchWorkerLines` for the streamed lines (never customer chat
  or ingress threads). `.bak-v16` before it runs; it runs only at the next restart.
- [x] **5. Sources and the firewall** — one extractor per kind; the firewall excludes the customer path by
  chat (`CUSTOMER_CHAT`, its children, ingress threads; unknown or deep lineage fails closed), drops
  secret-shaped chunks, neutralizes injection phrases; plan files read only inside their folder; no
  `history/` file imports `inbox`.
- [x] **6. Embedder adapter** — loopback-only URL, bearer key from env, `/info` model check, dims check,
  401/403/timeout/413/429/503 states, query cache, the key never in an error.
- [x] **7. Vector index adapter (Qdrant)** — refuses a non-loopback URL, a collection outside `neo_*` /
  the allowed list, and a key that is not scoped to Neo's collection, before any request; creates its four
  payload indexes; upserts only `id`, `vector` and `project/kind/at/model-tag` (never text); filtered
  search; delete by ids and by tag; `NoVectorIndex` when off.
- [x] **8. The indexer** — feed-driven passes, keyword first, then bounded embed and upload batches, each
  only while its service answers; updates replace only changed chunks; pruned ledger rows stay as archive;
  reconcile after a feed gap and weekly (orphan points deleted); drift re-upload with zero embed calls;
  model change with two tags; single-flight; counts-only events.
- [x] **9. Search** — exact ids first, then RRF over Qdrant KNN, history FTS (words + stems) and worker
  lines; filters on every list; modes `on` / `partial` / `off` / `skipped` with the reason; snippets
  highlighted on the original Arabic text; the event never holds the query text.
- [x] **10. Remember and forget** — `mem:` refs, refusal rules (empty, size, secret, injection), duplicate
  check, rate limit; forget removes chunks, FTS rows, vectors and points (queued while Qdrant is down) and
  leaves a tombstone.
- [x] **11. Factory, config and daemon wiring** — `history` and `backup` config with safe defaults; a
  heartbeat step through `faults.contain`; a corrupt `history.db` is moved aside and the engine still starts.
- [x] **12. Worker tools** — `history_search` and `remember` for the company and project workers,
  `history_search` only for consult runs, none for ingress or tainted runs; a tool card; one preamble line.
- [x] **13. Console History tab** — `GET /api/history`, `POST /api/history/remember`, `POST
  /api/history/forget` (validated, session-guarded, no-store); hit cards with sources, the mode banner,
  empty/loading/error states, a forget confirm; AR + EN catalogue keys; ids, dates and shas LTR; phone width.
- [x] **14. Telegram `/find`, `/remember`, `/forget`** — filters `p:` `k:` `since:` `until:`; replies under
  4,096 characters with a console link; numbers LTR in Arabic lines; a forget button for the same chat only.
- [x] **15. Embedder service** — `tools/history/compose.yml` (TEI CPU image pinned by digest, bge-m3 at a
  pinned revision, `127.0.0.1` only, `mem_limit`, `cap_drop: ALL`, no-new-privileges, health check, the
  key only in the environment), `install.ts` (writes `HISTORY_EMBEDDER_KEY` into `.env` once, 0600, prints
  nothing; waits for health; one test embed).
- [x] **16. Snapshot backup job (for `history.db`)** — online snapshot in a child process (no shell),
  integrity check, gzip, manifest, rotation (8 recent, 7 daily, 4 weekly), restore drill, free-space check,
  failure alert; `/var/backups/neo`; runbook `docs/backup.md`. The ledger is NOT in the list (separate
  decision).
- [x] **17. Attention items** — `history_off` and `backup_failed` (needs you), `history_degraded`
  (housekeeping), each resolving itself on recovery; AR + EN keys.
- [x] **18. Admin CLI and eval harness** — `status`, `copy-ledger` (read-only `VACUUM INTO`, never inside
  `data/`), `backfill --verify`, `forget`, `rescan-secrets`, `verify-clean`; `eval.ts` (recall@5, MRR).
- [x] **19. Docs** — ADR-0067 "As built" with the measured numbers, CONTEXT.md, CONFIG.md, HISTORY.md,
  HANDOFF.md, the tool card, `docs/backup.md`, a new `docs/history.md` operator guide.
- [ ] **20. Verify (live, before the merge)**
  - Status 2026-10-30: steps 1–6, 8 (keyword-only), 9 (embedder drills), 10 and the reviews are done; numbers in
    ADR-0067 "Measured". Open, waiting for ops to reissue Neo's shared-Qdrant key (note #547): the `--verify`
    upload, meaning-only and hybrid eval, the Qwen comparison, hybrid latency, `vectors_down` and drift drills,
    the `verify-clean` proof. Left unticked until those run. — full suite; install the embedder and size its memory cap
  from the measured peak; backfill a COPY of the ledger into `neo_history` under a verify tag (the key
  cannot create collections); an eval set of 20+ queries (10 Arabic, 10 English, incl. "the thing about bus
  seats not freeing up") for words-only, meaning-only and hybrid, and a comparison with
  `Qwen/Qwen3-Embedding-0.6B` (keep bge-m3 unless Qwen3 wins by 5+ points of recall@5 within +25 % memory or
  time); p50/p95 latency; down drills (embedder stopped, wrong Qdrant port, verify points deleted);
  360 px console screenshots in AR and EN; `verify-clean` back to 0 points; planner final review,
  `requesting-code-review`, `/security-review`; numbers into the ADR and HANDOFF; merge into `dev`.

---

## Operator steps

1. Approve this plan (the plan card).
2. After the merge into `dev`, run `bun tools/history/install.ts`. It pulls the embedder image and the
   model (about 2.3 GB) and writes `HISTORY_EMBEDDER_KEY` into `.env`.
3. Restart the daemon (your permission). Ledger migration v17 runs after its `.bak-v16` copy. Then the
   backfill starts by itself, and meaning search reports partial coverage for some hours. If you restart
   before step 2, search is keyword-only, and the `history_off` item names step 2.
4. Decide the ledger backup (ADR-0067, a separate decision). Option A (add the ledger to the same snapshot
   job, every 6 hours, with a weekly restore drill) is recommended over Litestream (later, once an off-host
   target is approved) and over moving the ledger to Postgres (a full async rewrite of the ledger with no
   backup gain).

## Ops notes (information, nothing blocks)

1. `neo_history` will hold about 25,000 to 35,000 points (about 120 MB of float32 vectors).
   `shared-qdrant` has a 1 GiB memory limit and used 179 MiB on 2026-10-29. Ops can choose int8 scalar
   quantization or on-disk vectors for the collection. Neo makes its four payload indexes itself.
2. Neo will write snapshots to `/var/backups/neo` (root, 0700). Please list the folder in the backup
   inventory and include it in any off-host copy.
3. Only for a later model with other dimensions: Neo will ask for a new `neo_*` collection and a new key.
4. When ops rotates the Qdrant secret (ops plan, Task 8), tell the operator. The daemon must reload to read
   the new key. Keyword search continues until then.
