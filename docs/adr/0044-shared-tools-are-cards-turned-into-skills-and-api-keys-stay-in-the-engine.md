# Shared tools are cards that become skills, and API keys stay in the engine

**Status:** proposed (2026-10-22; waits for the operator's approval). Related: ADR-0024 (security
kit), ADR-0031 (project fence), ADR-0032 (shared browser), ADR-0043 (`project_notes`, the same tool
gate), context-efficiency spec §8 (no engine-side AI).

Neo and the projects already have many tools: MCP servers, host CLIs in `tools/`, and external APIs
whose keys are spread across `.env` files. A worker learns about them only by chance. It may read a
`docs/*.md` file, find an MCP server in its tool list, or get a sentence in the dispatch preamble.
Nothing lists which tools exist, who may use them, or what they cost. API keys are copied into each
project that needs them. The operator asked for "skills, but for tools".

## Decision

1. **One tools catalogue: `docs/tools/<id>.md`, one tool card per tool**, tracked in this repo. The
   front matter is checked by a validator in a test. It holds `id`, `kind` (`mcp | cli | api`),
   `status` (`active | candidate | retired`), `owner`, `when` (the when-to-use line, capped in
   length), `scope` (`all` or a list of projects), `env` (key NAMES only), `cost`, `limits` and, for
   `api` cards, `relay` (base URL, auth header, env key name, allowed operations with methods, paths
   and a body cap) and `dataLeavesHost`. The body says how to call the tool and when NOT to use it.
2. **Each `active` card becomes a tool skill.** `bun tools/catalogue/install.ts` renders every active
   card into `~/.claude/skills/neo-tool-<id>/SKILL.md`. The card's `when` line is the skill
   description, and the card body is the skill body. The command uses the same idempotent install
   pattern as `tools/security/install.ts`. Workers already load user skills
   (`settingSources: ["user", …]`, `skills: "all"`), so every Claude worker in every project sees a
   when-to-use line for every shared tool, and we add no new channel into the prompt. Generated
   folders carry a marker file, so a re-install removes skills for retired cards and never touches
   other skills. `candidate` and `retired` cards are never rendered.
3. **API keys stay in the engine: the API relay.** An `api` card is reached only through one
   engine-side worker tool, `tool_api` (call: card id, operation, JSON body). The engine checks the
   call against the card: the card is active, the operation is declared, the body is within the cap,
   and the call is within the per-day cap in `config.tools`. For a `dataLeavesHost` card it also
   refuses text that matches `secret-patterns.ts`. Then it adds the key from its own env, makes the
   call and records it in the ledger (card, operation, project, bytes, status, latency; never the
   body). The key never goes into a project, a brief, a log or a skill.
4. **The relay is behind the same gate as `ask_operator` and `project_notes`:** operator workers
   only. Customer, ingress and tainted runs get no MCP, so they never reach it. The tool goes through
   the governor like any other Neo MCP tool. The engine never calls an API by itself: a worker
   decides, the engine acts. So a relay to an AI API (for example ScaleDown) is not engine-side AI.
5. **Skills are inventoried, not carded.** A skill is already self-describing. The catalogue covers
   tools only. The inventory of skills lives in the research note.

## Alternatives rejected

- **One big "neo-tools" index skill with per-tool reference files.** It costs fewer description
  tokens, but one broad description triggers badly. The operator asked that *each* tool has its own
  when-to-use line. A per-card cap on `when` keeps the cost bounded.
- **Hand-written skills, no cards.** They drift, and nothing checks key names, scope or status. The
  validator and generator keep one source of truth (the same reasoning as `tools/create-loop.ts` for
  loops).
- **Copy each API key into each project's `.env`.** This is today's pattern. It spreads secrets
  across repos and agents, and nothing meters it or turns it off from one place.
- **A host CLI that reads `/home/neo/.env` for workers.** A worker in another project would run a
  Neo file that reads Neo's secrets. The secret guard and the project fence would have to make
  exceptions, and nothing could gate it per run (customer or tainted runs). The in-process MCP tool
  already has that gate.
- **A third-party MCP gateway or marketplace.** It is another daemon and another secret store, on a
  public host. The engine already has an in-process MCP server with a governor in front of it.

## Consequences

- Adding a tool = write a card, run `bunx tsc --noEmit && bun test` (the validator), then
  `bun tools/catalogue/install.ts`. A new `api` card also needs its key name in the engine `.env`.
- Known gap (same as `project_notes`): Codex runs and loops do not get Neo's MCP tools, so they do
  not get the relay. They still see the tool skills (Claude loops) or nothing (Codex). This is a
  follow-up, not part of this ADR.
- Project-owned APIs (for example OTPIQ for waselni) stay in their project and are carded with
  `scope: [project]`, without a relay, until the operator moves a key into the engine.

## Amendment 1 (2026-10-22, before approval): a project asks Neo "what tools fit this task?"

The operator added: workers should be able to ask Neo which tools fit a task, and Neo should offer
the best few tools by itself. The engine stays free of AI.

6. **Tool search is deterministic.** The catalogue is indexed in an in-memory SQLite FTS5 table.
   This reuses `memory-recall.ts` (`safeFtsQuery`, `bm25`), extended with an *any-word* mode,
   because a whole brief must match on SOME words, not all of them. The indexed fields are the
   card's `when`, `tags`, `examples` and body, weighted in that order. The skill descriptions
   already installed on the host (user, plugin and the project's own) are indexed as read-only
   `skill` entries, so one search answers "tools, APIs, skills and services". Ranking: BM25 first,
   then a usage boost from the ledger's `tool_actions` rows (only orders that ended `done`, last 30
   days). The boost is counted, not judged.
7. **`tools_for(task)` is a Neo MCP tool.** It returns the top N matches. For each: id, kind, the
   matched words (the *why*, computed from the query and the fields, never generated), how to call
   it, cost and limits, and whether the calling project may use it. **Choosing a tool stays with
   the worker.** A search whose best score is below the threshold is recorded as a `tools_miss`
   event, so the gaps in the catalogue are visible.
8. **The tools hint.** On a genuine fresh start (the same place as the notes block and the memory
   snapshot; never on a resume, the ingress, or a tainted run), the engine puts at most
   `tools.hintMaxCards` (3) tool lines, within `tools.hintMaxChars`, at the start of a brief. It
   uses the same search, on the brief text. Below the score threshold there is no hint at all. The
   hint ends with "ask `tools_for` for more".
9. **Recipes are cards.** `kind: recipe` is a named chain of steps over other card ids for a common
   task (deploy check, prod read-only query, E2E test, store build). The validator checks that
   every step names an active card. Recipes become skills and are searchable like tools.
10. **Enrichment is done by a worker, never by the engine.** A loop (`tools-enrich`, off by
    default) gives a worker the `tools_miss` queries and the card files. The worker improves
    `tags` and `examples` and commits through the normal review path. The validator gates the
    result. This is "AI decides, engine acts" applied to the catalogue itself.
11. **ScaleDown is not in the engine path, and the catalogue is not compressed** (measured: it lost
    3 of 5 facts on the catalogue and 6 of 9 on a handoff). It stays a `candidate` for one
    worker-side use: asking one question of a big, non-sensitive text.

### Alternatives rejected (amendment)

- **Asking an LLM to pick the tools (ScaleDown Classify/Decisions, Gemini, or a Claude sub-call).**
  That puts AI in the engine and is not reproducible. The worker is already the AI and can judge the
  top N.
- **Embeddings / vector search.** It needs an embedding model (more AI, more processors) for a
  catalogue of about 20–50 cards, where BM25 with curated tags is enough. The memory plan already
  defers embeddings behind the same interface. The same applies here.
- **Injecting the whole catalogue into every brief.** It costs context on every run. The skills
  already carry one line per tool; the hint adds only the best 3.
- **A separate manifest file in each project.** Writing into other repos breaks ADR-0031. The
  project's capabilities are *derived* at query time instead: card `scope`, plus the project's own
  `.mcp.json` server names and `.claude/skills` descriptions, read-only.
