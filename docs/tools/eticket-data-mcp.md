---
id: eticket-data-mcp
kind: mcp
status: active
owner: eticket-v3
when: "Use inside eticket-v3 to inspect its data stores and API: Postgres, MongoDB, Redis, ClickHouse, Temporal and the gRPC API. Dev data only; production is read-only elsewhere."
scope: [eticket-v3]
env: []
cost: "free (host)"
limits: "configured in the eticket-v3 MCP file, so only sessions in that folder get it; dev ClickHouse, not production"
dataLeavesHost: false
tags: [eticket, postgres, mongodb, redis, clickhouse, temporal, grpc, database, query]
examples:
  - "look up a booking row in the dev Postgres"
  - "check a Temporal workflow's state"
  - "query ClickHouse for yesterday's search counts"
usage:
  tools: ["mcp__postgres__*", "mcp__mongodb__*", "mcp__redis__*", "mcp__clickhouse__*", "mcp__temporal__*", "mcp__grpcmcp__*"]
---
## How to call

These MCP servers (`postgres`, `mongodb`, `redis`, `clickhouse`, `temporal`, `grpcmcp`) come from the eticket-v3 project's own MCP file, so they exist only in sessions started there. Prefer read queries and parameterized statements.

For production data use the read-only prod access documented in the eticket-v3 project, not these servers.

## When NOT to use

- Not for any project other than eticket-v3: the scope excludes it.
- Do not write to a shared store to "test" something; use a fixture or the sandbox flow.
- Never copy production or customer data to this host without the operator's approval.
