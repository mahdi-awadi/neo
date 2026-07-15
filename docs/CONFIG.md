# Configuration reference

Neo resolves every setting with the precedence **environment variable → `config.json` → built-in
default** (`src/config.ts`). Secrets belong in `.env`; structured non-secret knobs belong in
`config.json`. Both files are gitignored — only `.env.example` and `config.example.json` are
committed. A fresh clone runs with a single value set: `TELEGRAM_TOKEN`.

## Secrets & deployment (`.env`)

These are read from environment variables (a few also fall back to `config.json`). Put the sensitive
ones in `.env` (`chmod 600`).

| Variable | Env-only? | Default | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_TOKEN` | yes | — | BotFather token. Required for the Telegram bot + web console. |
| `GEMINI_API_KEY` | yes | *(empty)* | Gemini key for the customer-facing path. Never touches the Claude subscription. |
| `AGENT_INGRESS_SECRET` | yes | *(empty)* | Bearer secret for `POST /agent/ingress` + `/inbox`. Empty → those endpoints refuse all requests. |
| `STITCH_API_KEY` | yes | *(empty)* | Google Stitch MCP (design generation) for operator workers. Off when empty. |
| `BOT_USERNAME` | env or `config.json` | *(auto via getMe)* | Bot `@username` (no `@`) for the web Telegram Login Widget. |
| `WEB_HOST` | env or `config.json` | `127.0.0.1` | Interface the web console binds. Set to a bridge IP to let a proxy reach it. |
| `WEB_PORT` | env or `config.json` | `3003` | Web console port. |
| `PUBLIC_URL` | env or `config.json` | *(empty)* | Public HTTPS URL the console is reached at (behind your proxy). |
| `GATEWAY_SEND_URL` | env or `config.json` | *(empty)* | Customer-reply gateway `/send` endpoint. Off when empty. |
| `MEETING_LINK` | env or `config.json` | *(empty)* | Booking link for the customer-reply CTA. |
| `BUSINESS_NAME` | env or `config.json` | *(empty)* | Name customer replies sign off as (never "Neo"). |
| `GITNEXUS_BIN` | env or `config.json` | *(empty)* | Path to the gitnexus MCP binary. Off when empty. |
| `CODEBASE_MEMORY_BIN` | env or `config.json` | *(empty)* | Path to the codebase-memory MCP binary. Off when empty. |
| `WORK_ROOT` | env or `config.json` | `/home` | Root holding your project repos (picker / dispatch / loop fence). |
| `COMPANY_FOLDER` | env or `config.json` | `<repo>/agent` | The always-on "company" workspace folder. |
| `NEO_LOOP_SCHEDULER` | env or `config.json` | `1` (on) | Set `0` to disable the loop scheduler. |

## Structured knobs (`config.json`)

Non-secret tuning, read only from `config.json` (copy `config.example.json`). All optional.

| Key | Default | Purpose |
| --- | --- | --- |
| `telegramAllowFrom` | `[]` | Numeric Telegram ids allowed to reach the bot / claim admin. Empty → first-come trust-on-first-use. |
| `providers` | `{ ownWork: "subscription", customerWork: "gemini" }` | Provider routing (the compliance firewall). |
| `subscriptionInteractiveReservePct` | `0.2` | Fraction of the subscription pool reserved for interactive use. |
| `budgetWindowUsd` | `20` | Per-window USD budget for background SDK work. |
| `budgetWindowMs` | `18000000` (5h) | Rolling budget window, matching the subscription usage window. |
| `idleCloseMs` | `86400000` (24h) | Idle-close threshold for normal projects (the company is exempt). |
| `dispatchTimeoutMs` | `900000` (15m) | Default per-dispatch ceiling when the caller doesn't request one. |
| `dispatchTimeoutMaxMs` | `7200000` (2h) | Hard cap on any per-dispatch ceiling a caller may request. |
| `dispatchStallMs` | `300000` (5m) | Abort a dispatched sub-run that produces no activity for this long. |
| `dispatchGraceMs` | `75000` (75s) | Grace window to commit green work + write a WIP note before a hard abort. |
| `drainWindowMs` | `90000` (90s) | Graceful-reload wait for running turns to wrap up before interrupt. |
| `stuckAfterMs` | `600000` (10m) | Alert when a running session has produced nothing for this long. |
| `longTurnAlertMs` | `1200000` (20m) | Alert when one activity label has run this long. |
| `alertRepeatMs` | `900000` (15m) | Re-alert about the same session only after this long. |
| `contextPolicy` | `{ handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604800000, handoffTimeoutMs: 180000 }` | Session context-window lifecycle thresholds. |

> **Note:** if you raise `drainWindowMs` past ~90s, also raise `TimeoutStopSec` in your service unit
> (systemd's default stop timeout is 90s and would kill the process mid-drain).

## Recipes

**Run locally (minimum).** Set `TELEGRAM_TOKEN` in `.env`, `bun run src/daemon.ts`, message your
bot. The web console needs `BOT_USERNAME` too.

**Expose the web console behind a TLS reverse proxy.** Bind the console where your proxy can reach
it and tell it its public identity:

```env
WEB_HOST=172.17.0.1          # a docker-bridge / LAN IP your proxy can reach (not 127.0.0.1)
WEB_PORT=3003
PUBLIC_URL=https://neo.example.com
BOT_USERNAME=your_bot        # must match @BotFather /setdomain for this PUBLIC_URL
```

Point your proxy (Traefik/Caddy/nginx) at `WEB_HOST:WEB_PORT` and terminate TLS there. Register the
`PUBLIC_URL` domain with @BotFather (`/setdomain`) so the Telegram Login Widget works.

**Enable the optional MCP servers.** If you have the binaries installed, set `GITNEXUS_BIN` and/or
`CODEBASE_MEMORY_BIN` (and `STITCH_API_KEY` for Stitch). They attach to operator workers only —
never to the customer/ingress path.

**Point projects at a non-`/home` root.** Set `WORK_ROOT=/srv/projects` (and, if you keep the
company workspace elsewhere, `COMPANY_FOLDER=/srv/projects/company`).
