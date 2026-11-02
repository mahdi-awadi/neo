# Stop or background one running tool call — design spec (ADR-0058)

Operator order, 2026-10-28: give the operator a way to STOP a running process inside a worker, or to
SEND IT TO THE BACKGROUND, without killing the whole session.

## Terms

See `CONTEXT.md`: **running tool call**, **stop (a tool call)**, **send to background**.

## What the SDK gives (verified in `sdk.d.ts`, 0.3.310)

| Need | SDK |
|---|---|
| Detach a running Bash or subagent call | `query.backgroundTasks(toolUseId)` → `true` when it matched; the call returns "running in the background" (with the output file); throws if `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` |
| Map a call to its task | `system` `task_started` / `background_tasks_changed` / `task_notification` carry `tool_use_id` + `task_id` (+ `output_file`, `status`) |
| End a background task | `query.stopTask(taskId)` → `task_notification` `status: "stopped"` |
| Read a background task's tail | control request `get_task_output` (last 8 KiB) |
| Know the call's id at execution | `canUseTool(tool, input, { toolUseID })` and the PreToolUse hook's `toolUseID` |

The engine reads none of the `task_*` messages today. The plan adds that to `session-runner.ts`.

## The seam

`src/engine/tool-control.ts`:

```ts
type ToolAction = "stop" | "background";
interface ToolControlResult { ok: boolean; text: string; toolUseId?: string; command?: string; log?: string }
function controlTool(deps, req: { sessionId: string; toolUseId?: string; action: ToolAction; by: Actor }): Promise<ToolControlResult>
```

- `Actor` = `{ kind: "operator", surface: "web" | "telegram" | "command" } | { kind: "company" }`.
- The session's `SessionControl` gains an optional `tools?: ToolCalls`:
  - `running(): RunningCall[]`;
  - `background(id): Promise<{ ok; log? }>`;
  - `stop(id): Promise<{ ok; reason? }>`.

  The Claude runner implements it with `backgroundTasks`/`stopTask`. The Codex runner implements
  `stop` as a turn interrupt and refuses `background`. Fakes simply leave it out.
- `RunningCall` = `{ toolUseId, tool, summary /* command or description, ≤ 200 chars */, since }`. It is
  fed by `onToolUse`/`onToolResult` and the `task_*` messages. A backgrounded call leaves the list; it is
  now a background task.

## Acceptance criteria

1. **Stop (Claude):** `controlTool(stop)` on a running Bash call does all of this:
   - backgrounds it and stops its task;
   - then sweeps any host process still carrying `NEO_TOOL_USE_ID=<id>` (SIGTERM, then SIGKILL after
     `toolControl.killGraceMs`, default 5000);
   - then stops the call's `docker exec` children inside their containers (criterion 3).

   The worker gets a steer follow-up: `The operator stopped your command \`<summary>\`. Do not run it
   again unless told to; go on with the rest of the task, or say what you need.` The session and its
   turn go on. The reply to the operator says what was stopped and what was not found.
2. **Background (Claude):** `controlTool(background)` calls `backgroundTasks(id)`. The worker's call
   returns at once with the SDK's own text, which names the log file. The reply to the operator gives
   the log path, from `task_started`/`task_notification` `output_file` when known. A call that already
   finished gives "nothing running with that id".
3. **`docker exec` children:** for each host process with the marker whose argv is `docker exec …`
   (or `docker compose exec …`), the engine resolves the container. It lists the container's running
   exec instances (Docker API over the local socket: `ExecIDs`, then each `/exec/{id}/json`) and kills
   the host pid tree of each exec whose `ProcessConfig` matches the client's command. It does nothing
   when the match is ambiguous, and says so. It never runs `pkill`. A missing Docker socket only skips
   this step, with a line saying so.
4. **The marker:** `canUseTool` (the governor's allow path) returns `updatedInput` for Bash with
   `export NEO_TOOL_USE_ID=<toolUseID>;` before the command. The marker is applied only when the SDK
   gave a `toolUseID`. Commands are otherwise unchanged, and the governor judges the original command.
5. **Codex:** `stop` interrupts the turn ("Codex has no per-command stop; the whole turn was
   stopped; the session stays"). `background` is refused ("Codex workers cannot move a command to the
   background").
6. **Surfaces:**
   - **Console:** the activity view shows a "Running now" strip. It lists the selected project's running
     calls, or all projects when none is selected: project, tool, command (LTR, code style), age, and a
     **Stop** button (with a confirm) and a **Background** button. The data is a `running` field on the
     state snapshot plus an SSE `tools` event on change. Actions are `POST /api/tool/stop` and
     `/api/tool/background` `{ session, toolUseId }`, admin session only. All strings are in AR+EN, and
     numbers stay LTR.
   - **Telegram:** a call running longer than `toolControl.noticeAfterMs` (default 120000) posts ONE
     notice per call, with **Stop** / **Background** buttons, to the project's operator chat. The notice
     is edited to the outcome when the call ends or is acted on.
   - **Commands:** `/stop <project>` and `/bg <project>` act on that project's newest running call.
     `/stop <project> <n>` picks from the list `/stop <project>` prints when there is more than one.
   - **Company:** a `tool_control` MCP tool (`action`, `project`, optional `toolUseId`) exists only on
     the dispatcher's server. Its description says to use it instead of `ps`/`kill`. `agent/CLAUDE.md`
     says so too.
   - `/list` shows each session's running call: `⏵ Bash 14m: git push origin dev`.
7. **Record and feed:** every action writes one `tool_control` event with `by`, `action`, `project`,
   `toolUseId`, `summary`, `outcome` (`stopped`/`backgrounded`/`not_running`/`refused`), `docker`
   (execs killed and not found) and `log`. It also adds a feed line to the project:
   `⏹ stopped by the operator (console): git push origin dev`.
8. **Safety:** only the targeted call's processes are touched: the SDK task, plus processes carrying
   that call's marker, plus exec instances matched to its own clients. A worker cannot call
   `tool_control`. The existing per-session `/kill` is unchanged.
9. **Side lanes (ADR-0057):** a side-lane session is a session like any other, so its calls show and can
   be controlled by session id. `/stop <project>` acts on the main lane; the strip and the notices show
   side lanes with their name.

## Edge cases

- The call ends while the button is pressed: `not_running`, nothing killed.
- Several calls at once (a parallel tool batch): the strip lists each; the commands ask which.
- A subagent (`Task`/`Agent`) call can be backgrounded by the same API. Stop stops its task. The
  marker and Docker steps apply only to Bash.
- `backgroundTasks` throws because background tasks are disabled for the session: Background is
  refused with the reason. Stop falls back to the marker sweep (criterion 1, steps 2–3) plus the
  steer.
- Daemon reload while a call is backgrounded: the SDK owns it. After a restart, `task_notification`
  `reason: worker_restart` arrives, and only the feed line is written.

## Out of scope

- A timeout on tool calls (ADR-0007).
- Showing live output in the console. `get_task_output` is noted for a later step.
