# MCP secrets reach workers through the env, never through argv

**Status:** accepted (2026-10-29; built on dev, restart-gated). Related: ADR-0050 §7 (worker env scrub),
ADR-0024 (security kit). Source: ops note #478, host resource audit 2026-10-29.

## Context

The Agent SDK writes every external MCP server config of a run into the spawned CLI's command line,
`--mcp-config <JSON>`. The engine's Stitch server config held the Google API key in its `X-Goog-Api-Key`
header, so every operator worker's command line carried the key. A command line is readable by any process
on the host (`/proc/<pid>/cmdline` is world-readable; `ps`; netdata's processes view, which the audit found
reachable without auth from the host's own Traefik).

## Decision

1. **A reference in the config, the value in the env.** The Stitch header is `${STITCH_API_KEY}`. Checked
   against the real Claude CLI binary (2026-10-29): it expands `${NAME}` in `--mcp-config` headers from its
   own env. `/proc/<pid>/environ` is readable by the owner only.
2. **The scrub keeps what the run's servers name.** `runConfig` collects the `${NAME}` references of the
   run's external MCP configs (`mcpEnvRefs`) and keeps those names through the worker-env scrub, also in
   `strip` mode — a server cannot work without the key it names. Relay keys (ADR-0050 §7) are removed first
   and are never kept.
3. **A test spawns the SDK against a fake executable** that records its argv and env: the argv never holds
   the key; the env does.

## Alternatives rejected

- **A 0600 temp file passed as `--mcp-config <path>`.** The SDK builds that flag itself from `mcpServers`;
  a second flag through `extraArgs` relies on how the CLI merges repeated flags, and the file must be cleaned
  up on every exit path. The env reference needs neither.
- **Drop Stitch from workers.** Removes a tool the operator uses; the leak is in how it is passed.

## Consequences

- The key that was exposed must be rotated (an operator step); the value is never printed.
- Restart-gated: running workers keep their old command lines until they end.
