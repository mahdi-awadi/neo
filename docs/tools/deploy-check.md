---
id: deploy-check
kind: recipe
status: active
owner: neo
when: "Use after a deploy, or when a site may be down, to check the deploy is healthy: the health endpoint, the key pages in a real browser, console and network errors, then report what is broken."
scope: all
env: []
cost: "free (host)"
limits: "read-only checks; the shared browser's limits apply"
dataLeavesHost: false
tags: [deploy, healthy, health, check, smoke, verify, release, down, uptime, status]
examples:
  - "check the deploy is healthy"
  - "verify the dev site after the release"
  - "the site looks down, check what is broken"
  - "smoke test the new build on the server"
steps:
  - card: shared-browser
    do: "make sure the shared browser is up (bun tools/browser/install.ts)"
  - card: playwright
    do: "open the health URL and the key pages; read them as text and take a screenshot of each"
  - card: chrome-devtools
    do: "list console errors and failed network requests on the pages that look wrong"
  - card: project-notes
    do: "when the broken part belongs to another project, send it a finding with the evidence"
---
## How to call

Native GitHub protection/rulesets are optional, including for private repositories; absence or a paid
feature limitation is not a deployment prerequisite. Preserve existing protection and all independent
[release safeguards](../release-policy.md). This recipe verifies health only, not authorization or the
CI/security, source/image identity, backup/migration, concurrency and rollback checks.

1. Find the service's health URL and its key pages in the project's own deploy docs (`docs/DEPLOY.md`
   or the equivalent). Request the health URL first (`curl -fsS <url>`); a non-2xx status is the finding.
2. Follow the steps above. Check the running build: when the health reply has a version or commit, compare
   it with the commit you expect.
3. Report each failure with its evidence: the status code, the console error, or the screenshot path.

## When NOT to use

- It does not deploy, restart or roll back anything. A fix to production is the operator's decision.
- Do not use it as a load test: one pass over the key pages is enough.
