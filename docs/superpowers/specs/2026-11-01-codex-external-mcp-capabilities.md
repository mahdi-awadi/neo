# Codex external MCP capabilities — specification

## Seam

`resolveCodexExternalMcpCapabilities(config, context)` is a pure, testable resolver. It accepts a
Codex own-work launch context (project identity, path, work class and profile) and returns native
Codex server fragments, exact approved tool names and required environment-variable names.

## Acceptance criteria

 - [x] The default grants no ambient MCP server to a Codex worker. Verified by
   `tests/codex-mcp-bridge.test.ts` and `tests/codex-workspace.test.ts`: ambient definitions are
   explicitly disabled, and profile-backed turns launch with `--ignore-user-config`.
 - [ ] A matching named project gets only its declared server and only manifest-listed tools.
 - [ ] Customer, ingress, consult, background and nonmatching-project contexts fail closed unless an
   explicit descriptor permits them.
 - [ ] Authentication appears only as declared environment-variable names; values never occur in
   generated config, CLI arguments, events or diagnostics.
 - [ ] Existing Neo SDK bridges and the Git/Docker permission profile continue to work on every Codex
   turn; unrelated ambient servers remain disabled.
 - [ ] Codebase-memory keeps indexing engine-owned and excludes all mutating/index-management tools.
 - [ ] Postgres auto-approval requires an eticket-v3-scoped read-only connection and a read-query-only
   manifest. Mail sending requires an explicit send policy, not merely a working connection.
 - [ ] A dispatched-equivalent registry test proves availability for every configured named capability;
   a connection/tool inventory smoke proves each enabled manifest against a harmless operation.

## Edge cases

- Case-colliding or duplicate server names, unsafe transport URLs/paths, credentials in URLs,
  missing/unsafe environment names, empty manifests and unknown tools are rejected.
- A server disappearing, changing its tools, failing auth, or losing its executable is a sanitized
  unavailable result, never a fallback to ambient config.
- Live follow-ups regenerate the exact capability set; a config change applies only to a new turn.
- A linked worktree still selects its project by Neo's explicit session identity, never a path
  prefix.

## Current prerequisites

| Server | Unmet prerequisite |
| --- | --- |
| `agent-native-analytics-local` | Project scope, safe auth-env reference and read-only tool inventory. |
| `agent-native-mail` | Project scope and explicit read/draft/send policy with a tool manifest. |
| `agent-native-my-app` | Project scope, auth-env/OAuth reference and tool inventory. |
| `plan` | Project scope, auth-env/OAuth reference and tool inventory; it is not Neo's plan registry. |
| `codebase-memory` | Native descriptor reusing `CODEBASE_MEMORY_BIN` and read-only manifest. |
| `postgres_eticket_dev` | eticket-v3 scope, read-only dev principal and read-query-only manifest. |
