# A decision card explains itself, and the engine rejects one that does not

**Status:** accepted (2026-10-23; built on `dev`, restart-gated). Builds on the matured
`ask_operator` design (commits 94c1015 and 907a420, 2026-09-09) and the plan card (ADR-0036).

On 2026-10-23 the operator could not understand two eticket-v3 cards in the Decisions group:
"Redis cut-over (ADR-0188): which project should get Redis username support first?" (buttons
`adminli first / gopkg bot first / Both, then cut over`) and "Start the three follow-up defects …?"
(buttons `Outbox in same tx / UserList limit bounds / Fix WalletDetailPage / None for now`).

## Root cause

1. **The card drops what the worker wrote.** `ask_operator` already requires a context, a detail per
   option and a recommendation, and stores them on the decision row (`spec`). But Telegram's
   `postDecision` builds the card from the title alone (`decisionCard(rec, question)`).
   `decisionBody()` renders the full card, but nothing calls it. The web console's lists also show
   only the title. The ⭐ in the screenshot proves the spec arrived.
2. **The schema accepts empty and jargon text.** `z.string()` accepts `""` and "ADR-0188",
   `WalletDetailPage`, "tx". Nothing checks that the card is written for a non-technical reader.
3. **The native `AskUserQuestion` bypasses the shape.** It is serviced straight into a decision with
   bare labels, no context and no recommendation.

## Decision

1. **One input shape, checked by the engine.** `ask_operator` takes `title`, `context`,
   `options[{label, explanation}]` (2–5) and `recommended {option, reason}`. One pure function,
   `checkDecision(input)` in `structured-question.ts`, either returns the `StructuredAsk` or lists
   every problem. The tool then returns an error result (`isError`) that names each field to rewrite.
   It checks:
   - Every field is present and not blank.
   - Lengths: a label is at most 40 characters (it fits a Telegram button); the title, context,
     explanation and reason are bounded too, so the card stays far below Telegram's 4096 limit.
   - `recommended.option` is one of the labels.
   - **Plain words:** no ADR number, code span, file path, `snake_case`, `camelCase` or compound
     `PascalCase` identifier, unless an explanation in brackets follows it ("ADR-0188 (our plan to
     add logins to Redis)"). Labels allow none at all.
   The stored row shape (`StructuredAsk`) does not change, so there is no migration.
2. **One renderer.** `decisionBody()` renders: the title, the context, a numbered option list
   ("1. label — explanation", with ⭐ on the recommended option) and the line
   "⭐ Recommended: 2. label — reason". Telegram's card uses it, and so does the decision's thread line
   (the web feed). The web console's thread and project views render the same parts from the stored
   spec, with the chrome words in the AR+EN catalogues.
3. **The native ask is redirected, not serviced.** On an operator surface, `AskUserQuestion` is denied
   with a steer to call `ask_operator` with the full shape. One shape reaches the operator.
4. **Guidance.** The dispatch preamble and the tool text say: write for a non-technical reader, in
   the operator's language when known, one decision per card. A loop has no `ask_operator` (an
   autonomous path cannot block on the operator). The governor's plain-text steer now asks for the
   same parts: context, numbered options with their effect, and a recommendation.

## Rejected

- **Prompt-only guidance.** The schema already asked for context and details. The card still lost
  them, and nothing stopped jargon. The operator asked for enforcement.
- **Truncate long fields silently.** The worker never learns, and the card reads cut off. A
  rejection makes the worker shorten its own text.
- **An AI check of "plainness".** The engine has no AI. A deterministic token check catches the
  observed cases (ADR numbers, code names); the guidance covers the rest.
- **Map the native ask into a matured decision.** It has no context and no recommendation to map.
- **Change the stored spec fields** (`optionDetails` to `explanations`, …). Old rows would need a
  migration for no reader-visible gain.

## Consequences

- Restart-gated. Workers see the new tool schema in their next session.
- A worker that writes jargon gets an error result and must call again. That costs one more turn,
  and it is the intended cost.
- **The jargon check is a floor, not a judge.** It catches ADR numbers, code spans, file paths and code
  identifiers, and it ignores links, email addresses and ordinary names (WhatsApp, Next.js, iPhone).
  It cannot catch an abbreviation ("tx") or a two-part code name ("UserList") without also blocking
  WhatsApp and GitHub. Those are left to the guidance, and to the context and explanations, which are
  now required and shown.
- Escalations (the governor's Allow/Deny approvals) and plan cards are engine-written. They keep
  their own shapes.
