# The chief of staff speaks to a project's session through the operator's own path

**Status:** accepted (2026-10-29; built on dev, restart-gated). Related: ADR-0060 (held API waits),
ADR-0008 (todo queue), ADR-0043/0050 (project notes, live notes), ADR-0057 (side lanes).

## Context

The chief of staff could `dispatch` (new work, queued behind a running or held todo) or send `project_notes`
(information, read at the next step). It could not do what the operator does when they switch to a project
and type "resume" or "status?". So, with a session held on a limit wait, it told the operator to `/kill` it.

## Decision

1. **One delivery path.** `handleMessage`'s delivery into an addressed session moves, unchanged, into
   `deliverToSession` (steer into a live run, resume an idle one, wait out a closing one). The operator's
   messages and the new `project_message` tool both use it — no second path, so the governor, approvals,
   live notes and the ADR-0060 hold handling apply the same way.
2. **An operator-only dep.** `DispatchDeps.projectMessage` exists only where the operator's deps are built
   (`dispatchDepsFrom`); the ingress strips it, so a customer-driven run never has the tool. The tool is on
   the company session only.
3. **The code enforces what it may do:** own work only — a session a customer-driven run (an ingress
   dispatch) ever used is marked `customerDriven` at dispatch and refused; 1..`maxChars` characters (longer
   is new work: `dispatch`); a main-lane session that is open, never the company itself; at most
   `perProjectPerHour` delivered messages per project folder, one delivery at a time. Refused without
   waiting: a session still starting (no run attached yet — a resume would start a second run), one
   closing, one held at a big plan (ADR-0052), and one waiting for the operator's own decision (the agent
   never answers it).
4. **Every message is marked:** a `project_message` event (never the text) and a line "🤖 chief of staff →
   <project>: <text>" of kind `agent_message`, in the project's Telegram stream and the operator's console
   thread (labelled from `threads.agentTo`).

## Alternatives rejected

- **A new "send into session" path in dispatch.** A second delivery mechanism that would drift from the
  operator's (closing sessions, live notes, decision blocks, Codex after-turn).
- **Let `dispatch` push into a busy session.** Bypasses the todo queue and can replace the running task;
  ADR-0008 forbids it.
- **Live `project_notes` from main for "resume".** A note is read at the worker's next step; a held or
  idle session has no next step, so it never wakes.
- **No rate limit; trust the agent.** AI decides, code enforces: a loop in the agent must not flood a
  project's session.

## Consequences

- "resume", "status?" and "continue" go through `project_message`; the tool card, the tool description and
  `agent/CLAUDE.md` say so, and that `/kill` is never the answer for this.
- Restart-gated: the tool exists only on a daemon that has this code.
