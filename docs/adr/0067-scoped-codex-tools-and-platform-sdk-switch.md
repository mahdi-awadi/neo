# ADR-0067: Scope Codex tools and persist the operator SDK switch

## Decision

The operator SDK selection is persisted in the ledger and shared by console and `/sdk`. New operator work uses that SDK. Running sessions drain accepted inputs and close gracefully; subsequent input starts under the latest selected provider without reusing a foreign thread ID. Untagged legacy IDs start fresh on Codex, whose missing-thread recovery is not yet available; Claude retains its existing retry behavior. Long-running loops resolve their provider and judge on each iteration. The console indicates sessions that have not switched.

Neo attaches its own run-specific MCP server instances to Codex using the MCP SDK's loopback HTTP transport, with a random per-server bearer capability passed in the worker environment. Only the exact tools created for that run are approved. A live Codex worker creates a fresh bridge for each turn because the SDK starts a new CLI process and MCP session on every follow-up; it resumes the same Codex thread. Each bridge closes at the end of its turn, including startup failures. Its HTTP idle timeout is disabled so a long-running tool or quiet event stream is not cut off ([Bun server documentation](https://bun.com/docs/runtime/http/server#idletimeout)). Before launching the real Codex executable, Neo enumerates its effective configured MCP servers and disables unrelated servers. Discovery or unsafe names fail closed; unrelated external servers are reported as unavailable. Neo does not place capability values in arguments.

Codex has no Claude `canUseTool` hook, and sandbox/approval behavior is not equivalent to Neo's Claude governor. In particular, side lanes remain unavailable on Codex. The tool-free todo summarizer uses its deterministic fallback on Codex because a zero-tool Codex run is not established. Customer-tainted inbox drafting fails closed with an explanation and leaves the inbox item unchanged; it never silently falls back to Claude. Customer-direct routing remains separate.

## Consequences

An SDK switch no longer silently leaves a running session on its old provider indefinitely; a session unable to close remains visible as blocked. The selection survives restart independently of the configured default. Codex can call the existing company dispatch and project tools without reimplementing their handlers. External MCP services, including globally configured ones, are unavailable to Codex workers until a separate governed integration exists. Codex model access still depends on the account; `NEO_CODEX_MODEL` supplies an explicit default when required.

## Evidence

The installed Codex SDK and MCP SDK completed authenticated local tool discovery and calls. A real Codex company run dispatched a Codex project worker in a disposable directory and received its result. Automated tests cover authentication, cross-run tokens, teardown, selection persistence, switching and provider-specific resume. A live UI verification against the deployed build remains required.
