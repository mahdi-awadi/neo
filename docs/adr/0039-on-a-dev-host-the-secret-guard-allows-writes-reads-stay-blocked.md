# On a dev host the secret guard allows writes; reads stay blocked

**Status:** accepted (2026-10-16) · amends ADR-0024 and ADR-0030 (the guard hook).

The guard (`tools/security/guard.ts`) blocked a Neo worker from every Write, `cat >> .env`,
`sed -i` and `cp … .env` on a secret file. The operator has no terminal. When they paste a dev key in
chat, no agent could put it into a project's dev `.env`. On 2026-10-15 this blocked contantme's R2
keys. The operator's order: "remove this rule for dev in hooks, since that rule is for production".

## Decision

1. **The host has an environment.** The installed kit holds `host.json` next to `guard.ts`:
   `{ "hostEnv": "dev" | "prod" }`. `bun tools/security/install.ts --host-env dev` writes it. A
   re-install without the flag keeps the file. A missing file, bad JSON or any other value means
   `prod` (fail closed). The name is `host.json`, not `config.json`, because `.security/config.json`
   is already the per-project settings file.
2. **On a `prod` host nothing changes.**
3. **On a `dev` host a WRITE to a secret file is allowed:**
   - the Write tool (it creates or replaces a file and echoes nothing back);
   - output redirections: `>`, `>>`, `&>`, `2>` (`printf 'K=V\n' >> .env`, `cat >> .env <<'EOF'`);
   - `sed -i` / `--in-place` in one strict shape only: each program is an optional address then
     `d` or a single `s///` with flags `g`, `I` or a number, and the only other options are
     `-E`/`-r`. Anything else (`w`, `e`, `r`, `p`, `;`, `--debug`, `-f`, `-n`) still counts as a
     read, because it can copy, run or print lines;
   - the destination of `cp` (`cp .env.example .env`). The source is still checked. With
     `-t`/`--target-directory` every word counts, because the last word is then a source.
   - `chmod 600 .env` was never blocked.
4. **Reads stay blocked on every host:** Read, Grep, `cat`, `grep`, `head`, `sed` without `-i`,
   input redirections, `cp .env …`, `tee` (it echoes what it writes) and the rest of ADR-0030.
   The Edit, MultiEdit and NotebookEdit tools stay blocked too. Claude Code requires a Read before
   an edit, and the tool result shows the lines around the change, which are other secrets.

## Considered options

- **Turn the guard off on a dev host** (the operator's literal words). Rejected. The host is
  public, and a dev key still opens real third-party accounts (R2, Meta, SMS). The need is to
  put a supplied value into a file. Reading secrets back into agent context, logs and the ledger
  is never needed. Writes-only gives the operator everything they asked for and keeps the one
  rule that protects them.
- **An environment variable on the daemon** (`NEO_HOST_ENV`). Rejected. The hook also runs in the
  operator's own sessions, which do not get the daemon's environment. The installed kit is the
  one place every session on the host reads.
- **Default `dev` when the file is missing.** Rejected. A kit copied to a production server would
  start with writes open. A missing value must fail closed.
- **Allow Edit too.** Rejected. See 4: Edit cannot work without a Read, and its result shows file
  content.

## Consequences

- A worker on this host can write an operator-supplied dev key into a project's `.env` (then
  `chmod 600`, and the file is gitignored). It still cannot read it back.
- The value is in the tool call's input, so it is in the transcript and the ledger. The operator
  already put it in chat, so this adds no new exposure. The rule "never print a secret into a reply
  or a log" stays.
- The guard is one layer, not a sandbox (ADR-0030 residuals stand). Code review found five ways
  a read could pass as a write: a `>` inside quotes, `sed -i` with `w`, `--debug` or `-f`, and
  `cp -t`. They are closed and tested. Redirections are stripped only outside quotes.
- Known limit, as on prod: a `|` inside quotes splits a pipeline, so `sed -i 's|a|b|' .env` is
  still blocked. Use another delimiter (`s#a#b#`).
- The hook reads `host.json` on every call, so no daemon restart is needed.
- The live install found an older bug. Bun's `cpSync` with a `filter` did not overwrite existing
  files, so a re-install never updated `guard.ts`, and ADR-0030 had never gone live. The
  installer now passes `force: true`. This install puts ADR-0030 and ADR-0039 live together.
