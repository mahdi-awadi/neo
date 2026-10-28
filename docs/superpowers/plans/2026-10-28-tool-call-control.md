---
approval: required
---
# Stop or background one running tool call — implementation plan (ADR-0058)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the operator (console, Telegram, commands) and the company (`tool_control` tool) can stop ONE
running tool call or send it to the background, and the worker's session goes on.

**Spec:** `docs/superpowers/specs/2026-10-28-tool-call-control-design.md` · **ADR:** `docs/adr/0058-stop-or-background-one-running-tool-call.md`

**Architecture:**
- The Claude runner tracks running calls and gives `SessionControl.tools`, backed by the SDK's own
  `backgroundTasks(toolUseId)` and `stopTask(taskId)`.
- One seam, `tool-control.ts` (`controlTool`), does the action, the marker sweep, the `docker exec`
  sweep, the steer, the event and the feed line.
- Every surface calls the seam.
- Codex: stop = turn interrupt; background refused.

**Tech:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.310, Docker Engine API over the local
socket (`fetch` with `unix:`), bun:test.

**Why it needs approval:** the engine starts killing processes (only the targeted call's) and stopping
in-container processes; there is a new command, buttons and a company tool. Builds on `dev` after side
lanes (ADR-0057, `7e8b35b`).

## Global constraints

- Reuse: `session-runner.ts` (stream consumer, `canUseTool`), `SessionControl`, the registry, the
  follow-up `steer` timing (ADR-0050 §5), `web-channel.ts` actions and the SSE emit, the Telegram callback
  buttons, `commands.ts`, the dispatcher MCP server (`neoMcpServers`), `ledger.recordEvent`, and the
  feed reply path.
- No broad `pkill`. Kill only pids proven to belong to the call: the marker in `/proc/<pid>/environ`,
  or an exec instance matched to its own client.
- All knobs in `config.toolControl` (`killGraceMs`, `noticeAfterMs`, `dockerSocket`). AR+EN for every
  console string; numbers LTR.
- TDD per task; `bunx tsc --noEmit` + `bun test` green (long runs in the background, polled). One
  commit per task on `dev`. No merge, no restart.

## Task 0: SDK spike (throwaway, ~30 min)

- [ ] Prove on 0.3.310, in a temp folder:
  - `backgroundTasks(id)` on a running `sleep 300` Bash call returns `true`;
  - the worker's tool result text and the `task_started` fields (`tool_use_id`, `task_id`,
    `output_file`);
  - `stopTask` ends the process group, including a `sleep` grandchild, and its `task_notification`.

  Record the findings in `docs/sdk-notes.md` ("Background and stop of one tool call"). If `stopTask`
  leaves grandchildren, the marker sweep (Task 3) is the backstop. If `backgroundTasks` does not work in
  streaming-input mode, change the plan before building (report it).

## Task 1: Running calls in the Claude runner

**Files:** `src/engine/session-runner.ts`, `src/types.ts` (`SessionControl.tools`, `ToolCalls`,
`RunningCall`). Test: `tests/tool-calls.test.ts` (fake SDK stream + fake query).

- [ ] Step 1: failing tests:
  - `onToolUse` adds a running call, `onToolResult` removes it;
  - `task_started` with that `tool_use_id` records its `task_id`/`output_file` and removes it from
    running;
  - `background(id)` calls `backgroundTasks(id)` and returns the log path;
  - `stop(id)` = background, then `stopTask(taskId)` once the task is known (bounded wait); an unknown
    id is `not_running`; a disabled-background throw → `{ ok: false, reason }`.
  - Codex runner: `stop` interrupts the turn; `background` is refused.
- [ ] Step 2: implement. Step 3: green, commit `feat(tools): the runner knows each running tool call and can background or stop it (ADR-0058)`.

## Task 2: The marker

**Files:** `src/engine/session-runner.ts` (`buildCanUseTool`: Bash allow → `updatedInput` with
`export NEO_TOOL_USE_ID=<toolUseID>;`). Test: `tests/approval-resilience.test.ts` or a new
`tests/tool-marker.test.ts`.

- [ ] Step 1: failing tests:
  - Bash with a `toolUseID` → the updated command starts with the marker, and the governor judged the
    original;
  - no `toolUseID` → unchanged;
  - non-Bash tools → unchanged;
  - an escalated-then-allowed Bash gets the marker too.
- [ ] Step 2: implement. Step 3: green, commit.

## Task 3: `tool-control.ts` — the seam, the marker sweep, the Docker sweep

**Files:** create `src/engine/tool-control.ts` and `src/engine/proc-tree.ts` (marker scan over
`/proc`, process trees, signal with grace; injectable `fs`/`kill` for tests); `src/config.ts`
(`toolControl`); `docs/CONFIG.md`. Test: `tests/tool-control.test.ts`.

- [ ] Step 1: failing tests:
  - stop: SDK stop → marker sweep (fake `/proc` with two marked pids and one unmarked → only the two get
    SIGTERM, SIGKILL after the grace) → Docker sweep. A fake Docker API has two running execs, one
    matching the client argv → only its host pid tree is killed. An ambiguous match kills nothing and
    reports it.
  - steer follow-up text sent to the worker;
  - `tool_control` event fields;
  - feed line;
  - background: log path in the reply;
  - `not_running`;
  - Codex result texts;
  - no Docker socket → step skipped with a line.
- [ ] Step 2: implement. Step 3: green, commit `feat(tools): stop or background one tool call, with its docker exec children (ADR-0058)`.

## Task 4: Commands and the company tool

**Files:** `src/engine/commands.ts` (`/stop`, `/bg`; `/list` shows running calls),
`src/engine/dispatch.ts` (`tool_control` on the dispatcher server only), `agent/CLAUDE.md` (untracked;
"stop or background a worker's command — never `ps`/`kill`"). Test: `tests/commands.test.ts`,
`tests/dispatch.test.ts`.

- [ ] Step 1: failing tests:
  - `/stop eticket-v3` acts on the newest running call; with two calls it lists them and
    `/stop eticket-v3 2` picks one;
  - `/bg` works the same way;
  - unknown project or nothing running → a clear text;
  - `/list` line;
  - `tool_control` exists only with `dispatch: true` and calls the seam with `by: company`.
- [ ] Step 2: implement. Step 3: green, commit.

## Task 5: Console strip

**Files:** `src/engine/dashboard.ts` (`running` on the snapshot), `src/engine/web-channel.ts`
(actions plus the SSE `tools` event), `src/frontends/web.ts` (`POST /api/tool/stop|background`, admin
session, CSRF like the other POSTs), `src/frontends/web/app.ts` + `index.html` (the strip), and the
`en`/`ar` `console.json` (`tools.*`). Test: `tests/web*.test.ts`, `tests/console-*.test.ts`.

- [ ] Step 1: failing tests:
  - the snapshot carries running calls;
  - the POSTs need a session, validate the body and call the seam;
  - the AR+EN keys exist;
  - no literal strings (the existing i18n test).
- [ ] Step 2: implement; headless-Chrome screenshots of the strip in LTR and RTL, desktop and mobile.
  Step 3: green, commit.

## Task 6: Telegram notice and buttons

**Files:** `src/frontends/telegram.ts` (the notice after `noticeAfterMs`, buttons → the seam, edit
the notice to the outcome), and the heartbeat or session watchdog that already ticks (reuse it, no new
timer). Test: `tests/telegram-*.test.ts`.

- [ ] Step 1: failing tests:
  - one notice per call after the threshold, none for short calls;
  - the Stop button (with a second-tap confirm, like attention removes) and the Background button call
    the seam;
  - the notice is edited when the call ends;
  - admin only.
- [ ] Step 2: implement. Step 3: green, commit.

## Task 7: Docs, security review, code review

- [ ] Step 1: update `docs/HISTORY.md`, `docs/CONFIG.md` (`toolControl`) and `docs/sdk-notes.md`; mark
  ADR-0058 accepted (as built).
- [ ] Step 2: run `/security-review` (process killing, a new POST). Then get an independent code review.
  Fix the findings.
- [ ] Step 3: full `bun test` + `tsc` green; commit; remove the worktree.

## Operator steps after the build

1. Merge to master and restart (no ledger migration).
2. Try it: in a scratch project, dispatch `sleep 600` and press Background, then dispatch
   `docker exec <a dev container> sleep 600` and press Stop. Check the container's `ps`.
