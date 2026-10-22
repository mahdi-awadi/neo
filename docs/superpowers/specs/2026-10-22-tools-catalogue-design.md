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
same one `project_notes` uses: an operator dep `toolsRelay`. The ingress path strips it explicitly
(`toolsRelay: undefined`, like `notes`). Loops and Codex do not get it (the known gap, ADR-0044).

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
