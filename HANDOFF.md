# Handoff — 2026-09-29

## In flight

**Branch:** `fix/interactive-turns-bypass-budget-throttle` (not `master`). Working tree clean except
`bun.lock` + `package.json`, which were already modified before this session (the Agent-SDK pin) and
are **not** mine — decide separately whether to commit them.

Two commits added, both green (`bunx tsc --noEmit` clean, `bun test` 826 pass / 0 fail):

- `a8ac47f feat(tools)` — `tools/create-loop.ts`, a CLI that authors a loop through the engine's own
  validated path (`validateLoopInput` → `createLoop` → ledger `loop_defs`), never hand-written SQL.
  It exists because `/api/loop/*` is admin-session-gated, so an agent working in this repo on the
  operator's behalf cannot author a loop. Also extracted `LEDGER_PATH` into `ledger.ts` (the literal
  was repeated in `daemon.ts` three times and `memory-bootstrap.ts` carried a "no shared constant
  exists yet" note), and added `tools` to `tsconfig.json`'s `include`.
- `15a92d5 feat(loops)` — the `waselni-store-readiness` loop definition, checked in at
  `docs/loops/waselni-store-readiness.json` + `.prompt.md`.
- A third, docs-only commit (2026-09-30) syncs the docs to those two: the narrative in
  `docs/HISTORY.md`, the CLI authoring path in `README.md`'s Loops section and `CLAUDE.md`'s Map, the
  resume state in `WIP.md`, and this file. `docs/loops.md`, `CONTEXT.md` and ADR-0004 were already
  written by the commits themselves.

**The loop is LIVE in `data/ledger.db` and the daemon needed no restart** (it re-reads `loop_defs`
every tick). Verified by replaying the daemon's own tick logic against the live DB: `effectiveLoops()`
returns it (7 loops), `listLoops` shows `scheduled · custom · enabled`, `isDue` true at 06:00 UTC and
false at 06:01/09:00, and `tickScheduler` at 06:00 returns `["waselni-store-readiness"]`. Daemon
PID 2284 (cwd `/home/neo`) holds that exact file open.

| field | value |
|---|---|
| folder | `/home/waselni` |
| trigger | cron `0 6 * * *` — 06:00 server-local/UTC ≈ 09:00 Asia/Baghdad |
| goal | `judge` — all four targets `done` with checkable evidence, nothing operator-blocked |
| bounds | 30 iterations, **$12 per fire** |
| session | `freshSession: true` — state lives in the repo file, not the session |
| enabled | yes |

A separate worker has already produced the first artefact: **`/home/waselni/docs/store-readiness.md`**,
committed on waselni's `dev` branch. 43 requirements × 4 targets = **172 rows** — `done` 32,
`partial` 24, `missing` 62, `operator-blocked` 22, `n/a` 32. It is an assessment only; nothing in
waselni has been changed, deployed or submitted.

## Decisions made

- **A loop prompt is a standing brief** — recorded as `docs/adr/0004-a-loop-prompt-is-a-standing-brief.md`,
  with a `Standing brief` entry added to `CONTEXT.md`. A loop does **not** go through dispatch:
  `runProjectLoop` puts `LoopDef.prompt` into `Order.task` verbatim, so there is no dispatch preamble,
  and `loopRunExtras` attaches `mcpServers` only for the dream loop, so there is no `ask_operator`.
  The prompt therefore carries the engineering baseline, waselni's own rules (never mock data, bump
  the PWA version), the reuse-the-existing-pipeline rule, the never-push/deploy/submit rule, the
  ask-once protocol, and the governance envelope itself.
- **06:00 UTC** chosen to match the existing `mywellbeing-checkin` convention (≈09:00 Baghdad), so
  operator-blocked items land at the start of the working day.
- **$12 per fire**, not per day-total: built-ins budget ~$2.50–3 per fix-and-verify iteration and
  this loop's iterations are narrower, so $12 funds roughly 8–15 real iterations a night without
  eating the interactive reserve.
- **Kept the script** as `tools/create-loop.ts` rather than deleting it — the admin gate locks every
  future agent out the same way. Added `promptFile` support so a long brief stays reviewable in
  markdown instead of buried in one JSON string (one source of truth, not two).
- Rejected: wiring `neoMcpServers` + `briefWithProjectDocs` into the loop path. It is the better
  long-term answer but is an engine change needing a restart, and it silently re-prices every
  existing built-in loop.

## Blockers

**Engine (1 and 2 are real gaps, both restart-gated; nothing below is fixed):**

1. **Loop workers have no `ask_operator`.** Blocked items go out as the worker's reply text (which
   does reach the operator's chat tagged `#waselni`) and are recorded with `asked: <date>` in the
   checklist so they are asked once. Wiring the MCP server into the loop path is the real fix.
2. **The declared budget is not the whole cost.** `runLoop` sums only `iterate()`'s `costUsd`
   (`loop-runner.ts:54`); the judge run between iterations is never added. Real spend ≈ `budgetUsd`
   plus one judge run per iteration. `Bounds.budgetUsd`'s "incl. judge runs" comment
   (`project-loop.ts:16`) is wrong today. Minor, related: `judgeGoal` accepts `timeoutMs` and never
   uses it — a judge run is effectively unbounded.
3. Because the goal will not be met for months, **every fire runs to a bound**, and budget — not the
   30 iterations — will end most of them. Raise `budgetUsd` to ~$30 if you want all 30 reachable.

**waselni (from the checklist, operator-only):** background-location posture is the lead one —
`ACCESS_BACKGROUND_LOCATION` is declared but never used, and the parent app requests it too;
removing it deletes several rows outright and is the cheapest outcome. Then: no in-app account
deletion and no deletion endpoint, no public privacy/terms/support URLs, reviewers cannot log in
(OTPIQ refuses non-Iraqi numbers — needs the prod `OTP_TEST_NUMBERS`/`OTP_TEST_CODE` set), counsel
sign-off on the cabin-recording notice, and no Mac/iOS hardware on this box for iOS screenshots or
crash validation.

## Next steps

1. Answer the background-location question first — it unblocks R-13/R-14/R-15 and may delete them.
2. Decide on the two engine gaps above; both need a restart, so batch them with the other
   restart-gated fixes already queued on this branch.
3. Watch the first few fires. If nightly spend or the reply volume is wrong, edit the definition and
   re-apply: `bun run tools/create-loop.ts docs/loops/waselni-store-readiness.json --update`.
4. Decide what to do with `bun.lock` / `package.json`, and whether this branch should merge.
