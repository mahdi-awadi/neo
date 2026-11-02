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

## Amendment (2026-10-30): the Telegram card leaves the chat when its call ends

**Context.** The operator found cards still in the chat, with live Stop / Background buttons, long
after their command had ended (screenshot of 2026-10-30, eticket-v3). A tap then showed only a toast,
"that command has already ended", or a "Could not move … to the background: not_running" line. Root
cause: the daemon posted the card and dropped the `sendMessage` result. The notice store knew a key's
call, but not its card, so when the call ended nothing could find the card. The heartbeat only
forgot the key, so a later tap resolved to nothing. After a tap, the handler replaced the card's
text with the result instead of removing the card.

**Decision.**
1. The notice store keeps the card (chat and message id) of each notice. When the call ends, by
   itself, by Stop or by Background, from any surface (a button, `/stop`, `/bg`, the console,
   `tool_control`), the store hands the card over **once** for removal. A card attached after its call
   already ended is queued at once.
2. Removal (`src/frontends/telegram-tool-cards.ts`, `removeToolCard`) does **`deleteMessage`** first.
   Only when Telegram **refuses** it (a 400/403, for example a message older than 48 h) does it drop the
   buttons with `editMessageReplyMarkup`. "Message not found" counts as done.
3. **Telegram limits.** The flood gate now also covers `deleteMessage(s)` (not `deleteWebhook`). A
   held delete does not count as a message "not delivered", because the sweep retries it. A 429 (or
   the gate's hold) is never answered with the fallback edit: the card waits for `retry_after`. A
   Telegram 5xx or a network error is retried after `cardSweepMs × 2^attempts`. After
   `toolControl.cardRemoveAttempts` tries, the card is left and the failure is logged.
4. **When.** A timer every `toolControl.cardSweepMs` (default 5 s) checks the in-memory call list. It
   calls Telegram only for a card to remove. The heartbeat's notice tick posts and sweeps. One card job
   runs at a time. At shutdown, after the drain, every remaining card is removed (one try, bounded
   by `cardSweepMs`), because the next boot cannot act on it.
5. **A tap.**
   - Confirm stop or Background that acts: the toast says what happened and the card is deleted at
     once. A chat line is sent only when it adds something: the log path of a backgrounded call, or a
     stop's extras (container processes, survivors).
   - A tap on a stale card (the call ended, or a key from before a restart), or one whose command ended
     between the tap and the action: the card is removed quietly, with an empty answer.
   - A stop that could not be **confirmed** keeps the card, and a line says why. The SDK stop first
     moves the call to the background, so in practice the call leaves the running list and the next
     sweep removes the card.
   - A toast or a line that fails (a stale query, a held 429) is logged. It never stops the card's
     removal.

**Rejected.**
- **Edit the card's text into the result** (the old behaviour). It leaves one dead card per long call
  in the operator's chat.
- **Remove only the buttons.** The operator asked for the card to go. Removing the buttons is only the
  fallback.
- **An event from the session runner on each tool result.** It would add plumbing across the runner,
  the registry and the daemon to save at most `cardSweepMs`. The sweep reads the same in-memory list
  the notices already use.
- **Store cards in the ledger to survive a restart.** Keys are random per boot (stale buttons never hit
  a new call), and a tap on a card from before a restart now removes it. A migration is not worth it.

## Known limits

- A card the shutdown sweep could not remove (a 429 at that moment, a crash with no drain) is removed
  only when someone taps it: the new process does not know it.
- A process that leaves its process group and does not inherit the marker (a daemonized child that
  clears its environment) survives a stop. The engine reports what it could not find.
- Codex: stop costs the whole turn; no background.
