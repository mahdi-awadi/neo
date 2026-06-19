# Kickoff prompt — continue Neo (Phase 2)

Open Claude Code inside `/home/neo` and paste the prompt below.

---

You're picking up the **Neo** project. First read `CLAUDE.md` and `MVP-PLAN.md` in this folder — they are the source of truth.

**Status:** Phase 0 (scaffold + verified Agent SDK) and Phase 1 (the walking skeleton) are complete. `bun test` is green and `bunx tsc --noEmit` is clean. The full loop works end-to-end with a real SDK run: a `/open <folder> <task>` order is parsed → routed through the firewall → run by a headless Claude worker that opens the folder and is governed via `canUseTool` → progress streamed back → outcome recorded in the bun:sqlite ledger. No tmux.

**Your job: build Phase 2** — live follow-up messages into a *running* session; idle-close + `resume` (carry the SDK session id in the ledger); full budget metering with the interactive reserve; concurrent project sessions in the registry; and `/status` + `/kill`.

**How to work (non-negotiable — see CLAUDE.md):**
1. **First write a bite-sized sub-plan for Phase 2** — one task per independently testable deliverable — and show it to me before coding. Phases 2–4 each get their own detailed plan.
2. Then implement **strictly TDD**: write the failing test → run it and watch it fail for the right reason → minimal code to pass → refactor → commit. One task = one commit.
3. `bunx tsc --noEmit` **and** `bun test` must be GREEN before every commit.
4. **Never break the firewall:** customer-source work must never route to the subscription — keep that assertion in the tests.
5. In `session-runner`, the `canUseTool` **allow** decision must echo `updatedInput` (see `docs/sdk-notes.md`). **Do not make real SDK calls in unit tests** — inject a fake `query`, exactly like the existing `tests/session-runner.test.ts`.
6. Reuse proven code from `/home/operant` where it helps (session tracking, `/status`, `/kill` patterns), but **never** its tmux / shim / socket / scraper layer.
7. Secrets stay in `.env` (gitignored). The engine stays deterministic — no AI in it; AI only inside SDK workers and Gemini reads.

Start by proposing the Phase 2 sub-plan.

---
