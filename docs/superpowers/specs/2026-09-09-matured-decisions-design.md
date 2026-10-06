# Matured operator decisions — schema-enforced shape + rich rendering

Date: 2026-09-09. Branch: `feat/structured-questions-and-styled-messages`. Deterministic, AI-free in
the engine, TDD. Restart-gated (tool schema + preamble are read at worker launch).

## The complaint (ground truth)

The operator received this from an `eticket_prod` worker and called it unclear:

> 🔵 DECISION #eticket_prod
> 1. Scope: How broad should the 'default logging' standard be?
> 2. Granularity: What log granularity do you want captured by default?
> 3. Ingestion: How should the ingestion consumer be fixed?

…with flat option chips: `Scope: Travel providers only` / `Scope: All integration types` /
`Granularity: Both (decorator + raw wire)` / `Ingestion: Redeploy Vector` / … .

## Problems → root cause (each one, in code)

Overriding principle (HANDOFF): **Neo never decides — it MATURES a decision so a well-formed one
reaches the operator.** A matured decision must carry: (1) one clear title, (2) the problem + root
cause, (3) each option with what it means + its trade-off, (4) a recommendation. The bad example
fails all four. Why, in the code:

- **(a) Three separate decisions mashed into one message.** Root cause: the `ask_operator` tool
  schema is `{ question: string, options?: string[], multiSelect? }`. `question` is free text, so a
  worker crams several decisions ("Scope / Granularity / Ingestion") into one call, and the
  multi-question `StructuredAsk` path (built for the SDK-native `AskUserQuestion`) lets unrelated
  decisions ride in one message. Nothing enforces *one decision per message*.
- **(b) No problem / root cause stated.** Root cause: the schema and the `decisions` row have only
  `question` + `options` — there is **no `context` field**, so the root cause has nowhere structured
  to live and nothing renders it. The tool description asks the worker to "show your work," but
  prose guidance is not a guarantee.
- **(c) Options are bare labels.** Root cause: `options: string[]` — a label and nothing else. The
  renderer (`decisionKeyboard` / `structuredKeyboard`) shows the bare label. Worse: the SDK-native
  `AskUserQuestion` already carries `options:[{label, description}]`, and
  `fromAskUserQuestionInput` **throws the description away**.
- **(d) No recommendation.** Root cause: no `recommendation` field anywhere; nothing renders one.
- **(e) Reader can't tell why the decision is needed or what each choice does.** This is the
  compound consequence of (b)–(d).

## Design — two layers, build the guarantee layer now

The brief poses: enforce by (a) a richer `ask_operator` **schema** (hard guarantee of shape) and/or
(b) a **maturing reviewer** worker that rewrites a shallow ask before it reaches the operator. We
build **(a) now** and **design (b) as the next phase**, because:

- (a) is deterministic, unit-testable, AI-free, and by itself fixes all of (a)–(e): it makes a
  shapeless question *impossible to raise*.
- (b) is additive AI-in-a-worker quality-sharpening (fills/deepens context + recommendation). It is
  bigger, already flagged PLANNED in HANDOFF, and rides on the same choke point — so it can land
  later without rework.

"No AI in the engine" holds throughout: the engine only **validates shape + renders + routes**. Any
*writing* of context/recommendation is the worker's job (schema) or a reviewer worker's job (phase 2).

### Layer A — schema-enforced matured decision (this change)

**One `ask_operator` call = exactly ONE decision.** New tool schema:

```
ask_operator({
  title:          string      // one-line title of the SINGLE decision
  context:        string      // 1–3 plain lines: what happened + the ROOT CAUSE
  options: [{                 // 2–5 options; NO patch-level options
    label:        string      // short button label
    detail:       string      // what it concretely means + its trade-off (cost/risk/effort)
    recommended?: boolean     // set on the ONE you recommend
  }]
  recommendation: string      // which option you advise + one line WHY
  multiSelect?:   boolean
  question?:      string      // optional crisp restatement; defaults to title
})
```

Zod `.min(2)`/required fields make a call missing title/context/options/recommendation fail at the
tool boundary — the SDK hands the validation error back to the worker, forcing a well-formed retry.
That is the hard guarantee. (Zod guarantees *presence + shape*, not subjective depth; depth is
nudged by the description and, later, the reviewer.)

The tool **description** adds: *raise exactly ONE decision per call; if you have several independent
decisions, call `ask_operator` once per decision — never bundle them.* This fixes (a) at the source:
the eticket_prod example becomes three separate, each-fully-matured decisions.

### Data model — enrich, don't fork

Reuse the existing decisions machinery (a matured decision is stored as the decision row's `spec`);
add fields, keep `options: string[]` as the index-addressed button labels so **all** existing logic
(callbacks `dec:<id>:<q>:<opt>`, `applyTap`, `answerText`, `keyboardRows`, the flat legacy path) is
untouched. New optional fields ride in the same `spec` JSON column — they persist for free
(`mapDecisionRow` only checks `Array.isArray(spec.questions)`), and old rows degrade gracefully.

```ts
interface StructuredQuestion {
  header?: string; question: string;
  options: string[];            // UNCHANGED — button labels, index-addressed
  optionDetails?: string[];     // NEW — index-aligned "what it means + trade-off"
  multiSelect?: boolean;
  recommended?: number;         // NEW — index of the recommended option (single-select)
}
interface StructuredAsk {
  questions: StructuredQuestion[];
  title?: string;               // NEW — the decision's one-line title
  context?: string;             // NEW — problem + root cause
  recommendation?: string;      // NEW — which + why
}
```

Pure additions in `structured-question.ts`:
- `maturedAsk(input)` — builds the single-question `StructuredAsk` from the tool input (aligns
  details, derives the `recommended` index, carries title/context/recommendation). Returns
  `undefined` on degenerate input (belt-and-suspenders behind Zod).
- `normalizeAsk` — carries `optionDetails`/`recommended`/title/context/recommendation through the
  same filter/clamp that already trims options (re-aligning details, re-clamping the recommended
  index).
- `fromAskUserQuestionInput` — now maps the native option `description` → `optionDetails` (stops
  discarding it), so SDK-native structured questions also render richer.
- `decisionBody(ask)` — the pure, channel-agnostic message body: title, context, each option as
  `• label — detail` (⭐ on the recommended one), and a `Recommendation:` line. Degrades: no title →
  first question; no context/recommendation → omitted; no details → bare labels; multi-question →
  numbered per-question layout. Simple English.
- `keyboardRows` — prefixes `⭐ ` to the recommended option's button (labels stay short; details go
  in the body, keyed to the buttons by matching label).

### Rendering (Telegram `postDecision`)

When a `spec` is present, the message body is `priorityBadge("decision") + #project + decisionBody(spec)`
(the title is `decisionBody`'s first line, so the badge/tag sit right before it). Buttons come from
`structuredKeyboard` (short labels, ⭐ recommended, Submit when needed, Other). The flat/legacy path
is unchanged. HTML-escaping + plain-text fallback already handled by `sendMessage`/`mdToHtml`.

### Multi-part decisions — the rule

`ask_operator` raises **one** matured decision. Several independent decisions → several calls →
several Decisions-group messages, each fully matured. The multi-**question** `StructuredAsk` stays
only for the SDK-native `AskUserQuestion` (interactive/company session, ≤4 questions), now rendered
clearly per question with option details. This is the "split into separate decisions" answer to the
brief's open question, with the structured multi-part path preserved where the SDK genuinely needs it.

### Layer B — maturing reviewer (NEXT PHASE, designed, not built)

`raiseOperatorDecision` is already the single choke point behind every raised decision. Phase 2:
before posting, the engine spawns one fresh reviewer worker (latest model) with the raw matured ask
+ minimal raising-session context; it returns a *sharpened* matured ask (deeper root cause, tighter
options, crisper recommendation, patch-level options dropped); the engine validates the same shape
and posts. Non-blocking-friendly (fall back to the raw ask on timeout/failure). AI lives only in the
reviewer worker — the engine still just orchestrates + validates. Left as a clean seam here.

## Before / after (the eticket_prod example)

**Before:** one message, three questions, flat chips, no context, no recommendation.

**After:** the worker raises three separate matured decisions; e.g. the ingestion one renders:

> 🔵 DECISION #eticket_prod Fix the log-ingestion consumer
>
> Vector is deployed but not consuming: the JetStream consumer was never created, so wire logs
> queue and are dropped after the retention window. Root cause is missing consumer wiring, not
> Vector itself.
>
> Options:
> • Redeploy Vector — quickest; but it does not create the missing consumer, so ingestion still
>   fails. Effort: low. Risk: masks the real gap.
> • JetStream + consumer — create the durable consumer Vector reads from. Effort: medium. Fixes
>   the root cause with existing infra. ⭐ recommended
> • Dedicated Go consumer — most control; new service to own and deploy. Effort: high.
>
> Recommendation: JetStream + consumer — it fixes the root cause with infra we already run, no new
> service to maintain.
>
> [ ⭐ JetStream + consumer ] [ Redeploy Vector ] [ Dedicated Go consumer ] [ ✏️ Other ]

## Testing (TDD, failing first)

- `structured-question.test.ts`: `maturedAsk` builds + validates; `normalizeAsk` carries/aligns the
  new fields; `fromAskUserQuestionInput` keeps descriptions; `decisionBody` renders title/context/
  details/recommendation and degrades; `keyboardRows` stars the recommended option; existing
  index/callback/answerText tests stay green.
- `raise-decision.test.ts` / `dispatch.test.ts`: `ask_operator` builds a rich `spec`; the row carries
  title/context/recommendation.
- `decisions.test.ts`: the enriched `spec` round-trips through the ledger row.
- Full `bunx tsc --noEmit` + `bun test` green.

## Out of scope / non-goals

- No new DB column (the `spec` JSON carries it). No change to the flat legacy `options` path,
  escalation approvals, callback encoding, resume/answer flow, or the priority/routing model.
- No AI added to the engine. Layer B (reviewer) is a separate, restart-gated phase.
