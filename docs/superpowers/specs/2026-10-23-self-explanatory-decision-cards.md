# Spec: self-explanatory decision cards (ADR-0049)

## Seam

`checkDecision(input: DecisionInput): { ok: true; ask: StructuredAsk } | { ok: false; problems: string[] }`
in `src/engine/structured-question.ts`. `decisionBody(ask)` stays the one renderer.

## Acceptance criteria

1. `checkDecision` accepts a complete decision and returns a `StructuredAsk` with `title`, `context`,
   the labels, `optionDetails` = the explanations, `recommended` = the index of
   `recommended.option`, and `recommendation` = the reason.
2. It lists one problem per bad field. Covered cases: a missing or blank title, context,
   explanation or reason; fewer than 2 or more than 5 options; a label longer than 40 characters; a
   duplicate label; `recommended.option` that is not a label; a field over its length cap.
3. It rejects jargon with no explanation in brackets, naming the field and the token: `ADR-0188`,
   a `code span`, a file path, `snake_case`, `camelCase`, compound `PascalCase` (`WalletDetailPage`).
   A token followed by "(…)" passes everywhere except in a label.
4. `decisionBody` renders the title, the context, "1. label — explanation" lines with ⭐ on the
   recommended option, then "⭐ Recommended: N. label — reason".
5. `ask_operator` returns `isError: true` and the problem list for a bad input, and raises nothing.
   A good input raises one decision whose spec is the checked ask.
6. Telegram `postDecision` posts `decisionCard(rec, decisionBody(spec))`. The text stays at most
   4096 characters, and the thread ref keeps its code entity.
7. The decision's thread line (`trace.outbound`) carries the same body.
8. The native `AskUserQuestion` on an operator surface is denied with a steer naming `ask_operator`
   and its fields. No decision is raised.
9. The web console's thread view and project view render the context, the numbered options with
   their explanations, and the recommended mark, with `decision.recommended` in AR+EN. The project
   view model carries the spec parts.
10. The dispatch preamble and the governor's plain-text steer carry the reader rules: non-technical
    reader, the operator's language when known, one decision per card.

## Edge cases

- An old row (no context or details) still renders: the title and the plain labels.
- A multi-select decision has no ⭐ on the buttons; the body still marks the recommended option.
