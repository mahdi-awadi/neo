# Side lanes — design spec (ADR-0057)

Operator order, 2026-10-28: small, independent tasks run at the same time as a project's main task,
instead of waiting in its todo queue. The chief of staff decides the lane; the engine enforces it.

## Terms

See `CONTEXT.md`: **lane**, **main lane**, **side lane**, **lane kind** (`read-only`, `ops`, `test`,
`code`).

## The seam

One small interface carries the whole feature: a todo's **lane** (`{ lane: "main" }` or
`{ lane: "side", kind }`).
- The **todo queue** stores it and decides when it starts (`submit`, `pump`).
- **Dispatch** starts a side lane as its own session (`dispatchToProject(..., { lane })`).
- The **governor** judges every tool call against it (`decide(tool, input, { ...ctx, lane })`).
- The **views** read it from the todo row.

The rules for what a kind may do live in one pure module, `src/engine/lanes.ts`:
- `laneVerdict(tool, input, ctx)` returns a deny reason or undefined. `governor.decide` calls it
  first when `ctx.lane` is set.
- `canStartSide(project, state, cfg)` returns `{ ok } | { wait: reason }`.
- `readLanesCfg(raw)` reads the config.

## Inputs

- `dispatch(project, task, team?, lane?, kind?)` and `todo add(..., lane?, kind?)`.
  - `lane` is `"side"` or `"queue"`. Absent means `"queue"`.
  - `kind` is required when `lane` is `"side"`. A side brief with no kind is refused with a message
    that names the four kinds. Nothing is queued.
- The tool descriptions and `agent/CLAUDE.md` ("Busy projects") tell the chief of staff when to pick
  `side`. Pick it for a short task that does not edit the files, branch or containers the main task
  uses. Use `ops` for DB rows, users, passwords, API calls and docker status. Use `test` for running a
  test or check as it is. Use `read-only` for a look or a report. Use `code` only for a small change
  that needs no running stack. Anything else goes to the queue.

## Config (`lanes`, docs/CONFIG.md)

```json
{ "lanes": { "enabled": true, "maxSidePerProject": 1, "maxDispatchesHost": 3,
             "worktreeRoot": "<os tmpdir>/neo-lanes", "noLaneClassifier": "none" } }
```

A bad value keeps its default. `enabled: false` sends every brief to the queue.

## Acceptance criteria

1. **Free project.** A `side` brief for a project that is not busy and has an empty queue runs in the
   main lane as today. There is nothing to run beside, so no isolation and no worktree are needed.
2. **Busy project, slot free.** A `side` brief starts now as a side-lane session. The reply says
   `started #N as a side lane (kind) beside <main todo>`. The main run is untouched: no follow-up is
   pushed into it, and its todo and session state are unchanged.
3. **Cap hit.** When the per-project or host cap is full, or the reserve holds background work, a
   `side` brief is stored as a queued side todo. The reply gives the reason and says it starts when a
   side slot frees. The pump starts it when a slot frees, before the main queue is done.
4. **No lane.** A brief without a lane behaves exactly as today (ADR-0008). This is tested against the
   existing queue tests, which stay green.
5. **Main lane ignores side lanes.** `projectBusy`, `findByFolder`, reply routing, focus and the
   running-todo check count only main-lane sessions and todos. A main todo released while a side lane
   runs starts normally.
6. **Governor, shared-folder kinds.** For `read-only`, `ops` and `test` the governor **denies**, with a
   message that names the lane rule and says "ask for a queue todo instead":
   - `Write`, `Edit` and `NotebookEdit` in the project folder. For `read-only`, these are denied
     anywhere except the temp dir.
   - Bash write commands and redirections into the project folder.
   - Git write subcommands (the `GIT_WRITE` set).
   - Container lifecycle commands (`docker`/`docker compose` `restart|stop|start|up|down|kill|rm|build|create`,
     `systemctl restart|stop|start`).

   Reads, `docker ps|logs|exec|inspect`, `git status|log|diff` and test commands are allowed under the
   normal rules. Normal risky-command escalations still apply.
7. **Governor, `code`.** The session folder is a new worktree `worktreeRoot/<project>-side-<id>` on
   branch `side/<id>`. Its base is the main checkout's current branch HEAD. Inside the worktree the
   normal rules apply. These are denied: writes or git commands that target the main project folder,
   `git checkout`/`switch` to another branch, `git push`, and container lifecycle commands.
8. **`code` end.** The worktree is removed (`git worktree remove`, never `--force`; a dirty worktree is
   kept and raised as a high `dirty` attention item). If `side/<id>` has commits beyond its base, a
   main-lane todo "Merge branch `side/<id>` into `<base branch>`" is queued. Otherwise the branch is
   deleted.
9. **Per-lane plumbing.** Each side lane has its own session, so these work per lane:
   - an approval, `ask_operator` card or stall abort affects only that lane;
   - a parked continuation (ADR-0029) or a retry (ADR-0027) keeps the lane and kind;
   - the result goes to the dispatcher like any dispatch;
   - `/kill <side session name>` stops only that lane.
10. **Side runs are short and clean.** A side run starts fresh (no resume of the main session). It
    does not run `ensureIndexed`: the existing index is used read-only. It gets no project-notes block
    and no live notes, no commit-finish nudge (ADR-0037), and no context handoff: at the checkpoint
    it ends with a result.
11. **Visibility.** `/list`, `/todo`, the `todo` tool's `list` and the console Queue tab show a "Side
    lanes" group per project with kind, state and age. The console strings are in the AR+EN
    catalogues, and numbers stay LTR.
12. **Provider.** Side lanes need the Claude governor hook. When `providers.ownWork` is `codex`, a side
    brief goes to the queue, and the reply says why.
13. **Restart.** A side todo that was running at a restart follows ADR-0027 (`retry`, keeping lane
    and kind). At boot, a `worktreeRoot` folder with no running todo is removed if it is clean. A dirty
    one is kept and raised as an attention item.
14. **Docs and rules.**
    - CLAUDE.md says AI may decide in Neo while the engine enforces. This is done in this design
      commit, by operator order.
    - The `dispatch`/`todo` tool descriptions, `agent/CLAUDE.md`, `docs/CONFIG.md`, `docs/HISTORY.md`
      and ADR-0057 (accepted) are updated in the build.

## Edge cases

- A side brief for an unknown project gets the same "not found" as today.
- A side brief for a paused queue: pausing holds main todos only. The side lane is still allowed;
  `pause` text says so.
- Two side lanes in one folder are allowed only if `maxSidePerProject > 1`. The default is 1, because
  two `test` runs can collide.
- A side lane asks for something its kind forbids. It is denied with the reason. The worker reports
  that the task needs the main lane, and the chief of staff re-dispatches it with `lane: "queue"`.
- Desks (`dev`, `research`, …) are folders like projects, so the same rules apply.
- The host cap counts dispatch runs only. Operator-opened sessions and loops are not counted, as today.
- The ledger migrates to v14: the `lane` and `lane_kind` columns on `project_todos`, plus
  `SessionInfo.lane` in memory. This needs a restart, as with every engine change.

## Out of scope

- An AI classifier for no-lane briefs (the `noLaneClassifier` switch is reserved).
- OS-level sandboxing of Bash (a later hardening; see ADR-0057 "Known limits").
- Running dockerized stacks inside a `code` worktree.
