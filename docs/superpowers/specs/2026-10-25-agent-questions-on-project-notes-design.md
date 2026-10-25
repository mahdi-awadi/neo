---
approval: required
---
# Agents ask and tell each other through project notes — design (ADR-0050 rev. 2)

**Order (operator, 2026-10-25):**
- Workers ask the main agent or another project's agent for information or help.
- The main agent gives information to a running worker.
- Keys go through the engine, never as raw values.
- **Correction (same day):** reuse the project-to-project code Neo already has, never duplicate it,
  and remove the old approach.

**Decision:** ADR-0050 rev. 2, which amends ADR-0043. **Resources:** ADR-0044 (spec
`2026-10-22-tools-catalogue-design.md`); this plan builds its Phases 1–2. **Terms:** `CONTEXT.md`
§ Projects telling each other, § Agents asking each other, § Shared tools.

## 1. What exists, and what this builds on

A search of master, dev and every branch from 2026-10-01 to 2026-10-25, plus `src/` and
`docs/adr`, found these mechanisms:

| # | Mechanism | Where | Status | Role here |
|---|---|---|---|---|
| 1 | `project_notes` (ADR-0043): project → project typed notes stored as attention items, notes block at a fresh start, caps, secrets, cause | `src/engine/project-notes.ts`, `dispatch.ts` tool, migration v12; commits `74230b2`…`e1649d7` | on `dev`, restart-gated | **the base**: questions and live notes extend it |
| 2 | Priority follow-ups: SDK `priority: "next"` (steer at the next tool boundary) / `"later"` (after the turn) | `c12c46f` on `origin/claude/project-thread-n3xiqw` (2026-10-04) | branch only, never merged; does not apply cleanly to `dev` | **the delivery point**: ported by hand |
| 3 | Dispatch result + dispatcher inbox (ADR-0007): a project's final result reaches the company, durably | `dispatch.ts` `queueDispatcherReport` / `flushDispatcherInbox`, `pipeline.ts` `deliverToCompany` | live (master) | unchanged. It carries end-of-run results, not questions |
| 4 | `dispatch` / `todo` (ADR-0008): company → project work, busy projects queue | `dispatch.ts`, `todo-queue.ts` | live | unchanged. Work still starts only here |
| 5 | `ask_operator` + decision cards (ADR-0049) + `deliverIntoFolder`: worker → operator, the answer goes back into the folder | `dispatch.ts`, `reply-routing.ts` | live; the card shape is on `dev` | unchanged. It is the fallback when no agent can answer |
| 6 | Handoffs (ADR-0021/0029): a session → its own successor | `context-policy.ts`, `context-checkpoint.ts` | live | not cross-agent. Unchanged |
| 7 | Tools catalogue (ADR-0044): cards, `tools_for`, `tool_api` relay | `feat/tools-catalogue` (docs only) | branch, not built | **resources**: built by this plan |
| 8 | ADR-0050 rev. 1: `agent_messages`, `ask_agent`, `tell_agent`, PostToolUse hook | `9343e63` (docs only) | branch, not built | **replaced** by this revision |

**Why `project_notes` is the base.** Rev. 1 would have rebuilt most of what notes already do. Notes
lack exactly three things: an answer that comes back in minutes, a `main` target, and delivery to a
worker that is running. This design adds those three things and nothing else. The dispatcher inbox
(3) does not fit: it delivers to the company only, and only at the end of a run. Decision cards (5)
go to the operator, not to an agent.

## 2. The seam

The seam stays `createProjectNotes(deps): ProjectNotes` in `src/engine/project-notes.ts`. It grows
by three members, and `runNoteAction` grows one action:

```ts
interface ProjectNotes {               // existing members unchanged: send, list, show, ack, resolve, withdraw, block, …
  ask(from: SenderCtx, q: { to: string; question: string; need: Need }, now: number): Promise<string>; // the tool result
  /** Held live notes + answers for this session's folder, framed; marks them delivered. "" if none. */
  takeLive(sessionId: string, folder: string, now: number): string;
  /** At boot and on the tick: answering rows left by a reload → failed; held answers older than live.holdMaxMs stop being delivered live. */
  sweepQuestions(now: number): void;
}
interface NotesDeps {                  // existing deps unchanged, plus:
  consult?: ConsultRunner;             // undefined → `ask` is refused ("questions are off")
  catalogue?: Catalogue;               // ADR-0044 tool search, for need:"resource"
  companyFolder: string;               // the folder `main` names
  liveSession?: (id: string) => boolean;
  blocked?: (sessionId: string, on: BlockedOn | undefined) => void; // registry.noteBlocked
}
type ConsultRunner = (job: { folder: string; forkFrom?: string; prompt: string; cause?: Cause;
                             workClass: WorkClass }) => Promise<{ answer: string; ok: boolean; reason?: string }>;
```

`SenderCtx` gains `sessionId`, `orderId?` and `workClass` (the tool sets them from the closure; the
args cannot). Thin users:
- `project_notes` in `neoMcpServers`: the action `ask`, and the `send` description says that a note
  from `main` reaches a running worker at its next step.
- The delivery wiring calls `takeLive` and then `control.followUp(text, "steer")`, in two places:
  1. right after a note from `main` or an answer is stored, if the target folder's live session is in
     a turn;
  2. before every follow-up or resume the pipeline and dispatch send (the text is prepended).
- `createConsultRunner` (`src/engine/consult.ts`) wraps `runOrder` with the `consult` profile.

## 3. `project_notes ask`

Args: `to` (a project name, or `main`), `question`, `need` (`info` | `resource` | `help`; default
`info`). The flow:
1. **Address.** `main` resolves to `companyFolder`. Any other name resolves through the existing
   rule (a folder directly under the work root, not a desk). The target is never the sender.
2. **Check.** The existing `send` checks run, with `title` = the question cut to 120 characters,
   `body` = the question, kind `question`, severity `normal`, and `ref` = `q-<order>-<n>`.
   Questions add these checks: `consult` is wired; the question is no longer than `questionMaxChars`;
   open questions for (sender, target) are below `questions.maxOpenPerPair` (1); the sender order's
   questions in the last hour are below `maxPerOrderPerHour`, or `backgroundMaxPerOrder` for
   background work; running consults are below `maxConcurrentConsults`; and for background work the
   reserve is not held. Each refusal names its config key, and no run starts.
3. **Store.** `send` stores the row, which writes the event `note_sent`, the trace line
   `note #N → main: <title>` and the `from_session`. A question is never routed "now" to the
   operator: `noteRoute` maps `question` to `digest`.
4. **Resource matches.** For `need: "resource"` with a catalogue, `catalogue.find(question,
   {project, folder, limit: 3})`.
5. **Consult.**
   - `forkFrom` = `ledger.lastSessionFor(target folder)`, but only when:
     - the target's registry session is not in a turn (no live control, or `control.active()` is false);
     - it uses the same SDK;
     - the last measured occupancy is ≤ `forkMaxOccupancyPct`.
   - The prompt is a fixed engine frame. It contains the asker (the project from the session), the
     need, the question as quoted data, and the matches. Its rules: answer only; read-only; never a
     secret value (point to `tools_for` / `tool_api`); if work is needed, say so (the asker sends a
     `request` note); at most `answerMaxChars`.
6. **Wait.** Call `blocked(sid, {kind:"agent", label:"asked <to>"})`, race the consult against
   `answerWaitMs`, and clear the block in `finally`.
7. **In time.** Run `findSecret` on the answer; on a match, use the withheld line instead. Then cut it
   to `answerMaxChars` and store it in `answer`. Resolve the note with the new resolution
   `{how:"answered"}`, set `delivered_at`, write the event `note_answered`, and add the trace line
   `↩ main answered note #N in 42s`. Return the answer, with the matches first.
8. **Late.** Return: "No answer yet (note #N). It will reach you at your next step. Continue other
   work; if you are blocked, check-point and raise ask_operator." When the consult settles, store the
   answer as in step 7, but leave `delivered_at` empty. If the asker folder's live session is in a
   turn, deliver it now.
9. **Failed** (stall, error, empty): the resolution is `{how:"not_needed", reason:"no answer: <reason>"}`.
   The asker gets the reason, plus "raise ask_operator if you are blocked".

## 4. Live notes (amends ADR-0043 §4)

- **What is delivered live:** an open `fyi` or `request` note whose sender is `main` (the company),
  and an `answered` question with `delivered_at` empty (delivered to its sender's folder).
- **Who takes it:** a row with `from_session` (an answer) goes only to that session while it is
  live. After that session ends, it goes to any session of the folder. Notes from `main` go to any
  session of the target folder. `takeLive` marks the rows in one transaction, so each row is
  delivered once.
- **How:**
  - If the target session is in a turn → `followUp(frame, "steer")` (priority `next`).
  - If it is idle → nothing yet; the text is prepended to the next follow-up or resume.
  - If there is no session → the notes block at the next fresh start, where notes from `main` and
    answers are listed first.
  - A Codex session (`steersMidTurn` is false) receives at its next turn.
- **Frame:** `[Neo · information, not a new task — continue your current brief]`, then one line per
  row (`• note #12 from main (fyi): <title> — <body cut>` / `• answer to note #9 from eticket-v3: …`),
  capped at `deliverMaxChars`. Rows that do not fit wait for the next point.
- A live note from `main` stays an open note. The target acks or resolves it as today. Delivery sets
  only `delivered_at`.
- Notes from projects (not `main`) are never delivered live (ADR-0043 is unchanged for them).

## 5. Follow-up timing (port of `c12c46f`)

- `SessionControl.followUp(text: string, timing: FollowUpTiming)`, where
  `FollowUpTiming = "steer" | "after-turn"`. The timing is **required**.
- Claude `"steer"` sends `priority: "next"`; Claude `"after-turn"` sends `"later"`.
- Codex ignores the timing, and `steersMidTurn` is false.
- Callers:
  - operator follow-ups (pipeline), decision answers and live notes use `"steer"`;
  - `dispatchToProject` into a busy session, todo releases and the commit-finish, wrap-up and
    API-retry follow-ups use `"after-turn"`.
- The queued notice says which happens: "it'll see this at its next step" or "runs after its
  current turn". The text lives in the existing reply strings.

## 6. Consult profile and runner

- `WorkerPathName` gains `"consult"`. Its defaults live in `config.workers.consult`, and the model is
  never hardcoded.
  - Disallowed tools: Write, Edit, NotebookEdit, Bash, Task, Agent, KillShell, SlashCommand.
  - MCP: a `neo` server with only `tools_for` and the memory read tool; codebase-memory.
  - The project fence applies, and `maxTurns` = `questions.consultMaxTurns`.
- `createConsultRunner({ runOrder, cfg, catalogue, ledger })`:
  - builds the order with the job's cause (so `/trace` shows it);
  - calls `runOrder(order, { onEscalation: async () => "deny" }, runDeps)` with `forkSession: true` +
    `resume: forkFrom` when forking;
  - never calls `ledger.saveSession` and never registers a session;
  - returns the final result text as `answer`.

## 7. Resources and the worker environment

These are unchanged from rev. 1:
- ADR-0044 P1–P2 as its plan says.
- `scrubWorkerEnv` in `src/engine/worker-env.ts`:
  - relay `envKey`s are always removed;
  - Neo's `.env` key names are recorded in `"report"` mode (the default) and removed in `"strip"`
    mode, except `inherit`;
  - it is called in `mergedSdkEnv`.
- Its config lives under `tools.workerEnv`, next to the relay it protects.

## 8. Config (added to `notes`, read by the existing `readNotesCfg`)

| Key | Default | Meaning |
|---|---|---|
| `questions.enabled` | `true` | `ask` refuses when false |
| `questions.answerWaitMs` | `240000` | how long `ask` holds the call |
| `questions.consultMaxTurns` | `12` | the turn cap of one consult run |
| `questions.forkMaxOccupancyPct` | `60` | fork only below this occupancy |
| `questions.maxOpenPerPair` | `1` | open questions from one sender to one target |
| `questions.maxPerOrderPerHour` / `backgroundMaxPerOrder` | `6` / `2` | questions per order |
| `questions.maxConcurrentConsults` | `2` | consult runs at once |
| `questions.questionMaxChars` / `answerMaxChars` | `1500` / `4000` | size caps |
| `live.deliverMaxChars` | `6000` | the most text one delivery carries |
| `live.holdMaxMs` | `86400000` | after this an undelivered answer stays only as a resolved note |
| `tools.workerEnv.engineSecrets` / `inherit` | `"report"` / SDK auth key names | §7 |

The existing `maxPerSenderPerDay` (30) and `maxOpenPerPair` (50) also count questions.

## 9. What is removed

- **ADR-0050 rev. 1 design** (never built): the `agent_messages` table, `agent-post.ts`, the
  `ask_agent` and `tell_agent` tools, the PostToolUse delivery hook, `config.agents`, and the rev. 1
  glossary terms (Agent ask, Agent tell, Delivery point, Ask chain). They are already replaced in the
  docs by this revision. A guard test makes sure none of these names appears in `src/`.
- **The untimed `followUp(text)`** is replaced by `followUp(text, timing)`. `tsc` proves that no
  caller is left. The old comment "the follow-up queues behind the in-flight turn" goes too.
- **ADR-0043 §4's "a note never enters a live session"** is amended in ADR-0043's status line
  ("amended by ADR-0050: notes from main and answers are delivered live"). The `project_notes`
  description loses its "only at the target's next session" wording.
- **Branch `origin/claude/project-thread-n3xiqw`**, after the port: `c12c46f` is superseded by the
  port. The branch's other four commits are listed for the operator. Deleting a remote branch is an
  operator step, never done by this plan.

## 10. Acceptance criteria

1. `ask` refuses, starting no consult and naming the key, for each of these: questions off; no
   consult wired; an unknown target; the sender itself; a desk other than `main`; a blank, long or
   secret question; an open question for the pair; the per-order cap, the background cap (counts at
   59 min and 61 min) and the concurrency cap; and background work while the reserve is held. The
   existing `send` refusals (secret, `maxPerSenderPerDay`) also apply.
2. A good `ask` stores one attention row (source `note`, kind `note_question`, `from_session` set),
   one `note_sent` event without the question text, and one trace line with the sender's cause. It
   starts exactly one consult in the target folder. `main` resolves to the company folder.
3. Fork vs fresh: it forks an idle Claude target at 40 %. It starts fresh at 70 %, for a target in a
   turn, for a Codex session, and when there is no saved session.
4. An answer in time is the tool result. The row is resolved `answered` with `answer` and
   `delivered_at` set, and there is one `note_answered` event. A secret-looking answer gives the
   withheld line, and the sentinel appears nowhere (rows, events, lines, replies).
5. A late answer: the "next step" text comes back at `answerWaitMs` (fake clock). After the consult
   settles, the answer is delivered once: by `followUp(…, "steer")` if the asker is in a turn, else
   prepended at the next turn. A second `takeLive` returns `""`.
6. `blockedOn {kind:"agent"}` is set during the wait and cleared on success, timeout and throw. The
   dispatch stall clock does not run during it (the existing stall harness).
7. Consult run options: the disallowed tools of §6; a `neo` server listing exactly `tools_for` and
   the memory read tool; `onEscalation` always `deny`; `forkSession` + `resume` when forking. No
   `saveSession` and no registry call.
8. Live notes: a `fyi` note from `main` to a project in a turn produces exactly one
   `followUp(frame, "steer")`. To an idle session, nothing happens until its next follow-up, which
   starts with the frame. With no session, it is listed first in the next notes block. A `fyi` note
   from another project is never delivered live. A delivery never starts a turn by itself (no
   `followUp` while idle).
9. Who takes: an answer with a live `from_session` is not delivered to another session of the same
   folder. Once that session ends, the other session takes it once.
10. Follow-up timing: Claude `steer` → `priority:"next"`, `after-turn` → `"later"`. A dispatch into a
    busy session uses `after-turn`. An operator follow-up uses `steer`. The queued notice names the
    timing. Codex has `steersMidTurn` false.
11. The firewall: ingress (`notes: undefined`), tainted runs (no MCP) and consult runs have no
    `project_notes`. Loops and Codex have no `neo` server.
12. `sweepQuestions`: an `answering` question found at boot resolves as `no answer: reload`, and the
    failure line is held for the sender. A held answer older than `holdMaxMs` is not delivered live
    any more (it stays visible on the note).
13. Migration v13 adds `answer`, `delivered_at` and `from_session` to `attention_items`, plus an
    index on `(source, delivered_at)`. v12 → v13 passes on a copy.
14. The removal guard: no `ask_agent`, `tell_agent`, `agent_messages` or `agentPost` in `src/` or
    `tests/` (a test). `tsc` passes with `followUp`'s timing required.
15. The preamble names `project_notes ask` and `tools_for` in one reworded clause and stays under its
    5000-character cap.
16. Console: the note views render `question` and `answered` with i18n keys
    (`notes.kind.question`, `notes.state.answered`) in EN and AR. Numbers stay LTR.

## 11. Edge cases

- The company is the target and is mid-turn: no fork. The consult starts fresh in `/home/neo/agent`,
  where it still has the main agent's CLAUDE.md and memory.
- The asker's run ends before a late answer: the next session of its folder gets the answer at its
  first follow-up, or it is listed in the notes block.
- A question that is really an order: the consult run cannot write, and the frame tells it to answer
  "this needs work: send a request note".
- The daemon reloads mid-consult: `sweepQuestions` at boot (criterion 12).
- An Arabic question: passed through as is.
- Many held rows: they are delivered in creation order, up to `deliverMaxChars`, and the rest wait.

## 12. Not in scope

- Notes and questions for loops and Codex (the ADR-0044 gap).
- Live delivery of project-to-project notes (only `main`'s notes and answers are live).
- Promoting ScaleDown (an operator step: DPA and quota).
- ADR-0044 Phases 3–5.
