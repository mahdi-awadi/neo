# Kickoff prompt — continue Neo (Phase 3)

Open Claude Code inside `/home/neo` and paste the prompt below.

---

You're picking up the **Neo** project. First read `CLAUDE.md` and `MVP-PLAN.md` in this folder — they are the source of truth.

**Status:** Phases 0, 1, and 2 are complete. `bun test` is green (58 tests) and `bunx tsc --noEmit` is clean. Phase 2 was verified end-to-end against the **real** Agent SDK (build-then-verify): a `/open` starts a live, governed worker; plain-text messages stream as **follow-ups into the running session**; quiet sessions **idle-close** and persist their SDK id so a later `/open` **resumes** them; a rolling **budget meter** reserves interactive headroom; multiple projects run concurrently in a registry; `/status` + `/kill` work. The verified streaming/interrupt/resume surface (and two shaping fixes) are recorded in `docs/sdk-notes.md` → Phase 2.

**Your job: build Phase 3 — the customer path (Gemini).** One customer channel (email webhook or a web form) → Gemini *reads* the customer message → produces an `Order(source:"customer")` → the engine executes it via trusted code. The whole point is to **prove, in code, that customer work never touches the Claude subscription** — the provider firewall already refuses `source:"customer"` → subscription; Phase 3 builds the Gemini execution path behind it.

**How to work (non-negotiable — see CLAUDE.md):**
1. **First write a bite-sized sub-plan for Phase 3** — one task per independently testable deliverable — and show it to me before coding. Phases 3–4 each get their own detailed plan.
2. Then implement **strictly TDD**: write the failing test → run it and watch it fail for the right reason → minimal code to pass → refactor → commit. One task = one commit.
3. `bunx tsc --noEmit` **and** `bun test` must be GREEN before every commit.
4. **Never break the firewall:** customer-source work must never route to the subscription — keep that assertion in the tests. The Claude subscription is personal-use; Gemini is the *only* brain customers reach, and Neo must never offer customers a Claude login.
5. **No AI in the engine.** AI lives only inside SDK workers (Claude) and customer-message reads (Gemini). The engine routes, governs, meters, records.
6. **Do not make real network calls in unit tests** — inject a fake Gemini client, exactly like the Agent SDK is faked in `tests/session-runner.test.ts` and the runner/pipeline in the existing tests.
7. Secrets stay in `.env` (gitignored). `GEMINI_API_KEY` is already in config.

Start by proposing the Phase 3 sub-plan.

---
