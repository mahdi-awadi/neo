# Shift-left security kit (resume spec)

**Order (operator, 2026-10-06, approved TODO):** every project gets the same security checks,
early and cheap: when a worker edits a file, at commit, at push, and nightly. Built in
`tools/security/` on `feat/security-checks`. Decision record: ADR-0024. Terms: CONTEXT.md
"Security checks".

Already built (commit 80ddc47): the findings normaliser, `scan.sh` with four layers, custom OWASP
rules for JS/Go/Python with fixtures, the guard hook (secret files) and the post-edit hook.

## Tasks and acceptance criteria

1. **Speed.** The write-time scan of `src/frontends/web.ts` takes ≤ ~8 s (it was 36.7 s).
   - `rules.ts build` writes `rules/merged/<group>.yml` (one per language group) and `common.yml`
     (`generic.secrets`), each with unique ids. The pack list lives only in `rules.ts`.
   - semgrep runs as osemgrep in a warm `neo-sec-semgrep` container (no network, read-only root,
     only the rules mounted). gitleaks runs at the same time in `neo-sec-gitleaks`.
   - Findings show repo-relative paths and rule ids without a config-directory prefix (TDD in
     `findings.ts`), so fingerprints match across checkouts.
   - The custom rule fixtures give the same results as before.
2. **install.ts.** Copies the kit to `~/.claude/security` and merges the guard (PreToolUse) and
   post-edit (PostToolUse) hooks into `~/.claude/settings.json`. Running it twice changes nothing.
   Other hooks and settings stay. Session runner sets `NEO_WORKER=1` for workers (TDD).
3. **init.ts `<repo>`.** Writes `.githooks/pre-commit` and `pre-push`. It chains any existing husky or
   `core.hooksPath` hook, never replaces it. It writes `.security/config.json`, records the baseline,
   and adds `.security/reports/` to `.gitignore`. Running it twice changes nothing.
4. **Nightly loop.** `docs/loops/security-sweep.json` plus its prompt, created through
   `tools/create-loop.ts`, cron `0 3 * * *`.
5. **Dispatch brief.** `briefWithProjectDocs` (src/engine/dispatch.ts) tells every worker that new
   high or critical findings block, and how to fix or report them (TDD).
6. **/security-review command.** `tools/security/security-review.md` is installed to
   `~/.claude/commands/security-review.md`.
7. **Security rules for CLAUDE.md.** A proposed diff for `/home/neo/CLAUDE.md` and
   `~/.claude/CLAUDE.md`, written to a file and sent to the operator with ask_operator. Nothing is
   saved to either file.
8. **Pilot** on this worktree: baseline, then each layer, with timings recorded.
9. **Docs:** `docs/security-checks.md`, HISTORY entry, CONFIG notes if any knob is added.

## Edge cases

- No Docker, or a scanner image cannot start: the layer warns and exits 0.
- Two hooks start the warm container at once: one wins, the other uses it.
- The image digest or kit path changes: the warm container is recreated.
- A rule fixture (`rules/tests/`) is never scanned as project code.
