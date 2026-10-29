# ADR-0058: the operator can stop, or send to the background, one running tool call

**Status:** accepted (2026-10-29; the operator approved all dev work, and the plan
`docs/superpowers/plans/2026-10-28-tool-call-control.md` is built on `dev`, restart-gated). Spec:
`docs/superpowers/specs/2026-10-28-tool-call-control-design.md`. Related: ADR-0007 (no wall-clock
limit), ADR-0050 §5 (steer follow-ups), ADR-0055 (long checks run in the background), ADR-0057 (side
lanes).

## Context

On 2026-10-28 an eticket-v3 worker ran `git push origin dev`. Its pre-push security scan (semgrep,
up to 30 min) and the worker's own foreground poll loops held the project for a long time. The only
ways out were `/kill` (which loses the session) or the chief of staff killing PIDs by hand with
`ps`/`kill`, which it did twice that day. The console showed a "pending" Bash call with no controls.

## Decision

1. **Use the SDK's own controls** (`@anthropic-ai/claude-agent-sdk` 0.3.310, read in `sdk.d.ts`):
   - **Send to background** = `query.backgroundTasks(toolUseId)`, the SDK's Ctrl+B. The blocking call
     returns at once with the SDK's "running in the background" result (it names the output file), and
     the task emits `task_notification` when it ends.
   - **Stop** = `backgroundTasks(toolUseId)`, then `stopTask(taskId)` once the SDK's `task_started` or
     `background_tasks_changed` names the task for that tool-use id. The CLI kills the shell's process
     tree and emits `task_notification` with `status: "stopped"`.
   - After a stop, the worker gets a steer follow-up (ADR-0050 §5): "the operator stopped `<command>` —
     do not run it again unless told to".
2. **One seam, `tool-control.ts`**: `stop(sessionId, toolUseId?, by)` and
   `background(sessionId, toolUseId?, by)`. An absent id means the session's newest running call. The
   session runner gives the seam a small `ToolCalls` handle (the list of running calls, plus the SDK
   calls). Every frontend calls the seam: the console strip, Telegram buttons and `/stop`/`/bg`, and the
   company's `tool_control` tool. Every action is recorded once (`tool_control` event: who, what, which
   command, the result) and shown in the feed.
3. **`docker exec` children are stopped too.** Killing the `docker exec` client on the host does not
   stop the process it started in the container. The governor's `canUseTool` already returns
   `updatedInput` for Bash. It now prefixes `export NEO_TOOL_USE_ID=<id>;`, so every host process of
   that call carries the marker in its environment. That process set is exact, which matters on a
   shared host. On stop, the engine:
   - finds the call's `docker exec` clients by the marker;
   - reads each container's running exec instances through the Docker API (`/containers/{id}/json`
     `ExecIDs` → `/exec/{id}/json` `Pid`, `ProcessConfig`);
   - kills the host pid tree of each exec whose command matches a client (SIGTERM, then SIGKILL after
     `toolControl.killGraceMs`).

   When the match is ambiguous (more identical running execs than clients), it kills none and reports
   that. It never runs a broad `pkill`.
4. **Codex workers** have no background or stop-task API. For them, **Stop** interrupts the current
   turn: the session stays, but the whole turn ends, and the reply says so. **Send to background** is
   refused with a clear reason.
5. **Who may do it:** the operator (an admin console session, the Telegram admin, the commands) and the
   company session (`tool_control` tool, only on the dispatcher's MCP server). Workers cannot stop
   another session's calls.
6. **Visibility:**
   - The console activity view shows a "Running now" strip: project, tool, command, age, and Stop /
     Background buttons (AR+EN).
   - Telegram posts one notice with the same buttons when a call has run longer than
     `toolControl.noticeAfterMs` (default 120 s), and offers `/stop <project>` and `/bg <project>`.
   - `/list` shows each session's running call.

## Rejected

- **Hand-rolled process control for Claude workers** (find the shell by pid, `kill -TERM -pgid`). The
  SDK already does it, and it also tells the worker. A home-made kill races the CLI's own bookkeeping,
  and the worker sees an unexplained exit 143.
- **`query.interrupt()` for Stop.** It ends the whole turn, so the worker loses its place. That is the
  same pain as `/kill`, just smaller.
- **Buttons on the old feed row of the tool call.** The tool-use id would have to be stored on every
  feed line (a ledger migration), and a row that has scrolled away is useless. A live strip shows only
  what is running now.
- **A wall-clock limit on tool calls.** ADR-0007 removed it on purpose. Long work is legitimate; the
  operator decides.
- **Killing a container's processes by name (`docker exec … pkill -f`).** It would hit the main task's
  or another worker's identical command.

## As built (2026-10-29)

- **Spike** (`docs/sdk-notes.md`): `task_started` names even a FOREGROUND Bash call's task.
  `backgroundTasks(id)` works, and the worker's result names the log. `stopTask` kills the task's shell
  but **not its grandchildren**, so the marker sweep is required, not a backstop. A PreToolUse hook's
  `updatedInput` applies with no decision, even when a settings rule skips `canUseTool`, so the
  **governor hook** adds the marker (not `canUseTool`).
- Codex: its one running "call" is the current turn (`codex-turn`). Stop aborts that turn and the
  session takes the next input. Background is refused.
- Telegram: the daemon's heartbeat posts ONE notice per call past `noticeAfterMs` to the operator's
  DM. Its buttons carry short keys (`tc:s|S|b:<n>`, ≤ 64 bytes). A second tap confirms Stop.
- Code: `tool-calls.ts` (tracker, marker), `proc-tree.ts` (`/proc` marker scan, trees, kill with grace,
  never pid 1), `docker-exec.ts` (exec instance by command, via the Docker API), `tool-control.ts`
  (the seam, notices), `/stop`, `/bg`, `/list`, `tool_control`, the console strip.

## Known limits

- A process that leaves its process group and does not inherit the marker (a daemonized child that
  clears its environment) survives a stop. The engine reports what it could not find.
- Codex: stop costs the whole turn; no background.
