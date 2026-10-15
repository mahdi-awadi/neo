# Threads wait only on a live question — spec (ADR-0038)

## Seam
- `staleDecisions(facts) → Array<{ id, reason }>` (`src/engine/decision-settle.ts`): pure. Its input
  is one thread's facts: the open decisions, every decision's question and time, the operator's
  messages, the done ends, the plan of each decision, and the parked decision ids.
- `ledger.decisionSettleFacts(threadId)` reads those facts. `ledger.supersedeDecision(id, reason, at)`
  closes one decision.
- `trace.refreshThread` runs `staleDecisions` → `supersedeDecision` before `deriveThreadState`, when
  `decisionSettle.enabled` is true.
- `ledger.closeThread(id, reason, at)` and `ledger.reopenThread(id)`. The web route
  `POST /api/thread/close`, the console button and the Telegram command `/close <ref>` call
  `closeThread` (through `web-channel` / `commands`).

## Acceptance criteria
1. **Asked again:** an open decision with a later decision in the same thread on the same question
   (trimmed, whitespace collapsed, case-folded) becomes `superseded`, with answer
   `asked again as #<8 chars>`.
2. **Answered in chat:** an open decision becomes `superseded`, with answer
   `answered in chat (<ref>); the thread's work then finished`, when all of these are true:
   - it is the thread's only live question;
   - it has a folder;
   - the operator wrote a chat line in the thread after it was raised (Telegram or web; not an
     answer line, not an approval verdict);
   - an order or todo of the thread in the same folder then ended `done`.

   A batch (Q1 … Q7) is never closed by this rule.
3. **Plan settled:** a plan's review decision becomes `superseded` (`plan <status>`) when its plan
   is done, abandoned or executing. A plan that is still awaiting keeps its decision open, even
   after rule 2.
4. A decision that a `waiting` todo is parked on is never superseded.
5. `refreshThread` settles the decisions first. A thread whose only open decisions were stale
   derives `done` (or `open`/`failed` from its work). `decisionSettle.enabled: false` turns the
   automatic rules off.
6. **Close:** `closeThread` does four things:
   - sets `closed_by_operator`;
   - dismisses the open decisions (answer `thread closed by the operator`);
   - cancels the todos parked on them;
   - returns the counts and the active todos left.

   The thread derives `done`. A later operator message or a new decision in the thread reopens it.
7. **Console:** the thread view has a Close thread button (EN+AR) while the thread is not closed.
   `POST /api/thread/close` needs the admin session (401 without it) and a numeric id (400). An
   unknown id returns 404. Superseded decisions show their status and reason.
8. **Telegram:** `/close <ref>` closes the thread and replies with what it closed. A bad or unknown
   ref gets the usage line.
9. **Approvals:** a session that leaves `running` loses its approval block, and `refreshThread`
   counts approvals only on running sessions.

## Edge cases
- A decision with no thread is never touched by the automatic rules.
- Closing a thread that is already closed is a no-op that says so.
- Rule 2 needs the operator message to come AFTER the decision, and the done end to come after
  that message.
