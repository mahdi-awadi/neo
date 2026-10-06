# HANDOFF — operator traceability plan (neo #42)

## Goal
Execute `docs/superpowers/plans/2026-10-06-operator-traceability-and-project-management.md` (spec + ADR-0015..0019) phase by phase: TDD, reviewed, restart-gated, never restarting the daemon.

## Done — the whole plan (P0–P6)
- **P0 + P1** live since the 2026-10-06 17:35 restart (master `f8fae4c`).
- **P2–P6** on local master `1d5921a` (fast-forward only, NOT pushed, restart-gated). Every task and phase reviewed and approved. `i18next` installed in `/home/neo` from the lockfile.
  - P5 closed with fixes `ed8e403`, `942ea5b` (remove warning posted in full on Telegram; consent bound to the exact ignored files; `drop` flag).
  - P6 project dashboard: `a8efc75`/`1cd7582` read model (`src/engine/project-view.ts`); `4b9a493`/`98b42c4` surfaces (console Projects tab EN+AR, `/project` + `/p`, `sessions` tool block); `6aadb43`/`ecc65ce` deployed-version + health probe (`src/engine/producers/probe.ts`); `1d5921a` sessions tool via `projectDeps`.
- tsc clean, 1541 pass (5 full runs clean), console bundle builds.
- Worktree `/home/neo-wt-trace` removed; branch `feat/operator-traceability` kept (= master). Nothing uncommitted except this file.

## Next steps
1. **Operator restart** to activate P2–P6. Checklist: `/home/neo/.superpowers/sdd/2026-10-06-operator-traceability-and-project-management/restart-checklist.md` — one boot runs migrations v5→v8 with ONE backup `data/ledger.db.bak-v4` (~250 MB; the ledger is ~253 MB + WAL). After it, verify per the checklist's "Try after restart" lines.
2. Deferred, not in the plan's tasks: `/attention refresh` + a console refresh button (spec §7 on-demand scan).
3. The 8 optional extras and the Docker exception need the operator's yes. Push of master: operator decision.

## Open decisions
- The restart (above). ADR-0020 (auto-memory as the one project memory): approve or not.

## Gotchas
- Ledger of rulings/progress/restart checklist: `/home/neo/.superpowers/sdd/2026-10-06-operator-traceability-and-project-management/` (moved from the removed worktree; gitignored). Trust it plus `git log` over recall.
- Known limits recorded there: `/project` names with spaces; `findByFolder` exact-path match; a failed digest send leaves an empty trace root; one unidentified flaky test failure seen once by a reviewer (not reproduced in 5 runs).
- Any new schema = migration 9. Never open `data/ledger.db` for writing.
- Other in-flight branches: `feat/console-paste-image` (re-port into `src/frontends/web/app.ts` on merge), `fix/telegram-stale-callback-answer` (switch the `plan:`, `att:` and new `pj:` taps to `ackCallback` on merge). Leftover worktree `/home/neo-wt-fence-allow` is not ours — do not touch.
