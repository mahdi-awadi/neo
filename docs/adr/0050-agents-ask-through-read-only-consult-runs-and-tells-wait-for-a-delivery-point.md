# Agents ask through read-only consult runs, and tells wait for a delivery point

**Status:** proposed (2026-10-25; waits for the operator's approval). Extends ADR-0043 (project
notes) and finishes ADR-0044 (tools catalogue, approved together with this ADR). Related: ADR-0006
(governor hook), ADR-0007 (dispatch reports to its dispatcher), ADR-0008 (todo queue), ADR-0015/0016
(cause, threads), ADR-0021 (safe checkpoints), ADR-0031 (project fence), ADR-0049 (decision cards).

On 2026-10-24, eticket-v3 (todo #591) needed the ScaleDown key and tool. The main agent knew about
them. The worker had no way to ask, and the main agent never sent them. The operator says they asked
for this before. Today a worker can only raise a decision for the operator (`ask_operator`) or leave
a note that only the operator turns into work (`project_notes`). Neither gets an answer from another
agent while the worker runs. The main agent also cannot give information to a running worker:
`dispatch` to a busy project queues a whole brief behind the current one.

## Decision

1. **`ask_agent({to, question, need})` is a worker tool in the `neo` MCP server.** `to` is `main` or
   a project folder under the work root. `need` is `info`, `resource` or `help`. The engine checks
   the ask (step 6), records it, starts a **consult run**, and holds the tool call for up to
   `agents.answerWaitMs`. If the answer comes in time, it is the tool result. If not, the tool returns
   "the answer will come to you later" and the answer goes to the asker at its next **delivery point**
   (step 3). The tool result then tells the worker: continue other work, or raise `ask_operator` if
   it is blocked. While the call waits, the session is `blockedOn: {kind: "agent"}`, so the stall
   limit does not run. This is the rule that already applies to operator decisions.
2. **A consult run answers. It is read-only and the engine throws it away afterwards.** It starts in
   the target's folder. It forks the target's latest session (`resume` + `forkSession: true`) when
   the target has one, the target is between turns (so no transcript ends on an open tool call), it
   uses the same SDK, and its occupancy is under `agents.forkMaxOccupancyPct`. Otherwise it starts
   fresh, and it still loads the target's `CLAUDE.md` and memory. A consult run is a ledger order but
   never a registry session, so it never makes a project busy. The engine
   never stores the fork's session id as the target's session. The consult worker profile disallows
   Write, Edit, NotebookEdit, Bash, Task and Agent. It gets no `ask_agent`, `tell_agent`,
   `dispatch`, `todo`, `ask_operator` or `tool_api`, and the engine denies every escalation (the
   autonomous rule). It keeps the read tools, codebase-memory, `memory_search` and `tools_for`. So an
   ask can make an agent answer, but never act. Work still starts only from the operator (ADR-0043),
   and a busy session is never touched: the fork runs beside it.
3. **`tell_agent({project, message})` is for the main agent only.** The engine holds the message.
   It never starts a turn, never joins the todo queue, and never wakes an idle session. It gives the
   message to the worker at a **delivery point**:
   - the PostToolUse hook's `additionalContext`, right after the worker's next tool call returns;
   - or prepended to the session's next turn;
   - or, if the project has no session, an `fyi` project note (ADR-0043), which the notes block shows
     at its next fresh start.

   The text goes inside a fixed engine frame: "Information from the main agent, not a new task.
   Continue your current brief." Late answers from step 1 use the same path. This is how tells fit
   the rule "never push a brief into a busy project": a tell is not a brief. It is capped
   (`agents.tellMaxChars`), it arrives only between tool calls, it cannot create work, and the
   operator sees it.
4. **Resources: workers never get a raw secret.** A resource answer points to the tools catalogue
   (ADR-0044): a tool card, a `neo-tool-*` skill, or `tool_api` for an API whose key only the engine
   holds. For `need: "resource"` the engine first runs the deterministic tool search on the question
   and gives the matches both to the consult run and to the asker. The engine refuses any question,
   answer or tell that matches `findSecret`. A withheld answer is replaced by a fixed line that
   points to the catalogue. **The worker environment is scrubbed:** today `mergedSdkEnv` passes the
   engine's whole `process.env`, Neo's `.env` keys included, to every worker. Each relay card's
   `envKey` is always removed. The other keys from Neo's `.env` are removed when
   `workerEnv.engineSecrets` is `"strip"`, except those in `workerEnv.inherit`. In `"report"` mode
   the engine records only the key names. The default is `"report"` until the operator has seen the
   names (rollout step).
5. **The firewall.** Customer-tainted runs have no MCP, so they have no ask or tell tools. The
   ingress strips them, as it strips `notes`. Loops and Codex workers get no `neo` MCP server today,
   so they have no ask or tell tools either (the same known gap as ADR-0044). A consult run cannot
   ask, so it can never be the start of a chain.
6. **Bounds, all in `config.agents`, checked in code before any run starts.**
   - The feature switch `enabled`.
   - The target exists and is not the asker itself. A desk can be a target only as `main`.
   - The depth is at most `maxDepth` (1), and the target is not already in the ask chain.
   - At most `maxOpenPerPair` (1) open ask from one asker to one target, so two agents cannot ping-pong.
   - At most `maxPerOrderPerHour` asks from one order, and `maxPerProjectPerDay` from one project.
     Background work has the lower `backgroundMaxPerOrder`.
   - At most `maxConcurrentConsults` consult runs at once.
   - The budget reserve (`heldByReserve`) is checked before a background consult starts.
   - Size caps on the question, the answer and the tell.

   Each refusal names its rule and starts no run.
7. **Everything is traced.** An ask, its consult run's order, the answer and a tell all carry the
   asker's cause (ADR-0015), so they join the asker's thread, and `/trace` shows the chain. The
   ledger records the events `agent_ask`, `agent_answer`, `agent_tell` and `agent_refused` (names and
   sizes, never the text). The operator sees one compact `notice` line per ask, answer and tell, in
   the console and the Telegram DM, at `progress` priority, through the flood gate.
8. **Storage.** One new ledger table, `agent_messages` (migration v13): kind, from, to, need, text,
   status, reply-to, cause, thread, depth, chain, asker order and session, and the times of creation,
   answer and delivery. Held answers and tells survive a reload. A row older than
   `agents.holdMaxMs` that was never delivered expires and becomes an `fyi` note.

## Alternatives rejected

- **Queue the question into the target's live session at its next turn end.** A dispatched worker's
  whole brief is often one turn, so the asker would wait for the target's brief to finish (minutes
  to hours). Two workers that ask each other would deadlock. It also puts another worker's text into
  a session that is working on the operator's brief.
- **A consult run with normal tools.** One worker's text would become another worker's orders. This
  is the prompt-injection path that ADR-0043 rejected. With a read-only run the worst case is a wrong
  answer, which the asker judges.
- **The engine answers from memory files or notes by itself.** That would be AI in the engine, or a
  keyword lookup that cannot answer "help".
- **Reuse `project_notes` for asks.** A note is an attention item with a days-long lifecycle
  (digest, snooze, → todo). An ask needs an answer in minutes, back into a live tool call. Notes stay
  the fallback when the asker or the target has no session.
- **Deliver a tell as a new turn (`followUp`).** It would wake an idle session and start work, and a
  tell to a busy session would arrive only after the brief ended.
- **The main agent pastes the key into a tell.** That is the secret path this ADR closes. The secret
  check refuses it, and the relay is the standard path.
- **A second tools mechanism for resources.** ADR-0044 already designs it. This ADR builds it.

## Consequences

- Every consult run is a real worker run on the subscription. The caps, the reserve check, and the
  fresh-start fallback for a big parent session keep the cost bounded. The `agent_*` events show
  the use.
- A fork leaves one transcript file per consult run in the SDK's project folder. The disk-cleanup
  loop already removes old transcripts.
- The "never push a brief into a busy project" rule is now enforced for tells in code. The existing
  gap where `dispatchToProject` queues a follow-up into a running session (when there is no todo
  queue) stays as it is. It is noted for a later fix and is not part of this ADR.
- Loops and Codex do not get the tools until the `neo` MCP server reaches them (the ADR-0044 gap).
