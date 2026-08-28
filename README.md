# Neo

**A personal work engine on coding-agent SDKs: Claude Agent SDK by default, OpenAI Codex SDK optionally.**
You give Neo an order over a channel ("open this project and do X"); it opens the project as a
governed, headless worker, drives the work
deterministically, and streams progress back to you. No `cd`, no terminal, no tmux.

**Core principle:** AI *decides*; the engine *acts and governs*. The engine itself contains **no
AI** — it routes, governs, meters, and records. AI lives only inside SDK workers (Claude or Codex)
and, optionally, customer-message reading (Gemini).

> Neo runs the Agent SDK on **your** machine against **your** folders on **your** Claude
> subscription by default. You can flip new operator work to OpenAI Codex SDK with `/sdk codex`,
> the web console switch, or `config.json`.

## Architecture

```
Frontend  (Telegram / web console)                 ← you talk to projects here
   ↕
Engine    (orders · provider routing · governance  ← deterministic. no AI. THIS repo.
           · budget · ledger · loops)
   ↕  runOrder/startOrder wrapper
Worker    (Claude Agent SDK by default, or Codex    ← does the actual project work
           SDK when selected in config)
```

- **Frontends** — a Telegram bot and a web operator console, both driving the same pipeline.
- **Engine** — provider routing (a compliance firewall enforced in code), a rolling budget meter
  that reserves interactive headroom, a session registry with idle-close + resume, a governor that
  path-fences file writes and escalates risky tools, a ledger (bun:sqlite), and a `trigger → action
  → goal` **loop runtime** for autonomous work.
- **Worker** — a SDK session opened in a project folder. The default Claude adapter uses
  `@anthropic-ai/claude-agent-sdk`, loading `~/.claude` plugins/skills and that folder's
  `CLAUDE.md` / `.mcp.json` / settings. The optional Codex adapter uses `@openai/codex-sdk` threads
  with Codex sandbox/approval controls.

## Features

- **Two operator frontends, one engine.** A Telegram bot and a web console both drive the same
  `source:"neo"` SDK pipeline — sharing the registry, budget meter, ledger, and admin. Plain
  messages stream as **follow-ups into the running worker**.
- **Full-fidelity progress stream.** Worker progress streams back as it happens — tool milestones
  plus a concise **result preview** (`↳ …`) for the meaningful tools (Bash / web / MCP / Task), so
  you see a command's output, not just that it ran. Long reports are **chunked** to fit Telegram's
  4096-char limit (never silently dropped), and the chunker is **table-aware** so a Markdown table
  survives the split and renders as an aligned block instead of raw pipes.
- **Compliance firewall, in code.** Your own work runs on the configured operator worker SDK
  (`subscription`/Claude by default, optionally `codex`); customer-direct work is refused onto the
  Claude subscription and routed to Gemini. Enforced by `provider-router.ts`, never a prompt.
- **Governed workers.** A default-escalate governor path-fences file writes to the session's project
  folder and escalates unknown/foreign MCP tools, `WebFetch`, and out-of-folder writes to the
  operator (autonomous paths auto-deny). Customer-tainted briefs run with **zero tools**.
- **Budget & usage metering.** A rolling meter reserves interactive headroom and throttles
  background work; `/usage` reports measured subscription token usage and rate-limit status read
  from Claude Code's own transcripts.
- **Live, concurrent, resumable sessions.** Multiple projects run concurrently in a registry; quiet
  sessions **idle-close** and persist their SDK id so a later `/open` **resumes** them. A context
  policy measures each session and hands off at safe boundaries before it fills the window.
- **One-shot project focus.** The default target is always the company; addressing a project is
  explicit and reverts after a single message (`/pin` to hold it), so stray messages never stick to a
  project. When a project is busy, the reply reports its **real status** — not an opaque "busy".
- **The "company" — an always-on default project** that answers free-text orders when nothing else
  is active, and can **dispatch** project work to governed sub-workers, bounded by a stall/liveness
  monitor (abort on silence or a per-dispatch ceiling, with a graceful wrap-up window). A `sessions`
  tool gives it live awareness of every project's state.
- **Loop runtime (autonomy).** `trigger → action → goal` loops run autonomous work through the same
  governed worker; loop **definitions are data** — author, edit, and toggle them from the web
  console with no restart.
- **Customer inbox.** Inbound customer mail queues as plain data (no auto-reply) for operator
  review — view, draft-with-agent, edit, approval-gated send, delete — from Telegram `/inbox` or the
  web console. The optional Go **gateway** (`gateway/`) bridges email/WhatsApp/voice into it.
- **Graceful reload.** `/reload` (or `SIGTERM`, e.g. `systemctl restart neo`) drains running
  sessions (commit green work + WIP note), snapshots them, and exits for the supervisor to restart —
  open projects reappear as idle + resumable.

## Quick start

### Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.0 (`curl -fsSL https://bun.sh/install | bash`).
- A **Claude subscription** with **[Claude Code](https://claude.com/claude-code)** installed and
  logged in — the Agent SDK runs the worker on that subscription (no API key needed).
- *(Optional)* **Codex SDK/CLI auth** if you set `providers.ownWork` to `"codex"`: use local Codex
  login or provide `CODEX_API_KEY` in the process environment.
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

### Talking to projects — one-shot focus

The default target for a plain message is always **the company** (the main/chief-of-staff agent).
Addressing a specific project is **explicit and one-shot**: you direct *one* message to a project,
then focus reverts to the company — so a stray next message never sticks to a project.

- **Address a project for one message:** `/use <name>` (then send your message), tap a project in
  `/list`, or reply to one of its streamed messages. After that one message, you're back on the company.
- **Have a back-and-forth with a project:** `/pin <name>` holds focus on it across messages; `/unpin`
  (alias `/company`, `/main`) returns to the company. `/list` marks the focused project `▶` (one-shot)
  or `📌` (pinned).
- **`/open <folder> <task>`** delivers its task to the project (that's the one message) and reverts to
  the company; `/pin` it if you want to keep working there.

A company **dispatch** to an already-open project checks whether a turn is really in flight, not just
whether the session is live. An **idle** project takes the brief right away. A **mid-turn** project
**queues** it behind the current turn. A stale session with no live handle is refused. When a dispatch
queues or refuses, the reply reports the **real status** — which project, what it's doing, how long,
and how many follow-ups are queued — not a bare "busy". The company also has a `sessions` tool to see
every project's live state at once.

### Operator commands

The same commands work over Telegram and the web console.

| Command | Does |
| --- | --- |
| `/open <folder> <task>` | Start a project session (or resume one) and give it a task; reverts to the company after. |
| `/list` (`/ls`, `/status`) | List open projects with live status (`▶`/`📌` = focused); tap a name to address it once. |
| `/use <name>` | Address a project for your **next message only**, then revert to the company. |
| `/pin <name>` | Keep talking to a project across messages (until `/unpin`). |
| `/unpin` (`/company`, `/main`) | Return focus to the company / main agent. |
| `/kill <name>` | Stop a project session. |
| `/trust [<project-or-folder>] [on\|off]` | Auto-approve actions for a project or folder (skip Allow/Deny prompts). |
| `/loop [<name>]` | List loops; `/loop <name>` runs one; `/loop <name> on\|off` toggles its schedule. |
| `/inbox` | Review queued customer messages (tap one to view & reply). |
| `/recent` (`/history`) | Recent orders and their outcomes. |
| `/usage` | Subscription token usage + rate-limit status. |
| `/sdk [claude\|codex]` | Show or switch the worker SDK used for new own-work sessions. |
| `/reload` | Gracefully restart the engine (drains running sessions, resumes them after). |
| `/help` | Show the command list. |

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
| `CODEBASE_MEMORY_BIN` | *(empty)* | Path to the codebase-memory MCP binary (code intelligence). Off when empty. |
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

- **Your own work → configured operator SDK**. Default is the Claude Agent SDK on your Claude
  subscription (`"subscription"`); use `/sdk codex`, the web console switch, or set
  `providers.ownWork` to `"codex"` to use OpenAI Codex SDK for new sessions.
- **Customer-direct work → Gemini.** `provider-router.ts` refuses, in code, to route
  `source: "customer"` onto the subscription. Neo never offers a customer a Claude login.
- **Budget guard.** Background SDK work shares your subscription pool, so the meter reserves
  interactive headroom (`subscriptionInteractiveReservePct`) and throttles background work.
- **Approval gate.** The governor is default-escalate: unknown/foreign MCP tools, `WebFetch`, and
  out-of-folder writes ask the operator on the Claude path (autonomous paths auto-deny). File writes
  are path-fenced to the session's project folder. The Codex path uses Codex sandbox/approval policy;
  Codex SDK does not expose Claude's `canUseTool` hook.

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
bun test              # run the suite (657 tests)
bunx tsc --noEmit     # typecheck
bun run src/daemon.ts # run the engine
```

Keep `bun test` and `bunx tsc --noEmit` green before anything is "done", and write the failing test
first. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the workflow and commit style. The phased build
history is in [MVP-PLAN.md](MVP-PLAN.md); design specs live under `docs/superpowers/`.

## License

[MIT](LICENSE) © 2026 Mahdi Awadi.
