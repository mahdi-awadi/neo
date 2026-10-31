# ADR-0072: an order has a size — quick, standard or big — and the engine only moves it up

**Status:** accepted (2026-10-31, built on dev, restart-gated). Plan:
`docs/superpowers/plans/2026-10-31-order-sizes.md`. Spec: `docs/superpowers/specs/2026-10-31-order-sizes.md`.
Amends ADR-0063 (the standing rules are per size), ADR-0036 (the plan gate never holds a quick order, and a plan
written after a move to big is always big), ADR-0008 and ADR-0057 (a todo has a size; a big side brief runs in
the main lane). Related: ADR-0006 (the governor hook and its steer), ADR-0037 (a run's own changes), ADR-0069
(the push rule, unchanged at every size).

## Context

Operator order, 2026-10-31: "order SIZES, so small fixes stop going through the full plan machinery". Today
every brief gets one preamble (ADR-0063): a DESIGN phase on the `planner` subagent at max effort, CONTEXT.md
terms, ADRs, a spec, a plan, then TDD, a planner review and the big-plan gate (ADR-0036). A one-page fix costs
an hour of documents. Safety must not relax at any size: the security scans, the push rule and the LTR-numbers
rule stay.

## Decision

1. **Three sizes.**
   - `quick`: one page or screen, a small change, no data-model change. Read the code, fix it, a test only when
     logic changes, typecheck, one Arabic and one English screenshot for UI, one commit, a 2–3 line result. No
     planner, spec, ADR or plan.
   - `standard`: a few files or services. A short plan in the worker's own task list, test-first, an ADR only
     for a real decision. No planner, no approval gate.
   - `big`: new modules, migrations, auth, payment or money, prod, multi-service. Today's full flow.
2. **AI decides, code enforces.** The chief of staff sets `size` on `dispatch` and `todo add`, as it sets
   `lane`. The operator's own message overrides it in code: it starts with `/quick`, `/full` or "quick fix".
   The engine reads that message (or the root of its thread) itself. Customer-driven, Codex and team orders are
   always `big`. Engine-made todos get their size by rule: an Execute and a merge are `big`, an attention todo
   takes its kind's size. A todo keeps its size on a retry. A continuation keeps it, except that a quick one
   becomes standard (a quick fix that needed a context handoff is not quick).
3. **No size means `big`.** "Unknown" means that nobody judged the work. The guard can only move a size up, so
   an unjudged order must start where today's safety is. A wrong big costs time; a wrong small costs safety. The
   speed comes from the chief of staff, which reads every order, and from the operator's `/quick`. It does not
   come from the default. This is the same rule as ADR-0036 ("a worker can make a plan big, never small") and
   ADR-0057 ("no lane means the queue").
4. **One preamble per size, from one set of rule texts.** The big preamble is today's text, byte for byte. The
   quick and standard preambles reuse its security, project-fence and stay-alive paragraphs and the push rule,
   word for word. Each preamble has its own length ceiling in a test.
5. **The upgrade guard** is a steer in the governor hook, the seam that the plan hold and the context
   checkpoint already use. It keeps state for one run. It never allows a call, and it never moves a size down.
   - **What moves an order up.** Config rules on the paths that a call changes and on the commands that it runs:
     migrations, auth, money, secrets/.env, deploy/CI, prod and a new module move the order to big; a .proto
     file and a dependency manifest move it to standard. Limits move it too: quick allows 5 files, 200 changed
     lines and 1 service; standard allows 20 files, 1000 lines and 3 services. Docs, images, snapshots and
     generated code are not counted.
   - **Where the guard counts.** On each call it makes an estimate from the tool input (Write, Edit,
     NotebookEdit, and the shell writes that the shared reader finds). At each commit point (`git commit`,
     `merge`, `cherry-pick`, `revert`, `am`, `rebase`) it makes an exact measure with git: `--numstat` against
     the run's start, plus the new untracked files, minus the paths that were already dirty and are untouched.
     At the run's end it measures again for the record.
   - **What "stopped and moved up" means.** The guard denies the call that crossed the line. Its deny reason
     gives the new size's rules, and the operator gets one line that says why.
     - To standard: the run goes on with the new rules, and the worker can do the call again.
     - To big: the run goes to **plan first**. Only reads, Neo's tools, helper agents and Markdown design
       documents are not denied until the operator approves a plan. A plan written now always gets the
       `approval` gate, so the existing plan hold stops the worker and Approve & build resumes it. If the run
       ends with no plan of its own that waits for approval, its todo is queued again at the head, as big.
     - In a side lane, a move to big stops the lane, and its todo joins the end of the main queue as big.
6. **The plan gate** (ADR-0036) never holds a quick order. A quick worker that creates a plan, spec or ADR file
   is denied with "quick task: just fix". A standard plan that the gate holds moves the order to big.
7. **Safety does not change with the size.** The governor, the push rule, the security hooks and the project
   fence are the same for every size. The quick and standard preambles keep the security paragraph, the push
   rule, "numbers stay LTR" and AR+EN.
8. **Visible.** A todo shows its size (`[quick]`, `[quick→big]`) in `/todo`, in the queue lines and on the
   console (an AR+EN chip, and a Size row in the todo sheet). A quick todo's result notification is clamped to
   3 lines; the full text stays in the thread and goes to the chief of staff.
9. **Ledger v18** adds `project_todos.size` (`big` for old rows), `size_by` and `size_up` (the facts of the
   latest move up, in JSON). Config key: `sizes`.

## Alternatives rejected

- **An AI classifier per brief** (a Claude, Jev or ScaleDown judge). The chief of staff already reads the order
  and writes the brief. A second model adds cost, delay and a second opinion (the same reason as ADR-0057).
- **Sizes by prompt only.** A worker that misjudges its order would change auth code without approval. Operator
  rule: AI decides, code enforces.
- **Default `standard`, or a quick default for unsized briefs.** Rejected for the reason in point 3.
- **The guard inside `governor.decide()`, like the lane rules.** `decide` judges one call with no history. The
  size needs what the run already changed and the commit that it started from. The steer seam already carries
  state for one run into the same hook (the plan hold, the checkpoint).
- **Count only at the commit (git).** A worker could write 2,000 lines before its first commit. The estimate
  for each call stops it early.
- **Count only for each call.** Codegen, formatters and `sed` in the shell are not seen by the call reader. The
  git measure at commit is the exact backstop.
- **On a move up, stop the run and queue a fresh session.** That loses the worker's context and its work in
  progress. A deny and a switch keep the session. A new queue entry is only the fallback, for a move to big
  that ends with no plan.
- **On a move up, ask the operator for permission for the call.** The rule has one answer, so a question only
  blocks the worker (the lesson of ADR-0057). The plan card is the operator's one decision, and its Approve &
  build also overrides a false move.
- **A model or an effort for each size** (for example quick on Sonnet). The order is about the process, not the
  model. Worker profiles (ADR-0005) can add it later.
- **A size table separate from the todos.** A size is a column, like `lane`.
- **Limits in code.** Operator rule: no hardcoding. They are in the config, and the `size_measured` events give
  the data to tune them.

## Consequences

- Small fixes skip the planner, the spec, the ADR and the plan. Sensitive or growing work still gets the full
  flow, and the operator approves it at the moment it becomes sensitive.
- Path words are a proxy. A label fix in `PaymentMethodPicker.tsx` becomes big (one Approve & build tap). Each
  project can add rules or `except` globs.
- Known limits: the estimate for each call does not see a change from an interpreter or codegen until the next
  commit point. A run that never commits, with the commit finish off, is moved up only after it ends. Codex
  workers have no hook, so every Codex order is big.
- Restart-gated: migration v18 (additive; one backup `ledger.db.bak-v<from>`), the preambles, the guard, the
  tool argument, `/quick` and `/full`. `sizes.enabled: false` plus a reload sends every order back to today's
  flow. The company's `agent/CLAUDE.md` (untracked) gets a "Order sizes" section.

## As built (2026-10-31)

Commits on `dev` (`git log --oneline 9b5c313..`):

- `82433dc` feat(sizes): the order-size model, its config and the operator's override
- `0d06fbe` feat(sizes): todo size, size_by and size_up — ledger v18
- `2151a24` feat(sizes): a dispatch preamble for each order size
- `8995cf3` feat(sizes): the upgrade guard's rules and limits as one pure judge
- `2f10a3e` feat(sizes): measure a run's own change from git; one run baseline for the commit finish and the guard
- `0c4fe57` feat(sizes): the upgrade guard — deny, move up, plan first
- `1061ba2` feat(sizes): the plan gate never holds a quick order; a plan after a move to big is big
- `73a2d06` feat(sizes): dispatch runs each order at its size, with the guard in the governor hook
- `a7c5d9f` feat(sizes): the todo queue stores, passes and shows each todo's size
- `6a8232d` feat(sizes): the chief of staff sets size; /quick, /full and "quick fix" override it in code
- `f4bae4f` feat(sizes): size badges on the console and in Telegram
- `901c69f` feat(sizes): engine-made todos get their size by rule

Differences from the plan:

- **Fail closed in dispatch** (found in the review of the dispatch task). A quick or standard brief goes out
  with the big preamble when its guard cannot be made, or when it is delivered into a live session (that
  session already runs with its own preamble). Dispatch records a `size_forced` event, and the queue records
  the todo as big (`todo_size_forced`).
- **Screenshots** come from a local Playwright harness, not the shared Docker browser (ADR-0032). The shared
  browser cannot reach a console on 127.0.0.1. `tests/console-sizes-mobile.e2e.test.ts` runs the real console
  (`tools/console-demo`) with `playwright-core` and Chromium from the local cache, at a phone's size, in English
  and Arabic. `NEO_SHOTS_DIR=<dir>` saves the screenshots. The test is skipped when that browser is not installed.
- **The console rendering** is in its own module, `src/frontends/web/todo-size.ts`: the size chip, the threads
  view's todo line and the todo sheet's Size row. Its functions are pure, so they are unit-tested. Every word
  comes from the catalogues; numbers, paths, commands and a project's own rule names are LTR isolates.
- **Telegram lines** carry the `[size]` tag (`sizeTag`: `[quick]`, or `[quick→big]` after a move up) on the
  queue lines, the project status and the dispatch start line. An unsized dispatch has no tag on its start line.

Fixes from the final review (one line each):

- **Re-queue only after a good or passing end.** A run in plan first (or a side lane moved to big) is queued
  again as big only when it ended well or stopped for a passing reason (ADR-0027); an operator's `/kill` or a
  task failure ends as usual, and the row stays big.
- **Side lanes in the main folder measure nothing.** `read-only`, `ops` and `test` lanes get no baseline
  (estimates and command rules only), so the main lane's edits never move them up; a `code` lane keeps its own.
- **git failed at the start → the order runs big (fail closed).** `readRunBaseline` tells "not in git" and "git
  ignores the folder" (no baseline, fine) from "git failed" (a `.git` is there but git cannot read it). On a
  failure a quick or standard order runs big with `size_forced`, and `size_measure_failed` is recorded. Chosen
  over denying every commit, which would leave the worker unable to commit work it cannot finish otherwise.
- **No carry-over of an old `/quick`.** A dispatch report delivered to the company carries its cause marked
  `engine`; the override is read only on the operator's own turn.
- **Rule gaps.** `.envrc`, `.dev.vars`, `service-account*.json`, crypto words (secrets); auth-token words, not
  design or parser tokens (a second `auth` rule); `*.prisma`, `ent/schema/**`, `schema.sql`; package-runner and
  in-container migrate commands (`commandHeads` looks past `docker compose exec|run <svc>` and `pnpm exec`);
  `psql -c` DDL. `secrets` and `deploy` are `always` rules: checked before the ignore list (Markdown excepted).
- **No continuation beside a re-queue.** A settled handoff of a run whose end re-queues the todo queues no
  continuation (`onHandoff` carries the size end, so the order of the two does not matter).
- **The dispatcher's note on a re-queue** says "re-queued as big … do NOT dispatch it again" (`resultNote`
  carries the size end); never "starts now" or a retry.
- **The worker SDK is read once** per dispatch: the size, the preamble and the guard always agree.
- **Spec gaps.** Plan first lets `Skill`, `ToolSearch`, `BashOutput` and `TaskOutput` run; `measureRunChange`
  filters untracked paths by the baseline and the ignore list before it reads them, and reads no more once the
  files pass the standard limit; a big run gets a guard with no opinion that measures its end for the record
  (`size_measured`, size big); a run moved to big that ends with its plan waiting adds `PLAN_WAITS_TEXT` to its
  result (AC 13).
