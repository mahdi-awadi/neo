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
5. ~~briefWithProjectDocs line~~ DONE (preamble 4843 chars, under the 5000 ceiling).
6. ~~command~~ DONE as /security-scan (security-scan.md): /security-review is a Claude Code built-in, so ours must not shadow it.
7. CLAUDE.md security rules: proposal in docs/superpowers/specs/2026-10-08-security-rules-for-claude-md.md → ask_operator (nothing saved).
8. Pilot (2026-10-08, this worktree, scan.sh run directly — init.ts NOT run: core.hooksPath is shared
   git config with /home/neo): baseline 354 s, 51 findings; file web.ts 6.4 s, ledger.ts 5.6 s, small
   1.3 s; staged 0.8 s; push dev..HEAD 41 s (0 new high, 1 medium). Fixed: trivy flagged the kit's own
   rule packs → skip **/tools/security/rules. Nightly full 261 s; its 2 "new" highs (spike/, path
   traversal) and ledger.ts's SSRF high were one false-positive class: `$REQ.query` matched
   `db.query(...)` and `$HTTP.get` any .get() → fixed in neo-js.yaml with ok: fixtures (12/12). Found: bun.lock 1 critical (proxy-addr 2.0.7) + 9 high
   (fast-uri 3.1.2 ×7, ip-address 10.2.0, @modelcontextprotocol/sdk 1.29.0); 6 semgrep highs to triage.
9. ~~docs~~ DONE: docs/security-checks.md, HISTORY, CLAUDE.md map line.
- ADR number: use 0024 (dev already has 0023).
