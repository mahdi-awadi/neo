# Neo

Neo is a personal work **engine**. You give it an order ("open this project and do X"); it opens
the project as a headless Claude Code worker via the **Claude Agent SDK**, governs the work
deterministically, and streams progress back over a channel (Telegram first). No `cd`, no terminal,
no tmux.

**Core principle:** AI *decides*; the engine *acts and governs*. The engine itself contains **no
AI** — it routes, governs, meters, and records. AI lives only inside SDK workers (Claude, on your
subscription) and customer-message reading (Gemini).

Neo is the clean successor to **operant** (at `/home/operant`). Same goals, rebuilt on the Agent
SDK so the old tmux/socket/scraper spine is gone.

## Architecture (three layers)

```
Frontend  (Telegram / email / WhatsApp)            ← you talk to projects here
   ↕
Engine    (orders · provider routing · governance  ← deterministic. THIS repo's job.
           · budget · ledger)
   ↕  query(task, { cwd, canUseTool, mcpServers, settingSources })
Worker    (Claude Agent SDK = Claude Code in a      ← does the actual project work
           project folder, on your subscription)
```

## Rules that live in CODE, not prompts (the compliance firewall)

These are enforced by `src/engine/provider-router.ts` and `governor.ts` — never by trusting a
prompt:

- **Your own work → your Claude subscription** (via the Agent SDK). It draws from your normal
  subscription usage limits today. The monthly-credit change Anthropic announced is **paused**;
  nothing changed. Do **not** build credit/overflow accounting (YAGNI). Keep the provider choice in
  `config` so if the plan ever changes it's a config flip, not a rewrite.
- **Customer-direct work (email/WhatsApp/web) → Gemini.** A customer must never touch the
  subscription, and Neo must never offer customers a Claude login. The router must **refuse, in
  code**, any attempt to route `source: "customer"` to the subscription.
- **Budget guard:** background SDK work shares your subscription pool, so reserve interactive
  headroom — never drain the plan you use yourself (`subscriptionInteractiveReservePct`).
- **Approval gate:** irreversible/external actions (deploy, delete, `git push`, payments, sending
  to real people) escalate to Neo before they run — never auto-approved.

## Current status

**Phase 2 complete — live, concurrent, governed sessions** (verified with a real SDK run): on top of
the Phase 1 skeleton, the engine now holds **live SDK sessions** you can talk to. Plain-text messages
stream as **follow-ups into the running worker**; quiet sessions **idle-close** and persist their SDK
id so a later `/open` **resumes** them; a rolling **budget meter** reserves interactive headroom and
throttles background work; multiple projects run **concurrently** in a registry; and `/status` + `/kill`
give visibility and control. All TDD (`bun test` green — 58 tests, `tsc` clean). The real-SDK
build-then-verify run confirmed streaming input, mid-run follow-ups, interrupt, and resume, and fixed
two shaping bugs (see `docs/sdk-notes.md` → Phase 2). The Telegram frontend needs a `TELEGRAM_TOKEN`
to run live.

**Phase 3 complete — the operator web console** (reprioritized from the Gemini customer path): a
second operator frontend at `neo.tech-gate.online` (Telegram-Login auth → trust-on-first-use admin →
signed session cookie) where Neo talks to the engine over the web exactly like Telegram — same
`source:"neo"` SDK pipeline, sharing the registry/meter/ledger/admin. Behind Traefik
(`/home/traefik/dynamic/neo.yml` → `172.20.0.1:3003`); live-verified HTTPS + valid cert. `bun test`
green (82 tests), `tsc` clean.

Next: **Phase 3b** (the deferred Gemini customer path), then Phase 4 (finance/board). Keep building
**phase by phase, TDD**, per `MVP-PLAN.md`.

## How to work here

- **Stack:** Bun + TypeScript. `bun install` · `bun test` · `bunx tsc --noEmit` · `bun run
  src/daemon.ts`.
- **Follow `MVP-PLAN.md`** in order. Write the failing test first, then the minimal code (TDD).
  `bunx tsc --noEmit` + `bun test` must be green before any task is "done." Commit per logical piece.
- **Port the proven code from `/home/operant`** — don't rebuild it: `store.ts` → `ledger.ts`,
  `finance.ts`, `frontends/telegram.ts`, the `config.ts` precedence pattern, the risk keywords from
  `autopilot-risk.ts`. **Do NOT port** `screen-manager.ts`, `shim.ts`, `socket-server.ts`,
  `autopilot.ts`, `autopilot-parser.ts` — they exist only to puppet the interactive CLI and are
  deleted by design.
- **Verified Agent SDK surface** (https://code.claude.com/docs/en/agent-sdk/typescript): package
  `@anthropic-ai/claude-agent-sdk`; entry `query({ prompt, options })`; key options `cwd`,
  `settingSources: ["project","local"]` (loads the folder's CLAUDE.md/.mcp.json/settings),
  `systemPrompt: { type:"preset", preset:"claude_code" }`, `permissionMode`, `canUseTool`,
  `mcpServers`, `resume`. The async generator yields `{ type: "assistant" | "result" | "system" |
  ... }`. The full shape is documented in `src/engine/session-runner.ts`.

## Conventions

- **Secrets** in `.env` (gitignored, `chmod 600`). Runtime/tenant data under `company/` is
  gitignored. Never commit keys or echo them into logs/replies.
- **No AI in the engine.** Determinism by default; AI only inside SDK workers + Gemini reads.
- Operator is addressed as **Neo** (not "Mahdi" — that's only the repo-author handle).
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Why these decisions (so you don't relitigate them)

- **New project, not an evolution of operant:** operant's spine (socket-server + shim + tmux +
  Ink-scraper) inverts under the SDK model. Building clean and porting only the proven, model-
  agnostic modules avoids carrying dead abstractions ("add the good" beats "subtract the bad").
- **Agent SDK, not Managed Agents:** the SDK runs on *your* server against *your* `/home` folders,
  on *your* subscription. Managed Agents runs in a remote sandbox that can't see your files.
- **Gemini for customers:** the Claude subscription is personal-use; customer-facing usage must not
  draw on it.

## Map

- `MVP-PLAN.md` — the phased build plan. Phase 0 (scaffold) done; Phase 1 is the walking skeleton.
- `src/` — engine modules; each file header states its responsibility + its Phase 1 TODO.
- `/home/operant` — the predecessor. Mine it for proven code to port.
