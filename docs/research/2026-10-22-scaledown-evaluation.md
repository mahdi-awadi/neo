# ScaleDown API — evaluation (2026-10-22)

Operator order: find out what ScaleDown is, test the supplied key, and say where it helps Neo and the
projects. The key is in `/home/neo/.env` as `SCALEDOWN_API_KEY`. It was read only through Neo's env
loader (`loadConfig`) and was never printed.

## What it is (from the official docs)

ScaleDown sells "task-specific small language models" behind one API host,
`https://api.scaledown.xyz` (auth header `x-api-key`). Sources: docs.scaledown.ai (`llms.txt`,
`api-reference/compress.md`, `compress-overview.md`, `dietcode/proxy-mode.md`) and the LiteLLM
provider page.

| Model | Endpoint | What it does |
|---|---|---|
| Compress | `POST /compress/raw/` | `{context, prompt, scaledown:{rate:"auto"\|0..1}}` → `results.compressed_prompt` + token counts. The docs claim 50–70% fewer tokens with "no meaningful" quality loss. |
| Summarize | OpenAI-style chat completions | An abstractive summary of a text. |
| Extract | OpenAI-style chat completions | Fields from text, filled against a JSON schema. |
| Classify | `POST /classify` | A probability for each label, scored against a rubric. |
| Decisions | `POST /v1/scaledown` | A drop-in replacement for the **Jev** Decisions API (TypeSafe), which some projects already use. |
| DietCode | local proxy + CLI | Sits between Claude Code and Anthropic (`ANTHROPIC_BASE_URL`). It replaces old turns with a ScaleDown summary. |

- **Pricing:** $0.05 per 1M input tokens, and output is free (LiteLLM and cloudprice listings). The
  official docs say to "contact sales" for a key and publish no price list.
- **Limits:** no rate limits are published. The API answers `429` when a limit is reached.
- **Privacy:** the marketing pages and the company blog claim **zero data retention**: a document
  exists only in memory for the request. They also claim no training on customer data, and that the
  service is "built to SOC 2 / HIPAA / GDPR / ISO 27001 standards" (built to the standards, which
  does not mean certified). `scaledown.ai/privacy`, `/terms` and `/pricing` return **404**. We found
  no legal privacy policy, no DPA and no list of subprocessors. A self-hosted deployment is offered
  to enterprise customers.
- **What leaves the host:** the full `context` and `prompt` text of every call goes to a third party
  that is not on our current list of processors (Anthropic, Google/Gemini, Cloudflare, TypeSafe).

## The test call

Script: a throw-away probe outside the repo. It used the key from the env loader and **synthetic
text only**: a made-up worker handoff of 5,296 characters (≈1,400 tokens), with no real data,
secrets or PII.

| Call | HTTP | Round trip | Server time | Tokens | Ratio kept |
|---|---|---|---|---|---|
| `rate:"auto"` | 200 | 659 ms (416 ms on the second call) | 199 ms / 123 ms | 1,398 → 355 | **0.25** |
| `rate:0.5` | 200 | 218 ms | 117 ms | 1,398 → 715 | **0.51** |
| `rate:0.5` (repeat) | **403** `{"message":"Forbidden"}` | 85 ms | — | — | — |
| tiny follow-up | **403** | — | — | — | — |

**The key works, but it stopped working after 3 calls** (`403 Forbidden`, with no rate-limit headers).
This looks like a trial key with a small call quota, or a key that was turned off. We stopped calling.
The operator must ask ScaleDown what the key's quota is.

**Quality check on the output.** Compression is *extractive and depends on the prompt*: it keeps the
whole sentences that answer the `prompt` and drops the rest.
- At `auto` it kept both facts the question asked about ("what is left", "what the reviewer asked").
  It dropped facts the question did not ask about (the migration). It also kept the **same sentence
  six times**, so it does not remove duplicates.
- So it is a good fit when there is one known question (RAG, Q&A over a document). It is a poor fit
  for text that must stay complete for questions nobody knows yet, such as handoff notes, memory
  snapshots and dispatch results. Neo depends on exactly that kind of text.

## Where it could help — and why mostly not

| Candidate | Verdict | Why |
|---|---|---|
| Neo engine: handoffs, memory snapshots, dispatch results, tool output | **No** | (1) **No AI in the engine.** A compression model in the engine path is engine-side AI (CLAUDE.md; context-efficiency spec §8). (2) The text has no single question, and the test shows that facts are dropped. A handoff that loses the "migration" line fails the spec's quality rule ("handoff completeness"). (3) Workers run on the subscription, so tokens cost no money. The real cost is the size of the context window, which ADR-0021 (sweet spot) and memory Phase 2 already handle locally, with no third party. |
| DietCode proxy in front of the workers | **No** | It sends every turn of every worker (code, secrets in view, customer-derived text) to a third party, and it moves the workers off the direct Anthropic path. That is a compliance and secret-handling change, not an efficiency setting. |
| Gemini customer reading (Phase 3b) | **No, for now** | Customer PII would go to a processor that has no published privacy policy or DPA. Gemini's context is large and cheap, so the saving is small. |
| eticket provider payloads (NDC/XML) | **No** | These payloads are parsed by code, not read by an LLM. Lossy compression of the data the code parses is wrong. |
| ClickHouse / log triage that a worker reads | **Maybe, as a pilot** | Big, repetitive, non-PII log text with one clear question ("why did X fail") is the case it is built for. A worker would call it as a tool on demand, never the engine. |
| Projects' own LLM features (RAG, long-document Q&A in adminli/mirshad) | **Maybe, per project** | Only if that project's LLM bill is real and its data may go to this processor. It is the project owner's decision, made per project. |
| Decisions API as a Jev replacement | **Watch** | It may be cheaper than TypeSafe/Jev for projects that use Jev. It needs its own accuracy test against our labels. |

## Recommendation

**Skip it for Neo itself. Do not adopt it yet for the projects. At most, run a small pilot later,
as an opt-in worker tool for log triage.** The conditions for that pilot:
1. ScaleDown publishes or signs a privacy policy or DPA (zero retention in writing).
2. We have a key with a known quota. The current key returns 403 after 3 calls.
3. It runs only through the catalogue's engine relay (ADR-0044), and it is marked
   `data-leaves-host`. It is never in the engine's own path and never on customer text. It
   refuses text that matches the secret patterns.

The catalogue therefore lists ScaleDown as a **`candidate`** card, not an `active` one. Candidate
cards are not turned into skills, so workers do not see the tool until the operator promotes the card.
