# The secret guard judges reads, not text

**Status:** accepted (2026-10-10) · amends ADR-0024 (the guard hook).

The guard (`tools/security/guard.ts`) blocked a worker's Bash call whenever any path-like word ended
in `.key`, `.pem` and the like. On 2026-10-10 it blocked `e.key` (a keyboard event in JavaScript),
which forced a product rename to `resultsKey`. It also blocked a git command that only listed files.
It blocked this session too, on a test file's text. Workers began to hide such commands in script
files to get past it.

## Decision

The guard asks one question: does this call **read** a secret file?

1. **Code, regexes and patterns are text.**
   - A word with code or regex characters is not a path: whitespace, quotes, parens, brackets,
     braces, `<>|;&!`, a backtick or a backslash.
   - The program argument is skipped for grep, egrep, fgrep, rg, ag and ack (the pattern), for sed,
     awk and jq (the script), for `node`, `bun`, `python` and other interpreters after
     `-e`/`-c`/`--eval`, and for `git log -S/-G/--grep`.
   - `grep -f FILE` and `rg -g GLOB` / `--include=GLOB` name files that the tool reads, so those
     values are checked.
2. **Listing names is not reading.**
   - Commands that only list, stat or move names are allowed: ls, stat, find without `-exec`/`-ok`,
     and git ls-files, status, check-ignore, add, rm and mv.
   - The Glob tool is allowed, because it returns names only.
   - Commands that do read content still count: git show, diff, blame and `log -p`.
3. **A bare key-file name must exist.** A word like `server.key` (no folder, no glob, no variable)
   counts only when that file exists in the call's working directory. Claude Code sends that
   directory in the hook payload. A path (`certs/server.pem`, `/etc/ssl/private/x.key`), a glob
   (`*.key`), `$HOME/...`/`~/...` and `HEAD:path` always count.
4. **Strong names count anywhere.** These count wherever they appear, and nothing changes for
   them: `.env*` (templates excepted), SSH keys (`id_rsa` …), credential stores and
   `.docker/config.json`.

## Considered options

- **Keep name-only matching, and add an allowlist of known words** (`e.key`, `event.key`).
  Rejected. The list never ends, and every miss forces a rename in a product.
- **Block only a list of reading commands** (cat, less, cp …). Rejected. Any program can read a
  file (`openssl rsa -in`, `base64 <`). The guard keeps "check every path argument" and removes
  only what cannot be a read.
- **Check that the file exists for every name.** Rejected for strong names. `cat .env` must stay
  blocked in a folder where `.env` will exist later, and the existing tests expect that.

## Consequences

- New tests cover the reported false positives, and every earlier true positive still passes.
- `git add server.key` is no longer blocked: it does not read the file. The commit and push scans
  (gitleaks) catch a committed secret.
- After code review the guard also: follows `cd`/`pushd` for the existence check; treats a pipe into `xargs`/`while read` as a read of the names listed before it; always checks input redirections (`< file cmd`); counts a bare key name given to a known reader (cat, head, less, openssl, cp, …) whether or not it exists; judges quoted paths with spaces; reads `dd if=` and curl `@file`.
- Known residuals, as before this change: a read hidden in code (`node -e "readFileSync(…)"`, `bash -c`), command substitution (`$(<file)`) and shell escapes or globs that disguise a name (`.e*`). The guard is one layer; the commit/push secret scans are another.
- The live hook is the copy in `~/.claude/security/`. It changes after a merge and a re-run of
  `bun tools/security/install.ts`.
