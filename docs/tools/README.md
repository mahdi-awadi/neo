# Tool cards (ADR-0044)

One file per shared tool: `docs/tools/<id>.md`. A card is YAML front matter plus a markdown body.
`tests/tools-catalogue.test.ts` loads this folder, so a bad card fails `bun test`.

## Add a card

1. Copy a card of the same kind (`mcp`, `cli`, `api` or `recipe`) and set `id` to the file name
   (`[a-z0-9-]{2,40}`).
2. Fill every field. The checks live in `src/engine/tools-catalogue.ts`:
   - `status`: `active` (workers are told), `candidate` (evaluated, not offered) or `retired`.
   - `when`: one line, at most `tools.whenMaxChars` (300) characters.
   - `scope`: `all` or a list of project names.
   - `env`: key NAMES only (`[A-Z][A-Z0-9_]*`). Never a value: a value-looking entry is an error.
   - `tags` (at most 12, lowercase words) and `examples` (at most 6, one line each) are required on
     an active card. Search matches them best.
   - `usage`: optional globs that map recorded tool calls to the card: `tools` (tool names) and
     `commands` (Bash text).
   - `relay`: only on `api` cards, and required on an active one. `baseUrl` is `https:`, `envKey` is
     also in `env`, each operation is `GET` or `POST` with a path that starts with `/`.
   - `recipe` cards have `steps` (2 to 10 of `{ card, do }`) and no `relay`. Each step names an
     active card that is not a recipe.
3. The body needs `## How to call` and `## When NOT to use`.
4. Run `bun test tests/tools-catalogue.test.ts`.

Promoting a card to `active` is the operator's decision. No card holds a key value.
