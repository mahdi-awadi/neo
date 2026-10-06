# The context window comes from the SDK, not a code table

**Status:** accepted (2026-10-06)

The context policy divides a session's last-turn input by the model's **context window**. It found
the window in a code table keyed by the model id in the transcript. The table only had
`default: 200_000`. The transcript reports `claude-opus-5-5`, never the pinned
`claude-opus-5-5[1m]` (the SDK strips the tag). So every Opus session was measured against 200k.

The SDK reports the true window in `result.modelUsage[*].contextWindow` on every turn. Probed live
on 2026-10-06: `claude-opus-5-5` and `claude-opus-5-5[1m]` both report 1,000,000; Haiku reports
200,000.

The effect: the console showed 235–356% for sessions at 47–71% of their real window. The gates
measured 519 `clear` verdicts since 2026-07-08; only 2 were at 85% of a 1M window. A `clear` drops
the session without a handoff note.

## Decision

1. The session runner reports each `contextWindow` the SDK gives, per canonical model id.
2. The ledger keeps the newest window per model (`model_windows`).
3. The window for a measurement is, in order: the operator's `contextPolicy.windowTokensByModel`
   override, then the SDK-reported window, then the code default (200k) for a model never seen.
4. A measurement on that guessed default is marked `windowKnown: false`. A guess never destroys a
   session: over `emergencyPct` the gate hands off (a note is written) instead of `clear`. The
   console and `/status` show no ctx% until the window is known.

## Considered options

- **Add `claude-opus-5-5: 1_000_000` to the code table.** Rejected: a hand-typed copy of an SDK
  fact. It breaks again the next time the pinned model changes, the same way it broke now.
- **Derive the window from the `[1m]` tag on the pinned model.** Rejected: the tag is not the
  window. Bare Opus 5.5 is 1M too, so the rule would be wrong for an unpinned session.
- **Key the window per session, not per model.** Not now: the transcript gives only the
  canonical id, so `sonnet` and `sonnet[1m]` in two sessions look the same. Neo pins neither today.
  Per model, the newest report wins. Revisit if Neo pins the same model with and without the tag.

## Consequences

- The table is empty after this change ships, and a resume gate runs before the resumed session's
  first turn. So the first resume of each large open session after the restart measures on the
  200k guess. Rule 4 turns what would be a `clear` into a handoff. Once any turn on the model
  completes, the window is known for every session on it.
- The context-policy thresholds (`handoffPct` 0.65, `emergencyPct` 0.85) now mean what they say.
