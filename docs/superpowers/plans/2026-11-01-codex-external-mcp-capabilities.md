# Plan: scoped external MCP capabilities for Codex

1. Obtain the operator's scope and operation policy for every named server, and provision only
   authentication environment references plus a read-only eticket dev database role.
2. Add validated external-capability config and the pure resolver; write failing validation and
   scope-matrix tests first.
3. Wire the resolver through direct project, dispatch, resume and loop Codex launches; merge its
   native fragments with Neo bridges and the Git/Docker profile without loading ambient config.
4. Reuse `CODEBASE_MEMORY_BIN` with its read-only query manifest; update the dispatch preamble only
   after the registry proves it available to Codex.
5. Add per-turn registry diagnostics that record capability/server/tool names only, plus hermetic
   HTTP and stdio MCP tests for approval, auth-by-env and teardown.
6. Verify every enabled server from a dispatched-equivalent worker with `tools/list` and one harmless
   operation. For Postgres, prove SELECT works and DML fails in a disposable read-only database.
7. Run full checks, security review/scan, final planner and code review, then commit the isolated
   change. No messages, production data or database writes are part of verification.
