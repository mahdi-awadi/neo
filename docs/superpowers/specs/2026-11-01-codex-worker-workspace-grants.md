# Codex worker workspace grants — specification

## Domain terms

- **Codex turn**: one Codex SDK CLI process, including each live-session follow-up.
- **Git metadata grant**: the resolved external git-dir and common git-dir a worktree needs for
  normal index/ref/object operations.
- **Docker socket grant**: one canonical project-configured Unix socket used by the Docker client.
  On Linux this opts the worker into direct networking, including other reachable sockets; it is
  not a writable grant to the host runtime directory.
- **Project workflow opt-in**: `projects.<name>.codexDockerSocket`, absent by default.

## Seam

`prepareCodexWorkspace(folder, dockerSocket?)` returns a small workspace capability: native Codex
permission-profile overrides with exact Git metadata and optional Unix-socket rules.
`session-runner` is its only consumer and selects that profile instead of broad workspace-write.

## Acceptance criteria

1. [x] A writable Codex run grants only resolved Git metadata directories. An ordinary checkout gets
   its `.git` directory explicitly because Codex makes Git metadata read-only by default.
2. [x] A linked worktree receives both its worktree git-dir and shared common git-dir, allowing a
   normal Git index write without allowing the repository's working tree or another project.
3. [x] Docker is absent by default. A configured socket enables direct networking for that worker;
   this permits other reachable sockets, but does not make `/var/run` a writable directory.
4. [x] Each live-session turn gets its own generated profile. Read-only Codex runs receive no profile
   and no Docker socket rule.
5. [x] A profile-backed turn ignores ambient Codex user configuration, so a legacy global
   `sandbox_mode` cannot silently replace the exact profile.
6. [x] Invalid, inaccessible or non-socket configured paths fail closed before worker launch; no
   direct-socket fallback exists.
7. [x] Project config parsing accepts nonblank socket paths only; launch paths select the option by
   their named project identity, not a folder-prefix mapping,
   without embedding a machine path in source.
8. [x] Unit coverage proves profile selection and linked-worktree metadata discovery. On the target
   host the disposable worktree harness completed a Git commit and Docker server query. A real SDK
   turn also staged a file, queried Docker, and retrieved a public GitHub remote HEAD.

## Edge cases

- Git command failure or malformed/non-absolute output: do not add an external directory.
- Symlinked paths: canonicalize paths before comparison/deduplication.
- `git-dir` equal to `git-common-dir`, directory already inside the folder, and duplicate paths:
  grant once or not at all as appropriate.
- A live Codex session starts a new CLI process per follow-up: each turn receives a newly generated
  profile; its resumed thread ID remains unchanged.
- Environment scrub still applies; profile values are SDK configuration, not worker environment.
- The transient launcher lives in a daemon-private directory outside the worker's workspace and
  system-temp grants; it is removed after its one CLI process exits.
