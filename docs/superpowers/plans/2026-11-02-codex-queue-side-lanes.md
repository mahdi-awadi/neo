# Codex queue and side lanes

- [x] Audit queue scheduling, per-project dispatch, SDK switching and lane safety constraints.
- [x] Verify native read-only sandbox access against a disposable project, network sockets and an owned process.
- [x] Add failing tests for Codex side dispatch, queue ordering, slot release, provider changes, runner restrictions and MCP isolation.
- [x] Enable only sandbox-enforceable Codex read-only side lanes; keep other kinds in the main queue.
- [x] Update the company tool descriptions so the model knows which lanes Codex supports.
- [x] Run targeted tests, typecheck, the full suite and a real queue-to-SDK side-lane check.
- [ ] Run the security hook, commit and restart.
