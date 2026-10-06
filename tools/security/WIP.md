# WIP — shift-left security kit (resume here)

Branch `feat/security-checks`, worktree `/home/neo-wt-security`. Interrupted by an engine restart on 2026-10-06.

## Verified so far (this run)
- WIP commit 904b5e3 is intact; `bun test tests/security-findings.test.ts` → 7 pass.
- All 10 scanner images are pulled. `rules/registry/` is gitignored (filled by update-rules.sh).
- Baseline timing: `scan.sh file . src/frontends/web.ts` = 36.7 s (target ≤ ~8 s).

## Next (operator-approved TODO, in order)
1. Speed: pre-filtered per-language merged rule file built at update-rules time (dedupe ids); measure
   `docker exec` into a long-lived semgrep container; keep full packs for push/nightly. Strip the
   path prefix from semgrep rule ids; map gitleaks `/scan/...` back to real paths (findings.ts, TDD).
2. install.ts (~/.claude/security + settings.json hook merge, idempotent) + NEO_WORKER=1 in session-runner.
3. init.ts (.githooks pre-commit/pre-push, chain husky/core.hooksPath, .security/config.json + baseline, .gitignore).
4. docs/loops/security-sweep.json + prompt via tools/create-loop.ts, cron `0 3 * * *`.
5. briefWithProjectDocs line in src/engine/dispatch.ts (TDD).
6. tools/security/security-review.md → ~/.claude/commands/security-review.md.
7. Security Rules diff for both CLAUDE.md files → file + ask_operator (do NOT save).
8. Pilot on /home/neo in the worktree; record timings. 9. docs/security-checks.md.
- ADR number: use 0024 (dev already has 0023).
