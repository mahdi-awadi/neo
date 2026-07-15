# Contributing to Neo

Thanks for your interest! Neo is a small, deterministic TypeScript engine built with a strict
test-driven discipline. This guide covers how to get set up and the conventions we hold to.

## Dev setup

```bash
git clone https://github.com/mahdi-awadi/neo.git
cd neo
bun install
cp .env.example .env     # set TELEGRAM_TOKEN if you want to run it end to end
```

Requirements: [Bun](https://bun.sh) ≥ 1.0. Running the full engine additionally needs Claude Code
logged into a Claude subscription and a Telegram bot token, but the **test suite and typecheck run
with no external services or secrets**.

## The two gates (must stay green)

```bash
bun test              # the suite
bunx tsc --noEmit     # typecheck (strict)
```

Both must be green before any change is considered done. Tests are scoped to `tests/` via
`bunfig.toml`.

## Test-driven development

Write the failing test **first**, then the minimal code to pass it, then refactor. Every feature or
bugfix lands with tests. When you change configuration loading, add/adjust a test in
`tests/config.test.ts`. Keep tests hermetic — control `process.env` explicitly and restore it
(see the `withEnv` helper in `tests/config.test.ts`) rather than depending on the ambient
environment.

## Conventions

- **No AI in the engine.** Determinism by default; the engine routes/governs/meters/records. AI runs
  only inside SDK workers. Don't add model calls to engine code paths.
- **No hardcoded deployment values.** Anything an operator might change (paths, hosts, domains,
  tokens, budgets) goes through `src/config.ts` (env → `config.json` → default) with a sane default
  and a doc entry in [docs/CONFIG.md](docs/CONFIG.md). Never commit secrets — `.env` and `config.json`
  are gitignored; only the `*.example` files are committed.
- **Match the surrounding code.** Follow the existing naming, comment density, and file-header style
  (each `src/` file states its responsibility at the top).
- **Small, logical commits.** One coherent change per commit, with a clear message. End commit
  messages with:

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

  (Drop that trailer if you are not pairing with Claude on the change.)

## Pull requests

1. Branch from `master`.
2. Keep `bun test` + `bunx tsc --noEmit` green; add tests for new behavior.
3. Update docs when you change a command, config key, or public behavior.
4. Describe what changed and why. Small PRs review faster.

## Reporting issues

Open a [GitHub issue](https://github.com/mahdi-awadi/neo/issues) with clear reproduction steps and,
for bugs, the relevant log output. Please don't include secrets (tokens, keys, chat ids) in issues.
