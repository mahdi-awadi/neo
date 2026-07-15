# Neo

**A personal work engine on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript).**
You give Neo an order over a channel ("open this project and do X"); it opens the project as a
governed, headless [Claude Code](https://claude.com/claude-code) worker, drives the work
deterministically, and streams progress back to you. No `cd`, no terminal, no tmux.

**Core principle:** AI *decides*; the engine *acts and governs*. The engine itself contains **no
AI** — it routes, governs, meters, and records. AI lives only inside SDK workers (Claude, on your
own subscription) and, optionally, customer-message reading (Gemini).

> Neo runs the Agent SDK on **your** machine against **your** folders on **your** Claude
> subscription. It is a single-user, self-hosted tool for doing *your own* work.

## Architecture

```
Frontend  (Telegram / web console)                 ← you talk to projects here
   ↕
Engine    (orders · provider routing · governance  ← deterministic. no AI. THIS repo.
           · budget · ledger · loops)
   ↕  query(task, { cwd, canUseTool, mcpServers, settingSources })
Worker    (Claude Agent SDK = Claude Code in a      ← does the actual project work
           project folder, on your subscription)
```

- **Frontends** — a Telegram bot and a web operator console, both driving the same pipeline.
- **Engine** — provider routing (a compliance firewall enforced in code), a rolling budget meter
  that reserves interactive headroom, a session registry with idle-close + resume, a governor that
  path-fences file writes and escalates risky tools, a ledger (bun:sqlite), and a `trigger → action
  → goal` **loop runtime** for autonomous work.
- **Worker** — a Claude Code session (`@anthropic-ai/claude-agent-sdk`) opened in a project folder,
  loading that folder's `CLAUDE.md` / `.mcp.json` / settings.

## Quick start

### Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.0 (`curl -fsSL https://bun.sh/install | bash`).
- A **Claude subscription** with **[Claude Code](https://claude.com/claude-code)** installed and
  logged in — the Agent SDK runs the worker on that subscription (no API key needed).
- A **Telegram bot** — create one with [@BotFather](https://t.me/BotFather) and copy its token.
- *(Optional)* a TLS reverse proxy (Traefik/Caddy/nginx) if you want the web console on a public
  domain, and a **Gemini API key** if you run the customer-facing path.

### Install & configure

```bash
git clone https://github.com/mahdi-awadi/neo.git
cd neo
bun install

cp .env.example .env      # then edit .env — at minimum set TELEGRAM_TOKEN
chmod 600 .env
# optional: cp config.example.json config.json  (structured, non-secret knobs)
```

At minimum set `TELEGRAM_TOKEN` in `.env`. For the web console also set `BOT_USERNAME` (your bot's
`@username`, without the `@`) and, if you front it with a proxy, `PUBLIC_URL`. See
[Configuration](#configuration) below.

### Run

```bash
bun run src/daemon.ts
```

You should see the engine boot log — providers, ledger, idle policy, loops, and the Telegram + web
frontends. If `TELEGRAM_TOKEN` is unset the daemon prints a clear notice and starts without the
frontends (the loop scheduler and the always-on "company" project still run).

### Become the operator (admin)

Admin is **trust-on-first-use**: the *first* Telegram id to message the bot (or log into the web
console) claims admin, and it is remembered in `data/admin.db`. Message your own bot before anyone
else. To reset admin, delete `data/admin.db`. You can pre-restrict who may claim admin with
`telegramAllowFrom` in `config.json`.

- **Telegram:** message the bot. Try `/help`, `/open <folder> <task>`, `/list`, `/loop`.
- **Web console:** put a TLS proxy in front of `WEB_HOST:WEB_PORT` (default `127.0.0.1:3003`),
  register your `PUBLIC_URL` domain in @BotFather (`/setdomain`), open it, and "Log in with
  Telegram". The console binds localhost by default and is meant to sit behind your proxy — don't
  expose the raw port publicly.

## Configuration

Precedence is **environment variable → `config.json` → built-in default**. Secrets go in `.env`
(gitignored); structured non-secret knobs go in `config.json` (gitignored; see
`config.example.json`). Every setting has a sane default — a fresh clone runs with only
`TELEGRAM_TOKEN` set. Full reference: **[docs/CONFIG.md](docs/CONFIG.md)**.

### Environment variables (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_TOKEN` | — | BotFather token. **Required** for the Telegram bot + web console. |
| `BOT_USERNAME` | *(auto via getMe)* | Bot `@username` (no `@`) for the web Telegram Login Widget. |
| `WEB_HOST` | `127.0.0.1` | Interface the web console binds (localhost by default). |
| `WEB_PORT` | `3003` | Web console port. |
| `PUBLIC_URL` | *(empty)* | Public HTTPS URL the console is reached at (behind your proxy). |
| `GEMINI_API_KEY` | *(empty)* | Gemini key for the customer-facing path (kept off the subscription). |
| `STITCH_API_KEY` | *(empty)* | Google Stitch MCP (design generation) for operator workers. Off when empty. |
| `GITNEXUS_BIN` | *(empty)* | Path to the gitnexus MCP binary. Off when empty. |
| `CODEBASE_MEMORY_BIN` | *(empty)* | Path to the codebase-memory MCP binary. Off when empty. |
| `AGENT_INGRESS_SECRET` | *(empty)* | Bearer secret for `POST /agent/ingress` + `/inbox` (gateway). |
| `GATEWAY_SEND_URL` | *(empty)* | Customer-reply gateway `/send` endpoint. Off when empty. |
| `MEETING_LINK` | *(empty)* | Booking link used in the customer-reply CTA. |
| `BUSINESS_NAME` | *(empty)* | Name customer email replies sign off as (never "Neo"). |
| `WORK_ROOT` | `/home` | Root holding your project repos (picker / dispatch / loop fence). |
| `COMPANY_FOLDER` | `<repo>/agent` | The always-on "company" workspace folder. |
| `NEO_LOOP_SCHEDULER` | `1` | Set `0` to disable the autonomous loop scheduler. |

Structured knobs in `config.json` (budgets, dispatch/watchdog timeouts, context policy, provider
routing, `telegramAllowFrom`, …) are documented in **[docs/CONFIG.md](docs/CONFIG.md)**.

### The compliance firewall (enforced in code, not prompts)

- **Your own work → your Claude subscription** via the Agent SDK. Provider choice lives in config so
  a future plan change is a flip, not a rewrite.
- **Customer-direct work → Gemini.** `provider-router.ts` refuses, in code, to route
  `source: "customer"` onto the subscription. Neo never offers a customer a Claude login.
- **Budget guard.** Background SDK work shares your subscription pool, so the meter reserves
  interactive headroom (`subscriptionInteractiveReservePct`) and throttles background work.
- **Approval gate.** The governor is default-escalate: unknown/foreign MCP tools, `WebFetch`, and
  out-of-folder writes ask the operator (autonomous paths auto-deny). File writes are path-fenced to
  the session's project folder.

## Loops (autonomy)

A **loop** is `trigger → repeated action → goal` — it runs until the goal is met (a verifiable
command, or an LLM-judge). Triggers are manual / interval / cron. A few generic, deployment-neutral
built-ins ship as examples (`green`, `error-sweep`, `docs-sweep`) that maintain the running repo;
operators author their own project loops from the web console (persisted as data, no restart).
`/loop` lists them, `/loop <name>` runs one, `/loop <name> on|off` toggles a schedule. See
[docs/loops.md](docs/loops.md).

## Development

Stack: **Bun + TypeScript**, test-driven.

```bash
bun install
bun test              # run the suite (346 tests)
bunx tsc --noEmit     # typecheck
bun run src/daemon.ts # run the engine
```

Keep `bun test` and `bunx tsc --noEmit` green before anything is "done", and write the failing test
first. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the workflow and commit style. The phased build
history is in [MVP-PLAN.md](MVP-PLAN.md); design specs live under `docs/superpowers/`.

## License

[MIT](LICENSE) © 2026 Mahdi Awadi.
