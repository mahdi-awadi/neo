# Context & Token Efficiency — Design

**Date:** 2026-07-23 · **Status:** approved for Phase 1 build
**Driver:** the operator's Claude usage report: 76% of usage at >150k context, 66% from
subagent-heavy sessions, 51% from 8h+ sessions, 42% from the superpowers plugin, 15% from the
playwright MCP, 12% from the writing-plans skill.

**Principle:** every knob is **config** (env > config.json > default), never a hardcoded value.
The engine stays deterministic and AI-free; all savings come from *how* workers are launched and
*what* is loaded into them.

---

## 1. Diagnosis — how Neo's design maps onto the usage report

| Report line | Root cause in Neo |
|---|---|
| 76% at >150k context | Company session is immortal (`idle.ts` exempts it); handoff only at 65% occupancy / 200 turns / **7 days**; loops resume the same SDK session every iteration with **no context check** (`loop-runner.ts` threads `resumeId` forward; the known pending item) |
| 51% from 8h+ sessions | `idleCloseMs` default 24h; nothing recycles a session below that except `/kill` |
| 66% subagent-heavy | Workers never specify a model — **every** path (company, dispatch, loops, ingress, judge, handoff) runs the CLI default (Opus-class). Only `effort:"low"` is used, on 3 of 7 paths. Subagents spawned inside workers also inherit the expensive model (Claude Code ≥2.1.198: built-in Explore inherits main model) |
| 42% superpowers / 12% writing-plans | `skills:"all"` in `sdkOptions()` injects every skill into every worker; the dispatch preamble **mandates** superpowers on every dispatch; community-measured: superpowers loads ~22k tokens at startup (obra/superpowers#190) + ~1.3k always-on (#1456) |
| 15% playwright MCP | MCP **results** (definitions are deferred by default via tool search) are capped only by the global default `MAX_MCP_OUTPUT_TOKENS` = 25,000/call; Neo sets no cap; engine-side MCP calls have timeouts but no size bounds |
| Cache economics | Subscription prompt-cache TTL is **1 hour**. Neo's idle-resume design re-pays the FULL accumulated context uncached whenever a session is resumed after >1h quiet — the worst possible pattern for scheduled/loop work |

Other measured facts: Neo repo `CLAUDE.md` is 18KB/~3.3k tokens and auto-loads into every
self-repo worker (all built-in loops); the dispatch preamble (~250 tokens) additionally mandates
reading all root `.md` files + `docs/` + codebase-memory-first on every dispatch; the budget meter
is USD-only — per-turn token telemetry exists (`usage.ts`) but drives nothing.

## 2. Mechanisms available (verified July 2026)

From the Agent SDK TypeScript `Options` (code.claude.com/docs/en/agent-sdk/typescript):
`model` + `fallbackModel` per query; `effort` (`low…max`); `maxTurns`; `maxBudgetUsd`;
`skills: string[] | "all"`; `disallowedTools` (bare name removes the tool definition from context);
`settingSources`; `strictMcpConfig`; `env` (passes env vars to the spawned Claude Code);
`agents` (programmatic subagents with per-subagent `model`/`effort`/`maxTurns`);
`resumeSessionAt` (resume truncated at a message); `forkSession`.
There is **no** first-class compaction option — compaction is automatic and tuned via env vars.

Env vars (code.claude.com/docs/en/env-vars, /en/mcp, /en/agent-sdk/tool-search):
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — % of window at which auto-compact triggers (compact earlier).
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — token capacity used for compaction math.
- `MAX_MCP_OUTPUT_TOKENS` — per-MCP-result cap (default 25,000; lower it).
- `ENABLE_TOOL_SEARCH` — deferred MCP tool loading (`true`/`false`/`auto[:N]`; on by default).
- `CLAUDE_CODE_SUBAGENT_MODEL` — global subagent model override (blunt but effective).
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` — successor to the deprecated `ANTHROPIC_SMALL_FAST_MODEL`.

Skill/plugin frontmatter + settings (code.claude.com/docs/en/skills, /en/sub-agents):
`model:`/`effort:` per skill; `context: fork` (skill runs in a forked context, output stays out of
the main window); `disable-model-invocation: true` (skill description not loaded at all);
`skillOverrides` in settings.json applies that to plugin skills you don't own; subagent frontmatter
`model: haiku`; docs recommend redefining `Explore` with `model: haiku` since it now inherits.

Official guidance that validates Neo's direction (costs + sessions docs): keep CLAUDE.md under
~200 lines; prefer fresh sessions with handoff artifacts over resuming fat transcripts
("capture the results you need as application state and pass them into a fresh session's prompt");
`/clear` is free while `/compact` of a big context is itself a large request; parallel sessions
draw the same pool linearly — queue when near limits.

The operator's named resources, identified:
- **claude-code-setup** (installed): official Anthropic plugin; scans a codebase and recommends
  automations. ~139 tokens always-on. Run `/claude-automation-recommender` per project.
- **Claude-Code-Memory-Plan** (repo root file): a store/inject/recall memory design — capped
  working-memory snapshot injected at session start, agent-curated writes, cheap-model session
  capture, hybrid semantic recall with citations. Adopted as Phase 3 below.
- **Microsoft SkillOpt** (github.com/microsoft/SkillOpt): treats a skill file as a trainable
  parameter — trajectory-driven, validation-gated edits producing a `best_skill.md`. Optimizes
  **accuracy, not tokens**; useful later to distill heavy skills. Exploratory only.

## 3. Design

### Phase 1 — worker profiles + loop/context hygiene (the code plan: `plans/2026-07-23-context-efficiency-phase1.md`)

1. **Worker profiles in config.** A `workers` config section with one profile per launch path —
   `company · project · dispatch · loop · judge · ingress · handoff` — each `{ model?, effort?,
   skills?, maxTurns? }`, plus a shared `workerEnv` map merged into every worker's environment.
   `session-runner.RunDeps` grows `model/skills/maxTurns/env`; a pure `worker-profile.ts` folds a
   profile into RunDeps (call-site overrides win). Unset = inherit = today's behavior.
   *Recommended defaults:* loops run `sonnet` with `skills: []`; judge + handoff run `haiku` at
   `effort:"low"`; company/ingress keep `effort:"low"` (moved from code into config); dispatch and
   interactive projects inherit. `workerEnv` example: autocompact at 70%, `MAX_MCP_OUTPUT_TOKENS`
   12000, `CLAUDE_CODE_SUBAGENT_MODEL` haiku.
2. **Context policy wired into loops** (closes the known gap): before each iteration that would
   resume, the engine gates the resume id through `decideContext` — a non-`keep` verdict drops it
   and the iteration starts fresh (the loop prompt is self-contained by design). Per-loop
   `freshSession: true` flag opts a loop out of resume entirely (right for judge/report loops).
3. **Cache-aware resume.** New contextPolicy knobs `staleResumeMs` (default = the 1h subscription
   cache TTL) and `staleResumePct`: resuming a session idle longer than `staleResumeMs` whose
   occupancy ≥ `staleResumePct` triggers handoff-then-fresh instead — never re-pay a fat cold
   transcript. Idle gap is measured deterministically from the transcript file mtime.
4. **De-hardcode:** `idlePollMs`, `loopTickMs`, `contextPolicy.windowTokens` move to config.
5. **CLAUDE.md diet:** phase-history narrative moves to `docs/HISTORY.md`; CLAUDE.md targets
   <200 lines (docs guidance) — saves ~2k tokens in every self-repo worker.

### Phase 2 — token telemetry + spend governance (follow-up plan)

- Persist per-session token/context telemetry (from `usage.ts` transcript parsing) into the ledger;
  surface in `/status`, `/usage`, and the web console.
- Optional token-based throttle beside the USD meter (`budgetWindowTokens`), sharing the same
  reserve logic. Queue background work (dispatch + loops already gate on the meter) instead of
  running 4+ parallel sessions into the same pool.
- Dispatch preamble tiers: a `preamble` dispatch-tool parameter + config default
  (`full | lean | none`) — `lean` drops the read-all-docs and mandatory-superpowers clauses and
  keeps codebase-memory-first; scheduled/loop dispatches default lean. The company (AI) chooses the
  tier per brief; the engine only enforces the configured default. No AI in the engine.

### Phase 3 — company memory (from the Memory Plan doc; follow-up plan)

Store/inject/recall for `agent/`: capped `working-memory.md` + dated logs, injected by the engine
into the company's first prompt (deterministic file read — the frozen snapshot); a `remember`
skill for curated writes; session capture via a `haiku`-profile worker turn at handoff/idle-close
(replacing free-form HANDOFF.md with structured memory); keyword-first hybrid recall (vector
search only if keyword recall proves insufficient — YAGNI). This is what makes aggressive session
recycling *safe*: state lives in files, not in a 150k transcript.

### Phase 4 — skill & plugin trimming (mostly operator config, small plan)

- `skillOverrides` (`disable-model-invocation: true`) for superpowers skills that shouldn't
  auto-fire in every session; keep brainstorming/writing-plans for invoked, planned work.
- Fork-and-tune candidates: `context: fork` + `model:`/`effort:` frontmatter on the heavy skills;
  optionally distill with SkillOpt (accuracy-gated).
- Playwright MCP: enabled only in projects that use it; results bounded by the Phase 1
  `MAX_MCP_OUTPUT_TOKENS` in `workerEnv`.
- Run `/claude-automation-recommender` per active project; adopt only what it justifies.

## 4. What we deliberately do NOT do

- No raw-API context-editing betas — Neo is subscription-only (compliance: keep it that way).
- No engine-side AI summarization — compaction belongs to the worker harness; the engine only
  decides *when* to recycle (deterministic signals).
- No wholesale superpowers removal — measured value on large planned tasks is real; we scope it.
- No speculative vector store in Phase 3 until keyword recall demonstrably falls short.

## 5. Measuring success

Compare the Claude Code usage report ("what's contributing to your limits usage") after two weeks:
>150k-context share and 8h+-session share should fall sharply; ledger `context_events` should show
handoffs firing at lower occupancy; loop iterations should show fresh-session starts; the meter +
new token telemetry (Phase 2) becomes the permanent scoreboard.
