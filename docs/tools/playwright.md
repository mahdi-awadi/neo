---
id: playwright
kind: mcp
status: active
owner: neo
when: "Use to drive a web page step by step: open a URL, click, fill a form, read the page as text, take a screenshot. It attaches to the shared browser, so it also serves RTL and E2E checks."
scope: all
env: []
cost: "free (host)"
limits: "shares the 3 GB browser cap with every project; sessions are isolated"
dataLeavesHost: false
tags: [playwright, browser, click, form, screenshot, snapshot, e2e, web, navigate]
examples:
  - "open the dev site and fill in the login form"
  - "take a screenshot of the checkout page in Arabic"
  - "check the console for errors after clicking Save"
usage:
  tools: ["mcp__playwright__*"]
---
## How to call

The MCP server `playwright` runs `@playwright/mcp` against the shared browser (`--cdp-endpoint http://127.0.0.1:9222 --isolated`). Wire it with `bun tools/browser/install.ts --wire-mcp`.

- `browser_navigate`, then `browser_snapshot` to read the page; act with `browser_click`, `browser_type`, `browser_fill_form`.
- `browser_take_screenshot` for a picture; `browser_console_messages` and `browser_network_requests` for errors.
- Close the page when done.

## When NOT to use

- For performance traces or deep CSS inspection, use the `chrome-devtools` card.
- For a repeatable test suite, write a Playwright test and attach to the browser with `NEO_BROWSER_CDP` (see `shared-browser`).
- Do not enter real customer logins or production secrets into a page.
