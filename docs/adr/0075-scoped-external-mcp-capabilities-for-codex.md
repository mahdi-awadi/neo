# ADR-0075: Scoped external MCP capabilities for Codex

## Context

Codex workers currently disable every ambient MCP server. This prevents a global user configuration
from silently granting an unrelated project mail, database or application authority. The six
requested servers are ambient definitions, not Neo-owned plugins: four use streamable HTTP and two
use stdio. Some current definitions hold static authentication headers, which Neo must not copy into
worker configuration, argv or logs. Codex also has no equivalent of Neo's per-call `canUseTool`
governor.

## Decision

Neo will add a disabled-by-default **external MCP capability** descriptor. A descriptor contains an
exact project scope, safe transport configuration, authentication environment *names*, and a finite
MCP tool manifest. A pure resolver emits only descriptors matching an operator own-work Codex run;
customer, ingress, consult and unmatched-project runs receive none. Codex receives the native
server fragment and approvals only for the manifest entries. Ambient config stays ignored/disabled;
Neo never reads or copies its headers, arguments or credential values.

Codebase-memory will reuse Neo's existing binary setting and expose only its read/query tools.
Postgres requires an eticket-v3-only descriptor and a read-only database role before any automatic
query approval. Mail requires a separately declared read/draft/send policy; connection alone never
authorizes sending.

## Rejected alternatives

- Re-enable all ambient MCP servers: cross-project authority and hidden credentials.
- Copy the user Codex config: can copy static auth and defeats Neo's scoped boundary.
- Wildcard server tools or blanket approval: Codex cannot apply Neo's per-call governor.
- A generic MCP proxy: adds an authentication/protocol surface without defining safe operations.
- Give every project Postgres or codebase indexing access: violates project scope and engine-owned
  indexing.

## Consequences

No requested ambient server becomes available until its scope, credentials-by-reference and tool
manifest are declared. Unknown servers and manifests that drift fail closed with sanitized names.
Workers retain only needed environment variable names; secret values never enter config, events,
arguments or documentation.
