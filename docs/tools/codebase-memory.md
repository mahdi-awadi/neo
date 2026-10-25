---
id: codebase-memory
kind: mcp
status: active
owner: neo
when: "Use to understand an unfamiliar codebase fast: search symbols, trace callers, read an architecture summary or a code snippet from the code graph, instead of grepping many files."
scope: all
env: []
cost: "free (host)"
limits: "Neo indexes the folder before each dispatch; workers must not run index_repository themselves"
dataLeavesHost: false
tags: [code, graph, search, symbols, callers, architecture, index, refactor, impact]
examples:
  - "who calls this function and what breaks if I change it"
  - "give me the architecture of this repo"
  - "find where the order status is set"
usage:
  tools: ["mcp__codebase-memory__*"]
---
## How to call

The MCP server `codebase-memory` is given to Claude sessions. Useful tools: `search_graph`, `search_code`, `get_architecture`, `get_code_snippet`, `trace_path`, `query_graph`, `detect_changes`.

- Start with `get_architecture` or `search_graph`, then read the exact snippet with `get_code_snippet`.
- Use `detect_changes` before a refactor to see what the diff touches.
- The index is refreshed by the engine before each dispatch. Take the project name from `list_projects` only if a tool asks for it.

## When NOT to use

- Do not call `index_repository` or `delete_project`; the engine owns the index.
- For a single known file, a plain read is cheaper.
- The graph can lag behind uncommitted edits; read the file when exactness matters.
