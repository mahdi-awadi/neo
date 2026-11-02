# Plan: Codex worker workspace grants

1. [x] Trace the Codex runner, worktree layout, native permission-profile behaviour and config
   plumbing; record ADR-0074 and this small capability seam.
2. [x] Add failing tests for Git metadata discovery, exact Unix-socket permission, SDK profile propagation,
   read-only behavior, and project-config opt-in mapping.
3. [x] Implement the workspace capability: resolve Git metadata through Git, generate a native exact
   permission profile for an opted-in DAC-accessible socket, keep read-only runs profile-free, and
   launch it from a daemon-private one-turn wrapper that ignores ambient profile overrides.
4. [x] Thread the per-project configuration through `profileDeps` into the Codex runner without
   affecting Claude or customer paths; document the explicit Docker security boundary.
5. [x] Add a disposable verification command that exercises normal Git index writing and optional
   Docker query through the same capability.
6. [x] Reproduce through the real SDK, correct CLI serialization and the Linux Docker networking
   behavior, run the disposable sandbox harness, focused tests and typecheck.
7. [x] Run the full suite and typecheck; run the repository security hook on commit, then restart
   the live service.
