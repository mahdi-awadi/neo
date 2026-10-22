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

**The key works.** After 3 quick calls it returned `403 Forbidden` (with no rate-limit headers). Later
the same day it worked again, so the 403 was a short-term limit, not a dead key. The limit is not
published. We now leave about 20 s between calls.

### Measured on real Neo samples (second round, same day)

Each sample was a tracked Neo file or real Neo tool output. We checked each one with Neo's own
`findSecret` before sending, and sent no customer data. "Facts" are exact strings that a correct
answer needs. We counted how many of them survive in the compressed text.

| Sample (Neo use) | Question given | Tokens in → out | Kept | Facts kept | Round trip |
|---|---|---|---|---|---|
| `HANDOFF.md` (handoff) | "next steps, open decisions, gotchas?" | 854 → 234 (`auto`) | 27% | **3 / 9** | 422 ms |
| same, gentle `rate: 0.3` | same | 854 → 685 | 80% | **6 / 9**. It lost all three gotchas | 409 ms |
| `git log --stat -40` (long tool output) | "which commits changed project-notes.ts?" | 6,788 → 5,646 | 83% | 6 / 6. It kept 9 duplicate lines | 1,474 ms |
| tools inventory (the catalogue) | "screenshot + RTL check: which tool, how to run?" | 2,398 → 207 | 9% | **2 / 5**. It lost the browser address, playwright and chrome | 703 ms |
| `docs/HISTORY.md`, last 20 kB (memory-like) | "why was context over 100%, what fixed it?" | 6,020 → 118 | 2% | 4 / 4 | 777 ms |

**What this shows:**
- ScaleDown is a fast (0.4–1.5 s) **question-conditioned extractor**. When the question is narrow and
  the answer sits in one place (HISTORY), it is excellent: 98% fewer tokens and every fact kept.
- When the text must stay complete, it loses facts even at a gentle rate. That covers a handoff (any
  line may matter later) and a catalogue (the worker must compare options). Those are exactly the
  texts Neo would want to shrink.
- On structured tool output (git log) it saves little (17%), and it does not remove duplicates.
- A narrow question over a big local document can also be answered by local BM25 search (the same
  FTS5 that memory recall uses), deterministically, for free, with nothing leaving the host. Only
  the 2% case clearly beats `grep`/FTS, and only for text a worker is allowed to send away.

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
| Compressing the tools catalogue, or the dispatch tools hint | **No** | It kept only 2 of 5 facts on the inventory. `tools_for` (ADR-0044 amendment) returns only the top few cards by local BM25, so there is nothing big left to compress. |
| Long tool output before it enters a worker's context | **No, in the engine path** | (1) The engine never sees tool output on its way into the SDK. Changing that means a proxy, which is the DietCode risk below. (2) On git log it saved 17%. |
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
2. We know the key's quota and rate limit. The current key returned 403 for a short time after 3
   quick calls.
4. It is used only as the worker-side "ask one question of a big, non-sensitive text" tool (the
   HISTORY case). Then the measured value (98% fewer tokens, all facts kept) is real. A worker can
   check the extract against the source, because it has both.
3. It runs only through the catalogue's engine relay (ADR-0044), and it is marked
   `data-leaves-host`. It is never in the engine's own path and never on customer text. It
   refuses text that matches the secret patterns.

The catalogue therefore lists ScaleDown as a **`candidate`** card, not an `active` one. Candidate
cards are not turned into skills, so workers do not see the tool until the operator promotes the card.
