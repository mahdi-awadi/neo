# Kickoff prompt — continue Neo (Phase 3b: Gemini customer path)

Open Claude Code inside `/home/neo` and paste the prompt below.

---

You're picking up the **Neo** project. First read `CLAUDE.md` and `MVP-PLAN.md` — they are the source of truth.

**Status:** Phases 0–3 complete, plus a live **loop runtime** and a **customer inbox**. `bun test`
green (239 tests in `tests/`), `tsc` clean.
- Phase 1: walking skeleton (`/open` → governed headless Claude worker → streamed → ledger).
- Phase 2: live follow-ups, idle-close + resume, budget meter, concurrency, `/status` + `/kill` — verified against the real SDK.
- Phase 3 (reprioritized): the **operator web console** at `neo.tech-gate.online` — Telegram-Login → trust-on-first-use admin → signed session cookie → the same `source:"neo"` SDK pipeline as Telegram, behind Traefik. Live-verified (HTTPS + valid cert).
- Loop runtime: `trigger → action → goal` loops through the governed worker — `Goal`/`Trigger`/`Bounds`, a 60s scheduler, `/loop` command + a built-in library (`gold-gofmt`, `green`, `error-sweep`, `docs-sweep`, `inbox-delete`). See `docs/loops.md`.
- Customer inbox: inbound mail queues for operator review (Telegram `/inbox` + web console, view/draft/edit/send/**delete**) — no auto-reply.
- **Next spec'd:** data-driven loop CRUD (`docs/superpowers/specs/2026-06-27-loop-crud-design.md`) — author loops from the admin console, no restart. Phase 3b (below) remains the other deferred track.

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

- **Launch:** `bun run src/daemon.ts` (needs `TELEGRAM_TOKEN` in `.env`, already set). It starts the Telegram bot + the web console on `172.20.0.1:3003` (Traefik → `https://neo.tech-gate.online`).
- **Become admin:** the FIRST Telegram id to message the bot claims admin (stored in `data/admin.db`). Start the daemon and message your bot yourself before anyone else. To reset admin: delete `data/admin.db`.
- **Web console:** open `https://neo.tech-gate.online` → "Log in with Telegram" → you're in (only the admin id is accepted).
- **Security:** the bot token was pasted in chat once — consider rotating it via BotFather. Optionally set `telegramAllowFrom` (your numeric id) in a `config.json` to pre-restrict who can even claim admin.
