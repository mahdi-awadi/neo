# Big plans wait for approval, and a plan card follows the plan

**Status:** accepted (2026-10-13) · extends ADR-0019 (plan registry), ADR-0034 (Execute judge) and
ADR-0035 (first seen done). Changes one line of ADR-0035: a sent plan whose steps are all ticked now
becomes done, and its card says so.

On 2026-10-13 the operator got a card for gold's "Multi-bar requests of the wallet's Karat" plan
with Approve · Changes · Execute · Drop. The worker had already built and committed it (#229,
`9be1a72`). Two defects:
- **No approval gate.** A worker writes a plan, the engine sends it, and the worker builds at once.
  That is right for a small change and wrong for a big one: money, migrations and auth were built
  before the operator saw the plan.
- **Cards that do not follow the plan.** Approve and Execute look like the same thing. A tap did not
  visibly change the card, and a finished plan kept its buttons.

## Decision

### 1. A plan's gate: `approval` or `info`, decided in code
`classifyPlan` (`plan-gate.ts`) reads only the file. A plan is **big** if any of these is true:
- Its front matter says `approval: required`.
- It has more `### Task` headings than `plans.approval.maxTasks`.
- It has more checkbox steps than `plans.approval.maxSteps`.
- A line matches one of `plans.approval.patterns`: migrations, auth, money, deploy or production,
  deletes. The check skips fenced code and operator-gated steps, because those steps are already
  the operator's.

A big plan gets gate `approval`, and any other plan gets `info`. A worker can make a plan big, but it
cannot mark a plan small. A plan that names a spec the operator already approved is `info`: one
approval covers the design unit (ADR-0034 rule 4).

### 2. A big plan stops the worker that wrote it
Dispatch and operator sessions watch their own tool calls (`createPlanWatch`). When a Write or Edit
to a plan path finishes, the engine registers the file. If the plan is `approval`, not yet approved
and not finished, the engine does this:
- It sends the card at once.
- It marks the row held (`heldAt`).
- It marks the session awaiting the operator (`noteBlocked`, as `ask_operator` does).
- Through the governor hook's steer (ADR-0021's seam), it denies every tool call except reads,
  Neo's own MCP tools (`send_file`, `ask_operator`) and edits to plan files. The denial tells the
  worker to STOP and end its turn.

A held plan's decision counts as a blocking decision, not a plan card (ADR-0029). So a todo run that
hands off parks on it, and the answer resumes that run. An `info` plan is sent too, and the worker
goes on.

### 3. One primary button, with its meaning defined once
`planActions(plan)` and `planState(plan)` in `plans.ts` are the only rule. Telegram's keyboard, the
web console and `/plans` all read them.

| State | When | Buttons |
|---|---|---|
| `awaiting` | sent, gate `approval` | **Approve & build** · Changes · Drop |
| `info` | sent, gate `info` (the worker is building) | **Stop** |
| `approved` | legacy rows | Approve & build · Drop |
| `building` | `executing` | Done · Drop |
| `done` / `dropped` | | none |

- **Approve & build:** if a worker is held on this plan, the frontend answers the plan's decision
  with "approved, build it". That is the same path as any decision answer, so the same worker
  resumes. If no worker is held, it is an Execute, judged by ADR-0034, so it queues the build once
  or says why not. `execute` stays as an action for old cards and the API, but no card shows it.
- **Stop:** drops the plan and interrupts the project's live session (the `/stop` path).
- **Changes:** unchanged. The next message goes back to the worker.

The Telegram labels are the console's English catalogue labels. A test keeps them the same.

### 4. A card follows the plan
Every state change edits the card's own message: its caption and its buttons
(`editMessageCaption`, through the new `EditPlanCard` port). The console re-reads the thread. The
state changes are these:
- approve, build, done, drop or stop;
- a run end that finds every step ticked: `done · <commit>`, also for a sent or `info` plan;
- a new version: the old card says "superseded by vN" and loses its buttons;
- a run end that leaves a plan unfinished: the plan waits (`awaiting`), because nobody is building
  it any more. This includes an `info` card, whose review then opens.

## Considered options
- **Hold by prompt only (tell workers to wait).** Rejected: the engine governs in code. The steer
  denial is the same mechanism the context checkpoint already trusts.
- **Hold before the plan is written (deny the Write).** Rejected: the engine cannot judge a plan it
  has not read, and the operator needs the file on the card.
- **An AI judge of "big".** Rejected: the engine has no AI. The counts and patterns are config.
- **Keep Approve and Execute as two buttons.** Rejected: the operator could not tell them apart.
  "Approved but not building" is a state nobody asked for.
- **A new card per state.** Rejected: that is a message flood (ADR flood gate). The card is edited.

## Consequences
- A worker that writes a plan through Bash is not seen until the run end. The card is still
  `awaiting`, and Approve & build queues the build.
- Ledger migration 11 adds `plans.gate`, `plans.held_at` and `plans.done_sha`.
- The dispatch preamble tells workers the rule in one paragraph.
- Restart-gated.
