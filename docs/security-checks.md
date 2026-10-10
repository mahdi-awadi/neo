# Security checks

Neo's shift-left security kit lives in `tools/security/`. It scans every project the same way, early
and cheaply, and blocks only what is new and serious. Decision record: ADR-0024. Terms: CONTEXT.md,
"Security checks".

## Layers

| Layer | When | What runs | Blocks on |
|---|---|---|---|
| write-time | after each Edit/Write (Claude Code PostToolUse hook) | semgrep + gitleaks on the one file | new high/critical (exit 2: the agent must fix it now) |
| pre-commit | `git commit` | semgrep + gitleaks on the staged content (the index, not the working copy), hadolint on staged Dockerfiles | new high/critical |
| pre-push | `git push` | the commits not yet on any remote (from the pushed refs): semgrep (deep) on their files, gitleaks on those commits, osv-scanner (dependencies), trivy (misconfig), hadolint, gosec (Go), the project's security tests | new high/critical, or failing security tests |
| nightly | `security-sweep` loop, 03:00 | everything: all files, full git history, dependencies, trivy (vuln/misconfig/secret), images from `config.json` (+ SBOM via syft), ZAP baseline and testssl on `devUrls` | reported, never blocking |

The PreToolUse **guard** hook (`guard.ts`) also keeps agents away from secret files (`.env*`, keys,
credential stores). It checks READS (ADR-0030): file tools' paths, Grep's path and glob, and the
path arguments of a Bash command. It does not check code (`node -e`, `python -c`), search patterns
(grep, rg, sed, awk, `git log -S`), commit messages, `--env-file` arguments, lines written into an
ignore file, or commands that only list names (ls, find without `-exec`, `git ls-files`/`status`, the
Glob tool). A bare key-file name such as `server.key` counts only when that file exists, so `e.key`
in a snippet is just text. It blocks a Neo worker (`NEO_WORKER=1`) and only warns the operator's own
sessions.
Templates (`*.example`, `.sample`, `.template`, `.dist`, `.defaults`) are always allowed.

## Policy

- Only **new** high or critical findings block. A project's existing findings are recorded once in
  `.security/baseline.json` (by fingerprint): tracked, not blocking.
- A fingerprint is tool + rule + repo-relative file + the matched code, without the line number, so
  a finding stays known when code above it moves.
- A secret's value is never copied into a finding or a report, only a hash of it.
- No Docker, a scanner that cannot start or finish, or an unreadable baseline (a merge conflict in
  `baseline.json`): the layer warns and passes. A scanner outage never stops editing or committing.
- A fingerprint uses the matched code, read from the scanned file (semgrep without a login reports
  only "requires login" for it).
- Getting past a check (`--no-verify`, editing the baseline, turning a hook off) is not allowed for
  workers (dispatch preamble). A false positive is reported to the operator.

## Commands

```bash
bun tools/security/install.ts            # kit → ~/.claude/security, hooks → ~/.claude/settings.json,
                                         # /security-scan → ~/.claude/commands; downloads the rules
bun ~/.claude/security/init.ts <repo>    # git hooks (chains existing ones), .security/config.json,
                                         # baseline, .gitignore lines
bash ~/.claude/security/scan.sh file|staged|push|full|baseline <repo> [...]
bash ~/.claude/security/update-rules.sh  # refresh semgrep packs + rebuild the merged rule files
bash ~/.claude/security/update-images.sh # bump the pinned scanner image digests (images.env)
bun ~/.claude/security/sweep.ts check --root /home   # the nightly loop's goal
```

The git hooks find the kit at `$NEO_SECURITY_KIT`, default `~/.claude/security`. Without it they
warn and still run any hook they chain.

`/security-scan` (a Claude Code command) runs the push layer on the branch, triages, then the
built-in `/security-review`.

## Per-project settings — `.security/config.json`

| Key | Meaning |
|---|---|
| `devUrls` | Dev URLs for the nightly ZAP baseline scan and testssl. Never production. |
| `images` | Docker images to scan nightly (vulnerabilities, secrets) and to write an SBOM for. |
| `testCmd` | The project's security test command, run at pre-push (for example authz tests). |

Reports go to `.security/reports/<layer>-<time>.json` (30 kept per layer, gitignored); SBOMs to
`.security/sbom/`. Commit `config.json` and `baseline.json`. A repo without `config.json` (never
`init`ed) gets no files at all: the write-time hook only prints there.

## Speed (write-time)

A write-time scan loads per-language merged rule files (`rules.ts build`, run by
`update-rules.sh`), runs osemgrep in a warm `neo-sec-semgrep-<kit hash>` container, and runs gitleaks at
the same time in `neo-sec-gitleaks-<kit hash>` (one pair per kit copy). Both containers have no network, a read-only root and only the rules
mounted; the files to scan are streamed in and removed after. For `src/frontends/web.ts` the semgrep
CPU time fell from 37.2 s to 5.9 s. A run inside a container stops itself after 50 s (write-time) or 30 min, so a hook that times out
leaves nothing running. `docker rm -f` on them is always safe: the next scan starts them again.

## Rules

- Registry packs (downloaded, gitignored): the OWASP core and cross-language classes for every
  file, language packs by file type, `security-audit` at the deep layers. The list lives in
  `tools/security/rules.ts`.
- Custom rules (`rules/custom/`, 20 for JS/TS, Go and Python) cover what the packs miss in our
  stacks: mass assignment, a price trusted from the client, weak randomness for secrets, secrets in
  logs, cookies without flags, CORS wildcard with credentials, LLM output reaching a sink, SSRF from
  a user URL, path traversal, error details sent to the client, unverified JWTs and raw HTML. Each has a fixture in
  `rules/tests/` (deliberately vulnerable code, never scanned as project code). `// ruleid:` marks a
  line that must match and `// ok:` one that must not. Run them with `semgrep --test` on a folder
  holding `neo-<lang>.yaml` next to `neo-<lang>.<ext>` (they need Docker, so `bun test` does not run
  them).
