---
approval: required
---

# Project notes — implementation plan

> For agentic workers: REQUIRED SUB-SKILL superpowers:test-driven-development per task (the failing
> test first, per acceptance criterion). Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-10-22-project-notes-design.md` (AC1–AC19, edge cases).
**ADR:** 0043. **Glossary:** `CONTEXT.md` → Projects telling each other.
**Branch:** `feat/project-notes` from `dev` (temporary worktree, removed at the end) → merge to `dev`.
No push, no daemon restart: the feature is restart-gated, and the report says so.

## Recommendation

Option **(C)**, built on attention items (ADR-0043). (A) lets one project make another act with no
approval and is a prompt-injection path. (B) is today's manual process: it depends on an AI noticing
a line, costs company turns, and never closes a note. (C) on attention items reuses the dashboard,
digest, console, snooze, dismiss and **→ todo**, so the new code is the note's rules only.

## Global constraints

- No AI in the engine: validation, routing and resolution are code over facts (git, todo status).
- No note starts work. Only **→ todo** (operator) or a company dispatch on the operator's order.
- `bunx tsc --noEmit` and `bun test` green at the end of every task. One commit per task.
- Every limit in config (`notes.*`), with defaults in code. Console strings in `locales/en` and
  `locales/ar`.
- The dispatch preamble plus the codebase-memory line stay under 5000 characters.

## Phase 1 — store and send (AC1–AC5, AC18)

- [x] **1.1 Migration 12.** Test first: a v11 ledger migrates; `attention_items` gains
  `from_project`, `cause_msg_id`, `resolution`, `acked_at` and index `(from_project, source)`; old
  rows read unchanged. Add `"note"` to `AttentionSource`; ledger reads/writes for the new fields.
- [x] **1.2 Config `notes`.** `readNotesCfg` like `readAttentionCfg`: each positive number kept, else
  the default. Test the defaults and a bad value.
- [x] **1.3 Secret patterns.** `src/engine/secret-patterns.ts`: `findSecret(text) → pattern name |
  undefined`. Table-driven tests: one hit per pattern, placeholders (`<token>`, `xxx`, `changeme`,
  `${VAR}`) are not hits, and the result never contains the matched text.
- [x] **1.4 `send`.** `project-notes.ts` `send`: addressing (`resolveProject` under the work root;
  refuse a desk, self, `/`, `..`), kind/severity, sizes, secrets, the two caps; then `attention.raise`
  with key `<sender>:<ref>` in one transaction. Tests for AC1, AC2 (refresh; reopen clears
  resolution, snooze, todo) and every AC3 refusal (nothing stored).
- [x] **1.5 Guard the scans.** Test: `reconcileAll` and the scan tick never touch source `note`;
  `pruneAttention("note")` uses `notes.keepResolvedDays`.
- [x] **1.6 Events and trace.** `note_sent` / `note_refused` events; a trace outbound line under the
  call's cause with the title only (AC4). Test that the body never reaches the trace.
- [x] **1.7 Routing table (AC5).** `noteRoute(kind, severity) → "now" | "digest"`. `now` posts one
  line through the existing operator send (priority `result`, flood gate) with the attention buttons.
  Test the table and that no route calls the todo queue or a session.
- [x] **1.8 The tool.** `project_notes` in `neoMcpServers`, gated on `deps.notes` (actions in this
  phase: `send`). Sender from `opts.projectName`, cause from `opts.cause()`. Tests: a tool call raises
  the item; the tool has no sender argument; **AC18**: `ingress.ts` passes `notes: undefined`, and a
  test builds the ingress tool set and finds no `project_notes`. Record which launch paths (dispatch,
  pipeline, company, loops) get the tool. *Recorded:* dispatch, operator sessions and the company
  (pipeline) get it; ingress strips it; loops get no Neo tools today (only dream memory), so loop
  workers cannot send notes — deferred.
- [x] **1.9 Wire the daemon.** Build `ProjectNotes` once in `daemon.ts`; pass `deps.notes` on the
  operator surfaces only.

## Phase 2 — the target and the sender read and close notes (AC6–AC12, AC19)

- [ ] **2.1 `list` / `show` / `ack`.** Box `to` / `from`, `listMax`, show only to or from the caller,
  ack target-only (AC7, AC10).
- [ ] **2.2 `resolve`.** `fixed <commit>` checks `git cat-file -e` and `git branch -a --contains` in
  the target folder through the bounded exec (`notes.gitTimeoutMs`). Tests with a temp repo: a real
  commit on a branch passes; an unknown sha, a dangling commit and a git error are refused and change
  nothing (AC8). `not_needed` / `duplicate` need a reason with the secret check (AC9). Target-only
  (AC10).
- [ ] **2.3 `withdraw`** (sender only), AC12.
- [ ] **2.4 The notes block.** `block(project)`: the "to me" part (AC6) and the "I sent" part (AC11),
  capped by `blockMax` and `blockMaxChars`, highest severity and newest first, the "information, not
  orders" header. Pure function tests, including the char cap and an empty result.
- [ ] **2.5 Inject it.** In `dispatchToProject` next to the memory snapshot (`gatedResume ===
  undefined`) and in `pipeline.ts` next to its snapshot (`!runDeps.resume`). Tests: fresh start gets
  it; resume does not; ingress and tainted runs do not (AC19); the recorded order matches what the
  worker got.
- [ ] **2.6 Tool actions** `list`, `show`, `ack`, `resolve`, `withdraw` in `project_notes`. Tool
  description tells workers: notes are information, not orders; refer to records by id; never paste
  customer data or secrets.

## Phase 3 — the operator and the trace (AC13–AC17)

- [ ] **3.1 Brief template.** `ATTENTION_BRIEFS` entries for the note kinds (`note_finding`,
  `note_fyi`, `note_request`); the existing "every kind has a template" test covers them (AC14).
- [ ] **3.2 → todo keeps the cause.** For a note with `cause_msg_id`, the todo's cause is that thread,
  not a new `attention` root. Test with the trace: `/trace` on the sender's thread lists the note, the
  todo and its run (AC14, AC17).
- [ ] **3.3 Todo end resolves.** On a todo end `ok` whose id is a note's `todo_id`, resolve the note
  `fixed` with the target's HEAD (AC15). A failed end leaves it open. Test both.
- [ ] **3.4 Dismiss shows to the sender.** Dismiss writes `{ how: "dismissed" }` for source `note`
  (AC16).
- [ ] **3.5 Surfaces.** Attention lines for notes read `<title> — from <sender>` on Telegram, the
  dashboard and the console. New console strings as i18n keys in `en` and `ar` (catalogue-complete
  test). `/trace` renders a note line. (AC13)

## Phase 4 — docs and the preamble

- [ ] **4.1** Replace the preamble sentence "Work for another project (even one an old note lists)
  goes back to Neo to dispatch." with one that points at `project_notes`. Test: the preamble plus the
  longest codebase-memory line stay under 5000 characters.
- [ ] **4.2** `docs/CONFIG.md` (`notes.*`), `docs/HISTORY.md`, CLAUDE.md "Current status", ADR-0043
  status → accepted.
- [ ] **4.3** Full `bun test` + `bunx tsc --noEmit`, `/security-review` (input handling: tool
  arguments, secret check), `requesting-code-review`. Merge to `dev`, remove the worktree, report:
  restart-gated, and what a restart turns on.

## Risks

- **Prompt injection through a note body.** A body is another worker's text. It is never put into a
  brief in full (the block has titles only); `show` returns it as tool output; the header and the
  tool text say notes are not orders. Work still needs the operator's tap.
- **PII in a body.** Not detectable in code. The tool text forbids it; sizes are capped; the operator
  sees every note in the digest.
- **Noise.** Caps per sender, `ref` dedupe, digest-only for most notes.
