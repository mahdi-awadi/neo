---
id: shared-browser
kind: cli
status: active
owner: neo
when: "Use when a worker or test suite needs a real browser: screenshots, E2E checks, RTL checks of a page. One memory-capped Chromium on 127.0.0.1:9222 serves every project."
scope: all
env: []
cost: "free (host)"
limits: "3 GB RAM for the whole service, 4 browsers at once, 20 queued, idle sessions close after 10 minutes"
dataLeavesHost: false
tags: [browser, screenshot, e2e, playwright, chromium, cdp, rtl, test]
examples:
  - "take a screenshot of the RTL login page"
  - "run the Playwright E2E suite against the dev site"
  - "check that a page renders numbers left-to-right in Arabic"
usage:
  commands: ["*tools/browser/*", "*neo-browser*", "*:9222*"]
---
## How to call

The service speaks CDP on `http://127.0.0.1:9222` (loopback only). Each connection gets its own browser.

- Start or check it: `bun tools/browser/install.ts` (in the Neo folder). Stop it: `--down`.
- From a Playwright test suite, attach when `NEO_BROWSER_CDP` is set (for example `http://127.0.0.1:9222`) and launch your own browser otherwise.
- The `playwright` and `chrome-devtools` MCP cards use this same browser.
- Memory against the cap: `docker stats neo-browser --no-stream`.

Reference: `docs/browser.md` (ADR-0032).

## When NOT to use

- Do not start a second Chromium for a one-off check; attach to this one.
- Do not leave pages open: idle sessions close after the timeout, and the cap is shared by all projects.
- It is a dev tool on a public host: never expose port 9222 outside loopback.
