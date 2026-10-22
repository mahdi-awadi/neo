---
approval: required
---
# Shared Tools Catalogue + Tool Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tracked catalogue of shared tools (`docs/tools/*.md`). Each active card becomes a
`neo-tool-*` skill. API tools go through an engine relay that keeps the keys. Workers ask
`tools_for(task)` for a deterministic, ranked set of matching tools, recipes and skills. A fresh
dispatch starts with a 3-line tools hint. The catalogue improves from usage and from a worker-run
enrichment loop.

**Architecture:** One deep module, `src/engine/tools-catalogue.ts`: `openCatalogue(deps) →
Catalogue { cards, errors, find, hint, relay, render }`. It has two real seams: `SkillSource`
(fs | fake) and `UsageSource` (ledger | fake). Its thin users are `tools/catalogue/install.ts`, the
`tool_api` and `tools_for` tools in `neoMcpServers`, the hint in `dispatchToProject`, and a
`skillify` attention producer. Search is SQLite FTS5 BM25. It reuses `memory-recall.ts`
`safeFtsQuery`, extended with an any-word mode. There is no migration.

**Tech Stack:** Bun 1.3 + TypeScript, `bun:sqlite` FTS5, `Bun.YAML.parse`, zod, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-tools-catalogue-design.md` (§1–9 + Amendment 1, A1–A12). ADR-0044 + Amendment 1.

## Global Constraints

- No AI in the engine: search is BM25 plus counts; the relay acts only on a worker's call; the worker judges.
- Fail closed: `tools.relayEnabled` defaults to `false`. Every config value falls back to the spec default (the `readNotesCfg` pattern). The defaults are in spec §5 + A12.
- Key values never go into a card, skill, event, reply or log. `tools_miss` stores terms only (≤ 24 words), never a brief.
- Operator-only: the `tools` dep (`DispatchDeps.tools?: Catalogue`) is stripped at the ingress (`tools: undefined`, like `notes`). The tools hint is never on a resume, the ingress, or a tainted run.
- Reuse: `findSecret`, `safeFtsQuery`, `openSqlite`, `ledger.recordEvent`, `tool_actions`, the `project_notes` gate, the notes-block injection point, the `AttentionDraft` producers, the `tools/security/install.ts` install pattern, and `tools/create-loop.ts`.
- Work in the worktree on `feat/tools-catalogue`. At the end of each phase, merge to `dev` when it is green. Never merge to master, restart, run `install.ts` on the real `~/.claude`, or enable a loop without the operator.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (use `git commit -F <file>`).

## Review Focus

- A card whose `env` list holds a pasted key value → a validation error that does not echo the value (P1 T1).
- A hand-made `neo-tool-x` folder in `~/.claude/skills` survives a re-install (P1 T3).
- A secret nested deep in a relay body → refused on a `dataLeavesHost` card (P1 T4).
- A 50 kB or Arabic brief → bounded cost, no throw. Arabic → a miss, not an error (P2 T6).
- A company session servicing a customer message never lists `tool_api` or `tools_for` and never gets a hint (P1 T4, P2 T7).

---

## Phase 1 — catalogue, skills, relay

### Task 1: Load and validate tool cards
**Files:** create `src/engine/tools-catalogue.ts` and `tests/tools-catalogue.test.ts`; modify `src/config.ts` (`tools: readToolsCfg(fileCfg.tools)`).
**Interfaces (produces):** `ToolKind = "mcp"|"cli"|"api"|"recipe"`, `CardStatus`, `RelaySpec`, `RecipeStep {card; do}`, `ToolCard { id; kind; status; owner; when; scope; env; cost; limits; dataLeavesHost; tags; examples; usage?: {tools?; commands?}; relay?; steps?; body; file }`, `ToolsCfg` (all keys of spec §5 + A12), `DEFAULT_TOOLS_CFG`, `readToolsCfg(raw)`, `parseCard(file, text, cfg)`, `loadCards(dir, cfg): { cards; errors }`.
- [ ] Step 1: failing tests: every §2 rule plus the A2 rules gives one `<file>: <field>` error. They cover: an active card without `tags`/`examples`; > 12 tags; a recipe step naming a missing, candidate or recipe card; a recipe with `relay`; a value-looking `env` entry (the error must not contain it); no front matter; duplicate ids. `readToolsCfg` falls back to the defaults on bad types.
- [ ] Step 2: `bun test tests/tools-catalogue.test.ts` → FAIL.
- [ ] Step 3: implement (`Bun.YAML.parse` inside try/catch; check recipe steps after all cards are loaded).
- [ ] Step 4: the test and `bunx tsc --noEmit` → PASS. Step 5: commit `feat(tools): tool cards and their validator (ADR-0044, P1.1)`.

### Task 2: The first cards + the real-catalogue test
**Files:** `docs/tools/README.md`; cards `shared-browser, security-kit, disk-kit, create-loop, codebase-memory, playwright, chrome-devtools, stitch, project-notes, eticket-data-mcp` (active, with tags, examples and usage globs) and `scaledown` (candidate, relay `https://api.scaledown.xyz`, `x-api-key`, `SCALEDOWN_API_KEY`, op `compress POST /compress/raw/`, `maxBodyBytes: 262144`, `dataLeavesHost: true`).
- [ ] Step 1: failing test: `loadCards("docs/tools")` gives `errors: []`. scaledown is a candidate with `dataLeavesHost`. `eticket-data-mcp.scope` deep-equals `["eticket-v3"]`.
- [ ] Step 2: FAIL. Step 3: write the cards from `docs/research/2026-10-22-tools-inventory.md` and each tool's own doc. Step 4: PASS. Step 5: commit `docs(tools): the first tool cards (ADR-0044, P1.2)`.

### Task 3: Render skills + install
**Files:** `tools/catalogue/install.ts`, `tests/tools-catalogue-install.test.ts`.
**Interfaces (produces):** `renderSkills(cards): Array<{dir; files}>` (`neo-tool-<id>` / `neo-recipe-<id>`, files `SKILL.md` + `.neo-tool` marker); `installCatalogue({src, claudeDir, cfg, dryRun?}): {written; removed; errors}`.
- [ ] Step 1: failing tests: one skill per active card and none for candidate or retired cards. The description is `JSON.stringify`-quoted and parses back with `Bun.YAML.parse` even with `: "#`. A marked stale folder is removed; an unmarked `neo-tool-hand` is kept. A second run leaves the mtimes unchanged. Catalogue errors → `skills/` is byte-identical. `dryRun` writes nothing.
- [ ] Steps 2–4: FAIL → implement → PASS. Run it only against `--claude-dir $(mktemp -d)` (10 folders). Step 5: commit `feat(tools): active cards become neo-tool skills (ADR-0044, P1.3)`.

### Task 4: The API relay + `tool_api`
**Files:** `src/engine/tools-catalogue.ts` (`relayCall`); `src/engine/ledger.ts` (`countEvents({kind, folder, since})`, a parameterized COUNT); `src/engine/dispatch.ts` (`DispatchDeps.tools?`, the `tool_api` tool); `src/engine/ingress.ts` (`tools: undefined`); `src/daemon.ts` (wiring); `tests/tools-relay.test.ts`, `tests/ledger.test.ts`.
**Interfaces (produces):** `RelayCtx { project; folder; cfg; env; ledger: Pick<Ledger,"recordEvent"|"countEvents">; fetch; now }`; `relayCall(cards, cardId, op, body, ctx): Promise<string>`.
- [ ] Step 1: failing tests: one test per §4 check, each with 0 fetches and a reply naming the check. The nested-secret case. The cap (200 events in 24 h refuse; events at 25 h do not count). A good call → 1 fetch with the header from `ctx.env`, and 1 `tool_api` event without the body or the sentinel key. A hanging fetch → a timeout reply, no throw. The ingress `neoMcpServers` has no `tool_api`; with `tools` it has one. `countEvents` filters by kind, folder and since.
- [ ] Steps 2–4: FAIL → implement → `bun test && bunx tsc --noEmit` PASS. Step 5: commit `feat(tools): API relay — keys stay in the engine, fail-closed, capped, metered (ADR-0044, P1.4)`. **Merge P1 → dev.**

## Phase 2 — tool search, `tools_for`, the hint

### Task 5: `safeFtsQuery` any-word mode
**Files:** `src/engine/memory-recall.ts`, `tests/memory-recall.test.ts`.
**Interfaces (produces):** `safeFtsQuery(query: string, opts?: { mode?: "all"|"any"; stopWords?: ReadonlySet<string>; maxTerms?: number }): string`. The default stays `"all"`, so memory recall is unchanged.
- [ ] Step 1: failing tests: `any` joins with ` OR `; stop words are dropped; more than `maxTerms` terms are cut, keeping the longest (the rarest-first ranking uses FTS document frequency in Task 6; here the plain cut keeps the longest words); quotes are still escaped. The existing `all` tests stay green.
- [ ] Steps 2–5: FAIL → implement → PASS → commit `feat(memory): safeFtsQuery any-word mode (ADR-0044, P2.1)`.

### Task 6: `openCatalogue` + `find` (+ derived project capabilities)
**Files:** `src/engine/tools-catalogue.ts`; `src/engine/tool-skills.ts` (`fsSkillSource`); `tests/tools-find.test.ts`.
**Interfaces (produces):** `SkillSource { global(): SkillRow[]; project(folder): SkillRow[] }` with `SkillRow { id; when }`; `UsageSource { okUses(cardIds): Map<string, number>; p50(cardId): number | undefined }`; `openCatalogue({dir, cfg, skills, usage, ledger}): Catalogue`; `ToolMatch` exactly as in spec A1.
- [ ] Step 1: failing tests (fake sources): the A9 #7 screenshot query ranks `shared-browser` first, and `why` contains `tags: screenshot, rtl`. The same query twice gives the same order. Stop words only → `[]` plus 1 `tools_miss` with terms only. The A9 #9 scope cases (default hidden; `showDisallowed` → `allowed:false`). waselni project skills never appear for eticket-v3. A broken `SKILL.md` is skipped. A 50 kB brief returns within the test timeout. An Arabic brief → `[]`, no throw. Candidate and retired cards are never returned.
- [ ] Steps 2–4: FAIL → implement (in-memory FTS5 `t(id, kind, when, tags, examples, body)`; project skill rows go in a temp table per call; `bm25(t,0,0,4,3,2,1)` negated, × usage boost; a stable tie order) → PASS. Step 5: commit `feat(tools): deterministic tool search over cards and skills (ADR-0044, P2.2)`.

### Task 7: `tools_for` + the tools hint
**Files:** `src/engine/dispatch.ts` (the `tools_for` tool; the hint after the notes block); `src/engine/pipeline.ts` (hint for operator paths only if listed in `hintPaths`); `tests/tools-for.test.ts`.
**Interfaces (produces):** `Catalogue.hint(brief, ctx): string`; tool `tools_for({ task: z.string(), limit: z.number().int().min(1).max(10).optional() })`.
- [ ] Step 1: failing tests: the reply format (`id · kind · allowed`, `why`, `how`, cost/limits), capped at `replyMaxChars`. A fresh dispatch with a matching brief → the task starts with the hint, after the notes block, and the recorded order equals what the worker gets. A kept resume → no hint. Ingress → no `tools_for` and no hint. A path not in `hintPaths` → no hint. The hint length is ≤ `hintMaxChars`. No match → no hint and no empty header.
- [ ] Steps 2–4: FAIL → implement (through `faults.guard`, like the notes block) → PASS. Step 5: commit `feat(tools): tools_for and the dispatch tools hint (ADR-0044, P2.3)`. Run the preamble-length test (the preamble + codebase-memory line < 5000 chars). **Merge P2 → dev.**

## Phase 3 — recipes, usage, cost/latency

### Task 8: Ledger usage source + p50
**Files:** `src/engine/ledger.ts` (`toolUsage({since}): Array<{tool; label; ok: boolean}>`, one parameterized query joining `tool_actions` to each order's last outcome); `src/engine/tools-catalogue.ts` (`ledgerUsageSource(ledger, cards, cfg)`: glob mapping, cache `usageCacheMs`; p50 from `tool_api` events); `tests/tools-usage.test.ts`.
- [ ] Step 1: failing tests: the A9 #8 cases (5 `done` beats 0; `failed` does not count; > 30 days does not count). A `commands` glob matches a Bash label. The cache: a second call within `usageCacheMs` does not query again. p50 is computed from 3 events.
- [ ] Steps 2–5: FAIL → implement → PASS → commit `feat(tools): ranking learns from what worked (ADR-0044, P3.1)`.

### Task 9: The first recipes
**Files:** `docs/tools/recipe-deploy-check.md`, `recipe-prod-readonly-query.md`, `recipe-e2e-test.md`, `recipe-store-build.md` (scoped to the projects that have those tools); the test.
- [ ] Step 1: failing test: the real catalogue loads with 0 errors, has 4 recipes, and `find("check the deploy is healthy")` returns `recipe-deploy-check` in the top 3.
- [ ] Steps 2–5: FAIL → write the recipes from the existing project skills and memory notes (read-only; no writes outside Neo) → PASS → commit `docs(tools): first recipes (ADR-0044, P3.2)`. **Merge P3 → dev.**

## Phase 4 — enrichment loop, skillify

### Task 10: `skillify` attention producer
**Files:** `src/engine/producers/skillify.ts` (`skillifyDrafts(deps: { ledger; catalogue; projects; cfg }, now): AttentionDraft[]`); wire it into the scan next to `engineDrafts`; `tests/producer-skillify.test.ts`.
- [ ] Step 1: failing tests: the A9 #12 cases (3 reordered titles → 1 item; a 4th → still 1 via the upsert ref `skillify:<sorted words>`; a matching recipe → none; another project's todos do not count).
- [ ] Steps 2–5: FAIL → implement → PASS → commit `feat(tools): suggest a recipe or skill when a task repeats (ADR-0044, P4.1)`.

### Task 11: `tools-enrich` loop definition
**Files:** `docs/loops/tools-enrich.json` + `docs/loops/tools-enrich.prompt.md` (the checked-in `LoopInput`, the same shape as `security-sweep.json`); `docs/loops.md`. Loading it into the live ledger with `bun tools/create-loop.ts docs/loops/tools-enrich.json` is an operator step after the restart. This plan never writes `loop_defs`.
- [ ] Step 1: failing test (in `tests/loop-validate.test.ts`): `tools-enrich.json` passes `loop-validate` with a weekly cron and the goal command `bun test tests/tools-catalogue.test.ts`. Its prompt names the `tools_miss` terms source and forbids promoting a card to `active`.
- [ ] Steps 2–5: FAIL → create → PASS → commit `feat(tools): weekly worker-run catalogue enrichment, off by default (ADR-0044, P4.2)`. **Merge P4 → dev.**

## Phase 5 — docs, review, (gated) ScaleDown pilot

### Task 12: Docs + preamble + review
**Files:** `src/engine/dispatch.ts` (one preamble sentence: "Shared tools: your `neo-tool-*`/`neo-recipe-*` skills; ask `tools_for` which fit; API tools go through `tool_api`."); `docs/CONFIG.md`; `docs/HISTORY.md`; `CLAUDE.md` (status + map); ADR-0044 → accepted; `HANDOFF.md`.
- [ ] Step 1: failing test: the preamble contains `tools_for`, and the preamble + codebase-memory line < 5000 chars. Steps 2–4: implement → PASS.
- [ ] Step 5: `/security-review` (the relay handles input and keys). Then superpowers:requesting-code-review. Fix the findings. Run the full `bun test` + `bunx tsc --noEmit` green.
- [ ] Step 6: commit `docs(tools): catalogue docs, preamble line, ADR-0044 accepted (P5.1)`. Merge → dev. Remove the worktree (the branch stays).

### Task 13 (operator-gated, not part of approval): ScaleDown pilot
Only after (a) a signed or published DPA, and (b) a known quota: flip `scaledown.md` to `active`, set `tools.relayEnabled: true`, and measure for 2 weeks with `tool_api` events.

## What goes live when (operator steps)

| Piece | How it goes live |
|---|---|
| Cards, recipes, `neo-tool-*` skills | `bun tools/catalogue/install.ts` (writes `~/.claude/skills`). The next worker start sees them. **No restart.** |
| `tool_api`, `tools_for`, the tools hint, the usage boost, `tools_miss`, skillify | dev → master + **daemon restart** |
| The relay actually calling out | after the restart + `tools.relayEnabled: true` in `config.json` |
| `tools-enrich` loop | after the restart: `bun tools/create-loop.ts docs/loops/tools-enrich.json` |
