---
approval: required
---
# Shared tools catalogue — design (ADR-0044)

**Order (operator, 2026-10-22):** a shared tools catalogue for Neo and every project ("like skills,
but for tools and APIs"), and an evaluation of the ScaleDown API.
**Inputs:** `docs/research/2026-10-22-tools-inventory.md`,
`docs/research/2026-10-22-scaledown-evaluation.md`. **Decision:** ADR-0044. **Terms:** `CONTEXT.md`
§ Shared tools.

## 1. The seam

There is one module, `src/engine/tools-catalogue.ts`, with a small interface:

```ts
loadCatalogue(dir: string): { cards: ToolCard[]; errors: string[] }   // parse + validate every docs/tools/*.md
renderSkill(card: ToolCard): { dir: string; files: Record<string, string> } // active card → SKILL.md
relayCall(cat, card id, op, body, ctx): Promise<string>                 // the API relay, all guards inside
```

Three thin users sit around it:
- `tests/tools-catalogue.test.ts` validates the real `docs/tools/` in CI, so a bad card fails `bun test`.
- `tools/catalogue/install.ts` writes the tool skills into `~/.claude/skills/`.
- The `tool_api` tool in `neoMcpServers` calls `relayCall`.

## 2. The tool card (`docs/tools/<id>.md`)

```yaml
---
id: shared-browser            # = file name; [a-z0-9-]{2,40}
kind: cli                     # mcp | cli | api
status: active                # active | candidate | retired
owner: neo                    # the project that maintains it
when: "Use when a worker needs a real browser: screenshots, E2E checks, RTL checks of a page."  # ≤ 300 chars
scope: all                    # all | [project, …]
env: []                       # key NAMES only; a value-looking entry is a validation error
cost: "free (host)"
limits: "3 GB RAM, 4 concurrent sessions"
dataLeavesHost: false
relay:                        # api cards only
  baseUrl: https://api.example.com
  authHeader: x-api-key
  envKey: EXAMPLE_API_KEY     # must also appear in `env`
  maxBodyBytes: 65536
  operations:
    - { name: compress, method: POST, path: /compress/raw/ }
---
## How to call
…
## When NOT to use
…
```

The validator collects every error (it does not stop at the first one). Rules:
- Every required field is present.
- `id` matches the file name. `kind` and `status` are in their enums.
- `when` is no longer than `tools.whenMaxChars`.
- `env` holds names that match `^[A-Z][A-Z0-9_]*$`. A value that `findSecret` flags is an error.
- `relay` is present **only** on `api` cards. An active `api` card **must** have one.
- `relay.baseUrl` is `https:`. `relay.envKey` is in `env`. Each operation has a method in
  `GET|POST` and a path that starts with `/`.
- The body has the `## How to call` and `## When NOT to use` sections.

## 3. Tool skills (install)

`bun tools/catalogue/install.ts [--claude-dir ~/.claude] [--dry-run]`:
- For each **active** card it writes `<claude-dir>/skills/neo-tool-<id>/SKILL.md`. The front matter
  is `name: neo-tool-<id>`, plus `description:` = `when` + " (scope: …)". The body is the card
  body, a generated-file header and the scope line. The folder also gets a `.neo-tool` marker.
- It removes every `neo-tool-*` folder that has the marker but no active card. A folder without the
  marker is never touched.
- It refuses to install (exit 1, nothing changed) if `loadCatalogue` reports any error.
- Running it again changes nothing (the same pattern as `tools/security/install.ts`).
- Scope: a skill is global (user skills), so its description names the scope. A worker in another
  project reads "scope: eticket-v3" and knows the tool is not for it. Per-project skill folders
  would mean writing into other repos, which ADR-0031 forbids.

## 4. The API relay

The worker tool `tool_api({ card, operation, body })` lives in the `neo` MCP server. Its gate is the
same one `project_notes` uses: an operator dep `tools` (the opened `Catalogue`). The ingress path strips it explicitly
(`tools: undefined`, like `notes`). Loops and Codex do not get it (the known gap, ADR-0044).

`relayCall` checks these, in this order. The first refusal returns a plain-text reason, and nothing
is sent.
1. The relay is enabled: `config.tools.relayEnabled`, default **false**, so it fails closed.
2. The card exists, is `active`, and is `kind: api`.
3. The operation is declared on the card.
4. The scope allows the calling project.
5. The serialised body is within `relay.maxBodyBytes`.
6. If `dataLeavesHost`, no string in the body matches `findSecret`.
7. The calling project has made fewer than `tools.maxCallsPerProjectPerDay` relay calls (all cards together)
   in the last 24 h, counted from the ledger events.
8. The key `process.env[relay.envKey]` is set. If it is missing, the reply names the key, never a
   value.

Then it makes **one** `fetch` with `AbortSignal.timeout(tools.timeoutMs)`. It sets the auth header
from the env and `content-type: application/json`. The reply is the response status plus the body,
cut to `tools.maxReplyChars`. The response body is never logged.

Ledger: `recordEvent("tool_api", { data: { card, operation, project, bytesOut, status, ms, refused? } })`.
This reuses the events table, so there is **no migration**. The daily cap counts these events.

The governor needs no change: `mcp__neo__*` is already allowed, and the relay's own guards are the
gate. A customer or tainted run never has the tool.

## 5. Config (`config.tools`, `docs/CONFIG.md`)

| Key | Default | Meaning |
|---|---|---|
| `relayEnabled` | `false` | the relay refuses everything until the operator sets this |
| `maxCallsPerProjectPerDay` | `200` | the cap for each project, all relay cards together |
| `timeoutMs` | `20000` | the timeout for one call |
| `maxReplyChars` | `20000` | the reply is cut to this |
| `whenMaxChars` | `300` | the validator's cap on `when` |
| `catalogueDir` | `docs/tools` | where the cards live |

A bad value falls back to the default, as `readNotesCfg` does.

## 6. First cards (from the inventory)

- `active`: shared-browser (cli), security-kit (cli), disk-kit (cli), create-loop (cli),
  codebase-memory (mcp), playwright (mcp), chrome-devtools (mcp), stitch (mcp), project-notes (mcp).
- `active`, `scope: [eticket-v3]`: the eticket-v3 data MCPs (one card, `eticket-data-mcp`).
- `candidate`: **scaledown** (api, `dataLeavesHost: true`). It has a full relay block, so promoting
  it later means only changing its status. See the evaluation for why it is not active.
- Project-owned APIs (OTPIQ, Coolify, Cloudflare, Expo, R2) are **not** carded in this plan. Each
  needs the operator to decide whether its key moves into the engine. This plan lists them in the
  report and does not move any key.

## 7. Acceptance criteria

1. A card with a missing field, a bad enum, an `env` entry that looks like a value, a `relay` on a
   non-api card, or a missing section fails `loadCatalogue` with a message that names the file and
   the field. The real `docs/tools/` loads with zero errors (a test).
2. `install.ts` writes one skill per active card and none for candidate or retired cards. It removes
   a stale marked folder, keeps an unmarked `neo-tool-x` folder, changes nothing on a second run, and
   changes nothing when the catalogue has errors.
3. `relayCall` refuses (with no fetch) for each of the 8 checks in §4, and each refusal names its
   check. A good call sends exactly one request with the header from the env, and records one
   `tool_api` event without the body. A timeout returns a refusal-shaped reply, not a throw.
4. The ingress `neoMcpServers` never has `tool_api`. An operator worker has it only when the relay
   dep is wired (a test, mirroring the `project_notes` gate test).
5. No key value appears in any card, skill, event, reply or log (a test: a sentinel key value is
   absent from all of them).
6. Docs: `docs/tools/README.md` (how to add a card), CONFIG, HISTORY, the CLAUDE.md map, and one
   preamble sentence ("shared tools: your skills named `neo-tool-*`; API tools go through
   `tool_api`"). The preamble stays under its cap (see the HANDOFF gotcha: preamble +
   codebase-memory line < 5000 chars; measure it).

## 8. Edge cases

- A card file that is not markdown, or has no front matter: a validation error, never a crash.
- Two cards with the same `id`: an error.
- A `when` that contains YAML-breaking characters: the renderer quotes the description.
- An `api` card whose key is missing from the env: install still renders the skill (the skill only
  says how to call it). The relay refuses with "key EXAMPLE_API_KEY is not set".
- The upstream returns a 4xx or 5xx: it is passed through as a status and body, never retried
  automatically (no hidden spend).
- Restart-gated: the relay and the preamble line go live only after dev → master and a restart.
  The skills go live when `install.ts` runs, which needs the operator's go-ahead because it writes
  into `~/.claude`.

## 9. Not in scope

- Moving any project's key into the engine.
- MCP tools for loops and Codex.
- Promoting ScaleDown.
- Cards for skills.
- Fixing the eticket-v3 committed credential. It belongs to another project; Neo dispatches it.

---

# Amendment 1 — "what tools fit this task?" (ADR-0044 §6–11)

The operator's addition (2026-10-22): projects use Neo's tools efficiently, and Neo becomes truly
agentic. It stays inside Neo's rules: the engine searches and counts, the worker judges.

## A1. The seam, deepened (this replaces §1)

```ts
openCatalogue(deps: {
  dir: string; cfg: ToolsCfg;
  skills: SkillSource;      // reads installed skill descriptions (fs adapter | fake in tests)
  usage: UsageSource;       // per-card success counts + relay latency (ledger adapter | fake)
}): Catalogue

interface Catalogue {
  cards: ToolCard[]; errors: string[];
  find(text: string, ctx: { project: string; folder: string; limit?: number }): ToolMatch[];
  hint(brief: string, ctx: { project: string; folder: string }): string;   // "" when nothing scores
  relay(cardId: string, op: string, body: unknown, ctx: RelayCtx): Promise<string>;
  render(): Array<{ dir: string; files: Record<string, string> }>;       // skills for install.ts
}
interface ToolMatch {
  id: string; kind: ToolKind | "recipe" | "skill"; title: string;
  why: string[];            // the query words that matched, per field: "tags: deploy, coolify"
  how: string;              // the first lines of "## How to call" (≤ cfg.howMaxChars)
  cost?: string; limits?: string; p50Ms?: number;   // p50 only for relay cards with calls
  allowed: boolean; reason?: string;                // scope check for ctx.project
  score: number;
}
```

`SkillSource` and `UsageSource` are real seams: each has two adapters (filesystem/ledger, and a fake in
tests). Everything else is internal to `src/engine/tools-catalogue.ts`.

## A2. Card schema additions

- `tags: string[]` (≤ 12, lowercase words) and `examples: string[]` (≤ 6 one-line example tasks).
  These are required on active cards. They are what the search matches best.
- `usage: { tools?: string[]; commands?: string[] }`: glob patterns that map `tool_actions` rows to
  this card. `tools` is matched against the tool name (for example `mcp__codebase-memory__*`).
  `commands` is matched against a Bash label (for example `*tools/browser/*`). It is optional; a
  card without it gets no usage boost.
- `kind: recipe` cards have `steps: [{ card: <id>, do: "<one line>" }]` (2–10 steps) and no `relay`.
  The validator checks that every `card` is an active non-recipe card.

## A3. Tool search (`find`)

1. **Index:** an in-memory FTS5 table `(id, kind, when, tags, examples, body)`, built once when the
   catalogue is opened and rebuilt when it is reloaded. Skill rows hold only `when` = the skill's
   description. Skills are read from `~/.claude/skills/*/SKILL.md`, from the enabled plugins' skill
   folders, and from `<folder>/.claude/skills/*/SKILL.md` for the calling project. The project rows
   are indexed per query into a temp table, so another project's skills never show.
2. **Query:** reuse `safeFtsQuery` with a new `mode: "any"`: the words are joined with `OR`. A small
   stop-word list in config (`tools.stopWords`) is dropped. At most `tools.queryMaxTerms` (24) terms
   are used: the rarest ones first, measured by FTS5 document frequency.
3. **Score:** `bm25(t, 0, 0, 4.0, 3.0, 2.0, 1.0)` (when, tags, examples, body), negated so that
   higher is better, then `× (1 + cfg.usageWeight × ln(1 + okUses30d))`. A tie keeps the catalogue
   order, so the result is deterministic.
4. **Filter:** candidate and retired cards are never returned. A card the project may not use is
   returned with `allowed: false` only if `tools.showDisallowed` is set (default `false`).
5. **Miss:** if the best score is below `tools.minScore`, record `tools_miss {project, terms}` (the
   terms only, at most 24 words, never the full brief), and return `[]`.

## A4. `tools_for` (worker tool) and the tools hint

- `tools_for({ task: string, limit?: 1..10 })` lives in `neoMcpServers`, behind the operator dep
  `DispatchDeps.tools?: Catalogue` (the same dep as the relay), and
  the ingress strips it. It returns one block per match: `id · kind · allowed`, `why`, `how`,
  `cost/limits/p50`. The text is capped at `tools.replyMaxChars`.
- **Hint:** in `dispatchToProject`, on a genuine fresh start, right after the notes block, through
  `faults.guard`. `catalogue.hint(brief)` returns at most `hintMaxCards` lines of the form
  `- <id> (<kind>): <when>`. The block is capped at `hintMaxChars` and ends with `Ask tools_for for
  more.` If nothing scores, it returns `""`. It runs only on the worker paths listed in
  `tools.hintPaths` (default `["dispatch"]`), so it fits the per-path profiles of context-efficiency
  Phase 1. Operator sessions (`project`, `company`) can opt in.

## A5. Usage, cost and latency

- `UsageSource` (ledger adapter) reads `tool_actions` joined with each order's last outcome over 30
  days, through one parameterized query. It maps rows to cards with each card's `usage` globs,
  counts the `done` orders, and caches the result for `tools.usageCacheMs` (10 min). No migration.
- The relay's p50 latency comes from `tool_api` events (spec §4). Cost and limits come from the card.

## A6. Enrichment loop (worker side)

`docs/loops/tools-enrich.json` (checked in; the operator loads it with `tools/create-loop.ts` after the restart, so it runs only when they choose):
- Weekly, if there were any `tools_miss` events since the last run, the loop gives a worker the miss
  terms and asks it to improve `tags` and `examples` (and to propose new cards as `candidate`) in
  `docs/tools/`.
- The goal is that `bun test tests/tools-catalogue.test.ts` is green and committed on a branch.
- Promoting a card to `active` stays the operator's decision.

## A7. Skillify suggestions (deterministic)

A producer for attention items (ADR-0018, source `skillify`) runs daily. For each project, it groups
the last 30 days of todo titles and dispatch brief first lines by normalised word sets (lowercased,
stop words dropped, sorted). If one group has `≥ tools.skillifyMin` (3) members and no card or skill
already scores above `minScore` for it, it raises one attention item: "this task repeated N times:
make it a recipe or a skill?". **→ todo** sends it to a worker. The engine only counts.

## A8. Efficiency additions, ranked (impact / effort)

| # | Addition | Impact | Effort | Phase |
|---|---|---|---|---|
| 1 | `tools_for` + card `tags`/`examples` | high: every worker can find the right tool | low-med | P2 |
| 2 | Tools hint at dispatch | high: no extra call needed, about 3 lines | low | P2 |
| 3 | Recipes (deploy check, prod read-only query, E2E, store build) | high: removes re-discovery of multi-step chains | med | P3 |
| 4 | Usage boost + `tools_miss` | med: ranking learns from what worked; gaps become visible | low (reads existing `tool_actions`) | P3 |
| 5 | Derived project capabilities in `tools_for` | med | low | P2 (inside `find`) |
| 6 | Cost/latency hints | low-med | low | P3 |
| 7 | Enrichment loop | med: the catalogue gets better without the operator | low | P4 |
| 8 | Skillify suggestions | med-high over time | med | P4 |
| 9 | ScaleDown relay pilot (one-question extraction of a big text) | low-med | low, after DPA + quota | P5, operator-gated |

## A9. Acceptance criteria (amendment)

7. `find` on a fake catalogue: "take a screenshot of the RTL page" ranks `shared-browser` first,
   with `why` naming `tags: screenshot, rtl`. A query of only stop words → `[]` plus one
   `tools_miss`. The same input → the same order every time (test it twice).
8. The usage boost: two cards with equal BM25; the one with 5 `done` uses ranks first; `failed`
   uses do not count. Rows older than 30 days do not count.
9. Scope: a card scoped to `eticket-v3` is absent for `waselni` (by default), and shown with
   `allowed:false` when `showDisallowed` is set. Project skills of waselni never appear for
   eticket-v3.
10. The hint: a fresh dispatch whose brief matches → the order task starts with the hint (after
    the notes block). A kept resume → no hint. An ingress `neoMcpServers` → no `tools_for`. A path
    not in `hintPaths` → no hint. The hint is never longer than `hintMaxChars`.
11. Recipes: a recipe that points at a candidate card → a validation error. A good recipe renders
    to `neo-recipe-<id>` and is found by search.
12. Skillify: 3 todos "deploy check waselni prod" (with words reordered) in 30 days → 1 attention
    item. A 4th → still 1 (the existing upsert). With a matching recipe → none.
13. `tools_miss` and `tool_api` events never contain the full brief or a body (a test with a
    sentinel).

## A10. Edge cases (amendment)

- A brief in Arabic: FTS5 `unicode61` tokenises it, and cards are English, so there is likely a miss.
  That is acceptable. The miss feeds enrichment (cards may add Arabic `tags`).
- A huge brief (50 kB): only the rarest `queryMaxTerms` terms are used, so the cost is bounded.
- A broken `SKILL.md` front matter: the skill is skipped, and search never throws (fail open to fewer
  rows).
- `tool_actions` was pruned: the counts are lower, and the ranking is still deterministic.

## A11. What needs a daemon restart

- **Restart-gated** (`dev` → master + restart): the `tool_api` relay, `tools_for`, the tools hint,
  the usage boost, `tools_miss`, and the skillify producer.
- **Not restart-gated:** the cards, and the skills written by `install.ts` (picked up when the next
  worker starts). The `tools-enrich` loop definition is data (created with `tools/create-loop.ts`),
  but the loop runs only on a daemon that has this code, so in practice it also comes after the
  restart.

## A12. Config additions (`config.tools`)

| Key | Default | Meaning |
|---|---|---|
| `stopWords` | a short English list (in code, can be overridden) | dropped from queries |
| `queryMaxTerms` | `24` | the most terms a query uses (the rarest first) |
| `minScore` | `0.5` | the best negated-BM25 score below this is a miss, with no hint |
| `usageWeight` | `0.3` | the strength of the usage boost |
| `usageCacheMs` | `600000` | how long the usage counts are cached |
| `showDisallowed` | `false` | return out-of-scope cards with `allowed:false` |
| `findLimit` | `5` | the default `tools_for` result count (max 10) |
| `replyMaxChars` / `howMaxChars` | `4000` / `400` | caps on the `tools_for` reply and on each `how` |
| `hintMaxCards` / `hintMaxChars` | `3` / `500` | caps on the tools hint |
| `hintPaths` | `["dispatch"]` | the worker paths that get the hint |
| `skillifyMin` | `3` | how many repeats raise a skillify item |
