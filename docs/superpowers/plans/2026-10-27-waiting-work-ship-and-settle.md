---
approval: required
---

# Waiting work: ship, settle, own, and never sit undeployed again

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WAITING in the console means "someone owes a named action". The decisions that are done or
moot in their repos close on evidence. A fix counts as done only when the daemon runs it.

**Architecture:** First ship `dev` as it is (Phase A, operator-gated). Then close the gaps the report
found in dev's rules (Phase B). Then add one read model, `waitingWork()`, that both views use
(Phase C). Last, make the restart producer see the integration branch (Phase D).

**Tech Stack:** Bun + TypeScript, `bun:sqlite` ledger, `bun test`.

**Spec / evidence:** `docs/investigations/2026-10-27-waiting-threads-third-report.md`;
ADR-0054 (proposed) `docs/adr/0054-waiting-work-has-an-owner-and-a-fix-is-done-only-when-it-runs.md`.

## Global Constraints

- TDD: write the failing test first. `bunx tsc --noEmit` is clean. `bun test` is green, and a known
  timing flake (`tests/dispatch.test.ts`, `tests/dashboard.test.ts`) passes when run again alone.
- Never open the live `data/ledger.db` with dev's `openLedger` while a v11 daemon runs. Read it only
  through a `VACUUM INTO` copy.
- Never record a fake operator answer. A close made by the engine is `superseded` or `expired`,
  with its reason in `answer`.
- An unanswered decision that matches `decisionSettle.keepPatterns` never expires.
- New knobs go in `config.json` through `src/config.ts` readers with defaults, and in `docs/CONFIG.md`.
- New console strings go in the console's AR+EN catalogues. Numbers and refs stay LTR.
- **[OPERATOR]** marks a step only the operator does: merge to master, restart, `--apply` on the live
  ledger, and loading a loop into the live ledger.

## Review Focus

1. A real question is never closed because some chat line or some later work exists (d83217cb).
   Pinned in B1.
2. A plan card closed on evidence must mark its **plan** done, not only the card. Otherwise the
   card comes back as "awaits Approve" (469c565d, 544144fb). Pinned in B3.
3. An order still running across a restart (a resumed session) must not be marked `interrupted`.
   Pinned in B2.
4. The Threads count and the Queue view must never disagree. Pinned in C1 by an invariant test over
   a ledger fixture.
5. The restart producer must not flood: one item for the integration branch, and none for branches
   already merged into it. Pinned in D1.

---

## Phase A: ship what is on dev (operator-gated)

### Task A1: release branch, merged and verified

**Files:** none new. Git only: branch `release/2026-10-27` in a temporary worktree.

- [x] **Step 1:** `git worktree add /tmp/neo-release -b release/2026-10-27 master`, then
  `git -C /tmp/neo-release merge --no-ff dev`.
  Expected: no conflicts (checked 2026-10-27: `git merge-tree` is clean; master has only 2 SDK pins).
- [x] **Step 2:** In the worktree, run `bunx tsc --noEmit` → no output. Run `bun test` → 0 fail, or
  only the two known timing flakes, which must pass when run again alone.
  (2026-10-27 trial: 2,278 pass, 2 fail; on re-run 112 pass, 0 fail.)
- [x] **Step 3:** Migration dry run. Copy the live ledger with `VACUUM INTO` to `/tmp`. Open the
  copy with the release code's `openLedger`. Expected: `PRAGMA user_version` = 13, and every
  v11 row count is unchanged.
- [x] **Step 4:** Merge `master` into `dev` as well, so the two SDK pins are on `dev`. Then
  `release/2026-10-27` = `dev` + pins. Commit. Remove the worktree.
  (Done 2026-10-27: `dev` already had master by `a7a6b53`, so `release/2026-10-27` = fast-forward of
  master to `dev` `24cb50b`. `tsc` clean; `bun test` 2,280 pass, 0 fail; the ledger copy migrates
  v11 → v13 with no row count changed in 22 tables.)
- [ ] **Step 5 [OPERATOR]:** Approve fast-forwarding `master` to `release/2026-10-27`.
- [ ] **Step 6 [OPERATOR]:** Restart the daemon (`systemctl restart neo`).
- [ ] **Step 7:** Post-boot check, read-only:
  - the newest `engine_boots` row has `head_sha` = the release head and `branch` = `master`;
  - the ledger `user_version` = 13;
  - the journal has no `fault` lines in the first 5 minutes.

**Done:** the daemon runs the release head. ADR-0038/0045/0052/0053 are live.

### Task A2: load the waiting-sweep loop

- [ ] **Step 1 [OPERATOR]:** `bun tools/create-loop.ts docs/loops/waiting-sweep.json`.
- [ ] **Step 2:** Run `bun tools/threads/sweep.ts check` once. Expected: it prints the list of
  decisions to judge, or meets its goal.

**Done:** `loop_defs` has `waiting-sweep`, enabled, cron `0 * * * *`.

> The one-time `settle-decisions --apply` waits for Phase B (Task B5). Today it would close
> d83217cb, which is still a real question.

---

## Phase B: close the gaps in dev's rules

### Task B1: remove the "answered in chat" guess; the dispatcher records chat answers

**Files:**
- Modify: `src/engine/decision-settle.ts:150-165` (the answered-in-chat branch of `staleDecisions`)
- Modify: `src/engine/dispatch.ts:~1930-1950` (company tools; next to the `plan` tool)
- Modify: `CONTEXT.md` ("Superseded decision": remove the chat clause), `docs/adr/0038-…` (amended by 0054)
- Test: `tests/decision-settle.test.ts`, and the test file that holds the ADR-0053 `plan` tool tests (find it with `grep -l "applyPlanAction" tests/`)

**Interfaces:**
- Produces: company tool `decision` with args `{ id: string /* 8+ chars */, action: "answer", answer: string, thread?: string }`.
  It calls `ledger.resolveDecision(id, answer, at)` only while the live input is an operator message
  (the same guard as `plan`). The event `decision_answered_in_chat` carries `{ id, msgId }`.

- [x] **Step 1:** Test `staleDecisions never supersedes on chat alone`. Fixture: one open question,
  then an operator line "Explain why we should cut off", then a todo in the same folder ended
  `done`. Expect `[]`.
- [x] **Step 2:** Test `decision answer records the operator's chat answer`. With a live operator
  input, `decision {id, action:"answer", answer:"yes, start them"}` sets status `answered` with
  that answer. Without a live operator input, the tool returns an error and the row stays `open`.
- [x] **Step 3:** Run both. Expect FAIL.
- [x] **Step 4:** Delete the branch from `staleDecisions`. Add the tool. Describe it in the
  dispatcher's tool list text.
- [x] **Step 5:** Run both, then the whole of `tests/decision-settle.test.ts`. Expect PASS. Update any
  old test that asserted the chat rule.
- [x] **Step 6:** Commit: `fix(threads): no close on a chat guess; the dispatcher records chat answers (ADR-0054)`.

### Task B2: every order ends

**Files:**
- Modify: `src/engine/ledger.ts` (new method next to `recordOutcome`, line ~860)
- Modify: `src/daemon.ts:145` (after `recordBoot`)
- Modify: `src/engine/dispatch.ts:660` (the `dispatch_delivered` path)
- Modify: `src/engine/decision-settle.ts` (expiry counts the new outcomes as ended)
- Test: `tests/ledger.test.ts`, `tests/decision-settle.test.ts`

**Interfaces:**
- Produces: `ledger.endInterruptedOrders(prevBootAt: number, at: number): number`. It records
  outcome `interrupted` for every order with no outcome whose newest event (or `created_at`) is
  before `prevBootAt`, and returns the count.
- Produces: the outcome status `delivered`, recorded when a brief is delivered into a live session.

- [ ] **Step 1:** Test `endInterruptedOrders closes only orders silent since the previous boot`.
  Fixture: order X has its last event before the previous boot; order Y has an event after it;
  order Z already has an outcome. Expect 1, X → `interrupted`, Y and Z unchanged.
- [ ] **Step 2:** Test `a resumed order is not interrupted`. An order with a `session_start` after
  `prevBootAt` stays without an outcome.
- [ ] **Step 3:** Test `expiry counts interrupted as ended`. A question older than 7 days on an
  `interrupted` order, with later `done` work in the folder, expires. A keep-pattern question does
  not expire.
- [ ] **Step 4:** Run. Expect FAIL. Implement. Call it in `daemon.ts` with the previous boot's `at`.
- [ ] **Step 5:** Run. Expect PASS. Commit: `fix(orders): an order silent across a restart ends as interrupted (ADR-0054)`.

### Task B3: a plan card closes when its plan is done by any path

**Files:**
- Modify: `src/engine/waiting-sweep.ts:210` (`closeWithEvidence`: today it refuses plan cards)
- Modify: `src/engine/plans.ts` (new `markPlanDone`)
- Modify: `src/engine/decision-settle.ts` (move the cleanup-only rule "a later todo that names the
  plan ended done" from `tools/threads/settle-decisions.ts` into `staleDecisions`, so the engine
  applies it continuously)
- Test: `tests/waiting-sweep.test.ts`, `tests/plans.test.ts`, `tests/decision-settle.test.ts`

**Interfaces:**
- Produces: `markPlanDone(deps: PlanDeps, planId: number, evidence: { commit?: string; file?: string; todoId?: number }, at: number): void`.
  It sets the plan to `done` with the evidence, records event `plan_done_by_evidence`, and the card
  follows (ADR-0036).
- Changes: `closeWithEvidence` on a plan card calls `markPlanDone`. It no longer refuses.

- [ ] **Step 1:** Test `evidence close of a plan card marks the plan done`. Expect the plan
  `done`, the card `superseded` ("plan done: commit c67c5b4f"), and no new card on the next `onRunEndPlans`.
- [ ] **Step 2:** Test `a todo naming the plan, ended done after the card, settles it in the engine`
  (same fixture as the settle-decisions test for #551/9f6a2b95). A `delivered` todo with
  `started_at == ended_at` does **not** count.
- [ ] **Step 3:** Run. Expect FAIL. Implement. Make `settle-decisions.ts` reuse the engine rule
  (one implementation).
- [ ] **Step 4:** Run. Expect PASS. Commit: `fix(plans): a plan done by any path closes its card (ADR-0054)`.

### Task B4: kept questions are judged, not frozen

**Files:**
- Modify: `src/engine/waiting-sweep.ts:107-150` (`waitingDecisions` / `needsJudging`)
- Test: `tests/waiting-sweep.test.ts`

- [ ] **Step 1:** Test `a keep-pattern decision with a newer commit in its repo needs judging`.
  Today's 2aa143d2 shape ("prod Qi binding", commit `aa65cce57` after it) must be in `toJudge`.
  The same decision with no newer commit must not be.
- [ ] **Step 2:** Run. Today `waitingDecisions` reads only threaded decisions, so the threadless
  shape fails. Make it read every open decision (`listOpenDecisions`). Run. Expect PASS.
- [ ] **Step 3:** Commit: `test(threads): kept prod questions are still judged on evidence (ADR-0054)`.

### Task B5: one-time settle on the live ledger

- [ ] **Step 1:** Ship B1–B4 the way Task A1 does (release branch, verify, [OPERATOR] merge and restart).
- [ ] **Step 2:** `bun tools/threads/settle-decisions.ts data/ledger.db` (dry run). Expect:
  - d83217cb is **not** in CLOSABLE;
  - 2aa143d2, 1f7d20a3, ae0daf27, 544144fb and 469c565d are closable, or listed for the sweep.
- [ ] **Step 3 [OPERATOR]:** Check the list, then run it with `--apply`. The tool backs up first.
- [ ] **Step 4:** Re-run the dry run. Expect CLOSABLE (0): it is idempotent.

**Done:** the 10 eticket-v3 threads in the screenshot are WAITING only where a C4 question
(4fc5a9c1, d83217cb, 708b51b4) or daa64d3a is still open.

---

## Phase C: waiting work has an owner and a next action

### Task C1: `waitingWork()`, one read model for both views

**Files:**
- Create: `src/engine/waiting-work.ts`
- Modify: `src/engine/trace.ts` (`refreshThread` derives WAITING from it)
- Modify: `src/engine/web-channel.ts` (`threads()`; the Queue view data)
- Modify: `src/frontends/web/app.ts`, the console AR+EN catalogues (a "Waiting" section in Queue;
  the owner and next action on each WAITING thread row)
- Test: `tests/waiting-work.test.ts`, `tests/web-channel.test.ts`

**Interfaces:**
```ts
export type WaitingOwner = "operator" | "sweep" | "engine";
export interface WaitingItem {
  kind: "decision" | "parked_todo" | "held_plan";
  id: string;            // decision id, "#<todo id>", or "plan:<id>"
  project: string;       // the decision's own project, not the thread's (G5)
  threadId?: number;
  owner: WaitingOwner;
  nextAction: string;    // the ask, "judge against the repo", or "resumes when #<id> is answered"
  since: number;         // when it started waiting
  keep: boolean;         // matches keepPatterns
}
export function waitingWork(ledger: Ledger, opts: { now: number; cfg: DecisionSettleCfg }): WaitingItem[];
```
Owner rule: `sweep` while the repo has a commit newer than the last judgement; `operator` after it is
judged `keep` or when it has no repo; `engine` for a parked todo (it resumes by itself).

- [ ] **Step 1:** Test `every WAITING thread has a waiting item, and every item's thread is
  WAITING`. Use a fixture ledger with decisions, parked todos, held plans, and a thread whose only
  decision is dismissed (mb1et's shape).
- [ ] **Step 2:** Test `a gold decision on an eticket thread counts as waiting for gold`. The
  `/api/threads?project=gold&state=waiting` result includes the thread;
  `project=eticket-v3&state=waiting` does not, unless an eticket item exists.
- [ ] **Step 3:** Test `nextAction is never empty`.
- [ ] **Step 4:** Run. Expect FAIL. Implement. Then render the owner and next action in the console
  (AR+EN keys `threads.waiting.owner.*`, `queue.waiting.*`).
- [ ] **Step 5:** Run. Expect PASS. Take an RTL console screenshot of a WAITING row: the ref and
  numbers stay LTR. Commit: `feat(threads): one waiting-work model with owner and next action (ADR-0054)`.

### Task C2: no silent wait; escalate by age

**Files:**
- Modify: `src/engine/waiting-sweep.ts` (`reminder`), `src/config.ts`, `docs/CONFIG.md`
- Test: `tests/waiting-sweep.test.ts`

**Interfaces:** config `waitingSweep.escalateAfterDays` (default 3). An operator-owned item older
than this goes at the top of the reminder with its age ("9d"). The fingerprint includes the age
bucket, so the reminder is sent again once when an item crosses the limit, and never every hour.

- [ ] **Step 1:** Test `an item crossing escalateAfterDays changes the fingerprint once`.
- [ ] **Step 2:** Test `the reminder lists kept prod questions with age, oldest first`.
- [ ] **Step 3:** Run. Expect FAIL. Implement. Run. Expect PASS. Commit.

---

## Phase D: a fix is done only when it runs

### Task D1: the restart producer sees the integration branch

**Files:**
- Modify: `src/engine/producers/restart.ts` (`RestartCfg`, `readRestartCfg`, `restartDrafts`)
- Modify: `docs/CONFIG.md`
- Test: `tests/producer-restart.test.ts`

**Interfaces:** `RestartCfg` gains `integrationBranch: string` (default `"dev"`) and
`maxUndeployedDays: number` (default 2). `restartDrafts` adds one draft with key `integration`:
"N commits on dev are not running (oldest D days)". Its severity is `high` when D >
`maxUndeployedDays`. The detail lists ADR numbers found in the commit subjects. Branches already
merged into the integration branch produce no `merge:` item.

- [ ] **Step 1:** Test `dev ahead of the running build gives one integration item`. Fixture repo:
  master = boot, `dev` +3 commits, one of them "(ADR-0053)". Expect 1 item, with detail
  containing "ADR-0053".
- [ ] **Step 2:** Test `severity is high after maxUndeployedDays`.
- [ ] **Step 3:** Test `a feature branch merged into dev gives no merge item`.
- [ ] **Step 4:** Run. Expect FAIL. Implement. Run. Expect PASS. Commit:
  `feat(restart): report fixes on the integration branch that are not running (ADR-0054)`.

### Task D2: say it where the operator looks

**Files:** `src/engine/commands.ts` (`/status`), `src/frontends/web/app.ts` (header) + AR+EN
catalogues. Test: `tests/commands.test.ts`, `tests/web-channel.test.ts`.

- [ ] **Step 1:** Test `/status shows running sha, branch and "dev +N not running"` when the
  integration item exists, and shows nothing extra when it does not.
- [ ] **Step 2:** Run. Expect FAIL. Implement. Run. Expect PASS. Commit.

### Task D3: "done" means live in handoffs and docs

**Files:** `CLAUDE.md` ("How to work here": a fix is reported "built on dev, not live" until
`git merge-base --is-ancestor <commit> <boot head>`), `src/engine/dispatch.ts` (the handoff "Engine
facts" block adds "dev +N not running"). Test: `tests/handoff.test.ts`.

- [ ] **Step 1:** Test `handoff facts include the integration gap`.
- [ ] **Step 2:** Implement. Run. Expect PASS. Commit.
- [ ] **Step 3:** Ship Phase C + D as in Task A1 ([OPERATOR] merge and restart). Then check that
  `/status` shows "dev +0".

---

## Operator approvals needed

1. **This plan** (it changes engine behaviour and needs restarts).
2. **Release 1 (Phase A):** fast-forward `master` to `release/2026-10-27`, then restart. Load the
   `waiting-sweep` loop.
3. **Release 2 (after B):** merge and restart, then `settle-decisions --apply` after you check the
   dry-run list.
4. **Release 3 (after C + D):** merge and restart.
5. **Not this plan, but open:** todo #700 duplicates the built oldest-code plan (stop it or let it
   run), and 7 real questions: 4fc5a9c1, d83217cb, 708b51b4, daa64d3a, bf799a94, 12a2836a, f0282349.
