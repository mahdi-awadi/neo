# Needs you vs housekeeping, pins, superseded items, tappable todos — design (ADR-0065)

Operator console UX order, 2026-10-29 (phone screenshots in `agent/inbox/Screenshot_2026-10-29-17-2*`).
Builds on ADR-0059 (#884: self-explaining items, todo summaries) — that work is on `dev`, not live; the
screenshots show the old build, so todo rows there still read "Execute the plan at …".

## Root cause (checked in the code and the live ledger, read-only)

- `projectHealth` returns `attention` when **any open item has severity `high`**; producers choose the
  severity. Live high items: `note_fyi` ×9, `dirty` ×7 ("uncommitted files after todo #N"), `ci_failed` ×2,
  `note_finding` ×1, `note_request` ×1. None needs the operator.
- What does need the operator — plans awaiting approval, decision cards, alerts — is in the decisions
  table. ADR-0054's `waitingWork()` already marks those `owner: "operator"`, but the badge never reads it.
- `restart_gated` items (`merge:<branch>`) stay open for every `chore/agent-sdk-<version>` branch.
- Todo rows: on `dev` the Queue tab has a `<details>` disclosure for the brief; the project page's QUEUE
  list has none. No console button shows pressed/busy state or a result toast.

## The seams

1. `src/engine/needs-you.ts`
   - `attentionClass(kind): "needs_you" | "housekeeping"` — one table. Needs-you kinds: `thread_failed`,
     `approval_stuck`, `queue_paused`, `decision_stale`, `secret_scanning`, `code_scanning`,
     `note_question`. Housekeeping: `pr_open`, `pr_review_requested`, `issue_open`, `dependabot`,
     `ci_failed`, `stale_branch`, `unpushed`, `no_upstream`, `drift`, `worktree`, `dirty`, `restart_gated`,
     `dispatch_spinning`, `ctx_window_suspect`, `skillify_repeat`, `thread_waiting` (its decision is already
     a needs-you item), `note_fyi`, `note_finding`, `note_request`. `ci_failed` is housekeeping: an agent
     fixes it through → todo (the operator can move it in the table). A site DOWN stays its own health
     state, above ATTENTION. Any kind not in the table: `needs_you`. A test lists every producer kind
     (`GITHUB_KINDS`, `GIT_KINDS`, `ENGINE_KINDS`, `RESTART_KINDS`, `SKILLIFY_KINDS`, note kinds), so a new
     kind must be classed.
   - `needsYou(deps, now): NeedsYouItem[]` — `{ ref, project, kind: "plan"|"decision"|"alert"|"todo"|
     "attention", why, action: "approve"|"answer"|"acknowledge"|"retry"|"open", since, pinned }`, from
     `waitingWork` (every open decision — one the sweep has not judged yet too, fail closed), failed todos, needs-you attention items, manual pins; minus unpinned.
2. Ledger v16: `pins (ref TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL)`.
   `setPin(ref, state|null)`, `listPins()`, `planByCard(decisionId)`.
3. `src/engine/supersede.ts`: `supersededBy(rows)` → `[{ id, by }]`: same project + kind, stem = branch
   (or `facts.dep`) minus a trailing `-?v?\d+(\.\d+)*`, lower version (numeric compare) than an open
   sibling. Run inside `reconcile` (every producer path); resolves as dismissed (stays closed while the
   scan still sees it) with `resolution` `{how:"superseded", by, key, reason:"superseded by #<id> (<branch>)"}`.
   Only branch-named kinds and dependency PRs; an id-keyed kind (`todo:903`) never.
4. Views: `projectHealth` reads the needs-you count (`attention` when > 0); the project card shows
   "N need you" and the project page splits **Needs you** and a collapsed **Housekeeping (N)**.
   `GET /api/needs-you` → the strip; `POST /api/pin { ref, state }`. `GET /api/todo/:id` → the detail.
5. Console: a "Pinned — needs you" strip under the tab bar on every tab (count chip, collapsible on phone),
   each row: kind chip, project, one-line why, the action button, an unpin control; any attention item or
   todo has a pin control. A todo row (Queue tab and project QUEUE) is a button that opens the todo detail
   view: summary, full brief, project, lane, state, created/started/ended times, result or last note,
   links, and the allowed actions (cancel, retry, move up). One `act(button, request)` helper for every
   button: `aria-pressed`/`aria-busy`, a pressed style, disabled while busy, then a toast with the reply
   text (→ todo: "queued as #N" or the refusal reason).
6. i18n: new keys under `needs.*`, `pin.*`, `todo.detail.*`, `toast.*` in `locales/{en,ar}/console.json`;
   ids, counts and times through `ltr()`; key-parity test.

## Acceptance criteria

1. With the live mix (notes, dirty, ci_failed, pr_open, stale_branch, restart_gated only), every project
   reads OK; a project with an open plan card, decision card, failed todo or unknown-kind item reads
   ATTENTION with that count.
2. The project page shows needs-you items first; housekeeping is collapsed with its count.
3. The strip lists every needs-you item across projects with its action; approve/answer/retry/open work
   from the strip; pin and unpin persist across reloads and devices; unpinned items leave the strip and
   come back when their state changes (a new decision is a new ref).
4. With `chore/agent-sdk-0.3.303 … 0.3.312` open, only 0.3.312 stays; the others are resolved with
   "superseded by #<id> (chore/agent-sdk-0.3.312)". A non-versioned branch is never superseded.
5. Tapping a todo row (Queue tab and project page) opens the detail view within one tap, with a visible
   pressed then loading state; cancel/retry/up show a toast with the engine's reply.
6. Every console button shows pressed + busy state and a result toast; "→ todo" shows "#N" or the reason.
7. EN and AR catalogues have the same keys; phone-width (390 px) screenshots in EN and AR show the strip,
   the split project page and the todo detail, with ids, counts and times LTR in RTL.

## Edge cases

- A decision with no project: shown under "Neo". A failed todo later retried: leaves the strip.
- Pinning a resolved item: refused with a reason. A pin whose target is gone: dropped from the strip.
- Version compare: `0.3.10` > `0.3.9`; a stem with only one item is untouched.
- The strip with 0 items is hidden; with many, it shows 5 and "show all (N)".
- The detail of a todo that is gone or not found: a toast, no blank view.

## Not in scope

Changing producers' severities; deleting branches or closing PRs; Telegram layout changes beyond the
needs-you count in `/attention`.
