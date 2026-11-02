# Spec: a decision lands on the thread of its work, and closes when its question is gone (ADR-0053)

Built on `dev` with TDD. The live daemon is not touched: the restart is the operator's step.

## Acceptance criteria

**A: thread of new work**
- A1. A company tool call with no live input (an ended turn, or a continuation after a handoff) does
  not file a dispatch, `todo add` or `ask_operator` under the last ended turn's thread. The work gets a
  new thread root with origin `dispatcher`.
- A2. With `thread: "<ref>"` on the company `dispatch`, `todo add` or `ask_operator`, the todo, order
  or decision is filed under that thread. An unknown ref returns an error, and nothing is created.
- A3. A dispatch run's `ask_operator` with no live input still lands on its own order's thread
  (unchanged).
- A4. Progress lines keep their present fallback (unchanged).

**B: state follows the facts**
- B1. Resolving, dismissing, superseding or expiring a decision re-derives its thread. A thread whose
  last open decision closes leaves `waiting`.
- B2. A new plan card version supersedes the older card's open decision with the reason
  `replaced by plan card v<N>`, and that decision's thread is re-derived.

**C: closing**
- C1. A plan's review decision that is not the plan's current card is superseded:
  `replaced by plan card v<N>`.
- C2. A plan that is done or dropped, or executing with a `todoId`, supersedes its card even when a
  todo is parked on it. The parked todo is cancelled with the reason.
- C3. Approve & build on a held plan (executing, no `todoId`) does NOT supersede a parked card.
- C4. Expired: not a plan card, not parked, older than `expireAfterDays`; its order has ended, and a
  later order in its folder has ended done. Status `expired`, with the reason. A `keepPatterns` match,
  an escalation (no order) or `expireAfterDays: 0` keeps it open.
- C5. The company `plan` tool `approve`/`drop` calls `applyPlanAction`, only while the live input is an
  operator message. Otherwise it refuses and changes nothing.
- C6. `tools/threads/settle-decisions.ts`: dry-run by default; it prints closable (id, project,
  thread, reason) and keep-open (id, project, why). `--apply` takes a backup, closes, re-derives
  every touched thread, and every thread whose stored state disagrees with its facts. Run twice, the
  second run closes nothing. A `keepPatterns` match is never closed.

## Edge cases
- Re-entry: settle → supersede → onDecisionClosed → refresh of the same thread: the guard skips the
  inner refresh, and the outer one derives after the settle.
- A decision with no thread: the settle rules run only in the cleanup. The runtime always gives new
  decisions a thread (A1).
- Config: `decisionSettle.expireAfterDays` (non-negative integer, default 7) and `keepPatterns`
  (regex list, default in code). A bad value keeps the default. AR and EN labels for the status
  `expired` and the origin `dispatcher`.

## Tasks
1. Ledger: `onDecisionClosed`, `expireDecision`, settle facts (current card, plan todoId, order
   ended / later done). Trace subscribes. Plans: supersede the older card.
2. `decision-settle.ts`: the replaced, parked-plan and expired rules, plus config.
3. Tools: `workCause`, the `thread` arg, the `dispatcher` root, and the `plan` tool.
4. The cleanup tool. Docs: CONTEXT, CONFIG, HISTORY, HANDOFF. Run the dry-run.
