# Waiting Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** WAITING threads leave WAITING when their decisions are done (on checked evidence). An hourly
loop re-checks them and reminds the operator once, only on change.

**Spec:** `docs/superpowers/specs/2026-10-22-waiting-sweep-design.md` · **ADR:** 0045 · branch
`fix/waiting-threads` → `dev`. Restart-gated.

## Global Constraints
- No AI in the engine. The worker judges; the engine checks the evidence and acts.
- No migration. Only the meta table and the existing columns are used.
- The one-off runs against the live ledger only with v11 columns and a `VACUUM INTO` backup.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus
- A `--file ../../etc/x` or absolute path → refused (task 2).
- A reminder is never sent twice for the same list (task 2, task 3).
- `report:"goal"` never forwards worker text (task 1).

### Task 1: Loop field `report: "goal"`
Files: `src/engine/loop-validate.ts`, `src/engine/loops.ts` (`LoopDef`, `startScheduledLoop`), `tests/loops.test.ts`, `tests/loop-validate.test.ts`.
- [x] Failing tests (spec AC 4, and validation of `report` values) → implement → green → commit.

### Task 2: `waiting-sweep.ts` + `supersedeDecision` cancels parked todos
Files: `src/engine/waiting-sweep.ts`, `src/engine/ledger.ts`, `src/config.ts`, `tests/waiting-sweep.test.ts`, `tests/ledger.test.ts`.
- [x] Failing tests (spec AC 1–3) with a fake GitRunner and a temp ledger → implement → green → commit.

### Task 3: CLI + loop definition
Files: `tools/threads/sweep.ts`, `docs/loops/waiting-sweep.json`, `docs/loops/waiting-sweep.prompt.md`, `tests/waiting-sweep-cli.test.ts`.
- [x] Failing tests (spec AC 5; CLI `check` twice prints once) → implement → green → commit.

### Task 4: One-off cleanup (Part 2)
Files: `tools/oneoff/2026-10-22-close-done-waiting-threads.ts`, `tests/oneoff-waiting-threads.test.ts`.
- [x] Failing test (spec AC 6 against a fixture ledger) → implement → dry run on the live ledger →
  `--apply` (backup first) → verify the counts → commit.

### Task 5: Docs + review
`docs/loops.md`, `docs/CONFIG.md`, `docs/HISTORY.md`, `CLAUDE.md` map, `HANDOFF.md`. Run
`/security-review` (the CLI takes input), then code review, then a full `bun test` + `tsc`. Merge
to `dev`.
