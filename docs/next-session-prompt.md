# Kickoff prompt — continue Neo (Phase 3b: Gemini customer path)

Open Claude Code inside `/home/neo` and paste the prompt below.

---

You're picking up the **Neo** project. First read `CLAUDE.md` and `MVP-PLAN.md` — they are the source of truth.

**Status:** Phases 0–3 complete, plus a live **loop runtime** (with data-driven CRUD) and a
**customer inbox**. `bun test` green (346 tests in `tests/`), `tsc` clean.
- Phase 1: walking skeleton (`/open` → governed headless Claude worker → streamed → ledger).
- Phase 2: live follow-ups, idle-close + resume, budget meter, concurrency, `/status` + `/kill` — verified against the real SDK.
- Phase 3 (reprioritized): the **operator web console** at `neo.example.com` — Telegram-Login → trust-on-first-use admin → signed session cookie → the same `source:"neo"` SDK pipeline as Telegram, behind Traefik. Live-verified (HTTPS + valid cert).
- Loop runtime: `trigger → action → goal` loops through the governed worker — `Goal`/`Trigger`/`Bounds`, a 60s scheduler, `/loop` command + generic built-ins (`green`, `error-sweep`, `docs-sweep`). See `docs/loops.md`.
- Data-driven loop CRUD (`docs/superpowers/specs/2026-06-27-loop-crud-design.md`): loop *definitions* are data (ledger `loop_defs`), so an operator authors/edits/deletes loops from the admin web console with no restart; built-ins stay run/toggle-only.
- Customer inbox: inbound mail queues for operator review (Telegram `/inbox` + web console, view/draft/edit/send/**delete**) — no auto-reply.
- **Deferred track:** Phase 3b (below) — the Gemini customer path.

**Your job: build Phase 3b — the customer path (Gemini)**, the originally-planned Phase 3 that was deferred. One customer channel (email webhook or a public web form, distinct from the operator console) → Gemini **reads** the customer message → `Order(source:"customer")` → the engine executes via **Gemini, never the Agent SDK / subscription**. Prove the firewall end-to-end: customer work never touches the Claude subscription.

**How to work (non-negotiable — see CLAUDE.md):**
1. **First write a bite-sized sub-plan** — one task per independently testable deliverable — and show it before coding.
2. **Strictly TDD**: failing test → watch it fail → minimal code → refactor → commit. One task = one commit. `bunx tsc --noEmit` + `bun test` green before every commit.
3. **Never break the firewall:** `provider-router` currently refuses `customer` → subscription; flip it to `customer` → `{provider:"gemini"}` once the path exists, and keep the test that customer can never resolve to `subscription` even if misconfigured.
4. **No AI in the engine.** AI only inside SDK workers (Claude) and customer-message reads (Gemini). Don't make real Gemini/network calls in unit tests — inject a fake client (like the SDK is faked in `tests/session-runner.test.ts`).
5. Secrets in `.env` (gitignored). `GEMINI_API_KEY` is in config but currently empty — add it for the live verify.

Start by proposing the Phase 3b sub-plan.

---

## Operator notes (to actually run what's already built)

- **Launch:** `bun run src/daemon.ts` (needs `TELEGRAM_TOKEN` in `.env`). It starts the Telegram bot + the web console on the configured `WEB_HOST:WEB_PORT` (default `127.0.0.1:3003`), typically behind a reverse proxy (e.g. Traefik → your `PUBLIC_URL`).
- **Become admin:** the FIRST Telegram id to message the bot claims admin (stored in `data/admin.db`). Start the daemon and message your bot yourself before anyone else. To reset admin: delete `data/admin.db`.
- **Web console:** open `https://neo.example.com` → "Log in with Telegram" → you're in (only the admin id is accepted).
- **Security:** the bot token was pasted in chat once — consider rotating it via BotFather. Optionally set `telegramAllowFrom` (your numeric id) in a `config.json` to pre-restrict who can even claim admin.
