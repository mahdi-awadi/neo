---
id: prod-readonly-query
kind: recipe
status: active
owner: neo
when: "Use in eticket-v3 when a question needs production data: find the query in the code, try it on dev data, then ask the read-only production project to run it. Never query or change production from here."
scope: [eticket-v3]
env: []
cost: "free (host)"
limits: "read-only; production is reached only through the read-only production project"
dataLeavesHost: false
tags: [production, prod, query, read-only, readonly, data, database, sql, investigate, diagnose]
examples:
  - "query production data read-only"
  - "how many bookings failed in production yesterday"
  - "check a production order's payment state"
  - "diagnose a production booking error"
steps:
  - card: codebase-memory
    do: "find the tables and the code path that hold the data the question needs"
  - card: eticket-data-mcp
    do: "write the query and check it on dev data first (dev only)"
  - card: project-notes
    do: "send the checked query to the read-only production project as a request, with the question it answers"
---
## How to call

1. Write one bounded, read-only query (`SELECT … LIMIT n`). No DDL, no writes, no locks.
2. Check it on dev data with the data MCP, then send it with `project_notes send` (kind `request`) to the
   read-only production project. Its rules forbid changes to production.
3. Treat what comes back as customer data: do not copy it into commits, logs or docs.

## When NOT to use

- Never to change production data or schema: that is the operator's decision, through a release.
- Not for dev data alone: use the data MCP directly.
