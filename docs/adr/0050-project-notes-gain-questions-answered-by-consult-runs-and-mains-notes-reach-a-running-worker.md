# Project notes gain questions answered by read-only consult runs, and main's notes reach a running worker at its next step

**Status:** accepted (2026-10-25, revision 2; built on `feat/agent-messaging`, restart-gated). **Amends ADR-0043**
(project notes). Finishes ADR-0044 (tools catalogue; approved together with this ADR). Adopts
commit `c12c46f` (branch `origin/claude/project-thread-n3xiqw`, 2026-10-04, never merged): "operator
follow-ups reach a busy Claude worker mid-turn". Related: ADR-0006, ADR-0007, ADR-0008,
ADR-0015/0016, ADR-0031, ADR-0049.

On 2026-10-24, eticket-v3 (todo #591) needed the ScaleDown key and tool. The main agent knew about
them. The worker had no way to ask, and the main agent never sent them.

Revision 1 of this ADR (commit `9343e63`) proposed a parallel mechanism: its own `agent_messages`
table, the `ask_agent` and `tell_agent` tools, and a PostToolUse delivery hook. The operator pointed
out that Neo already has project-to-project messaging. A search of every branch from the last
three weeks found these existing pieces:
- **`project_notes`** (ADR-0043, on `dev` since 2026-10-22, restart-gated). It already has
  addressing, the sender taken from the session, size caps, a secret refusal, per-sender and
  per-pair caps, cause and trace lines, a routing table, the notes block at a fresh start, and a
  lifecycle checked against facts.
- **`c12c46f`**. It uses the SDK user-message `priority` (`"next"`: the CLI attaches the message at
  the running turn's next tool boundary; `"later"`: after the turn).

Revision 2 builds on these two pieces and drops everything in revision 1 that duplicated them.

## Decision

1. **A question is a project note.** `project_notes` gains the action `ask`, which takes `to`,
   `question` and `need` (`info` | `resource` | `help`) and is stored as the note kind `question`.
   - It goes through the same `send` path: the same addressing, sender-from-session, size and secret
     checks, caps, cause, `note_sent` event and trace line.
   - Addressing gains one target, `main`, which means the company desk. A desk can be a target only
     under that name.
   - A question is an attention item on the target, like any note. So it shows on the target's
     dashboard, and the operator can see what was asked of whom.
2. **A read-only consult run answers a question.**
   - The engine starts it with the existing one-shot `runOrder` (the loop runner). It runs in the
     target's folder with a new `consult` worker profile:
     - the disallowed tools are Write, Edit, NotebookEdit, Bash, Task and Agent;
     - the `neo` server holds only `tools_for` and the memory read tool;
     - no codebase-memory server: the governor escalates its reads, and a consult run denies every
       escalation, so the server would be useless; its mutating tools are also disallowed;
     - every escalation is denied;
     - it is never put in the session registry, so it never makes a project busy.
   - It forks the target's last saved session (`resume` + `forkSession: true`) when the target is
     between turns, uses the same SDK, and is under `notes.questions.forkMaxOccupancyPct`. Otherwise
     it starts fresh in the target folder.
   - An ask can make an agent answer, but never act. Work still starts only from the operator
     (ADR-0043).
3. **The asker waits, within a limit.**
   - The tool holds the call for up to `notes.questions.answerWaitMs`, with `blockedOn: {kind: "agent"}`
     so the stall limit does not run.
   - An answer that comes in time is the tool result, and the note resolves as `answered`. The
     answer is stored on the row in a new `answer` column.
   - A late answer is held on the row (`delivered_at` is empty) and reaches the asker at its next step
     (point 4).
   - If there is no answer, the tool result says to raise `ask_operator` if the worker is blocked.
4. **Notes from main reach a running worker at its next step (amends ADR-0043 point 4).**
   - The company already sends notes. A `fyi` or `request` note **from `main`** and a held answer are
     delivered to a live session of the target folder with `control.followUp(frame, "steer")`. This
     is the ported `c12c46f`: priority `"next"`, attached at the running turn's next tool boundary.
   - This happens only while the session is in a turn (`control.active()`). An idle session is never
     woken: the text is prepended to its next turn, or the notes block shows it at the next fresh
     start (as today).
   - The frame says: information, not a new task; continue your current brief.
   - All other notes keep the ADR-0043 rule: no live delivery.
   - This gives the main agent its "tell" with no new tool: `project_notes send kind:fyi`.
5. **Briefs never steer.** As in `c12c46f`, a brief that `dispatchToProject` queues into a busy
   session uses `"after-turn"` (priority `"later"`). `followUp` must now always be given a timing.
6. **Resources:** keys never travel in a note. A question with `need: "resource"` first runs the
   ADR-0044 tool search, and the matches go to the consult run and to the asker. Answers are
   checked with `findSecret`, and an answer that matches is withheld. The worker environment scrub
   (relay keys always removed; Neo's `.env` keys reported, then removed when the operator chooses)
   is unchanged from revision 1.
7. **Bounds** are added to the notes config as `notes.questions.*`:
   - at most 1 open question per pair (so two agents cannot ping-pong);
   - a cap per order per hour, with a lower one for background work;
   - a cap on concurrent consult runs, and the reserve check for background consults.

   A consult run has no notes tool, so a chain stops at one hop. That needs no depth counter.
8. **Storage:** no new table. Migration v13 adds `answer`, `delivered_at` and `from_session` to
   `attention_items`.

## Alternatives rejected

- **Revision 1: an own `agent_messages` table plus `ask_agent`/`tell_agent` tools.** It would copy
  the notes code: addressing, sender, caps, secrets, cause, trace, lifecycle. That is the second
  implementation the baseline forbids. It is dropped before any of it was built.
- **A PostToolUse `additionalContext` hook as the delivery point (revision 1).** It is a second way
  to put text into a turn. The SDK's own `priority: "next"` already does this, and `c12c46f` built
  and tested it. The hook's own SDK docs also say it is "not a delivery channel".
- **A separate tool for tells.** `project_notes send kind:fyi` from the company is a tell. Live
  delivery is a routing rule, not a new tool.
- **Queue the question into the target's live session.** The asker would wait for the target's whole
  brief, and two agents asking each other would deadlock.
- **A consult run with normal tools.** One worker's text would become another worker's orders. This
  is the injection path ADR-0043 rejected.

## Consequences

- One tool (`project_notes`) for all agent-to-agent traffic: findings, information, requests,
  questions and answers. The preamble line that already points to it stays (reworded).
- ADR-0043 point 4 is amended: live delivery happens only for notes from `main` and for answers.
- `SessionControl.followUp(text, timing)` takes a required timing, so `tsc` proves that no caller
  still uses the old untimed path.
- Every consult run is a real worker run. Caps, the reserve check and the fresh-start fallback keep
  it bounded.
- Loops and Codex have no `neo` server, so they cannot ask (the ADR-0044 gap). Codex sessions
  receive only at turn start (`steersMidTurn` is false).
