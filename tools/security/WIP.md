# WIP — shift-left security kit (resume here)

Branch `feat/security-checks`, worktree `/home/neo-wt-security`, rebased onto dev 7e0b105 on 2026-10-08.
Spec: docs/superpowers/specs/2026-10-08-shift-left-security-kit.md · ADR-0024 · CONTEXT "Security checks".

## Verified so far (this run)
- WIP commit 904b5e3 is intact; `bun test tests/security-findings.test.ts` → 7 pass.
- All 10 scanner images are pulled. `rules/registry/` is gitignored (filled by update-rules.sh).
- Baseline timing: `scan.sh file . src/frontends/web.ts` = 36.7 s (target ≤ ~8 s).

## Next (operator-approved TODO, in order)
1. ~~Speed~~ DONE: rules.ts merged per-group files + osemgrep in warm containers + gitleaks in parallel.
   web.ts: CPU 37.2 s → 5.9 s; wall 9–14 s at load 11–13 (≈ 6.5 s quiet). Fixtures: 30 = 30 findings.
2. ~~install.ts + NEO_WORKER=1~~ DONE (built and tested against a temp ~/.claude; NOT run on the real one — operator step).
3. ~~init.ts~~ DONE (.githooks with chaining; husky → .husky/<hook> line; config, baseline, gitignore).
4. ~~security-sweep loop~~ DONE: docs/loops/security-sweep.json + prompt + sweep.ts (goal); validated via create-loop on a scratch ledger. Live create = operator step after install.
5. briefWithProjectDocs line in src/engine/dispatch.ts (TDD).
6. tools/security/security-review.md → ~/.claude/commands/security-review.md.
7. Security Rules diff for both CLAUDE.md files → file + ask_operator (do NOT save).
8. Pilot on /home/neo in the worktree; record timings. 9. docs/security-checks.md.
- ADR number: use 0024 (dev already has 0023).
