# Tools inventory — Neo and the projects (2026-10-22)

A read-only sweep of this host. It lists key NAMES only. No secret file was read. It is the input to
ADR-0044 (the tools catalogue). "Who gets it" means who gets it today.

## 1. MCP servers

| Server | What it does | Configured in | Who gets it |
|---|---|---|---|
| `neo` (in-process) | `send_file`, `ask_operator`, `project_notes`; company: `sessions`, `dispatch`, `todo`; `memory*` when the memory gate passes | `neoMcpServers`, `src/engine/dispatch.ts` | operator turns, dispatched workers, the customer company brief (stripped of operator-only tools); never tainted runs, loops or Codex |
| `memory` (dream) | budgeted memory edits | `src/engine/loops.ts` (`dreamMcpServers`) | the `memory-dream` loop only |
| `playwright` (Neo) | headless browser | `PLAYWRIGHT_MCP`, `dispatch.ts` | operator turns |
| `stitch` | Google Stitch design generation (`STITCH_API_KEY`) | `~/.claude.json` + `dispatch.ts` | user sessions; Neo operator turns |
| `codebase-memory` | code graph index and search (`CODEBASE_MEMORY_BIN`) | `~/.claude.json`, `~/.codex/config.toml`, `dispatch.ts` | user sessions, Codex CLI, Neo operator turns; Neo indexes before each dispatch |
| `chrome`, `playwright` (user) | DevTools and Playwright on the shared browser `127.0.0.1:9222` (ADR-0032) | `~/.claude.json` | every Claude session as root, so Neo workers too (they escalate, see §5) |
| `telegram` (plugin) | channel reply, react, edit, download | the telegram plugin's `.mcp.json` | every user session |
| `operant`, `agent-native-*`, `plan` | the old engine shim; remote agent-native apps | `~/.claude.json` | user sessions; currently failing (connection closed / OAuth) |
| eticket-v3: `postgres`, `mongodb`, `redis`, `clickhouse`, `temporal`, `grpcmcp` | data stores and gRPC API | `/home/eticket-v3/.mcp.json` | sessions in eticket-v3 |
| waselni: `wasilni-postgres`, `context7` | DB, library docs | `/home/waselni/.mcp.json` | sessions in waselni |
| adminli: `whatsapp_business_tools`, `meta_social_technologies` | Meta hosted MCP | adminli entry in `~/.claude.json` | sessions in adminli |

## 2. Skills (inventoried, not carded — ADR-0044 §5)

- **User** (`~/.claude/skills`, 18): codebase-design, domain-modeling, karpathy-guidelines,
  simple-english, context-xray, journey, and 12 design and taste skills.
- **Plugins enabled:** superpowers (15), agent-teams (6), ui-design (9), frontend-design,
  claude-code-setup, telegram (2), typesafe (1).
- **Projects:** eticket-v3 (13), goose (4), mirshad/new (5 each), waselni (4), adminli (2), gold,
  saffar, video-app (1 each).
- **Reach:** `settingSources: ["user","project"]` + `skills: "all"` (`session-runner.ts`), so every
  Claude worker loads user, plugin and project skills. Codex loads only `~/.codex/skills`.

## 3. Host CLIs in `tools/`

| Tool | Purpose | Run |
|---|---|---|
| `security/` | the scan kit (ADR-0024): install, per-repo init, `scan.sh` layers, secret guard, nightly sweep | `bun tools/security/install.ts`; `bun ~/.claude/security/init.ts <repo>` |
| `browser/` | the shared, memory-capped Chromium (ADR-0032) | `bun tools/browser/install.ts [--wire-mcp\|--down]` |
| `disk/` | the disk-cleanup kit (ADR-0040/0041) | through the `disk-cleanup` loop; Tier B `cleanup.ts delete --ids` |
| `create-loop.ts` | author or edit a loop through the engine's validation | `bun tools/create-loop.ts …` |
| `bench-threads.ts` | thread-read benchmark | `bun run tools/bench-threads.ts` |

## 4. External APIs (key names only)

| API | Key names | Used by |
|---|---|---|
| Telegram | `TELEGRAM_TOKEN`, `DECISIONS_CHAT_ID`, `TELEGRAM_*BOT_TOKEN` | neo; gold, waselni, prod-ops |
| Gemini | `GEMINI_API_KEY` (+ `_FREE_`/`_PAID_`, `SAFFAR_GEMINI_API_KEY`, `GOOGLE_AI_API_KEY`) | neo (customer path), eticket-v3, adminli, saffar, frontdoor, video-app |
| Google Stitch | `STITCH_API_KEY` | neo |
| Codex / OpenAI | `CODEX_API_KEY`, `OPENAI_API_KEY` | neo (Codex); adminli, goose |
| TypeSafe / Jev | `TYPESAFE_API_KEY`, `TYPESAFE_API_URL`, `TYPESAFE_MODEL` | eticket-v3 |
| Cloudflare | `CLOUDFLARE_API_TOKEN`, `_ACCOUNT_ID`, `_ZONE_ID`, `CF_API_TOKEN`, `CF_TUNNEL_TOKEN` | eticket-v3, tkt-v2, eticket-deploy, cpahost, contantme, traefik, prod-ops |
| R2 / S3 | `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `S3_*` | contantme, video-app, eticket-v3, techgate, waselni |
| Expo / EAS | `EXPO_TOKEN` | waselni, eticket-v3 (CI) |
| Coolify | `COOLIFY_TOKEN`, `COOLIFY_BASE`, `COOLIFY_DEPLOY_TOKEN`, `COOLIFY_APP_UUID` | eticket-v3, waselni, contantme, prod-ops |
| GitHub | `GITHUB_TOKEN`, `GH_TOKEN` | CI in goose, eticket-v3, contantme, waselni, video-app |
| OTPIQ (SMS) | `OTPIQ_API_KEY`, `OTPIQ_API_BASE`, `OTPIQ_SMS_ENABLED` | waselni |
| Meta / WhatsApp | `META_ACCESS_TOKEN`, `META_APP_SECRET`, `WHATSAPP_API_TOKEN`, … | frontdoor, waselni, contantme, eticket-v3 |
| ClickHouse | `CLICKHOUSE_URL`, `_USER`, `_PASSWORD`, `_DATABASE` | eticket-v3 (+ MCP), waselni, tkt-v2 |
| ScaleDown | `SCALEDOWN_API_KEY` | neo `.env` only (evaluation — see `2026-10-22-scaledown-evaluation.md`) |
| Others | Twilio, SendGrid, Resend, Stripe, ZainCash, QiCard, FCM, Langfuse, DeepSeek, Wayl, Jina, Qdrant | various projects |

## 5. How a worker reaches a tool today

- **Preamble** (`briefWithProjectDocs`, `dispatch.ts`): the rules and the named skills. Today it
  names no tools except codebase-memory.
- **Governor** (`governor.ts`): `mcp__neo__*` and the safe built-ins are allowed. Every other MCP tool
  (codebase-memory, playwright, chrome, stitch, project DB servers) escalates, unless the project is
  trusted. Customer work denies every escalation.
- **Tainted runs:** no Bash/Write/Edit/web/Task, no `mcpServers`.
- **Loops:** no `neo` server. **Codex:** no Neo MCP servers and no skills (dropped, with a warning).

## Found during the sweep (for the operator)

1. **eticket-v3 has a login credential committed in `/home/eticket-v3/.mcp.json`** (the `grpcmcp`
   server's login body). It is not repeated here. It belongs to eticket-v3: Neo should dispatch a
   rotate-and-move-to-env fix there. This session must not edit another project.
2. **A comment in Neo does not match its code.** Comments in `dispatch.ts` and `codebase-memory.ts`
   say "the governor denies subagents the index tools". The governor has no such rule. Only a brief
   line keeps workers off `index_repository`. This is a small fix in this repo, outside this plan.
