---
approval: required
---
# Side lanes — implementation plan (ADR-0057)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** small, independent todos (`ops`, `test`, `read-only`, small `code`) run beside a project's
main task instead of waiting in its queue. The chief of staff picks the lane; the governor enforces it.

**Spec:** `docs/superpowers/specs/2026-10-28-side-lanes-design.md` · **ADR:** `docs/adr/0057-side-lanes-small-tasks-run-beside-the-main-task.md`

**Architecture:**
- A lane (`{ lane: "main" } | { lane: "side", kind }`) rides on the todo row (ledger v14) and on the
  session (`SessionInfo.lane`).
- One pure module, `src/engine/lanes.ts`, holds the rules: `laneVerdict`, `canStartSide`,
  `readLanesCfg`.
- `governor.decide` calls `laneVerdict` first when `ctx.lane` is set.
- The todo queue starts side todos in free side slots.
- `dispatchToProject` starts a side lane as its own fresh session, with a worktree for `code`.
- No second scheduler, no new table.

**Tech:** Bun + TypeScript, bun:sqlite, zod, bun:test.

**Why it needs approval:** a ledger migration (v14), a governor change, a change to the release rule
of ADR-0008, and the engine deleting worktrees and branches.

## Global constraints

- Reuse: `todo-queue.ts` (submit/pump/retry/continuations), `dispatchToProject`, `registry`,
  `governor.decide` + its Bash parser (`GIT_WRITE`, `WRITE_CMD`, `bashForeignWrite`), `heldByReserve`,
  the `worktree`/`dirty` attention items, and `faults.guard`.
- A brief with no lane must behave exactly as today. Every existing queue and dispatch test stays green
  without edits (except where the API gains an optional field).
- All knobs in `config.lanes`. Console strings go in the AR+EN catalogues, with numbers LTR.
- TDD per task. `bunx tsc --noEmit` and `bun test` stay green. Run long checks in the background.
  Commit per task to `dev`. No merge, no restart.

## Task 1: Lane model, config, migration v14

**Files:** create `src/engine/lanes.ts`; modify `src/engine/ledger.ts`, `src/engine/ledger-migrations.ts`,
`src/config.ts`, `src/engine/registry.ts`, `docs/CONFIG.md`. Test: `tests/lanes.test.ts`, `tests/ledger-migrations.test.ts`.

- [x] Step 1: failing tests:
  - `readLanesCfg` defaults, and a bad value keeps its default;
  - `addTodo` stores `lane`/`laneKind`, and an old row reads as `main`;
  - migration v13→v14 keeps every row count;
  - `registry.findByFolder` skips a session whose `lane` is `side`, and `sideLanes(folder)` lists it.
- [x] Step 2: implement: the `LANE_KINDS` const, the `Lane` type, migration v14 (`lane TEXT NOT NULL
  DEFAULT 'main'`, `lane_kind TEXT`), `SessionInfo.lane`, `Registry.sideLanes`.
- [x] Step 3: green, commit `feat(lanes): lane model, config and ledger v14 (ADR-0057)`.

## Task 2: Governor lane rules

**Files:** `src/engine/lanes.ts` (`laneVerdict`), `src/engine/governor.ts` (`GovernorCtx.lane`, call
first in `decide`), `src/engine/session-runner.ts` (pass `lane` into the ctx). Test: `tests/lanes-governor.test.ts`.

- [x] Step 1: failing tests, one per spec criterion 6 and 7 rule, each **denied** with the lane message:
  - Edit in the folder; `echo x > src/a.ts`; `git commit`, `git -C <folder> reset`;
  - `docker compose restart api`, `docker restart x`, `systemctl restart y`;
  - `read-only` Write in `/tmp` allowed, elsewhere denied;
  - `code`: Edit in the worktree allowed, Edit in the main folder denied, `git switch main` denied,
    `git commit` in the worktree allowed, `git push` denied.
  - Allowed cases: `docker ps`, `docker compose logs`, `docker exec db psql …`, `git status`,
    `bun test`.
  - No lane: every existing governor test unchanged.
- [x] Step 2: implement by reusing the Bash parser (export its segment walk, rather than adding a
  second one).
- [x] Step 3: green, commit `feat(lanes): the governor keeps a side lane out of the main lane's way (ADR-0057)`.

## Task 3: Dispatch starts a side lane

**Files:** `src/engine/dispatch.ts` (an `opts.lane`; skip the reuse guard; fresh registry entry with
`lane`; skip `ensureIndexed`, the notes block, live notes, commit-finish and the context handoff for
side runs), plus a new `src/engine/lane-worktree.ts` (create and remove the worktree, raise the merge
todo). Test: `tests/dispatch-lanes.test.ts`.

- [x] Step 1: failing tests:
  - a side dispatch to a busy folder starts a second session, and the main session gets no follow-up;
  - the side session is not returned by `findByFolder`;
  - its governor ctx carries the lane;
  - `code` gets a worktree on `side/<id>` from the main branch HEAD (temp git repo fixture);
  - at the end, a clean worktree is removed, a branch with commits queues a merge todo, a branch
    without commits is deleted, and a dirty worktree is kept and raised as `dirty`;
  - with provider `codex`, the side brief is refused to the queue.
- [x] Step 2: implement. Step 3: green, commit `feat(lanes): dispatch runs a side lane as its own session (ADR-0057)`.

## Task 4: The todo queue releases side lanes

**Files:** `src/engine/todo-queue.ts` (`submit` lane rules, side slots in `pump`, `busy`/`runningTodo`
count only main, retry and continuation keep the lane), `src/engine/lanes.ts` (`canStartSide`). Test:
`tests/todo-lanes.test.ts`.

- [x] Step 1: failing tests for spec criteria 1–5, 9 and 13:
  - free project → main lane;
  - busy project with a free slot → side starts now;
  - per-project cap, host cap and reserve → queued side todo, and the pump starts it when the slot frees;
  - a main todo is released while a side lane runs;
  - retry keeps the lane, and a continuation keeps the lane;
  - boot `recover` handles a side todo;
  - boot sweep of orphan worktrees (clean removed, dirty raised);
  - no lane → the existing queue tests unchanged.
- [x] Step 2: implement. Step 3: green, commit `feat(lanes): the todo queue starts side todos in free side slots (ADR-0057)`.

## Task 5: Tools and the chief of staff's rules

**Files:** `src/engine/dispatch.ts` (the `dispatch` and `todo` tool schemas and descriptions:
`lane`, `kind`), `agent/CLAUDE.md` ("Busy projects"; untracked, edit in place), `CLAUDE.md` (the queue
line). Test: `tests/dispatch.test.ts`.

- [x] Step 1: failing tests:
  - the tool schema accepts `lane`/`kind`;
  - `side` without `kind` is refused, with the four kinds named;
  - the description names when to pick `side` and each kind.
- [x] Step 2: implement; write the chief-of-staff rules (spec "Inputs"). Step 3: green, commit.

## Task 6: Visibility

**Files:** `src/engine/todo-queue.ts` (`list`), `src/engine/commands.ts` (`/list`),
`src/engine/dashboard.ts` (`DashTodo.lane`/`kind`), `src/frontends/web/app.ts` (Queue tab group),
the locales `en`/`ar` `console.json`. Test: `tests/todo-queue.test.ts`, `tests/console-*.test.ts`.

- [x] Step 1: failing tests: `/todo` and `/list` show a "Side lanes" group with kind/state/age; the
  console snapshot carries `lane`/`kind`; AR+EN keys exist.
- [x] Step 2: implement, then take RTL and LTR screenshots of the Queue tab (headless Chrome).
  Step 3: green, commit.

## Task 7: Docs, review, ADR accepted

- [x] Step 1: update `docs/CONFIG.md` (`lanes`), `docs/HISTORY.md`, and `docs/loops.md` if it is
  touched. Mark ADR-0057 accepted.
- [x] Step 2: run `/security-review`, because the governor changed. Then superpowers:requesting-code-review.
  Fix the findings.
- [x] Step 3: full `bun test` (in the background, polled) and `tsc` green. Commit. Remove the worktree.

## Operator steps after the build

1. Merge to master and restart (ledger v13 → v14).
2. Update the company's `agent/CLAUDE.md` if the build left it to the operator. It is untracked and
   this plan edits it in place.
3. Watch the first side lanes in `/list`. `lanes.enabled: false` turns the feature off without a
   code change.
