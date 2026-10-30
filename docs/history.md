# Task history — operator guide (ADR-0066)

The task history is Neo's searchable archive of past work in every project. It answers "what did we do
about X, and where is it". It finds work by meaning (Arabic and English), by words and by exact ids. Each
hit names its source, so you can check it.

- Decision and as-built notes: `docs/adr/0066-*.md`. Terms: `CONTEXT.md` ("Task history").
- Config: `docs/CONFIG.md` ("Task history", "Snapshot backup"). Backups: `docs/backup.md`.
- Code: `src/engine/history/`, `src/engine/backup/`, `tools/history/`.

## What is indexed

The text and the word index live in `data/history.db` (mode 0600). The vectors live in Neo's collection
`neo_history` on the shared Qdrant. Qdrant gets only the vector and four short fields (`project`, `kind`,
`at`, `m`, the model tag). It never gets the text.

| Kind | Ref | What |
| --- | --- | --- |
| `todo` | `todo:884` | The todo brief, without the engine's standing text. |
| `order` | `order:<uuid>` | A dispatched or side-lane order that has no todo. |
| `result` | `result:<order uuid>` | The summary of an order that ended `done`, `error` or `failed`. |
| `digest` | `msg:<id>` | A progress digest. |
| `message` | `msg:<id>` | Your own message lines. |
| `plan` | `plan:12` | The plan title and the text of the plan file. |
| `note` | `note:470` | A project note: title, body, refs, answer, resolution. |
| `attention` | `att:31` | GitHub and git attention items. |
| `decision` | `dec:<uuid>` | A decision card: the question, context, options and answer. |
| `remembered` | `mem:3` | A fact that you, the company or a worker saved with `remember`. |
| `line` | `line:<message id>` | Streamed worker lines. They stay in the ledger. Search reads them as one more word list. |

When the ledger's retention deletes a row, the history keeps it as an **archived entry**. Its hit shows
"archived".

## What is never indexed (the firewall)

The firewall decides each row on the ledger's facts and fails closed:

- Customer work: every order on chat `-3` (`CUSTOMER_CHAT`), and all orders under it.
- Consult runs: they also use chat `-3`, so they are excluded too.
- Orders whose `source` is not `neo`, and every row on a thread that started from `ingress`.
- Rows with a missing order, parent or thread, a parent chain deeper than 8, or no clear place.
- Engine-written user lines (`surface = 'engine'`).
- A chunk with a secret shape (`findSecret`). The `history_secret_skip` event names the ref and the
  pattern, never the text.
- The history code never opens the inbox database.

Prompt-injection phrases in stored text are made harmless. Workers see hits as quoted data.

## How to search

### Console: the History tab

Type words or ids in the query box. The filters are a project, kinds, and a date range (UTC). On a phone,
the filters fold behind one button. The mode banner says when meaning search is not fully on. Each hit
card shows the kind, title, project, date, ref, how it was found ("via"), an archived tag, the snippet,
the commits, a plan link and a link to its todo or thread. A link `<console>/#history=<query>` opens the
tab with that search.

### Telegram: `/find`

```
/find <words or id> [p:<project>] [k:<kind>,…] [since:YYYY-MM-DD] [until:YYYY-MM-DD]
```

- `p:` a project, `k:` one or more kinds (comma list), `since:` and `until:` UTC dates (inclusive).
  A filter word can stand anywhere in the line.
- The reply has at most `history.telegram.findLimit` (5) hits, then the console link. It is at most
  4,096 characters. Numbers stay left-to-right in Arabic lines.
- The console chat box takes `/find`, `/remember` and `/forget` too.

Examples:

```
/find bus seats not freeing up
/find المقاعد لا تتحرر بعد الإلغاء p:waselni
/find #884
/find dev 479236d
/find qi refund k:todo,result since:2026-10-01
```

### Workers: `history_search`

Every operator-side worker, the company and consult runs get `history_search`. The tool card is
`docs/tools/history-search.md`. The dispatch preamble tells workers to search before they redo work.

### Search tips

- Ids rank first: `#884`, `todo 884`, `plan 12`, `note 470`, a commit sha (7–40 hex), a decision id, an
  order UUID, a thread ref (`m…`), a PNR-like code. A query of only ids makes no embed call (mode
  `skipped`).
- Write the idea in plain words. Meaning search finds "capacity is not released on cancellation" for
  "bus seats not freeing up", also across Arabic and English.
- Arabic works with or without harakat, `ال`, `و` and `ب` prefixes, and Arabic-Indic digits.
- A query is at most 500 characters. A query of only stop words is refused (`query_stopwords`).

## The modes

Each reply states the meaning-search mode:

| Mode | Meaning |
| --- | --- |
| `on` | Meaning search answered and covers the history. The console shows no banner, and `/find` shows no mode line. |
| `partial` | Meaning search covers only part of the history (for example, during the first backfill). The reply gives the coverage. Word and id matches cover all of it. |
| `off` | Keyword-only mode. The reply gives the reason code. Exact, word and line matches still answer. |
| `skipped` | The query is only ids. Exact matches only, no meaning search. |

### Off reasons and what to do

"Off" reasons need you. The `history_off` attention item (needs you) appears at once and names the step.
"Down" reasons can go away by themselves. The `history_degraded` item (housekeeping) appears only after
`history.degradedAlertMinutes` (60). Each item closes by itself when the service works again.

| Reason | Kind | What to do |
| --- | --- | --- |
| `not_configured` (embedder) | off | The embedder is not installed. Run `bun tools/history/install.ts`, then reload Neo. |
| `not_configured` (vectors) | off | `SHARED_QDRANT_URL` or `SHARED_QDRANT_API_KEY` is not in `.env`. Ask ops for them, then reload Neo. |
| `config_refused` | off | A setting was refused: a URL that is not loopback, a collection that is not allowed, a key that is not a JWT for `neo_history` only, or a collection with other dimensions. Fix `config.json` or the key, then reload Neo. |
| `embedder_refused` | off | The embedder refused the key. Run `install.ts` again (the key in `.env` and the service must match). |
| `embedder_wrong_model` | off | The service runs another model or revision than the config names. Run `install.ts` (it pins the model), or make `history.embedder.model` and `revision` match. |
| `vectors_refused` | off | Qdrant refused the key. Ops may have rotated it. Reload Neo to read the new key. If it still fails, ask ops. |
| `vectors_key_rejected` | off | The probe found that Qdrant rejects Neo's key itself (a bad signature after a rotation, or no access to `neo_history`). Ask ops to reissue `SHARED_QDRANT_API_KEY` for `neo_history`. The daemon must reload to read it. |
| `collection_missing` | off | Qdrant accepts the key, but `neo_history` does not exist (a 404, or a collection list without it). Ask ops to create `neo_history` (1,024 dims, cosine). |
| `embedder_down`, `embedder_slow` | down | Check `docker compose -p neo-embedder ps` and `docker logs neo-embedder`. `install.ts` starts it again. |
| `vectors_down`, `vectors_slow` | down | Check the shared Qdrant (an ops service) and the URL in `SHARED_QDRANT_URL`. |
| `embedder_busy` | search only | Nothing. The indexer had an embed request in flight, so the search did not wait behind it: it gave the word, id and line matches at once. Search again later for meaning matches (after a backfill, this goes away). |

A search embeds its query only when the meaning list is used: not for an id-only query, not for worker
lines only, not with `search.weights.meaning` 0, and not when the shared index is off. A worker session may
make `search.perSessionMinute` (30) searches a minute; the operator surfaces are not limited.

When history is off in config (`history.enabled: false`), no store opens and no worker gets the tools.
`/find` says the history is not available. The console route answers `503 history_off`.

## When a service is down

The engine never stops, and search always answers from `history.db`.

- **Embedder down.** New chunks are stored and keyword-searchable. They wait for a vector.
- **Qdrant down, or its key refused.** Vectors are made and kept in `history.db`. Uploads and point
  deletes wait in a queue.
- **On recovery,** the indexer embeds and uploads the waiting work in bounded batches. Nothing is lost.
- **Collection emptied or lost (drift).** Each pass compares the point count with its upload marks. When
  the collection is much smaller, the indexer uploads the stored vectors again, with no new embed.
- **`history.db` corrupt.** At start, the daemon moves it to `history.db.corrupt-<UTC time>` (with its
  `-wal` and `-shm` files) and sends one alert. Every surface then says that history is not available.
  Restore the newest snapshot (`docs/backup.md`), then reload Neo.

## Remember and forget

### Remember

- Console: the Remember form in the History tab. Telegram: `/remember <fact> [p:<project>]`.
  Workers: the `remember` tool (not in consult runs).
- The entry gets a ref `mem:N`. It is keyword-searchable at once, and meaning-searchable after its vector
  is made.
- Refused: empty text, fewer than 10 or more than 4,000 characters, a secret shape, an injection shape,
  and more than 20 saves for one session in one hour. The same text for the same project gives the old
  ref ("Already saved").

### Forget

Forget removes one entry everywhere: its chunks, word-index rows, vectors and Qdrant points. Use it for
an entry that must not be found again (for example, a secret that got in).

- Console: the Forget button on a hit card. A reason is necessary.
- Telegram: `/forget <ref> [reason]` shows the entry and a Forget button. Nothing is removed until you tap
  it. With no reason, the code records "forgotten by the operator in Telegram".
- Admin: `bun tools/history/admin.ts forget <ref> --reason <text>`.
- A ledger-backed ref gets a tombstone, so a later sync never adds it again. A `mem:` entry is deleted and
  keeps no tombstone. A `line:` ref cannot be forgotten: worker lines are not in the history.
- If Qdrant does not answer, the points wait in a queue and the reply says how many.
- Forget never changes the ledger row.

## The embedder service

The embedder is text-embeddings-inference with `BAAI/bge-m3` in the container `neo-embedder`. The image
and the model are pinned (`tools/history/embedder.env`). The port is `127.0.0.1:8088`, never public.

```sh
bun tools/history/install.ts         # key into .env (once, 0600), start, health, /info and a test embed
bun tools/history/install.ts --down  # stop and remove it; the model volume stays
```

- The first start downloads the model (about 2.3 GB) into the volume `neo-embedder-models`.
  `install.ts` waits up to `NEO_EMBEDDER_START_WAIT_S` (1,200 s).
- `install.ts` writes `HISTORY_EMBEDDER_KEY` into `.env` once. It gives the key to `docker compose` only
  in the child's environment, never as an argument. It never prints the key.
- The daemon reads the key at its next restart. A restart is your decision.
- Limits: memory `NEO_EMBEDDER_MEM` (no swap on top), `NEO_EMBEDDER_CPUS` CPUs, the same number of
  threads, `cpu_shares` 256, a pids limit, and `NEO_EMBEDDER_MAX_BATCH_TOKENS` (2,048) tokens in one
  batch. TEI's default batch (16,384 tokens) makes the warm-up go past the memory cap, so the container is
  killed at each start. All capabilities are dropped and `no-new-privileges` is on.
- Machine-local changes (for example, the memory cap) go in `tools/history/embedder.local.env`
  (untracked). Then run `install.ts` again.

### Change the model

The model tag (`<model>@<dims>:<revision prefix>`) keeps each model's vectors apart, so search never
mixes two models.

1. Start a second TEI container for the next model on another loopback port. Its key must be in the env
   variable that `next.keyEnv` names. `install.ts` manages only `neo-embedder`, so this step is by hand.
2. Set `history.next` in `config.json`: the same fields as `history.embedder` (url, keyEnv, model,
   revision, dims). If `dims` differs, ops must first make a new `neo_*` collection and a new key, and
   `next.collection` names it. Reload Neo.
3. The indexer embeds all text for the next tag too. `admin.ts status` shows the coverage of each tag.
4. At full coverage, copy the next model's values into `history.embedder`, remove `history.next`, put the
   new model and revision in `embedder.env`, run `install.ts`, and reload Neo.
5. The old tag's points and vectors are deleted `history.retireAfterDays` (7) days later. If the old
   model was in another collection, ask ops to delete that collection.

## Admin commands

`tools/history/admin.ts` uses the engine's own code and loader. It never prints a key.

| Command | What it does |
| --- | --- |
| `status [--db <file>]` | Service states (with the step when one is off), coverage of each tag, verify-tag count, queued point deletes, the writer lock. |
| `copy-ledger --to <file> [--from <ledger>]` | A consistent read-only copy of the ledger. Refuses a target in `data/` and a file that exists. |
| `backfill --ledger <copy> --db <file> [--verify]` | Indexes a ledger copy into a scratch store outside `data/`. Without `--verify`, nothing goes to Qdrant. With it, points go under the tag `<tag>~verify`, only if the collection holds no other tag. |
| `verify-clean` | Deletes the verify-tag points and checks that the count is 0. |
| `forget <ref> --reason <text> [--db <file>]` | Forgets one entry. |
| `rescan-secrets [--db <file>] [--dry-run]` | Checks every stored chunk with today's secret finder and forgets each whole entry with a match. `--dry-run` only lists them. |

`NEO_DIR=<folder>` names the Neo folder whose config and `data/` are used. The model flags
(`--embedder-url`, `--model`, `--revision`, `--dims`, `--key-env`) point a command at another embedder.

`tools/history/eval.ts` measures recall@k, MRR and latency for words only, meaning only and hybrid over
`tools/history/eval-set.json`.

## Key rotation

The engine reads `SHARED_QDRANT_API_KEY` and `HISTORY_EMBEDDER_KEY` once, at start. When ops rotates the
Qdrant key, meaning search goes off (`vectors_key_rejected` from the probe, `vectors_refused` from any
other call) until the daemon reloads. Keyword search
continues. The reload is your decision.

## Backups

`history.db` holds archived entries and remembered entries, which exist nowhere else. A snapshot backup
runs each night into `/var/backups/neo`, with a weekly restore drill. The runbook, the failure codes and
the restore steps are in `docs/backup.md`. The Qdrant collection needs no Neo backup: Neo uploads it again
from `history.db`.
