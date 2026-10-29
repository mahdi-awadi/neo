# "Needs you" is classed by kind in code; pins live in the ledger

**Status:** accepted (2026-10-29, as built on dev; restart-gated). Builds on ADR-0059 (self-explaining items),
ADR-0054 (waiting work, owners), ADR-0018 (attention actions).

## Context

The console's Projects tab shows ATTENTION on almost every project. The rule (`projectHealth`) is "any
open item with severity `high`", and each producer sets the severity itself. Live (2026-10-29, read-only):
the high items are 11 notes between projects (`note_fyi` 9, `note_finding` 1, `note_request` 1), 7 `dirty`
"uncommitted files after todo #N" and 2 `ci_failed`. None asks the operator for anything. The items that do
— plans awaiting approval and decision cards — live in the decisions table and never reach the badge. Old
`chore/agent-sdk-*` bump branches stay open one per version (#289 … #395).

## Decision

1. **One classifier, `attentionClass(kind) → "needs_you" | "housekeeping"`**, a fixed table in code. An
   unknown kind is `needs_you` (fail closed). The producer's severity only orders items inside a class.
2. **One read model, `needsYou(ledger, now)`** joins: every open decision from waiting work (ADR-0054:
   plans, decisions, alerts — one the sweep may still close counts too, fail closed), failed todos, open attention items classed `needs_you`, and manual pins;
   minus items the operator unpinned. The badge, its count, the pinned strip and `/attention` read it.
3. **Pins are a ledger table** (`pins`, migration v16): `(ref, state pinned|unpinned, at)`, ref =
   `att:<id>` | `dec:<id>` | `todo:<id>`. Server-side, so every device agrees.
4. **Superseded items are resolved by the engine** inside `reconcile`, as dismissed (the next scan that
   still sees one keeps it closed), with the reason in the existing `resolution` JSON: same project, same
   kind, same stem (a branch or dependency name with its trailing version removed), a lower version than
   an open sibling. Only branch-named kinds and dependency PRs; an id-keyed kind never. No branch or PR
   is deleted or closed.
5. **Todo detail is one endpoint** (`GET /api/todo/:id`) on the existing todo read; actions reuse
   `POST /api/todo`. Every console button goes through one `act()` helper: pressed + busy state, then a
   toast with the engine's reply text.

## Alternatives rejected

- **Lower producer severities.** Severity means "how bad", not "whose move"; a CI failure is bad but an
  agent can fix it. Fixing each producer leaves the next one to repeat the mistake.
- **Let an AI classify each item.** The class is a stable property of the kind; code decides it in one
  table, testable, with a fail-closed default (operator rule: AI decides only where it helps).
- **Pins in localStorage.** Per device; the operator uses a phone and a desktop.
- **Delete superseded branches.** Irreversible; deleting needs the operator. Resolving the item is enough.
- **A second "needs you" list beside waiting work.** ADR-0054 already owns "who moves it next"; reuse it.

## As built (2026-10-29)

- A project's "Needs you" section counts and lists the project's whole share of the needs-you list (plans,
  decisions and failed todos as strip rows, then the needs-you attention items), so it always matches the
  badge. A plan card alone makes a project ATTENTION.
- Every console POST button goes through `act()` (`web/act.ts`); the toast region is a manual popover so
  a toast shows above the open todo sheet (a modal dialog lives in the top layer). Exempt: the composer's
  own send and attachment discard, and a project row's select (a navigation tap).
- Pin toasts use the console's own words (`pins.pinned` …); other toasts carry the engine's reply, which
  stays English like every engine reply.

## Consequences

- Projects with only housekeeping read OK; their items sit under "housekeeping (N)".
- Restart-gated: migration v16 runs at the restart (additive: one table).
