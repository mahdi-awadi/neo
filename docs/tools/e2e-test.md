---
id: e2e-test
kind: recipe
status: active
owner: neo
when: "Use to run or write end-to-end tests in a real browser: attach the project's suite to the shared browser, check RTL pages and their numbers, and debug a failing step with DevTools."
scope: all
env: []
cost: "free (host)"
limits: "the shared browser's limits apply (4 browsers at once, shared RAM cap)"
dataLeavesHost: false
tags: [e2e, end-to-end, test, browser, playwright, rtl, ui, flow, regression]
examples:
  - "run the end to end tests in a real browser"
  - "write an E2E test for the login flow"
  - "check the Arabic page keeps phone numbers left-to-right"
  - "debug why the checkout E2E step fails"
steps:
  - card: shared-browser
    do: "start or check the shared browser; point the suite at it with NEO_BROWSER_CDP"
  - card: playwright
    do: "run the project's E2E suite, or drive the flow step by step to write a new test"
  - card: chrome-devtools
    do: "for a failing step, read console errors, network requests and computed CSS"
---
## How to call

1. Run the project's own E2E command (see its README or test docs) with `NEO_BROWSER_CDP` set, so the
   suite attaches to the shared browser instead of launching its own.
2. For an Arabic or Kurdish page, check every number stays left-to-right: phone fields, prices, dates and
   codes. Take a screenshot of each RTL page you check.
3. When a step fails, follow the DevTools step before you change the test. Fix the code, not the assertion.

## When NOT to use

- Not for unit tests or API-only tests: run those with the project's test runner.
- Do not run E2E tests against production data.
