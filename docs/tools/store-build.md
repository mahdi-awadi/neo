---
id: store-build
kind: recipe
status: active
owner: neo
when: "Use in a mobile project before a store build: find the build profile for the variant, run the security scan, smoke-test the web build, then hand the store submit to the operator."
scope: [waselni]
env: []
cost: "free (host); the cloud build itself uses the project's CI and build quota"
limits: "store submit and production release are operator-gated"
dataLeavesHost: false
tags: [store, build, mobile, app, ios, android, release, expo, eas, testflight, play]
examples:
  - "build the app for the store"
  - "prepare the iOS and Android release build"
  - "check the app is ready for TestFlight"
  - "make a test build of the driver app"
steps:
  - card: codebase-memory
    do: "find the build profile and app config for the variant (test or production), and the backend URL it bakes in"
  - card: security-kit
    do: "scan the branch before the build; a new high or critical finding blocks it"
  - card: playwright
    do: "smoke-test the web build (the test surface) on the main flows"
  - card: project-notes
    do: "when the build needs the operator (store submit, credentials, a release), raise it with the evidence"
---
## How to call

1. Build through the project's own CI workflow or build profile, as its docs say. Never change a profile's
   backend URL to make a build work.
2. A test build uses the test variant and the dev backend; a store build uses the production variant.
3. Store submit and production release wait for the operator. Raise them with `ask_operator`.

## When NOT to use

- Not for a web-only release: use `deploy-check` after the deploy.
- Do not submit to a store or push a release tag without the operator's go-ahead.
