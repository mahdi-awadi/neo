---
approval: required
---
# Order sizes — implementation plan (ADR-0072)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to carry out this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** orders get a size — `quick`, `standard` or `big` — so small fixes stop going through the full plan
machinery, while sensitive or growing work still gets today's full flow. The chief of staff sets the size, the
operator overrides it, and a deterministic upgrade guard moves an order up (never down) and fails closed.

**Spec:** `docs/superpowers/specs/2026-10-31-order-sizes.md` · **ADR:**
`docs/adr/0072-an-order-has-a-size-and-the-engine-only-moves-it-up.md` · **Terms:** `CONTEXT.md` ("Order
sizes").

**Architecture:**
- One pure module, `src/engine/order-size.ts`: the sizes, the config, the operator's override,
  `resolveSize`, the rules and limits (`judgeTouch`), and every text.
- One stateful adapter for each run, `src/engine/size-guard.ts`: it builds a `Touch` from each tool call,
  measures the run's change with git at commit points and at the end, and is a steer in the governor hook
  (the seam of the plan hold and the context checkpoint).
- Small hooks on the existing seams: `dispatchToProject` (`opts.size`, `hooks.onSizeUp`, `TodoEnd.size`), the
  plan watch (`mayHold`, `forceApproval`, `plans()`, `approvedHeld()`), the todo queue (`submit` resolves and
  stores the size), the ledger (v18), the tools (`size`), the pipeline (`/quick`, `/full`).
- No second scheduler, no new table, no change to the governor's `decide()`.

**Tech:** Bun + TypeScript, bun:sqlite, zod, bun:test, the existing `walkBash`/`gitCall`/`writeTargets` reader,
`git()` of `git-read.ts`, Bun.Glob.

**Why it needs approval:** a ledger migration (v18); a new steer in the governor hook that denies tool calls;
changes to the plan gate (ADR-0036) and to the standing rules (ADR-0063); new operator-facing commands; the
company's rules file.

## Global constraints

- **Reuse:** `briefWithProjectDocs` and the `standing-rules.ts` sentences (no second wording), `walkBash`,
  `gitCall`, `writeTargets`, `GIT_WRITE`, `realish` (bash-walk.ts), `createCommitFinish`'s baseline (moved into
  `runBaseline`, not copied), `git()` and `headOf()` (git-read.ts), `classifyPlan` and the plan watch, the
  `laneArgs`/`LANE_GUIDE` pattern of the tools, `faults.report`/`faults.guard`, `raise` for attention items,
  `retryBrief` for the re-run text, `todoRowHtml` and `act()` in the console.
- **Big is today.** `briefForSize("big", t)` is `briefWithProjectDocs(t)`, byte for byte. Every existing test stays
  green without edits, except the v17 migration test (pinned to `version <= 17`) and the places where an API
  gains an optional field.
- **No hardcoding:** every limit, rule, phrase and default lives in `config.sizes` (`docs/CONFIG.md`). Console
  strings go in the AR+EN catalogues; numbers and paths stay LTR.
- **Fail closed:** the guard only denies; an error in it denies the call and reports an engine fault; a failed
  measure denies the commit; an unknown size reads as `big`.
- TDD for each task: the failing test first, then the code. `bunx tsc --noEmit` and `bun test` stay green. Run long
  checks in the background and read them before you end (ADR-0055); never wrap a test in `timeout`. Commit after
  each task. Do not merge, push or restart: those are the operator's (ADR-0069, ADR-0054).

## Task 1: The size model, its config and the operator's override

**Files:** create `src/engine/order-size.ts`; modify `src/config.ts` (`NeoConfig.sizes`, `readSizesCfg` in
`loadConfig`). Tests: `tests/order-size.test.ts`, one case in `tests/config.test.ts`.

- [x] Step 1: failing tests (spec AC 1–3):
  - `ORDER_SIZES` order, `larger`, `isOrderSize`;
  - `readSizesCfg(undefined)` equals `DEFAULT_SIZES_CFG` (spec §10); a size that is not one, a limit of 0 or a
    float, a non-array `override.quick`, and a rule list with one bad regex each keep their default;
  - `parseSizeOverride`: `/quick fix the picker` → quick, rest "fix the picker"; `/quick@neo_bot x` → quick;
    `/full x` → big; `Quick fix: x` → quick; `إصلاح سريع: x` → quick; `this is not a quick fix` → none;
    `/quickly x` → none; `/quick` → quick with rest "";
  - `resolveSize`: each precedence pair of spec §2 (`forced` > `override` > `chosen` > `engine` > `side` >
    `default`) with `by` and `why`; `enabled: false` → big for every input;
  - `loadConfig` exposes `cfg.sizes` with the defaults when `config.json` has no `sizes`.
- [x] Step 2: implement the types, `DEFAULT_SIZES_CFG` (with spec §5.2's rule table and ignore list as data),
  `readSizesCfg`, `parseSizeOverride`, `resolveSize`.
- [x] Step 3: green; commit `feat(sizes): the order-size model, its config and the operator's override (ADR-0072)`.

## Task 2: Ledger v18 — a todo has a size

**Files:** `src/engine/ledger-migrations.ts` (`todoSizes`, version 18 "todo sizes"), `src/engine/ledger.ts`
(`NewTodo.size?`, `NewTodo.sizeBy?`, `TodoRow.size`, `TodoRow.sizeBy?`, `TodoRow.sizeUp?`, `TodoDbRow`,
`mapTodoRow`, `addTodo`, `updateTodo` patch `size` and `sizeUp`). Tests: `tests/ledger-migrations.test.ts`,
`tests/todo-sizes.test.ts` (its ledger part).

- [x] Step 1: failing tests (spec AC 5):
  - pin the existing migration-17 test to `MIGRATIONS.filter((x) => x.version <= 17)`, so that it still proves 16 → 17;
  - a v17 file ledger with a todo row migrates to 18: same row counts, backup `${path}.bak-v17`, `size = 'big'`,
    `size_by` and `size_up` NULL; reopening runs nothing (`{ from: 18, to: 18, backup: undefined }`);
  - `openLedger(...).listTodos({})[0]` reads `size: "big"` and `sizeBy: undefined` for the old row;
  - `addTodo({ …, size: "quick", sizeBy: "operator" })` round-trips; `updateTodo(id, { size: "big", sizeUp })`
    round-trips the JSON; a stored `size_up` of `{not json` reads as none; a stored size `huge` reads as `big`.
- [x] Step 2: implement the three `ALTER TABLE … ADD COLUMN` statements (spec §11) and the mapping.
- [x] Step 3: green; commit `feat(sizes): todo size, size_by and size_up — ledger v18 (ADR-0072)`.

## Task 3: A dispatch preamble for each size

**Files:** `src/engine/dispatch.ts` (the shared paragraph constants, `briefForSize`), `src/engine/standing-rules.ts`
(only if a quick sentence is shared), `src/engine/history/extract.ts` (two `ENGINE_BLOCKS` rules). Tests:
`tests/size-briefs.test.ts`, `tests/history-extract.test.ts`.

- [x] Step 1: failing tests (spec AC 6). First a characterization test: the sha256 of `briefWithProjectDocs("TASK")`
  as it is today, written into the test before any refactor. Then:
  - `briefForSize("big", "T") === briefWithProjectDocs("T")`, and the hash is unchanged;
  - the quick and standard texts contain, and do not contain, what AC 6 lists; each ends with `\n\nThe order:\n` + task;
  - the ceilings: quick < 3,000 and < 3,700 with `codebaseMemoryLine({ project: "home-" + "x".repeat(80) })`;
    standard < 4,500 and < 5,200 with it;
  - `stripEngineBlocks(briefForSize(s, TASK)) === TASK` for each size, also inside `continuationBrief`.
- [x] Step 2: move the shared paragraphs of `briefWithProjectDocs` into module constants (the output is the same
  string), then write the quick and standard texts of spec §7.
- [x] Step 3: green (all existing preamble tests unchanged); commit `feat(sizes): a dispatch preamble for each order size (ADR-0072)`.

## Task 4: The guard's rules and limits — one pure judge

**Files:** `src/engine/order-size.ts` (`pathWords`, `compileSizeRules`, `serviceOf`, `judgeTouch`, `sizeTag`,
`sizeReason`, `upSteer`, `planFirstSteer`, `sideStopSteer`, `operatorUpLine`, `SIZE_GUIDE`). Test:
`tests/order-size-rules.test.ts`.

- [x] Step 1: failing tests (spec AC 7, 8 and 10, the pure parts):
  - `pathWords`: `PaymentMethodPicker.tsx` → `payment method picker tsx`; `HTTPServer.go` → `http server go`;
    `oauth2/2fa.ts` keeps `oauth2` and `2fa`;
  - every positive and negative case that AC 7 lists, through `judgeTouch` with a one-path or one-command touch,
    from `quick` and from `standard`; the decisive facts (`rule`, `path` or `command`) are in the result;
  - the limits: 6 files, 201 lines or 2 services from quick → standard (`rule` files, lines or services, with
    `value` and `max`); 21 files, 1001 lines or 4 services from standard → big; a quick touch past standard's
    limits → big; ignored paths add nothing; a rule hit wins a tie with a limit;
  - `planner: true` → deny `planner` in quick and standard, `ok` in big; a `created` path under the plan paths or
    `**/adr/**` in quick → deny `just-fix`; the same path not created → ok;
  - `sizes.projects.<p>.rules` adds a rule and `except` exempts a path for that project only;
  - the texts: `sizeTag` (`[quick]`, `[quick→big]`), `sizeReason` for each rule kind, and `upSteer`, which
    contains the new size's limits from the config.
- [x] Step 2: implement. The rule regexes compile once in `compileSizeRules`; all with the `i` flag; `words`
  are anchored to one whole path word.
- [x] Step 3: green; commit `feat(sizes): the upgrade guard's rules and limits as one pure judge (ADR-0072)`.

## Task 5: Measure a run's own change; one run baseline

**Files:** `src/engine/commit-finish.ts` (`runBaseline` taken out of `createCommitFinish`, which now takes it as
an argument), `src/engine/size-guard.ts` (`measureRunChange`). Tests: `tests/size-measure.test.ts` (a temp git
repo), `tests/commit-finish.test.ts` (unchanged, still green).

- [x] Step 1: failing tests (spec AC 9, the measure part), in a temp repo made by the test:
  - a committed change and an uncommitted change since the start sha are both counted, with numstat lines;
  - a new untracked file counts its lines; a binary file counts as a file with 0 lines; a rename counts both
    paths; a deletion counts;
  - a path that was dirty before the run and is untouched is not counted; when it is touched, it is;
  - ignored paths (`docs/**`, `*.md`) are not counted; services come from `Dockerfile` folders;
  - a folder outside git → `undefined`; a git that fails (an injected `GitRunner`) → `undefined`.
- [x] Step 2: implement with `git diff --numstat --summary -z --relative <startSha>` and
  `git ls-files --others --exclude-standard -z` through the `GitRunner` seam. Read at most 2 MB of a new file.
- [x] Step 3: green (commit-finish tests unchanged); commit `feat(sizes): measure a run's own change from git; one run baseline for the commit finish and the guard (ADR-0072)`.

## Task 6: The size guard — deny, move up, plan first

**Files:** `src/engine/size-guard.ts` (`createSizeGuard`, `touchOf`). Test: `tests/size-guard.test.ts` (fake files
and git through the seams; real `walkBash`).

- [x] Step 1: failing tests (spec AC 8–11 and 23):
  - `touchOf`: Write (new and existing, multiset lines), Edit (`replace_all`), MultiEdit, NotebookEdit,
    Bash redirect, `sed -i`, `git rm`, `cp`; the command heads after `sudo`/`env`/`VAR=`; the commit points of
    `git commit`, `git -C <repo> commit`, `git merge`, `git cherry-pick`; `Agent` with `subagent_type: "planner"`;
  - a quick guard: the sixth file is denied with `upSteer` once, `size()` becomes standard, `onUp` is called once,
    and the same call is then allowed; a failed call (`onToolResult(id, true)`) adds nothing;
  - a touch of `services/identity-service/auth/token.go` → big: denied, then plan first: `Read`, `Grep`,
    `mcp__neo__ask_operator`, `mcp__codebase-memory__search_code`, `Agent` and a Write of
    `docs/superpowers/plans/x.md` are not denied; `Edit` of a `.ts` file and every `Bash` call get
    `planFirstSteer`; plan first ends when `planApproved()` returns true;
  - at `git commit` the guard measures (fake git); a measure past the limits moves the order up and denies the
    commit; a failed measure denies the commit with the measure-failed text and does not move the size;
  - a side guard moved to big denies every later non-read call with `sideStopSteer`;
  - `raise("big", { rule: "plan" })` moves the order without a deny;
  - `end({ planAwaiting: false })` in plan first → `requeue: true`; with `planAwaiting: true` → `false`;
    `end()` of a quick guard whose final measure passes its limits → a `late` size up;
  - a guard whose internals throw (an injected fault) denies the call with the internal-error text and reports
    one fault; `steer` never throws;
  - a guard created with size big returns undefined from `steer` for every call (planner and plan files
    included); its `end()` still measures.
- [x] Step 2: implement. `steer` is synchronous and wrapped in try/catch; the pending touches are keyed by the
  tool-use id; the service lookups are cached.
- [x] Step 3: green; commit `feat(sizes): the upgrade guard — deny, move up, plan first (ADR-0072)`.

## Task 7: The plan gate never holds a quick order

**Files:** `src/engine/plan-watch.ts` (`mayHold`, `plans()`, `approvedHeld()`), `src/engine/plans.ts`
(`PlanRun.forceApproval` in `register`). Test: `tests/plan-gate.test.ts` (new cases next to AC3/AC4 there).

- [x] Step 1: failing tests (spec AC 12):
  - `mayHold: () => false`: a big plan written mid-run is registered and sent, `held()` is undefined, and `steer`
    has no opinion;
  - `forceApproval`: a small plan registers with gate `approval` and holds the worker;
  - `plans()` lists the ids that the watch registered; `approvedHeld()` is false while held and true after the
    plan becomes `executing`;
  - without the new options, every existing plan-gate test is unchanged.
- [x] Step 2: implement.
- [x] Step 3: green; commit `feat(sizes): the plan gate never holds a quick order; a plan after a move to big is big (ADR-0072)`.

## Task 8: Dispatch runs each order at its size

**Files:** `src/engine/dispatch.ts`. Test: `tests/dispatch-sizes.test.ts`. Capture the run handlers with a fake
`start` as `tests/dispatch.test.ts` (around line 2162, `steer = h.contextSteer`) and
`tests/dispatch-commit-finish.test.ts` do, then call `handlers.contextSteer`. The `recordingStart` of
`tests/dispatch-lanes.test.ts` ignores the handlers, so extend it or use those two as the model.

- [x] Step 1: failing tests (spec AC 13, 14 (dispatch part), 16 and 17):
  - `opts.size: "quick"` → the order's task starts with the quick preamble; no size → big;
  - the run's `contextSteer` is `planWatch ?? guard ?? checkpoint`: a planner call in a quick run is denied by the
    guard; a held plan's STOP still comes first;
  - a move up records `size_up` with the order id, sends one operator line (`operatorUpLine`) under the cause,
    delivers a `[size]` note to the dispatcher with `wake: false`, and calls `hooks.onSizeUp`;
  - a run moved to big: its plan watch gets `forceApproval`; `onHold` in a standard run raises the size to big;
    a quick run's plan watch never holds;
  - the end: `size_measured` is recorded; `TodoEnd.size` carries `requeue` (plan first with no plan of its own
    that waits) and any late move;
  - the start line reads `→ dispatching to <name> [quick]: …`;
  - a quick run that ends well: the operator's result line has at most 3 lines plus the thread pointer; a failure is
    not clamped; the dispatcher report keeps the full text;
  - Codex own work: no guard is created (and the size is big, Task 9);
  - a side lane gets its guard with `side`; one `runBaseline` is shared by the commit finish and the guard.
- [x] Step 2: implement the wiring as listed in spec §3.
- [x] Step 3: green (`tests/dispatch*.test.ts` unchanged); commit `feat(sizes): dispatch runs each order at its size, with the guard in the governor hook (ADR-0072)`.

## Task 9: The todo queue stores, passes and shows the size

**Files:** `src/engine/todo-queue.ts`. Tests: `tests/todo-sizes.test.ts` (its queue part), `tests/todo-queue.test.ts`
(the lines now carry the tag; update only those expectations).

- [x] Step 1: failing tests (spec AC 3, 13–16 and 20, the queue part):
  - `submit` stores the size and `sizeBy` from `resolveSize` and records `todo_size_set`. A customer reply chat,
    a Codex provider and `team` → big, with the reason in the reply. A `big` side brief → main lane;
  - `launch` passes `size: t.size` to `dispatchToProject`;
  - `onSizeUp` updates the row (`size`, `sizeUp`);
  - `TodoEnd.size.requeue` in the main lane: the same row is `queued` at position 1, as big, `attempts` unchanged,
    with a result that names the move, no `dirty` item, and `todo_size_requeued` recorded. In a side lane: main
    lane, big, at the end of the main queue, and the reply names a `code` lane's branch;
  - continuations (the four places, now one `continuationOf`): a quick todo's continuation is standard with
    `sizeUp.rule = "handoff"`; others keep their size; a side continuation keeps it;
  - `retry` keeps the size;
  - the lines of spec §8: `renderProject`, `tag`, the queued and side-queued acks, the transition line;
    `nextNote` adds `[size] #N moved up …` after a move in this run; every reply names the size and who set it.
- [x] Step 2: implement.
- [x] Step 3: green; commit `feat(sizes): the todo queue stores, passes and shows each todo's size (ADR-0072)`.

## Task 10: The chief of staff sets the size; the operator overrides it

**Files:** `src/engine/dispatch.ts` (the `dispatch` and `todo` tools: `size` arg, `SIZE_GUIDE`, `operatorSizeFor`),
`src/engine/pipeline.ts` (`handleMessage` branch 1 and the usage line; `dispatchDepsFrom` adds `sizes`),
`src/engine/commands.ts` (`PIPELINE_COMMANDS`, `renderHelp`). Test: `tests/size-tools.test.ts` (on the model of
`tests/dispatch-lane-tools.test.ts`).

- [x] Step 1: failing tests (spec AC 4, 18 and 19):
  - both tools accept `size` and reject `size: "huge"`; the `dispatch` description contains `SIZE_GUIDE`; the
    `todo` description points to it;
  - `size` reaches `submit` from both tools;
  - with a live operator message `/quick fix x` (role user, surface telegram), the tools pass
    `operatorSize: "quick"` whatever `size` says; with a live `ok go` whose thread root is `/full …`, they pass
    big; an engine-written root, an assistant message or a scheduler-fired turn gives none; a live `/full` beats
    a root `/quick`;
  - `handleMessage("/quick fix the picker")` delivers the text to the company (not "not an order");
    `handleMessage("/quick")` replies with the usage line and delivers nothing;
  - `telegramCommands()` contains `quick` and `full`; `/help` lists them.
- [x] Step 2: implement.
- [x] Step 3: green; commit `feat(sizes): the chief of staff sets size; /quick, /full and "quick fix" override it in code (ADR-0072)`.

## Task 11: Size badges on the console and in Telegram

**Files:** `src/engine/dashboard.ts` (`DashTodo`, `TodoDetail`: `size`, `sizeBy?`, `sizeUp?`),
`src/engine/project-view.ts` (the running line), `src/frontends/web/app.ts` (`todoRowHtml` chip, the threads
view's todo line, the sheet's Size row), `src/frontends/web/index.html` (`.sz-*` CSS),
`src/frontends/web/locales/{en,ar}/console.json` (spec §8's keys). Tests: `tests/console-sizes.test.ts`,
`tests/console-i18n.test.ts` (the new key families), `tests/todo-detail.test.ts`.

- [x] Step 1: failing tests (spec AC 20 and 21):
  - `activeTodos` and `todoDetail` carry `size`, `sizeBy`, `sizeUp`;
  - `/project <p>` shows `#812 [quick] running`;
  - the bundle's `todoRowHtml` renders the chip with the catalogue label, ` ↑` and the title when moved up;
  - the sheet renders the Size row and the reason line from `todoDetail.sizeUp.*` and `todoDetail.area.*`; a
    project's own rule name falls back to the name as an LTR isolate;
  - catalogue parity: the families `queue.size.*`, `todoDetail.sizeBy.*`, `todoDetail.sizeUp.*` and
    `todoDetail.area.*` exist in en and ar with the same placeholders.
- [x] Step 2: implement; numbers, paths and commands through `ltr()`.
- [x] Step 3: take RTL (ar) and LTR (en) screenshots of the Queue tab and of a moved-up todo's sheet through the
  shared browser (ADR-0032); check that the numbers and paths read left to right; attach them to the result.
- [x] Step 4: green; commit `feat(sizes): size badges on the console and in Telegram (ADR-0072)`.

## Task 12: Engine-made todos get their size by rule

**Files:** `src/engine/attention-briefs.ts` (`size` in each template, spec §9), `src/engine/attention-actions.ts`
(`engineSize`, with `sizes.attention` overrides), `src/engine/plans.ts` (`executePlan` → `engineSize: "big"`),
`src/engine/todo-queue.ts` (the merge todo → big). Tests: `tests/attention-actions.test.ts` (it already checks that every producer kind has a brief), `tests/todo-sizes.test.ts`.

- [x] Step 1: failing tests (spec AC 22): every kind in `ATTENTION_BRIEFS` has a size; `→ todo` on a `dirty`
  item stores `quick`, by `engine`; `sizes.attention.dirty = "standard"` overrides it; an unknown kind is big;
  an Execute and a merge todo are big.
- [x] Step 2: implement.
- [x] Step 3: green; commit `feat(sizes): engine-made todos get their size by rule (ADR-0072)`.

## Task 13: Docs, the company's rules, review, ADR accepted

**Files:** `docs/CONFIG.md` (the `sizes` row, after `lanes`), `CLAUDE.md` (item 6 in place — the file stays at
200 lines), `docs/HISTORY.md`, `docs/adr/0072-…` (status accepted, plus "As built"), and the untracked
`/home/neo/agent/CLAUDE.md` (below).

- [x] Step 1: write the docs. In `CLAUDE.md`, the second line of item 6 becomes (one line for one line):
  ```markdown
     plan by order size (ADR-0072: big = rich plans + `planner`) and finish non-stop — ADR-0063, `standing-rules.ts`.
  ```
- [x] Step 2: edit `/home/neo/agent/CLAUDE.md` in place, as written in "The company's rules" below. It is untracked.
  From a worktree outside `/home`, the write is a fenced escalation that the operator approves (ADR-0031). Do it
  from `/home/neo`, or leave the text in the result for the operator.
- [x] Step 3: run `/security-review` (the guard is a new steer that denies tool calls) and
  `superpowers:requesting-code-review`; a final `planner` review against the spec. Fix the findings.
  *(Done as one security-focused planner review against the spec; its 9 findings are fixed in 07286c4. The
  built-in `/security-review` command was not run separately.)*
- [x] Step 4: run the full `bun test` in the background and poll it, plus `bunx tsc --noEmit`; all green. Commit
  `docs(sizes): config, history and the company's rules for order sizes; ADR-0072 accepted`. Remove the worktree
  (the branch stays). Do not push.

## The company's rules (`/home/neo/agent/CLAUDE.md`, exact text)

Replace the paragraph that starts with "**Plan fully, then finish non-stop**" with:

```markdown
**Plan fully, then finish non-stop** (operator, 2026-10-29, VERY IMPORTANT) — for a **big** order. Its worker
writes a complete, ambitious plan for the whole goal (every feature the domain needs, edge cases, UX, tests,
ops), made and reviewed with its `planner` subagent (the strongest model at the highest effort, config
`planner`), then executes it to the end in committed checkpoints. A **quick** or **standard** order skips the
plan documents (ADR-0072, "Order sizes" below). Every worker stops only for a real operator decision
(product/UX policy, cost, an irreversible, prod or external action) or a hard blocker, and says what remains.
The engine's dispatch preamble carries these rules for each size; don't re-type them in briefs.
When a worker stops halfway with work it could do, send it on (`project_message` "continue"), don't accept it.
```

Add at the end of the file:

```markdown
## Order sizes — quick, standard, big (ADR-0072, needs the engine restart to go live)
Every brief you `dispatch` (or `todo add`) gets a `size`. It decides how much process the worker runs:
- `quick` — one page or screen, a small change, no data-model change: read the code, fix, a test only when
  logic changes, typecheck, one AR+EN screenshot for UI, one commit, a 2–3 line result; no planner, spec,
  ADR or plan. E.g. "the date picker does not clear when I tap ×", "the Arabic label on the bookings filter
  is wrong", "fix the typo in plan X".
- `standard` — a few files or services: a short plan in the worker's task list, test-first, an ADR only for
  a real decision, no approval gate. E.g. "add a status filter to the bookings list" (API + UI), "show the
  PNR on the ticket PDF", "fix the failing CI test in travel-service".
- `big` — new modules or services, migrations, auth, payment/money, prod/deploy, multi-service features:
  today's full flow; a big plan waits for the operator's Approve & build. E.g. "wallet top-up through Qi",
  "add a column to bookings" (migration), "a new partner sign-up flow", "change who can refund".
Unsure → the larger size. No `size` → `big`, so always set it. Tell the operator the size with the todo
number ("queued #812 as quick"). Side lanes: `read-only`/`ops`/`test` are quick and `code` is standard
unless you say otherwise; a big side brief runs in the main lane.
The operator decides over you, in code: a message that starts with `/quick`, `/full` or "quick fix" sets the
size whatever you pass, also when you dispatch after a clarifying question in that thread. Never pass a
smaller size to speed up work. Size a new order in an old thread on its own.
The engine only moves a size UP. A quick or standard order that touches auth, money, migrations,
secrets/.env, deploy/CI or prod, or grows past its size (quick: 5 files, 200 changed lines, 1 service;
standard: 20 files, 1000 lines, 3 services) is stopped and moved up; the operator gets one line saying why.
A move to big stops the worker until the operator approves its plan; if it ends without a plan, the same
todo is queued again as big. Never re-dispatch a moved todo; a `[size]` line in its result says what moved.
```

## Operator steps after the build

1. Review the branch, merge it to master and restart (the operator's call; ADR-0054: "built on dev" until then).
2. Check that `/home/neo/agent/CLAUDE.md` has the two edits above. The company reads them at its next fresh
   session.
3. Send a first quick order (`/quick fix …` for a small UI bug). `/todo` shows `[quick]`; the result comes in
   2–3 lines. Send one `/full` order and check that its plan card waits for Approve & build.
4. After a week, read the moves and the measures (below) and tune `sizes.quick`, `sizes.standard` and
   `sizes.projects.<name>` in `config.json`.

## Ops notes

- **Restart-gated.** Nothing is live until the daemon runs a build that contains these commits. The restart
  brings: the `size` argument and `SIZE_GUIDE` in the company's tools; a preamble for each size; the guard in the
  governor hook; the plan-gate changes; `/quick` and `/full` (the Telegram "/" menu is set at boot); the badges
  in `/todo` and on the console. A console page opened after the restart loads the new bundle (ADR-0023). A page
  that was open before shows the badges only after it reloads: the console has no self-reload on a new bundle
  (checked in `app.ts`).
- **Migration v18.** At boot `migrate()` runs every pending ledger migration in order (v18 last). Before the
  first one it makes ONE backup, `data/ledger.db.bak-v<from>`, with `VACUUM INTO`, the same as v17's
  `.bak-v16`. The live ledger is about 450 MB (2026-10-31), so check `df -h /home` for at least 1 GB free first.
  The older `.bak-*` copies (about 1.2 GB together) are Tier B in the disk kit: the operator decides on them.
  v18 is additive (three columns). Old todos read `big`. A failed migration stops the boot and names the backup
  (ADR-0010).
- **Rollback.** Without code: `"sizes": { "enabled": false }` in `config.json` and a reload (the operator's call)
  → every order is big, with no guard and no override, as today. With code: run the previous build. No database
  restore is needed, because an older build ignores the new columns.
- **Tuning data.** The moves and the measures are events. For example, read-only on the live ledger:
  `SELECT json_extract(data, '$.rule') AS rule, json_extract(data, '$.from') || '→' || json_extract(data, '$.to') AS move, count(*) FROM events WHERE kind = 'size_up' GROUP BY 1, 2 ORDER BY 3 DESC;`
  and `SELECT json_extract(data, '$.size'), avg(json_extract(data, '$.files')), avg(json_extract(data, '$.lines')) FROM events WHERE kind = 'size_measured' GROUP BY 1;`.
  A rule that moves too much gets an `except` glob for its project (`sizes.projects.<name>.except`). Example:
  Neo's own `src/engine/session-*.ts` match the `sessions?` auth word.
- **Known limits** (ADR-0072): a change from an interpreter or codegen is seen at the next commit point, not
  before; a run that never commits, with the commit finish off, is moved up only after it ends; Codex orders are
  always big; path words are a proxy (a label fix in a payment component is big — one Approve & build tap).
