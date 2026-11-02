# ADR-0052: a session held at a big plan takes no brief — its todo waits

Status: accepted (2026-10-26). Amends ADR-0036 and ADR-0008.

## Context

contantme todos #659, #660, #665, #666 and #680 were each marked `done` at once, with the result
"delivered into the operator's open session", but nothing reached the repo.

The briefs did reach the operator's session, and a turn did start each time. But that session had
written a big plan (`2026-10-26-contantme-master-plan.md`, plan #1645, gate `approval`) and was
**held** at it (ADR-0036). A held worker gets STOP on every tool call except reads. So each turn could
only say "the approval hook blocks me" and end. The todo queue had already marked the todo `done`,
because a delivery into a live session counts as done at the moment of delivery.

Two faults made this repeat:

1. Dispatch's reuse guard did not know about the hold. It saw a live session that was idle between
   turns and delivered.
2. The hold is mirrored into the registry as a `decision` block, and every delivery calls
   `clearDecisionBlock`. So the first delivery erased the mirror, and `sessions` then showed the held
   session as idle. The plan watch still held the worker.

## Decision

- The plan watch exposes `held()`: the path of the plan it holds the worker at, read fresh from the
  ledger (the same check its STOP steer uses). The session control carries it as
  `SessionControl.held()`, for operator sessions and dispatch runs alike.
- Dispatch refuses a brief for a held session (`dispatch_refused`, reason `plan_held`) and says why. It
  does not deliver, so no todo is marked `done` for it.
- `projectBusy` counts a held session as busy. A todo for it waits `queued`, and the daemon tick
  releases it once the hold lifts (Approve & build, Changes into a small plan, or Drop).
- `clearDecisionBlock` keeps the block while the session is held. Only the operator's tap on the plan
  card lifts the hold.

## Rejected

- **Keep delivering, and track the delivered turn to its end before the todo is `done`.** The turn
  still could only say STOP, so the todo would end in a failure no retry could fix. The hold is known
  before delivery, so the right answer is to not deliver.
- **Read the hold from the registry block.** That block is a lossy mirror (any delivery could clear
  it), and an `ask_operator` decision has the same kind. The plan watch is the source of truth.
- **Read the hold from the ledger (`plans.held_at`).** `held_at` stays set after the run ends, but a
  fresh run is not held. Only the live run's watch knows whether this session is held.
