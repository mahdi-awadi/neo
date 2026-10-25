---
approval: required
---
# Agent Questions and Live Notes on `project_notes` — Implementation Plan (ADR-0050 rev. 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A worker asks the main agent or another project a question with `project_notes ask` and gets the
  answer back into its tool call.
- Notes from the main agent and late answers reach a running worker at its next step.
- Keys reach no worker; they go through the ADR-0044 catalogue and relay instead.
- The design reuses ADR-0043 notes and ports `c12c46f` instead of building a second mechanism.

**Architecture:**
- `createProjectNotes` (ADR-0043) gains `ask`, `takeLive` and `sweepQuestions`, plus one migration
  (v13: three columns on `attention_items`).
- A read-only consult run (`runOrder` + the `consult` worker profile, forking an idle target's
  session) answers each question.
- Delivery uses the SDK user-message priority (`followUp(text, "steer" | "after-turn")`), ported
  from `c12c46f`.
- Resources come from ADR-0044 P1–P2, plus a scrub of the worker environment.

**Tech Stack:** Bun 1.3 + TypeScript, `@anthropic-ai/claude-agent-sdk` (`priority`, `forkSession`),
`bun:sqlite`, zod, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-questions-on-project-notes-design.md` (ADR-0050 rev. 2).
**Also builds:** `docs/superpowers/plans/2026-10-22-tools-catalogue.md` Phases 1–2 (ADR-0044).

## Global Constraints

- **Reuse:**
  - `createProjectNotes` / `runNoteAction` / the `send` checks / `noteRoute` / the notes block
    (`project-notes.ts`);
  - `runOrder` (one-shot runner); `worker-profile.ts` paths; `registry.noteBlocked`;
    `trace.outbound`; `ledger.recordEvent`; `findSecret`; `heldByReserve`;
    `ledger.lastSessionFor`.
  - No new table, no new tool, no new delivery channel.
- **No AI in the engine.** It guards, stores, frames and delivers; workers answer.
- **Never steer, never wake.**
  - Live delivery happens only while the target is in a turn (`control.active()`).
  - Nothing calls `followUp` on an idle session for a note.
  - A note never adds a todo.
- **No secrets.** A secret value appears in no row, event, line, frame, reply or log (sentinel
  tests).
- **Firewall.** `project_notes` is absent from the ingress, tainted and consult runs. Loops and Codex
  have no `neo` server.
- **Config.** Every new value falls back to the spec §8 default through `readNotesCfg` /
  `readToolsCfg`.
- **i18n.** Console strings go in `locales/{en,ar}/console.json` with namespaced keys, AR+EN.
  Numbers stay LTR isolates.
- **Where to work.** Worktree `/home/neo-agent-messaging`, branch `feat/agent-messaging`. Merge a
  phase to `dev` only when it is green.
- **What not to do.**
  - Never merge to master or restart.
  - Never open the live ledger with this code.
  - Never run `install.ts` on the real `~/.claude`.
  - Never delete a remote branch.
- **Green.** Every task ends with `bunx tsc --noEmit` + its tests; every phase ends with the full
  `bun test`.
- **Commits** use `git commit -F <file>` and end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Preamble.** It stays under its 5000-char cap (4978 today). Reword the text; never append.

## Review Focus

1. **A question that is really an order ("fix X in your repo").** Expected: the consult run cannot
   write and answers "needs work, send a request note". Pinned in T6 (profile) and T7 (frame).
2. **The asker's run ends before a late answer.** Expected: the next session of the folder gets it
   once. Pinned in T7 (`takeLive` after `from_session` ends).
3. **The daemon reloads mid-consult.** Expected: the row ends `no answer: reload`, and the asker
   hears it; nothing hangs. Pinned in T7 (`sweepQuestions` at boot).
4. **Many held rows, more than `deliverMaxChars`.** Expected: delivered in order, the rest at the
   next point, none lost or repeated. Pinned in T7.
5. **The main agent pastes a key into a note or an answer.** Expected: the `send` refusal (exists),
   or the withheld answer line. Pinned in T7.

---

## Phase 0 — SDK check (throwaway, ~30 min)

### Task 0: Prove `priority: "next"` and `forkSession` on SDK 0.3.310
**Files:** `spike/notes-live-probe.ts` (not imported by `src/`); the results go in `docs/sdk-notes.md`.
- [ ] Step 1: In a `mktemp -d` folder, start a streaming-input run on a long task ("list every file,
  one Read each"). After its first tool call, push a user message with `priority: "next"` that says
  "PROBE-7731: say this code now". Record whether the model sees it before the turn ends.
- [ ] Step 2: While a run on session S is idle between turns, start `query({resume: S, forkSession:
  true})` and ask about S's history. Record that it answers from it, gets a new id, and leaves S
  unchanged. Then repeat while S is mid-turn, and record the result only (the plan forks idle targets
  only).
- [ ] Step 3: Write the results and the SDK version into `docs/sdk-notes.md`. Commit
  `docs(sdk): priority "next" and forkSession on 0.3.310 (ADR-0050, P0)`. **If step 1 fails, stop
  and report:** live notes would then fall back to turn start only, and the plan is re-sent.

## Phase 1 — tools catalogue, relay, env scrub (ADR-0044 P1)

### Tasks 1–4: ADR-0044 Phase 1, exactly as `2026-10-22-tools-catalogue.md` Tasks 1–4
These build the cards, validator, skills install and `tool_api` relay, plus `ledger.countEvents`.
They produce `DispatchDeps.tools?: Catalogue`.

### Task 5: Scrub the worker environment
**Files:** create `src/engine/worker-env.ts` and `tests/worker-env.test.ts`. Modify `src/config.ts`
(`loadDotEnv` returns the names it set; `tools.workerEnv` in `readToolsCfg`),
`src/engine/session-runner.ts` (`mergedSdkEnv`) and `src/daemon.ts`.

**Interfaces:** produces `scrubWorkerEnv(env: Record<string,string>, o: { engineKeys: ReadonlySet<string>; relayKeys: ReadonlySet<string>; inherit: ReadonlySet<string>; mode: "report" | "strip" }): { env: Record<string,string>; stripped: string[]; reported: string[] }`.

- [ ] Step 1: Failing tests:
  - relay keys are removed in both modes;
  - `report` keeps the engine keys and lists their names;
  - `strip` removes them except `inherit`;
  - the `SENTINEL` value is absent from `stripped`, `reported` and every event;
  - `mergedSdkEnv` applies the scrub;
  - `loadDotEnv` returns only the names it set.
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement it (pure). The daemon records `worker_env_report {names}` once per start.
- [ ] Step 4: PASS plus `tsc`.
- [ ] Step 5: Commit `fix(security): workers never inherit engine-held keys; report or strip Neo's .env keys (ADR-0050 §7, P1.5)`.
  Full `bun test`. **Merge P1 → dev.**

## Phase 2 — tool search, `tools_for`, the hint (ADR-0044 P2)

### Tasks 6a–6c: ADR-0044 Phase 2, exactly as `2026-10-22-tools-catalogue.md` Tasks 5–7
These produce `Catalogue.find(text, {project, folder, limit})`. Their preamble sentence is folded
into T10's single clause. **Merge P2 → dev.**

## Phase 3 — port the follow-up timing (`c12c46f`)

### Task 6: `followUp(text, timing)` with SDK priority, required timing
**Files:** `src/types.ts` (`FollowUpTiming`, `SessionControl.followUp(text, timing)`,
`steersMidTurn?`), `src/engine/session-runner.ts` (`userMessage(text, priority?)`; Claude maps
`steer → "next"` and `after-turn → "later"`; Codex ignores the timing), and every `followUp` caller.
Callers that use `steer`: `pipeline.ts` operator follow-ups, `reply-routing.ts` decision answers.
Callers that use `after-turn`: `dispatch.ts` busy dispatch, todo release, commit finish, wrap-up and
API retry. Also the queued notice strings. Tests: `tests/session-runner.test.ts`,
`tests/pipeline.test.ts`, `tests/dispatch.test.ts` (port `c12c46f`'s tests).

- [ ] Step 1: Port `c12c46f`'s tests:
  - the pushed message has `priority:"next"` for `steer` and `"later"` for `after-turn`;
  - a busy dispatch pushes `after-turn`;
  - an operator follow-up pushes `steer`, and the reply says "it'll see this at its next step";
  - Codex: `steersMidTurn` is false, and the reply says "runs after its current turn".
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement. Make the timing **required**, so `tsc` lists every old caller, then fix each.
  Delete the stale comment "the follow-up queues behind the in-flight turn".
- [ ] Step 4: Run `bunx tsc --noEmit` (no untimed caller is left) and the full `bun test` → PASS.
- [ ] Step 5: Commit `feat(session): follow-ups carry a timing — operator replies steer at the next step, briefs wait for the turn (port of c12c46f, ADR-0050 §5)`. **Merge P3 → dev.**

## Phase 4 — questions and live notes on `project_notes`

### Task 7: `ask`, `takeLive`, `sweepQuestions` (fake consult) + migration v13
**Files:** `src/engine/ledger-migrations.ts` (v13: `attention_items.answer TEXT`,
`delivered_at INTEGER`, `from_session TEXT`, index `(source, delivered_at)`), `src/engine/ledger.ts`
(read and write the three columns; `heldLive(folder)`; `markNotesDelivered(ids, at)` in one
transaction; `questionCounts({fromOrder?, pair?, since})`), `src/engine/project-notes.ts` (kind
`question`; target `main`; resolution `answered`; `ask`, `takeLive`, `sweepQuestions`;
`NotesCfg.questions` / `live`; `noteRoute("question")` → `digest`), `src/engine/liveness.ts:36`
(`kind` += `"agent"`), `docs/CONFIG.md` (the spec §8 rows). Tests:
`tests/project-notes-questions.test.ts`, `tests/project-notes-live.test.ts`,
`tests/ledger-migrations.test.ts`.

**Interfaces:** produces `ProjectNotes.ask`, `takeLive` and `sweepQuestions`, `NotesDeps.consult`,
`catalogue`, `companyFolder`, `liveSession` and `blocked`, the `ConsultRunner` type and
`SenderCtx.sessionId`, `orderId` and `workClass`, all exactly as in spec §2. Also
`frameLive(rows): string`.

- [ ] Step 1: Failing tests, one `it` per spec §10 criterion 1 refusal. Each asserts that no consult
  is called and that the reply contains the config key.
- [ ] Step 2: Failing tests, with a fake consult, a fake clock and a spy trace:
  - criterion 2 (one row with `note_question` + `from_session`, a `note_sent` event without the text,
    the cause, one consult, `main` → company folder);
  - criterion 3 (fork vs fresh, five cases);
  - criterion 4 (in time; the secret sentinel);
  - criterion 5 (late: the next-step text, then delivered once);
  - criterion 6 (`blocked` set and cleared on success, timeout and throw);
  - criterion 9 (who takes);
  - criterion 12 (`sweepQuestions` at boot, and `holdMaxMs`).
- [ ] Step 3: Failing live-note tests (`tests/project-notes-live.test.ts`):
  - a `fyi` from `main` → `takeLive` returns a frame starting
    `[Neo · information, not a new task — continue your current brief]`;
  - a second `takeLive` returns `""`;
  - a `fyi` from another project → `""`;
  - 3 rows over `deliverMaxChars` → in order across two calls;
  - with no session, the notes block lists `main`'s notes and answers first.
- [ ] Step 4: Migration test: v12 → v13 on a temp copy adds the columns and the index. Old rows read
  back with `answer` and `delivered_at` null.
- [ ] Step 5: Run all → FAIL.
- [ ] Step 6: Implement. `ask` = the `send` path (title = the question cut to 120, `ref`
  `q-<order>-<n>`), then the consult raced against `answerWaitMs`. A late settle writes the answer
  and calls the deps' delivery callback (T8 wires it).
- [ ] Step 7: All tests plus `bunx tsc --noEmit` → PASS.
- [ ] Step 8: Commit `feat(notes): questions answered by consult runs, and main's notes held for live delivery (ADR-0050, P4.1)`.

### Task 8: Consult runner, the tool action, delivery wiring
**Files:** create `src/engine/consult.ts` and `tests/consult.test.ts`. Modify `src/config.ts`
(`WorkerPathName` += `"consult"`), `src/engine/worker-profile.ts` (consult defaults, spec §6),
`src/engine/session-runner.ts` (`RunDeps.forkSession?: boolean`, passed to `query`),
`src/engine/project-notes.ts` (`runNoteAction` `ask`; `NOTES_TOOL_DESCRIPTION` covers `ask`, live
notes from main, and drops "only at the target's next session"), `src/engine/dispatch.ts` (zod for
`ask` args; `SenderCtx` from the closure; before a follow-up, prepend `notes.takeLive`),
`src/engine/pipeline.ts` (the same prepend on follow-ups and resumes), and `src/daemon.ts` (build the
consult runner; wire `companyFolder`, `liveSession`, `blocked` and the delivery callback = if the
folder's live session is `active()`, then `followUp(takeLive(...), "steer")`; run `sweepQuestions` at
boot and on the tick). Tests: `tests/consult.test.ts`, `tests/notes-wiring.test.ts`.

**Interfaces:** consumes T6 (`followUp` timing) and T7. Produces
`createConsultRunner(deps: { runOrder: typeof runOrder; cfg: NeoConfig; catalogue?: Catalogue; ledger: Pick<Ledger,"recordOrder"> }): ConsultRunner`
and `consultPrompt(job: { asker: string; need: Need; question: string; matches: ToolMatch[]; answerMaxChars: number }): string`.

- [ ] Step 1: Failing `tests/consult.test.ts`:
  - criterion 7 (disallowed tools; the `neo` tool list is exactly `tools_for` + the memory read
    tool; `deny`; `forkSession` + `resume`; no `saveSession`; no `registry.add`);
  - `consultPrompt` quotes the question as data, names the asker from the job, and includes "answer
    only", "never a secret value — point to tools_for / tool_api" and "if work is needed, say so:
    the asker sends a request note".
- [ ] Step 2: Failing `tests/notes-wiring.test.ts`:
  - criterion 8 (live: exactly one `followUp(frame,"steer")` to a session in a turn; none to an idle
    one; the next operator follow-up starts with the frame);
  - criterion 11 (no `project_notes` on the ingress or consult servers);
  - the tool's `SenderCtx` comes from the closure and the args cannot set it;
  - the dispatch stall clock does not run while `blockedOn agent` (the existing stall harness).
- [ ] Step 3: FAIL.
- [ ] Step 4: Implement.
- [ ] Step 5: PASS, `bunx tsc --noEmit`, full `bun test`.
- [ ] Step 6: Commit `feat(notes): project_notes ask, read-only consult runs, live notes at the next step (ADR-0050, P4.2)`. **Merge P4 → dev.**

## Phase 5 — remove what this replaces, then show, document and review

### Task 9: Removal and guard
**Files:** `tests/no-replaced-mechanisms.test.ts` (new); `docs/adr/0043-*.md` (status line:
"Amended by ADR-0050: notes from main and answers are delivered live (§4)"); `CONTEXT.md` (the
"Notes block" and "Project note" entries mention live notes from main); `README.md` and
`docs/HISTORY.md` (no mention of `ask_agent` or `tell_agent`).
- [ ] Step 1: Failing guard test. It scans `src/` and `tests/` (except itself) and fails on any of
  `ask_agent`, `tell_agent`, `agent_messages`, `agentPost`, `agent-post`. It also asserts that
  ADR-0043's status line contains "Amended by ADR-0050".
- [ ] Step 2: FAIL (on the ADR line).
- [ ] Step 3: Edit the docs. Then check: `git grep -n "ask_agent\|tell_agent\|agent_messages"` →
  only ADR-0050's "Alternatives rejected" and the spec §1/§9 history lines.
- [ ] Step 4: PASS.
- [ ] Step 5: Commit `chore(notes): drop the rev. 1 agent-messaging design, amend ADR-0043, guard against its return (ADR-0050, P5.1)`.

### Task 10: Console, trace, preamble, docs, reviews
**Files:**
- `src/frontends/web/app.ts` (note kind `question`, state `answered`) and
  `src/frontends/web/locales/{en,ar}/console.json` (`notes.kind.question`, `notes.state.answered`);
- `src/engine/trace.ts` (`renderTrace` shows `note #N question → answered 42s`);
- `src/engine/dispatch.ts` (preamble clause: "Missing a fact, tool or key? project_notes ask (main
  or a project) and tools_for — never wait silently, never paste keys.", worded to fit the cap);
- `docs/CONFIG.md`, `docs/HISTORY.md`, `CLAUDE.md` (status + map), ADR-0044 and ADR-0050 → accepted,
  `HANDOFF.md`.

Tests: `tests/console-i18n.test.ts`, `tests/trace.test.ts`, `tests/dispatch.test.ts`.
- [ ] Step 1: Failing tests:
  - criterion 15 (the preamble contains `project_notes ask` and `tools_for`, under 5000 chars);
  - criterion 16 (both keys in EN and AR);
  - the trace line.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: Run `/security-review` (input handling, keys, relay), then
  superpowers:requesting-code-review. Fix the findings. Run the full `bun test` + `tsc`.
- [ ] Step 6: Commit `docs(notes): questions and live notes in the console, trace and preamble; ADR-0044/0050 accepted (P5.2)`.
  Merge → dev. Remove the `node_modules` link, then `git worktree remove /home/neo-agent-messaging`.

## Rollout (operator steps)

| Step | What | Gate |
|---|---|---|
| 1 | Merge `dev` → master, then restart | operator. The ledger migrates v11 → v13 at start (backups are automatic) |
| 2 | Questions, live notes, follow-up timing, `tools_for`, the hint, the relay code | live after step 1 (`notes.questions.enabled` defaults to `true`) |
| 3 | `bun tools/catalogue/install.ts` (the tool skills) | operator go-ahead; no restart |
| 4 | Read `worker_env_report`, set `tools.workerEnv.inherit`, then `engineSecrets: "strip"` | operator, then a restart |
| 5 | `tools.relayEnabled: true`, then ScaleDown to `active` | operator (DPA + quota) |
| 6 | Delete the remote branch `origin/claude/project-thread-n3xiqw` (its `c12c46f` is ported; its other 4 commits are listed in HANDOFF) | operator |
| Off switch | `notes.questions.enabled: false` | operator, then a restart |
