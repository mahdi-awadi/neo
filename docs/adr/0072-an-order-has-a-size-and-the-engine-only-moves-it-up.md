# ADR-0072: an order has a size — quick, standard or big — and the engine only moves it up

**Status:** proposed (2026-10-31). The plan `docs/superpowers/plans/2026-10-31-order-sizes.md` waits for the
operator's Approve & build. Spec: `docs/superpowers/specs/2026-10-31-order-sizes.md`.
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
