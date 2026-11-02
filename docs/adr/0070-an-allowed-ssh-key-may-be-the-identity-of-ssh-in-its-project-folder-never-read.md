# An allowed SSH key may be the identity of ssh in its project folder; it is never read

**Status:** accepted (2026-10-30, built on dev). Amends ADR-0030 (the guard reads files, not text) and
reach plan P0.3 (every private key in a `.ssh` folder is a secret). Related: ADR-0039 (`host.json`).
Asked by prod-ops (project note #570); the operator decided "Allow prod-ops to use the key" (#74622e42).

## Context

The PreToolUse guard (`tools/security/guard.ts`) counts every non-public file in a `.ssh` folder as a
secret. Any Bash command that names one is blocked for a worker, `ssh -i <key> host` included, because
`ssh` is not a listing command, so its `-i` value is checked like a file it reads. prod-ops must reach
the prod host with `/root/.ssh/prod_server_key` for two operator orders (the Asfoor copy and #557).

`ssh -i` does not put the key's content in the agent's context: ssh reads it and prints nothing of it.
The risk is any other path that reads it: `cat`, `cp`, `base64`, a `scp` source, the Read tool, or an
ssh option that runs a local command (`ProxyCommand`, `LocalCommand`, `KnownHostsCommand`, `Match exec`)
or loads a config file (`-F`) that could hold one.

## Decision

1. **A host-local allow-list.** `ssh-identities.json` next to the installed guard:
   `{ "allow": [{ "key": "/root/.ssh/prod_server_key", "cwd": "/home/prod-ops" }] }`. Only entries with
   absolute paths count, and never `/` as the folder. A missing, unreadable or malformed file gives no
   exception (fail closed). The hook reads it on every call, so a change needs no restart. The installer
   never copies it from the source and never overwrites it (like `host.json`).
2. **What it allows.** In a Bash call whose SESSION folder (the hook's `cwd`) is the entry's folder or
   inside it, the entry's key may be the identity of `ssh` or `scp`: `-i <key>`, `-i<key>`,
   `-o IdentityFile=<key>` or `-o "IdentityFile <key>"`. Only that one argument is dropped from the
   check; the rest of the command is checked as before.
3. **What it does not allow.** Any other naming of the key is still a read: another command, a `scp`
   source, an input redirection, `rsync -e "ssh -i …"`, `ssh-keygen`, `ssh-add`, the Read/Grep tools.
   The options are an ALLOW-list, parsed the way ssh/scp's getopt reads them (grouped flags, ssh's
   second option pass right after the host, `--`): ssh `-4 -6 -C -N -T -n -q -t -v -i -l -o -p`, scp
   `-4 -6 -C -T -p -q -r -v -i -l -P -o`, and `-o` only with IdentityFile, IdentitiesOnly, BatchMode,
   ConnectTimeout, ConnectionAttempts, StrictHostKeyChecking, ServerAliveInterval, ServerAliveCountMax,
   LogLevel, Port, User or Compression. Any other option (`-F`, `-A`, `-L`, `-E`, `-J`, scp `-S`,
   ProxyCommand, LocalCommand, …) gives no exception. A block-list was the first draft; the review
   pointed out that ssh has more options and spellings than any block-list would track.
3. **What it does not allow.** Any other naming of the key is still a read: another command, a `scp`
   source, an input redirection, `rsync -e "ssh -i …"`, `ssh-keygen`, `ssh-add`, the Read/Grep tools.
   A command with a substitution (`$(…)`, backticks, `<(…)`) anywhere gets no exception, even inside
   single quotes that only run on the remote host: the guard has no shell parser, and stripping quotes
   by regex could open a hole. `sftp` is left out: it runs local `!commands` from a batch file.
4. **No new secret handling.** The guard still never reads the key file; it only compares paths.
5. **The folder is the hook's `cwd`.** Claude Code resets a session's shell to its project folder after
   any `cd` outside its working folders (seen on this host on 2026-10-30), so another project's session
   cannot hold `/home/prod-ops` as its `cwd`. A per-session engine value would be stronger, but it needs
   an engine change and a restart; that can come later without changing this file's format.

## Rejected alternatives

- **Allow the key everywhere** (drop it from the `.ssh` rule): every project could `cat` it.
- **A cwd-free allow-list** (any folder may use the key as identity): wider than the operator's decision.
- **Put the list in `host.json`:** `install.ts --host-env` rewrites that file whole, so the list would be
  lost on the next `--host-env` install.
- **An ssh-agent loaded by the operator:** works without a guard change, but it lasts only until a
  reboot or agent restart and gives every project on the host the identity.
- **A wrapper script** (`prod-ssh`) that holds the key path: hides the path from the guard, so it is a
  bypass by name, and any project could call it.

## Consequences

- prod-ops can run `ssh -i /root/.ssh/prod_server_key deploy@<prod> …` and `scp -i …`. The guard still
  blocks every direct read of the key it can see in the command text.
- A remote command that uses `$(…)` must be sent another way (for example a script copied with `scp`,
  then run), because the exception never applies to a command with a substitution.
- The guard is a best-effort check on command text, not a sandbox (ADR-0030): a key path built at run
  time (`$(…)`, a variable other than `$HOME`) was not caught before and is not caught now. ssh still
  reads `~/.ssh/config`; a `LocalCommand` placed there is outside what the guard checks.
- Adding another key or project is a one-line edit of the host's `ssh-identities.json` by the operator.
