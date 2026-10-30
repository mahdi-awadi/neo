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

**Host environment (ADR-0039).** The installed kit's `host.json` says what this server is:
`{ "hostEnv": "dev" }` or `"prod"`. `install.ts --host-env dev|prod` writes it; a re-install without
the flag keeps it. A missing or unreadable file means `prod`. On a `dev` host the guard lets a worker
WRITE a secret file: the Write tool, output redirections (`printf 'K=V\n' >> .env`,
`cat >> .env <<'EOF'`), `sed -i` and the destination of `cp .env.example .env`. Reads stay blocked on
every host (Read, Grep, cat, `sed` without `-i`, `tee`, a `cp` source, input redirections), and so do
Edit/MultiEdit (they need a Read and echo the file). On a `prod` host nothing changed. The hook
reads `host.json` on every call, so a change needs no restart. This host is set to `dev`.

## Policy

- Only **new** high or critical findings block. A project's existing findings are recorded once in
  `.security/baseline.json` (by fingerprint): tracked, not blocking.
- A fingerprint is tool + rule + repo-relative file + the matched code, without the line number, so
  a finding stays known when code above it moves.
- A secret's value is never copied into a finding or a report, only a hash of it.
- No Docker, a scanner that cannot start or finish, or an unreadable baseline (a merge conflict in
  `baseline.json`): the layer warns and passes. A scanner outage never stops editing or committing.
  What the scan missed is recorded (`incomplete`), never dropped silently (ADR-0051).
- A fingerprint uses the matched code, read from the scanned file (semgrep without a login reports
  only "requires login" for it).
- An **unreachable** Go vulnerability does not block (ADR-0066). osv-scanner runs govulncheck in the
  pinned Go image; a Go finding whose every verdict is `called: false` is capped at medium and tagged
  `unreachable` (the message starts "unreachable (never called)"). It stays in every report. The
  verdict counts only when Go analysed that `go.mod` on its own, at the version osv reports. No
  analysis (no Go, govulncheck failed for that module, the binary could not be fetched or checked,
  out of memory), a missing verdict, or another ecosystem: full severity, as before.
- Getting past a check (`--no-verify`, editing the baseline, turning a hook off) is not allowed for
  workers (dispatch preamble). A false positive is reported to the operator.

## Commands

```bash
bun tools/security/install.ts            # kit → ~/.claude/security, hooks → ~/.claude/settings.json,
                                         # /security-scan → ~/.claude/commands; downloads the rules
bun tools/security/install.ts --host-env dev   # the same, and mark this host dev (ADR-0039)
bun ~/.claude/security/init.ts <repo>    # git hooks (chains existing ones), .security/config.json,
                                         # baseline, .gitignore lines
bash ~/.claude/security/scan.sh file|staged|push|full|baseline <repo> [...]
bash ~/.claude/security/update-rules.sh  # refresh semgrep packs + rebuild the merged rule files
bash ~/.claude/security/update-images.sh # bump the pinned scanner image digests (images.env)
bun ~/.claude/security/sweep.ts check --root /home   # the nightly loop's goal
```

The git hooks find the kit at `$NEO_SECURITY_KIT`, default `~/.claude/security`. Without it they
warn and still run any hook they chain. A chained hook (for example `.githooks/pre-commit.pre-neo`)
that is missing or not executable fails the hook with exit 1 (ADR-0051): commit it, or re-run
`init.ts`, which drops a chained hook that is gone.

`/security-scan` (a Claude Code command) runs the push layer on the branch, triages, then the
built-in `/security-review`.

## Per-project settings — `.security/config.json`

| Key | Meaning |
|---|---|
| `devUrls` | Dev URLs for the nightly ZAP baseline scan and testssl. Never production. |
| `images` | Docker images to scan nightly (vulnerabilities, secrets) and to write an SBOM for. |
| `testCmd` | The project's security test command, run at pre-push (for example authz tests). |
| `semgrepChunkFiles` | Files per semgrep part (default 200). Lower it when a part times out (ADR-0051). |
| `semgrepTimeoutSec` | Time limit for one semgrep part, in seconds (default 1800; write-time is always 50). |
| `osvMemoryMb` | Memory limit (no swap) for osv-scanner with Go call analysis, in MB (default 8192). Over it: no analysis, full severity (ADR-0066). |
| `osvTimeoutSec` | Time limit for osv-scanner with Go call analysis, and for waiting on another one, in seconds (default 2400). |
| `osvGoTags` | Build tags for the Go call analysis, comma-separated (letters, digits, `_ . ,`). Set it when a build uses tags. |

Semgrep runs in parts: each part is staged, scanned and removed on its own, under its own time
limit, so a slow part loses only its own files. A value that is not a positive integer uses the
default. A semgrep part or a gitleaks scan with no result is a **missing part**: `baseline.json` and
every report list them under `incomplete`, and every layer that compares against an incomplete
baseline warns that old findings may show as new. To complete it, raise `semgrepTimeoutSec` or
lower `semgrepChunkFiles`, then run `scan.sh baseline <repo>` again.

Reports go to `.security/reports/<layer>-<time>.json` (30 kept per layer, gitignored); SBOMs to
`.security/sbom/`. Commit `config.json` and `baseline.json`. A repo without `config.json` (never
`init`ed) gets no files at all: the write-time hook only prints there.

## Speed (write-time)

A write-time scan loads per-language merged rule files (`rules.ts build`, run by
`update-rules.sh`), runs osemgrep in a warm `neo-sec-semgrep-<kit hash>` container, and runs gitleaks at
the same time in `neo-sec-gitleaks-<kit hash>` (one pair per kit copy). Both containers have no network, a read-only root and only the rules
mounted; the files to scan are streamed in and removed after. For `src/frontends/web.ts` the semgrep
CPU time fell from 37.2 s to 5.9 s. A run inside a container stops itself after 50 s (write-time) or 30 min (semgrep: per part, `semgrepTimeoutSec`), so a hook that times out
leaves nothing running. `docker rm -f` on them is always safe: the next scan starts them again.

## osv-scanner and Go call analysis (ADR-0066)

osv-scanner does Go call analysis only with a Go toolchain on `PATH`, so the push and nightly layers
run it in the pinned Go image (`GO_IMAGE` in `images.env`) through `osv-go.sh`. The osv-scanner
binary is downloaded once from `OSV_BIN_URL` into the `neo-sec-gocache` volume and checked against
`OSV_BIN_SHA256` before every run; `update-images.sh` takes both from the binary in `OSV_IMAGE` and
refuses a release file that differs. The volume also holds the Go module and build caches (the first
scan downloads them).

- **The repo is a copy-on-write overlay** at its own path: Go may write `go.sum` files, the writes go
  to the scan's temp folder, never to the repo, and paths and fingerprints stay the same.
- **Each module is analysed on its own** (`GOWORK=off`, `-mod=readonly`), as its own build sees it.
  `gomods.ts` links a local `replace` target that has no `go.mod` (a Docker mount placeholder such as
  eticket-v3's `services/*/common`) to the repo's module of that path, inside the overlay only.
- **A verdict counts only at the version osv reports.** `osv-go.sh` records the versions Go selected
  for each `go.mod` (`go list -m all`); the standard library never counts.
- **Limits:** `osvMemoryMb` (no swap; `GOMEMLIMIT` at 85% of it), `osvTimeoutSec`, and one Go
  analysis at a time on the host. Build tags for the analysis: `osvGoTags`.
- With no usable output the plain `OSV_IMAGE` scans read-only and the layer warns; a module whose
  analysis failed is named in a warning, and its findings keep full severity.
- An unreachable finding is never written into `baseline.json`'s fingerprints, so it shows as a new
  medium finding in each scan and blocks the day the code calls it.

`docker volume rm neo-sec-gocache` is always safe.

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
