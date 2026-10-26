# ADR-0053: a decision lands on the thread of its work, and closes when its question is gone

Status: accepted (2026-10-26). Amends ADR-0016 (threads), ADR-0036 (plan cards) and ADR-0038
(settling decisions). Builds on ADR-0029 (a run parks on its decision) and ADR-0034 (Execute).

## Context

On 2026-10-26 the console listed 23 `waiting` threads, and the ledger had 110 open decisions, the
oldest from 2026-09-03. Three faults made this happen:

1. **Wrong thread (A).** The dispatcher is one long session that serves many threads. A tool call
   files its new work under the session's current cause (`pipeline.ts:617` `turnCause`,
   `pipeline.ts:741` `runCause`). When no input is live, that falls back to `lastCauseOf`, which is
   the cause of a turn that has already ended. After a context handoff, the continuation starts with
   no cause (`pipeline.ts:1061`), so it inherits the last thread. In one turn the dispatcher also acts
   on several things: a contantme result, and CityNet work from its handoff note. The engine cannot
   tell which thread each action belongs to. Todo #655 (eticket CityNet) was filed on the contantme
   thread 535459, and so was decision `bf799a94`, which the dispatcher raised from #655's result.
   Decisions raised by a project worker were already on the thread of their order. A fan-out such as
   "Do all todos" correctly gathers many projects in one thread (ADR-0016).
2. **Waiting with nothing open (B).** A thread's stored state changes only when `refreshThread`
   runs. `postVersion` dismisses the previous plan card's decision (`plans.ts:538`) but refreshes only
   the new card's thread, and it records no reason. Threads 515045 and 477825 stayed `waiting` with
   only a dismissed decision. Other paths that close a decision (`answerDecision`, escalations) do not
   refresh the decision's thread either.
3. **Cards never close (C).** A plan card closes only through its own buttons. When the operator
   approves in chat, the dispatcher can only send a brief that says "Operator APPROVED". The plan
   stays `sent`, its card stays open, and a continuation parked on it waits forever (plan 1548, card
   `aa76e69d`, todo #611; the plan was built by #610). Settling also never touches a decision that a
   todo is parked on, or a decision with no thread. 75 of the 110 have no thread.

## Decision

1. **New work is filed under a live cause, or under a thread it names.**
   - New work means dispatch, `todo add` and `ask_operator`. Tools get a separate
     `workCause()`, which returns only a live cause: the input the session is working on now, or, for
     a dispatch run, its own order's cause. It never returns an ended turn's cause. Lines (progress,
     files) keep the old fallback.
   - On the company session, `dispatch`, `todo add` and `ask_operator` accept an optional `thread`
     ref (`m4f2`), so the dispatcher files work under the thread it belongs to. An unknown ref is an
     error, and nothing is done.
   - With no live cause and no `thread`, the work gets its own thread root, with the new origin
     `dispatcher`.
2. **Every decision close re-derives its thread.** The ledger notifies `onDecisionClosed`
   (thread id) from `resolveDecision`, `dismissDecision`, `supersedeDecision` and `expireDecision`.
   The trace subscribes and re-derives that thread (with a re-entry guard). An older plan card is
   superseded with the reason `replaced by plan card v<N>`; it is no longer dismissed without one.
3. **More settle rules (`decision-settle.ts`).** Each rule records its reason in the answer.
   - **Plan card replaced:** a plan's review decision that is no longer the plan's current card is
     `superseded`.
   - **Plan settled, parked:** a plan that is done, dropped, or executing as another todo
     (`todoId` set) supersedes its card even when a todo is parked on it. The parked todo is
     cancelled with the same reason (the existing `supersedeDecision` behaviour). Approve & build on a
     held plan sets `executing` without a `todoId`, so the frontend's answer still resumes the parked
     worker.
   - **Expired:** status `expired`. A decision that is not a plan card, has no parked todo, and is
     older than `decisionSettle.expireAfterDays` (default 7; 0 = off). Its order has ended, and a
     later order in the same folder has ended `done` after that. The project moved on without the
     answer. A decision whose question or options match `decisionSettle.keepPatterns` (irreversible,
     prod, money and auth words) never expires. A governor escalation (no order) never expires.
4. **The dispatcher records the operator's approval.** A new company-session tool, `plan`, with
   `approve` or `drop`, calls the existing `applyPlanAction`. It runs only while the dispatcher's live
   input is an operator message, typed on Telegram or the web, and the event names that message.
   Approve goes through Execute (ADR-0034): judged, then queued once. So a chat approval moves the
   plan, and rule 3 closes its card.
5. **One-time cleanup:** `tools/threads/settle-decisions.ts`. It applies the same rules, including
   to decisions with no thread. Plan cards also use the evidence Execute already uses (ADR-0034): a
   todo in the plan's repository, created after the card, that names the plan, was not parked, and
   ended `done` means the plan was built. Dry-run is the default; `--apply` takes a `VACUUM INTO`
   backup first. It never closes an unanswered decision that matches `keepPatterns`, but it lists
   those. It is idempotent: it closes only `open` rows.

## Rejected

- **Thread from the decision's project** (a decision lands on its project's newest thread). This is
  a guess (ADR-0016 rejects joins by time or text). A fan-out thread rightly holds many projects.
- **Mark a plan approved when a todo whose brief names it starts.** A held worker's own continuation
  names its plan, so this would bypass the approval gate (ADR-0036). Approval stays explicit.
- **Expire any decision by age alone** (ADR-0038 rejected this). Here expiry also needs the order
  ended, later finished work in the same folder, and no keep-pattern match.
- **Record a fake answer** ("approved") on a card closed another way. The reason says what happened;
  `answered` stays reserved for the operator.
