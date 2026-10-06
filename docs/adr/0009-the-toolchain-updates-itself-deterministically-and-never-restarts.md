# The toolchain updates itself deterministically, and never restarts the daemon

**Status:** accepted (2026-10-04)

The operator's order (2026-10-04): "add auto update for neo that checks skills and MCP for updates
and updates them automatically; it should update the Claude SDK too." Two standing rules frame it:
keep the worker Agent SDK on the latest exact version, and never restart the daemon without the
operator's permission.

## Decision

1. **One engine module, three sources.** `src/engine/updater.ts` holds the orchestration (inventory,
   run, rollback, status). Each **category** has one source behind a small interface: `sdk`
   (the `@anthropic-ai/claude-agent-sdk` pin in this repo), `plugins` (Claude Code plugins, through
   the `claude plugin` CLI), `mcp` (MCP servers in `~/.claude.json`, project `.mcp.json` files and
   Neo's own: the `playwright-mcp` global, the `codebase-memory-mcp` binary, docker images). All
   process and network calls go through one injected `UpdateSys` port, so every rule is unit-tested.
2. **Deterministic, not a loop.** A loop's action is an AI worker; an update must not depend on one.
   The job is engine code scheduled by the loop runtime's own trigger (`isDue` with an `interval`
   trigger, `updates.everyMs`, default 24 h). The last run is read from the ledger, so a restart
   neither skips nor repeats a day.
3. **Per category.**
   - **sdk** — never touches the running install. It bumps the exact pin on a new branch in its own
     git worktree, runs `bunx tsc --noEmit` and `bun test`, and if both are green fast-forwards
     `master` (local, the repo convention) and records the model ids the new bundle names. Then it
     reports "SDK x→y ready, restart needed" and waits. A red run is not merged; its output is
     reported. A version that failed once is not retried until a newer one appears.
   - **plugins** — refreshes the marketplaces, then `claude plugin update <id>` for each enabled
     plugin. A changed version is verified (`claude plugin validate` + `claude plugin details`). If
     that fails, the plugin's entry in `installed_plugins.json` is restored to the old version, whose
     folder the CLI keeps.
   - **mcp** — only items with something to apply: the `playwright-mcp` global npm package, the
     `codebase-memory-mcp` binary (download, checksum, swap, keep a `.bak`) and untagged docker
     images (`docker pull`, the old image id kept for rollback). Each is verified by starting the
     server and listing its tools over MCP. Floating npx servers, remote HTTP servers and pins in
     another project's tracked `.mcp.json` are reported, not changed.
4. **Breaking changes are held.** Release notes are read where they exist (the SDK `CHANGELOG.md`,
   a plugin's `CHANGELOG.md`, GitHub release notes). A version whose notes say breaking, removed or
   migration is a **held update** when `updates.holdBreaking` is on (the default) and is applied
   only by `/updates apply <item>`.
5. **Never mid-task.** Plugin and MCP changes replace files a running session may still read. They
   are applied only when no session is running; otherwise the run defers them and the tick retries.
   The SDK bump is always safe (it only touches a branch).
6. **Recorded.** Every check, apply, rollback, hold, deferral and failure is a ledger event
   (`update_*`) with item, from, to and detail. `/updates`, `/updates run`, `/updates apply <item>`
   and `/updates rollback <item>` read and steer it.

## Considered options

- **A loop whose worker runs the update.** Rejected: it puts an AI between the engine and a change
  to its own toolchain, and a loop needs a worker run (and budget) for what is a fixed procedure.
- **Bump the SDK in the live checkout and restart.** Rejected: restarting is the operator's call.
  A worker reads the SDK at launch, so even a live `bun install` without a restart would mix two
  SDK versions across workers.
- **Apply breaking updates too and only flag them.** Rejected as the default: this is how
  Dependabot and Renovate treat majors, because a format change (codebase-memory v0.11.0 moves its
  index format) can break every running session. `updates.holdBreaking: false` turns it off.
- **Edit pinned versions in other projects' `.mcp.json`.** Rejected: those files are tracked in
  those projects; a change there belongs in that project's history, made by its own work.
- **Use `codebase-memory-mcp update`.** Rejected for now: its side effects on agent configs are not
  documented; a checksum-verified download of the configured asset is deterministic.
