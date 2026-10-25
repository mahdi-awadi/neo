---
id: scaledown
kind: api
status: candidate
owner: neo
when: "Candidate only, not offered to workers. Would compress a large text down to what one question needs, before the text goes into a model. Waiting for the operator's data and quota review."
scope: all
env: [SCALEDOWN_API_KEY]
cost: "ScaleDown plan quota (key held by Neo)"
limits: "request body at most 256 KiB through the relay; the relay stays off until the operator enables it"
dataLeavesHost: true
tags: [compress, summarize, context, tokens, scaledown]
examples:
  - "shrink a 200 KB log to what answers one question"
relay:
  baseUrl: https://api.scaledown.xyz
  authHeader: x-api-key
  envKey: SCALEDOWN_API_KEY
  maxBodyBytes: 262144
  operations:
    - { name: compress, method: POST, path: /compress/raw/ }
---
## How to call

Not active. When the operator promotes it (status `active` and `tools.relayEnabled`), a worker calls the engine's `tool_api` with `card: scaledown`, `operation: compress` and a JSON body. The engine holds the key; a worker never sees it.

Evaluation: `docs/research/2026-10-22-scaledown-evaluation.md`.

## When NOT to use

- The text leaves the host: never send customer data, secrets or anything under a data-protection duty.
- Do not use it where a plain read or a codebase-memory query answers the question.
- Do not use it until the card is active.
