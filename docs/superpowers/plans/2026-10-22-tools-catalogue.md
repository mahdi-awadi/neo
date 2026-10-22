---
approval: required
---
# Shared Tools Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tracked catalogue of shared tools (`docs/tools/*.md`). Each active card becomes a
`neo-tool-*` skill that every Claude worker loads. API tools are reached through an engine relay that
keeps the keys in Neo's env.

**Architecture:** One module, `src/engine/tools-catalogue.ts` (load + validate, render, relay). Three
thin users: a test that validates the real cards, `tools/catalogue/install.ts` (writes the skills),
and the `tool_api` tool in `neoMcpServers`. No migration: relay calls are `tool_api` ledger events.

**Tech Stack:** Bun 1.3 + TypeScript, `Bun.YAML.parse` (built in, no new dependency), zod (already
used for MCP tools), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-tools-catalogue-design.md` (ADR-0044).

## Global Constraints

- The relay fails closed: `config.tools.relayEnabled` defaults to `false`.
- Defaults: `maxCallsPerProjectPerDay: 200`, `timeoutMs: 20000`, `maxReplyChars: 20000`,
  `whenMaxChars: 300`, `catalogueDir: "docs/tools"`.
- Key values never go into a card, a skill, an event, a reply or a log. `env` holds names that match
  `^[A-Z][A-Z0-9_]*$`.
- Reuse what exists: `findSecret` (`src/engine/secret-patterns.ts`), `ledger.recordEvent`, the
  `readNotesCfg` config pattern, the `project_notes` gate in `neoMcpServers`, and the idempotent
  install pattern of `tools/security/install.ts`.
- The ingress path strips the new dep explicitly (`toolsRelay: undefined`), as it does `notes`.
- No AI in the engine: the relay acts only on a worker's call.
- Work in a worktree on `feat/tools-catalogue`. Merge to `dev` when green. **No** merge to master,
  **no** restart, and **no** `install.ts` run against the real `~/.claude` without the operator's
  go-ahead.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (write the
  message to a file and use `git commit -F`).

## Review Focus

- A card whose `env` list holds a pasted key value instead of a name → a validation error that does not echo the value (Task 1).
- `install.ts` on a host where the operator hand-made a folder named `neo-tool-x` → it must survive (Task 2).
- A relay body with a secret nested deep in a JSON object or array → refused on a `dataLeavesHost` card (Task 3).
- An upstream that hangs → the call ends at `timeoutMs` with a reply, and the worker is not stuck (Task 3).
- A company session servicing a customer message (the ingress) → never lists `tool_api` (Task 4).

---

### Task 1: Load and validate tool cards

**Files:**
- Create: `src/engine/tools-catalogue.ts`
- Create: `tests/tools-catalogue.test.ts`
- Modify: `src/config.ts` (add `tools: readToolsCfg(fileCfg.tools)` and the `NeoConfig.tools` type)

**Interfaces:**
- Produces: `type ToolKind = "mcp"|"cli"|"api"`, `type CardStatus = "active"|"candidate"|"retired"`,
  `interface RelaySpec { baseUrl; authHeader; envKey; maxBodyBytes; operations: {name; method: "GET"|"POST"; path}[] }`,
  `interface ToolCard { id; kind; status; owner; when; scope: "all"|string[]; env: string[]; cost; limits; dataLeavesHost: boolean; relay?: RelaySpec; body: string; file: string }`,
  `interface ToolsCfg { relayEnabled: boolean; maxCallsPerProjectPerDay; timeoutMs; maxReplyChars; whenMaxChars; catalogueDir: string }`,
  `DEFAULT_TOOLS_CFG`, `readToolsCfg(raw: unknown): ToolsCfg`,
  `parseCard(file: string, text: string, cfg: ToolsCfg): { card?: ToolCard; errors: string[] }`,
  `loadCatalogue(dir: string, cfg: ToolsCfg): { cards: ToolCard[]; errors: string[] }`.

- [ ] **Step 1: Write the failing tests.** In `tests/tools-catalogue.test.ts` (temp dirs through the existing per-run temp root helper, ADR-0042):
  - `parseCard` on a good `cli` card → no errors, and every field is read.
  - Each spec §2 rule gives one error naming `<file>: <field>`: missing `when`; `kind: tool`; `status: on`; `id` ≠ file name; `when` of 301 chars; `env: ["sk-live-abc…"]` (the error must NOT contain the value); `relay` on a `cli` card; an active `api` card without `relay`; `relay.baseUrl: http://…`; `relay.envKey` not in `env`; an operation `method: DELETE`; a body without `## When NOT to use`.
  - No front matter → an error, and no throw.
  - `loadCatalogue`: two files with the same id → an error; it collects errors from several files.
  - `readToolsCfg({relayEnabled:"yes", timeoutMs:-1})` → the defaults (`relayEnabled:false`, `timeoutMs:20000`).
- [ ] **Step 2: Run** `bun test tests/tools-catalogue.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `parseCard`, `loadCatalogue` and `readToolsCfg`. The front matter is the YAML between the leading `---` lines, parsed with `Bun.YAML.parse` inside try/catch. Check `env` values with `findSecret` and report "env entry N is not a key name" without echoing it.
- [ ] **Step 4: Run** `bun test tests/tools-catalogue.test.ts && bunx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(tools): tool cards and their validator (ADR-0044, T1)`.

### Task 2: The first cards, and the real-catalogue test

**Files:**
- Create: `docs/tools/README.md` (how to add a card; the field table from spec §2)
- Create: `docs/tools/{shared-browser,security-kit,disk-kit,create-loop,codebase-memory,playwright,chrome-devtools,stitch,project-notes,eticket-data-mcp,scaledown}.md`
- Modify: `tests/tools-catalogue.test.ts`

**Interfaces:**
- Consumes: `loadCatalogue`, `DEFAULT_TOOLS_CFG` (Task 1).

- [ ] **Step 1: Write the failing test** `the real docs/tools catalogue loads with zero errors and has the scaledown candidate`: `loadCatalogue("docs/tools", DEFAULT_TOOLS_CFG)` → `errors` is `[]`; the card `scaledown` has `status === "candidate"`, `dataLeavesHost === true` and `relay.envKey === "SCALEDOWN_API_KEY"`; `eticket-data-mcp.scope` deep-equals `["eticket-v3"]`.
- [ ] **Step 2: Run** → FAIL (no cards).
- [ ] **Step 3: Write the 11 cards** from `docs/research/2026-10-22-tools-inventory.md`. Their facts (purpose, how to run, limits) come from that note and the tool's own doc (`docs/browser.md`, `docs/security-checks.md`, `docs/loops.md`, ADR-0040). Only `scaledown` has a `relay` block: `https://api.scaledown.xyz`, `x-api-key`, `SCALEDOWN_API_KEY`, op `compress POST /compress/raw/`, `maxBodyBytes: 262144`. Its "When NOT to use" lists the evaluation's "No" rows.
- [ ] **Step 4: Run** `bun test tests/tools-catalogue.test.ts` → PASS.
- [ ] **Step 5: Commit** `docs(tools): the first tool cards, ScaleDown as a candidate (ADR-0044, T2)`.

### Task 3: Render skills and install them

**Files:**
- Modify: `src/engine/tools-catalogue.ts` (add `renderSkill`)
- Create: `tools/catalogue/install.ts`
- Create: `tests/tools-catalogue-install.test.ts`

**Interfaces:**
- Produces: `renderSkill(card: ToolCard): { dir: string; files: Record<string,string> }` (`dir = "neo-tool-<id>"`, files `SKILL.md` and `.neo-tool`);
  `installCatalogue(opts: { src: string; claudeDir: string; cfg: ToolsCfg; dryRun?: boolean }): { written: string[]; removed: string[]; errors: string[] }`.

- [ ] **Step 1: Write the failing tests** (temp `claudeDir`):
  - `renderSkill` gives a `SKILL.md` whose front matter parses with `Bun.YAML.parse` to `{ name: "neo-tool-x", description: <when> + " (scope: all)" }`, even when `when` contains `: "#`.
  - `installCatalogue` with 2 active, 1 candidate and 1 retired card → `written` has exactly the 2 active dirs.
  - A marked stale `neo-tool-old` → in `removed`, and gone from disk. An unmarked `neo-tool-hand` → kept.
  - A second run → `written` holds the same paths, and the file mtimes do not change (write only on a content change).
  - A catalogue with 1 error → `errors` is non-empty, and `skills/` is byte-identical before and after.
  - `dryRun` → nothing is written.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `renderSkill` (quote the description with `JSON.stringify`, which is valid YAML) and `installCatalogue`. `install.ts` parses `--claude-dir` (default `~/.claude`) and `--dry-run`, calls `installCatalogue`, prints a summary and exits 1 on errors. Its header comment follows `tools/security/install.ts`.
- [ ] **Step 4: Run** `bun test tests/tools-catalogue*.test.ts && bunx tsc --noEmit` → PASS. Then run `bun tools/catalogue/install.ts --claude-dir $(mktemp -d) ` against a temp dir only, and check that 10 skill folders are written.
- [ ] **Step 5: Commit** `feat(tools): active cards become neo-tool skills, idempotent install (ADR-0044, T3)`.

### Task 4: The API relay and the `tool_api` worker tool

**Files:**
- Modify: `src/engine/tools-catalogue.ts` (add `relayCall`)
- Modify: `src/engine/dispatch.ts` (`DispatchDeps.toolsRelay?`, the `tool_api` tool in `neoMcpServers` behind it)
- Modify: `src/engine/ingress.ts` (strip: `toolsRelay: undefined`)
- Modify: `src/daemon.ts` (wire `toolsRelay` from `loadCatalogue(cfg.tools.catalogueDir)` for operator deps)
- Create: `tests/tools-relay.test.ts`

**Interfaces:**
- Modify: `src/engine/ledger.ts`: add `countEvents(opts: { kind: string; folder: string; since: number }): number`, a parameterized `SELECT COUNT(*) … WHERE kind=? AND folder=? AND at>=?`. The events are recorded with `folder` = the calling folder. Pruning keeps the newest `eventsKeep` rows, so a day's calls are always counted.
- Produces: `interface RelayCtx { project: string; folder: string; cfg: ToolsCfg; env: Record<string,string|undefined>; ledger: Pick<Ledger,"recordEvent"|"countEvents">; fetch: typeof fetch; now: () => number }`;
  `relayCall(cards: ToolCard[], cardId: string, op: string, body: unknown, ctx: RelayCtx): Promise<string>`;
  `DispatchDeps.toolsRelay?: { cards: ToolCard[]; cfg: ToolsCfg }`.

- [ ] **Step 1: Write the failing tests** with a fake `fetch` that records its calls, and a fake ledger:
  - In `tests/ledger.test.ts`: `countEvents` counts only the matching kind and folder at or after `since`.
  - One test per check in spec §4 (relay off; unknown/candidate/non-api card; undeclared op; out of scope; body over the cap; a nested secret `{a:[{b:"<a findSecret sample>"}]}` on a `dataLeavesHost` card; the cap reached (200 prior events in 24 h, 200 at 25 h ago do not count); key unset). Each one → the reply names the check, and `fetch` gets 0 calls.
  - A good call → 1 fetch to `baseUrl+path` with `method`, the `authHeader` set from `ctx.env`, and a JSON body. The reply holds the status and the cut body. There is 1 `tool_api` event whose JSON has no body text and no key value (sentinel `KEY_SENTINEL_123`).
  - A hanging fetch → the reply says it timed out, and the call does not throw.
  - `neoMcpServers` built for ingress has no `tool_api`. Built with `toolsRelay` it has one. Built without it, it has none (mirror the existing `project_notes` gate test).
- [ ] **Step 2: Run** `bun test tests/tools-relay.test.ts` → FAIL.
- [ ] **Step 3: Implement** `relayCall` (the checks in spec order; `AbortSignal.timeout(cfg.timeoutMs)`; never log the body) and the `tool_api` zod tool `{ card: string, operation: string, body: record(unknown) }`. Its description says: shared API tools, see the `neo-tool-*` skills, text sent leaves the host when the card says so. The project comes from `opts.projectName ?? basename(opts.folder)`, as for notes.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` → all PASS.
- [ ] **Step 5: Commit** `feat(tools): the API relay — keys stay in the engine, fail-closed, capped, metered (ADR-0044, T4)`.

### Task 5: Docs, preamble, review

**Files:**
- Modify: `src/engine/dispatch.ts` (one preamble sentence in `briefWithProjectDocs`) + its existing preamble-length test
- Modify: `docs/CONFIG.md` (`tools.*` table), `docs/HISTORY.md`, `CLAUDE.md` (status line + map entry), `docs/adr/0044-*.md` (status → accepted, built on dev), `HANDOFF.md`

- [ ] **Step 1: Write the failing test.** The preamble contains `neo-tool-` and `tool_api`, and the preamble plus the codebase-memory line stays under 5000 chars (extend the existing test).
- [ ] **Step 2: Run** → FAIL. **Step 3:** add the sentence. Trim elsewhere if it is over the cap. **Step 4:** `bun test && bunx tsc --noEmit` → PASS.
- [ ] **Step 5: Update the docs** listed above, in plain English (simple-english skill).
- [ ] **Step 6:** run `/security-review` (the relay is input handling plus outbound calls with keys). Then request code review (superpowers:requesting-code-review), fix what it finds, and run the full suite green again.
- [ ] **Step 7: Commit** `docs(tools): catalogue docs, preamble line, ADR-0044 accepted (T5)`. Merge `feat/tools-catalogue` → `dev` (fast-forward). Remove the worktree. Do **not** merge to master, restart, or run `install.ts` on the real `~/.claude`. These wait for the operator.

## After approval and restart (operator steps, not tasks)

1. `bun tools/catalogue/install.ts` installs the skills for every session. They take effect on the next worker start, with no restart needed.
2. dev → master + restart → `tool_api` goes live. It stays refusing until `tools.relayEnabled: true` is set in `config.json`.
3. ScaleDown stays `candidate` until its DPA and key quota are confirmed (see the evaluation).
