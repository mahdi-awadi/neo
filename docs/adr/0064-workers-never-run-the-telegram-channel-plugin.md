# Workers never run the Telegram channel plugin

**Status:** accepted (2026-10-29; built on dev, restart-gated). Related: ADR-0062 (worker command line),
`docs/sdk-notes.md` (`settingSources`).

## Context

The daemon polls its Telegram bot with grammy. Every worker runs with `settingSources: ["user", "project"]`
so it gets the operator's user plugins and skills. The user plugins include the official Telegram channel
plugin (`telegram@claude-plugins-official`). In a worker, that plugin starts its own `bun` poller (a child
of the worker's CLI) and long-polls `getUpdates` on the same bot. Telegram allows one poller per bot, so the
daemon's poller fails with `409: Conflict: terminated by other getUpdates request` (`engine_fault
telegram.polling`). Seen with `ps` on 2026-10-29: worker pid 905197 had the plugin's poller as a child.

## Decision

1. **The flag-settings layer turns the plugin off for every worker.** `sdkOptions` (the one options
   builder for single-shot and long-running runs, so for the company session, dispatch, side lanes, loops
   and consult) sends `settings: { enabledPlugins: { "telegram@claude-plugins-official": false } }`
   (`WORKER_SETTINGS`). The SDK loads `settings` as the flag layer, which outranks user and project
   settings, so this entry wins over the user `true`. Every other user plugin and skill stays on.
2. **It sits with the governance fields**, after the per-run fields, so no run can drop it.
3. **Checked on the real CLI** (SDK 0.3.310, 2026-10-29): without the setting, the init message lists the
   `telegram` plugin and its `plugin:telegram:telegram` MCP server; with it, neither is listed and the other
   nine user plugins are.

## Alternatives rejected

- **Turn the plugin off in `~/.claude/settings.json`.** It also removes it from the operator's own
  interactive sessions, where it is wanted; and the engine must not depend on a host file it does not own.
- **Drop `settingSources: "user"`.** Workers lose superpowers and the other plugin skills.
- **Kill the plugin's poller after spawn.** A race and a symptom fix; the poller still starts.
- **A config knob for the plugin list.** The id names one fixed plugin that conflicts with the daemon by
  design; it is an engine invariant like `WORKER_ENV`, not a deployment value.

## Consequences

- Restart-gated: running workers keep their pollers until they end; new workers after the restart have none.
- A different Telegram channel plugin (other id) would need its id added to `WORKER_SETTINGS`.
