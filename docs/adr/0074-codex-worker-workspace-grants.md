# ADR-0074: Give Codex workers exact Git and Docker permissions

## Context

Codex `workspace-write` makes only its `workingDirectory` writable. A linked Git worktree has a
`.git` *file*, whose git-dir and common git-dir live outside that directory; normal Git index
transactions therefore fail creating `index.lock`. Docker's Unix socket is also outside the
workspace, so a worker cannot connect to it. Adding `/var/run` as an SDK `additionalDirectories`
grant would expose unrelated runtime files, and a home-grown HTTP relay would risk breaking Docker
streaming/hijacked connections. Granting Docker to every project would silently broaden authority.

## Decision

For every writable Codex turn, Neo resolves Git's own absolute `--git-dir` and
`--git-common-dir` for the order folder. It supplies those paths in a run-scoped native Codex
permission profile extending `:workspace`. Codex keeps `.git` metadata read-only even when it is
inside the working directory, so an ordinary checkout gets an exact `.git` rule too. Neo never
parses `.git` itself and never grants a parent project or work-root directory.

Docker is disabled unless that project explicitly configures `codexDockerSocket`. On Linux, testing
showed that the managed network proxy blocks direct Docker socket connections even with its socket
allowlist configured. The opt-in therefore enables direct networking for that worker, including
other host-reachable sockets and network endpoints; the socket rule is not an isolation boundary.
Docker's protocol remains intact, without granting a writable `/var/run` directory. Read-only Codex
runs receive no profile.
Neo also launches a profile-backed turn through `codex exec --ignore-user-config`, via a private
per-turn wrapper because the pinned SDK does not expose that flag. This prevents an ambient legacy
`sandbox_mode` setting from replacing the profile; auth remains available through `CODEX_HOME`.

This deliberately does not pretend that a Docker socket is low privilege: an opted-in project can
control the daemon according to its daemon policy and can reach other host-accessible sockets and
network endpoints. This authority is explicit per project and no worker receives a writable
`/var/run` or Docker by default. Operators
should prefer a rootless daemon or an authorization-proxy socket for projects that do not need full
daemon authority.

## Rejected alternatives

- Add `/var/run` directly: rejected because the SDK grants a directory, exposing unrelated host
  runtime files.
- Add the socket file directly: rejected because Codex's SDK/CLI accepts writable directories,
  not a supported file-level allowlist.
- Make the worktree's parent or main repository writable: rejected because Git requires only its
  resolved metadata directories and this would weaken ADR-0031's project boundary.
- Enable Docker for all Codex workers: rejected because Docker-daemon access is privileged and
  must be a project owner's deliberate workflow configuration.
- Build a custom Docker relay or command allowlist: rejected because Docker's API is broad and
  streaming/hijacked connections make a partial proxy unsafe. The project opt-in explicitly grants
  direct networking and daemon authority instead.

## Consequences

Linked worktrees can complete normal Git operations without a broad filesystem exemption. Docker
development workflows work only after a config edit and only through one exact socket rule. A bad
or inaccessible configured socket fails that worker start closed rather than falling back to host
access. The diagnostic harness creates a disposable linked worktree, performs a normal Git index
write, and, when supplied a socket, queries Docker under the same native permission profile.
