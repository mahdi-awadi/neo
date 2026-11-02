# ADR-0078: Codex read-only side lanes

## Context

The per-project queue and independent project dispatch are SDK-neutral. ADR-0057 side lanes were
restricted to Claude because they rely on a per-command governor, which the Codex SDK does not
expose. Always putting a safe status inspection in the main queue can make it wait behind a long
build even though a read-only sandbox can isolate it.

## Decision

Permit `read-only` Codex side lanes. The queue retains side-slot, host and budget caps; a Codex
read-only side lane is a separate session beside the main work and is never resumed as the main
session. The runner forces Codex's read-only sandbox, no network, no web search and no permission
escalation, regardless of conflicting run options. It discards writable workspace and planner
config. MCP servers, plugins, hooks and subagents are disabled for this lane: MCP handlers run
outside the sandbox and even memory search can initialize a project index. The normal queue and provider switch continue to own lifecycle,
retries and results. The company tool descriptions explain Codex's narrower side-lane support.

Codex `ops`, `test` and `code` side lanes remain in the main queue: sandboxing alone cannot implement
their command-specific service, Docker or Git restrictions. A runner-level check refuses such a lane
if the selected provider switches to Codex after the queue has admitted it.

## Verification and limits

A real Codex SDK side run could read a disposable project file but could not write one, even when
conflicting run options requested broader access. The host harness exercises a real Codex Linux
sandbox against successful host baselines: project writes, Unix and TCP connections, and signals to
an owned host process are blocked. Queue tests cover main ordering, different projects, side slot
caps and switching providers. These checks establish the observed target-host sandbox behavior;
they do not provide Claude's per-tool governor or enable external MCP services.
