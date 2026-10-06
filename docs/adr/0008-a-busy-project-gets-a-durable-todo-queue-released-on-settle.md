# A busy project gets a durable todo queue, released when the current todo is settled

**Status:** accepted (2026-10-04)

The operator's order (2026-10-04): "for the main agent in neo add a todo list for each project, so
when a project is running I can send more tasks. The main agent keeps them in a todo list and sends
them one by one after the current task completes."

Before this, a dispatch to a busy project pushed the brief into the running session's input
channel ("queued this brief behind its current turn"). That queue was invisible, held only in
memory, lost on reload, and could be dropped by a closing channel (the 2026-10-04 lost-brief bug,
ADR-0007). It also started the brief when the current **turn** yielded, not when the current
**task** was done.

## Decision

1. **One durable queue per project, in the ledger.** A `project_todos` table in the existing ledger
   DB (no new store) holds every todo: project, folder, brief, team flag, work class, who it came
   from, status (`queued → running → done | failed | cancelled`), position, order id, result
   summary and timestamps. A `todo_paused` table holds paused projects. Every brief the company
   dispatches becomes a todo, so the list also shows what is running and what finished.
2. **The queue sits above dispatch, not inside the session.** The company's `dispatch` tool goes
   through the queue (`src/engine/todo-queue.ts`). For a **busy project**, or a project whose queue
   is non-empty or paused, the brief is queued and the tool returns at once: "queued as #N for
   <project>, position P". Otherwise it starts now through the unchanged `dispatchToProject`. A
   brief is never pushed into a running session and never merged or dropped.
3. **Release on settle.** The next todo starts when the current dispatch run ends — the run that
   closes on the SDK's `idle` (ADR-0007), not at a turn's `result`. Dispatch's background
   continuation calls the queue only after the final result went to the operator and the dispatcher
   inbox. The dispatcher's result text carries a one-line note of what the queue does next, so the
   company hears about it without an extra turn.
4. **Failure policy, in config.** A todo that ends badly (failed, stall-aborted, killed, cut short
   by a reload) applies `todoOnFailure`: `continue` (default — report the failure, start the next)
   or `pause` (pause the project's queue until it is resumed). The next todo never starts silently.
   A run that throws before it has a result (the worker failed to launch) is a bad end too:
   dispatch closes it through the same exits, so a project's queue never stays stuck behind it.
5. **A tick also releases.** The daemon tick pumps every queue whose project is free. This covers
   a queue left waiting by a cooldown, the interactive reserve, a reload drain, a resume, or a
   restart. The pump checks the same holds as dispatch first, so a held queue does not write a
   refusal event every tick.
6. **Restart.** At boot, after ADR-0007's dispatch recovery, a todo still marked `running` was cut
   short. It is marked `failed` with where it stopped (the folder's HEAD now), and the failure
   policy applies. Queued todos stay queued and the tick resumes them in order once the operator
   channel is up.
7. **Visibility and control.** The company gets a `todo` tool (list / add / reorder / cancel /
   pause / resume). The operator gets `/todo`, `/todo <project>`, `/todo cancel <id>`,
   `/todo up <id>`, `/todo pause|resume <project>` (one engine command, so Telegram and the web
   compose box share it) and a Queue tab in the web console. Each release sends one short line to
   the operator ("eticket-v3: done #12, starting #13 'fare step UI'") at default priority — one line
   per transition, and none when the queue is empty, because the result line already says it.

## Considered options

- **Make the in-session queue durable.** Rejected. It would still release at a turn boundary, not
  at task end, and the input channel is the SDK's, not the engine's: it dies with the run.
- **Let the company keep the list (its memory or CLAUDE.md) and re-dispatch later.** Rejected. That
  puts scheduling in the AI, which the engine must not depend on. It is lost on a context clear,
  and nothing would wake the company at the right moment.
- **Release only on run completion.** Rejected. A queue that a hold or a restart left waiting would
  never move again.
- **Re-run the interrupted todo at boot.** Rejected. Work is not idempotent (commits, pushes,
  migrations). The company gets the stop point and decides whether to dispatch a resume brief.
- **Refuse `cancel` of a running todo, or make it kill the run?** Cancel only applies to queued
  todos. Stopping a running one stays `/kill <project>`, an existing and explicit operator action.
- **A brief to an operator-opened session.** The queue delivers it as a follow-up when that session
  is between turns and marks the todo done at once ("delivered into the operator's session"),
  because such a session has no dispatch run whose end the engine could observe. This keeps today's
  behaviour for that rare case instead of inventing completion tracking for it.
