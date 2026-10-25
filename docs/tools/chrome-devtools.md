---
id: chrome-devtools
kind: mcp
status: active
owner: neo
when: "Use when a page needs DevTools-level inspection: performance traces, Lighthouse audits, network request detail, console errors, computed CSS or a heap snapshot, on the shared browser."
scope: all
env: []
cost: "free (host)"
limits: "shares the 3 GB browser cap with every project"
dataLeavesHost: false
tags: [devtools, chrome, performance, lighthouse, network, console, css, heap, trace]
examples:
  - "run a Lighthouse audit on the home page"
  - "why is this page slow, record a performance trace"
  - "list the failed network requests on the booking page"
usage:
  tools: ["mcp__chrome__*"]
---
## How to call

The MCP server `chrome` is `chrome-devtools-mcp --browserUrl http://127.0.0.1:9222`, the shared browser. Wire it with `bun tools/browser/install.ts --wire-mcp`.

- `new_page` or `navigate_page`, then `take_snapshot` to read the page.
- `performance_start_trace` and `performance_stop_trace`, then `performance_analyze_insight`.
- `lighthouse_audit`, `list_network_requests`, `list_console_messages`, `get_css_styles`, `take_heapsnapshot`.

## When NOT to use

- For plain clicking, form filling and screenshots, the `playwright` card is simpler.
- Do not leave pages open; the browser cap is shared.
- Do not run audits against production pages without the operator's approval.
