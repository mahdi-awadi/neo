# Plan approval gate and live plan cards — spec

ADR-0036. Builds on ADR-0019, ADR-0034 and ADR-0035.

## Acceptance criteria
1. `classifyPlan` returns big, with reasons, for each of these:
   - front matter `approval: required`;
   - more tasks than `plans.approval.maxTasks`;
   - more steps than `plans.approval.maxSteps`;
   - a pattern match outside code fences and operator-gated steps.

   Otherwise it returns small. The thresholds and patterns are config with defaults, and a bad
   value keeps the default.
2. A new version of a plan stores its gate (`approval` or `info`). A plan that names a spec whose
   row is approved, building or done is `info`.
3. In a dispatch or operator session, a Write or Edit to a big plan file holds the worker:
   - the card is sent at once with Approve & build · Changes · Drop;
   - the row gets `heldAt`, and the session is marked blocked;
   - every later tool call except reads, `mcp__neo__*` and plan-file edits is denied with a STOP
     reason.

   The hold ends when the plan is no longer awaiting.
4. A small plan's card is sent at once with only Stop, and the worker is not held.
5. Approve & build on a held plan returns a resume, and the frontend answers the plan's decision
   with the approval brief. Without a held worker, it runs the ADR-0034 Execute. The plan becomes
   `executing`.
6. Stop drops the plan and interrupts the live session of its folder.
7. Each state change edits the card's message: caption plus buttons. Done shows `done · <sha>`. An
   older version's card shows "superseded by vN" with no buttons.
8. A sent, approved or info plan whose file is finished at a run end becomes done. At a run end,
   every unfinished plan becomes `awaiting`, including an `info` plan, because nobody is building
   it any more.
9. A held plan's decision is a blocking decision for the handoff (todo parks on it).
10. The console thread view shows the state and the same actions, AR and EN. The Telegram labels
    equal the EN catalogue.
11. The dispatch preamble states the rule, and the preamble stays under 5000 characters.

## Edge cases
- A finished plan (ADR-0035) is never held or sent.
- A plan under Execute (`executing`) is never held.
- An old card's `execute` tap still works, as Approve & build.
- A run with no plan deps (customer path, loops) has no watch. The run end still sends cards.
