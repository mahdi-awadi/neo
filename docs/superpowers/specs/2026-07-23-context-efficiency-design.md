# Context, Memory & Efficiency — Design (rev. 2)

**Date:** 2026-07-23 (rev. 2 same day) · **Status:** approved for Phase 1 build
**Drivers:** (a) the operator's Claude usage report (76% of usage at >150k context, 66%
subagent-heavy, 51% from 8h+ sessions, 42% superpowers plugin, 15% playwright MCP); (b) the
operator's directives: **work quality is never traded for tokens**, every project gets a proper
setup (code-intel MCP + right skills), and **memory is a first-class goal**, not a token tactic.

**Principles:**
1. **Quality invariant.** The model doing real project work is never silently downgraded. Every
   profile defaults to *inherit* (today's exact behavior); any economy override is opt-in, allowed
   only on mechanical non-code paths, gated by measurement, and reversible by a config flip.
2. Every knob is **config** (env > config.json > default) — no hardcoded values.
3. The engine stays deterministic and AI-free; AI only inside workers.

---

## 1. Diagnosis (unchanged from rev. 1)

| Report line | Root cause in Neo |
|---|---|
| 76% at >150k context | Company session immortal; handoff only at 65% / 200 turns / 7 days; loops resume the same SDK session every iteration with no context check |
| 51% from 8h+ sessions | `idleCloseMs` 24h; nothing recycles below that |
| 66% subagent-heavy | Subagents inside workers inherit the top model; parallel sessions share one pool |
| 42% superpowers / 12% writing-plans | `skills:"all"` everywhere + dispatch preamble mandates superpowers; plugin loads ~22k tokens at startup (obra/superpowers#190) |
| 15% playwright | Configured at the `/home/manager` scope → loads into every session there, incl. ones that never touch a browser; results uncapped (default 25k tokens/call) |
| Cache economics | Subscription prompt-cache TTL = 1h; idle-resume of a fat transcript after >1h re-pays the whole context uncached |

**Crucial observation:** the biggest levers — recycling sessions at safe boundaries, cache-aware
resume, earlier auto-compaction, scoping which skills/MCP servers load, capping MCP result size,
dieting CLAUDE.md, queueing background work — are **quality-neutral**. They change what dead
weight sits in context, not which model thinks. Model routing is a *last* lever, not the first.

## 2. Quality guarantee (how "never touched" is enforced, not promised)

- **Defaults change nothing.** `workers` profiles ship empty (inherit) except the two behaviors
  that already exist in code today (company + ingress `effort:"low"`), which merely move into
  config. Merging Phase 1 with default config produces byte-identical SDK options for every
  code-writing path.
- **Economy overrides are fenced to mechanical paths.** Only paths whose output is not project
  work product are eligible: `handoff` (writes a state note), `judge` (read-only met/not-met
  verdict, engine re-verifies command goals deterministically anyway), `ingress` (routing).
  `dispatch`, `project`, `company`, and `loop` (loops edit real code) are **not** eligible for
  model downgrades in this design.
- **Measured, not assumed.** Before any economy override sticks, compare two weeks of ledger
  evidence: loop outcomes (`goal-met` rate, iterations-to-green), handoff-note completeness
  (does the resumed session recover without re-asking), dispatch re-work rate. Any regression →
  flip the config back. Phase 4's telemetry makes this a dashboard, not a feeling.
- **Context hygiene helps quality.** Long-context degradation ("context rot", community-measured
  from ~100-150k tokens) means a fresh worker with a good memory snapshot usually *outperforms*
  a 150k-token session. Recycling + memory is a quality strategy, not just a cost one.

## 3. Mechanisms available (verified July 2026 — unchanged facts, key ones)

SDK `query()` options: `model`/`fallbackModel`, `effort`, `maxTurns`, `skills: string[]|"all"`,
`disallowedTools`, `settingSources`, `strictMcpConfig`, `env`, `agents` (per-subagent `model`),
`resumeSessionAt`, `forkSession`. Compaction is automatic; tuned via env:
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `MAX_MCP_OUTPUT_TOKENS`
(default 25k/result), `ENABLE_TOOL_SEARCH` (deferred MCP tool defs, on by default),
`CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Skills frontmatter: `model`,
`effort`, `context: fork`, `disable-model-invocation`; `skillOverrides` in settings applies the
latter to plugin skills. Official guidance: CLAUDE.md < ~200 lines; prefer fresh sessions +
handoff artifacts over resuming fat transcripts; `/clear` free, `/compact` of a big context is
itself expensive; queue rather than parallelize near limits.

## 4. Code-intelligence MCP: gitnexus vs codebase-memory — the measured verdict

Head-to-head run 2026-07-23 on this server, Neo repo, 5 questions with hand-verified ground
truth, scored on correctness + bytes a worker would pay. Setup: gitnexus (npm, indexed 2,586
symbols) vs **DeusData/codebase-memory-mcp v0.9.0** (github.com/DeusData/codebase-memory-mcp —
single static binary, installed to `~/.local/bin`, indexed Neo in **0.51s**: 1,560 nodes/3,976
edges; this is the exact tool-set Neo's `codebase-memory.ts` was written for).

| Question | gitnexus | codebase-memory | Winner |
|---|---|---|---|
| Impact of `runOrder` (used via `deps.run ?? runOrder` DI) | `impact()`: 0 results, asserted **LOW risk** (dangerously wrong); Cypher: test caller only | `trace_call_path`: empty (broken tool); **`query_graph` over its `USAGE` edges: complete** — all 8 real usage sites incl. two the hand-built ground truth missed (631 B) | **cbm** |
| Concept→flow: "how does dispatch work" | `query()`: **empty** (FTS index corrupt on this box) | top-4 = exactly the dispatch chain with line ranges (16.5 KB, needs a limit) | **cbm** |
| Find budget-throttle logic | `query()`: empty | `shouldThrottle` ranked #1 + whole meter cluster (2.8 KB) | **cbm** |
| Architecture overview | terse resources (4 modules), needs many follow-up reads | one call: entry points, hotspots (fan-in), boundaries, layers, 12 cohesion-scored clusters (22.9 KB, verbose) | **cbm** (substance) |
| Symbol 360° `decideContext` | `context()`: all callers, ergonomic, ~1 KB | `query_graph` Cypher: same answer, 262 B (but `trace_call_path` broken) | tie |

**Decision: codebase-memory is the primary code-intel MCP for Neo workers** — 4/5, including the
only complete impact answer (its `USAGE` edge type sees function *references*, which Neo's
dependency-injection style makes essential; gitnexus's CALLS/IMPORTS graph structurally cannot).
It is also what Neo's engine already natively speaks: `codebaseMemoryBin` is now set, the
`ensureIndexed` guard and dispatch preamble work unchanged. Caveats encoded into the preamble
guidance: prefer `search_graph`/`query_graph`/`get_architecture(aspects=…)`; avoid
`trace_call_path` (broken in 0.9.0); cap result sizes (`MAX_MCP_OUTPUT_TOKENS`).
**gitnexus is demoted to an optional operator-side tool** (its `context()`/`rename` ergonomics
are nice interactively) — never loaded into the same worker as codebase-memory, and only kept at
all if its corrupt-FTS + hook-noise warts get fixed; otherwise retire it. Fairness note:
gitnexus's Q2/Q3 losses are partly an install-health failure (corrupt FTS), but
reliability-as-deployed is precisely what a worker experiences.

## 5. The Memory Plan (`Claude-Code-Memory-Plan-v`) — assessment and adoption

**Assessment: adopt the architecture, adapt the plumbing, defer the vector DB.**

What's genuinely right (and adopted):
- The **store / inject / recall** triad as the complete job description of memory.
- The **capped, frozen working-memory snapshot** — a hard cap keeps memory from becoming a junk
  drawer, and freezing it per session keeps the worker's world-model stable. This slots exactly
  into Neo's handoff model: HANDOFF.md was already a proto-snapshot; this makes it structured.
- **Curated writes as a skill with editable judgment rules** — rules in prose, not code, so the
  operator can tune what's worth keeping. Matches Neo's "rules live where you can read them."
- **Idempotent capture** (hash the source turn) and **citations** (file + date + heading on every
  recall — recall that can't cite is a liability).
- **Bootstrap from history** — Neo already owns a goldmine: the ledger (orders, dispatches, loop
  outcomes, context events) + existing HANDOFF.md notes + `~/.claude/projects/*` transcripts.

What's adapted for Neo (differences from the doc, with reasons):
- **No SessionStart/Stop hooks needed for workers.** The doc targets interactive Claude Code; Neo
  *is the harness* for its workers. The engine injects the snapshot deterministically (prepend to
  the first prompt / drop `memory/working-memory.md` where the folder's CLAUDE.md references it)
  and captures at Neo's natural boundaries — handoff, idle-close, dispatch completion — where a
  summarizing turn already happens. The `handoff` worker profile is the "cheap, fast model" the
  doc calls for, and that's an *eligible* economy path (a summary note, not work product).
- **Two scopes:** company memory in `agent/memory/` (threads, decisions, operator preferences)
  and per-project memory in `<project>/memory/` (project facts, gotchas, decisions) — scaffolded
  by onboarding (§6), gitignored by default.
- **Recall starts hybrid-keyword, not vector.** bun:sqlite FTS5 over chunked dated logs +
  working-memory, with source/date/heading metadata and recency-weighted ranking — deterministic,
  zero-model, engine-friendly, and honors the doc's own advice ("add complexity later only if you
  hit its limits"). A local embedding layer is a defined *upgrade slot* behind the same search
  interface, added only when keyword recall measurably misses (log recall queries + whether the
  answer was found; that log IS the eval).
- Skip the Agentic OS upsell; everything here is files + engine code we own.

**Proof-of-works (from the doc, kept as acceptance tests):** fresh session answers "what were we
working on?" from the snapshot alone; "remember X" survives a session boundary; a weeks-old fact
is found via different words *with its source cited*.

## 6. Per-project onboarding (new — every project added gets the full setup)

When a project enters Neo (first `/open` or first dispatch to a new folder), a deterministic
engine pipeline runs, config-gated (`onboarding.*` knobs), each step bounded + best-effort:
1. **Index:** ensure the configured code-intel index exists (gitnexus `analyze --skip-agents-md`,
   engine-side, mirroring today's `ensureIndexed` shape). Re-index stays engine-triggered on
   dispatch, replacing the noisy per-Bash hook.
2. **Memory scaffold:** create `memory/working-memory.md` (capped template) + `memory/log/` and
   gitignore them if absent.
3. **Setup pass (AI, in a worker, once per project):** run the installed **claude-code-setup**
   plugin's `claude-automation-recommender` against the folder; the worker returns a
   recommendation report (which MCP servers, skills, hooks fit THIS project). The report goes to
   the operator as a normal message; **installs happen only on operator approval** — the governor
   already escalates config-touching writes, and recommendations are advice, not authority.
4. **Scoped MCP:** the project's worker profile records which MCP servers it actually needs
   (e.g. playwright only for browser-testing projects), so `strictMcpConfig` + explicit
   `mcpServers` keep every other worker lean. This directly fixes the playwright-at-`/home/manager`
   leak found on this machine.
A ledger `onboarded` marker makes the pipeline idempotent (the doc's sentinel-file idea).

## 7. Phases (reordered by the operator's priorities)

- **Phase 1 — quality-neutral hygiene (built first; plan: `plans/2026-07-23-context-efficiency-phase1.md`, rev. 2):**
  worker-profile plumbing with **inherit-everything defaults**; `workerEnv` (earlier autocompact,
  `MAX_MCP_OUTPUT_TOKENS` cap — quality-neutral); loop resume gated by context policy +
  `freshSession` flag; cache-aware resume (`staleResumeMs`/`staleResumePct`); de-hardcoded
  timing/window constants; CLAUDE.md diet. Economy model suggestions live ONLY in `docs/CONFIG.md`
  ("economy mode — opt-in, fenced to handoff/judge/ingress, measured, reversible"), not in defaults.
- **Phase 2 — memory (co-primary goal):** §5 build — snapshot + injection, curated-writes skill,
  boundary capture, FTS5 recall with citations, ledger/transcript bootstrap, acceptance tests.
- **Phase 3 — onboarding pipeline:** §6 build, incl. pointing engine indexing + the dispatch
  preamble at the configured code-intel server (gitnexus today) and the concurrency-wart fix.
- **Phase 4 — telemetry & skill governance:** per-session token/context telemetry in the ledger
  (the quality-vs-economy scoreboard §2 needs); optional token-based throttle; queue-over-parallel;
  dispatch preamble tiers (`full|lean|none` — company chooses per brief, engine enforces the
  configured default); `skillOverrides`/`disable-model-invocation` for superpowers skills that
  shouldn't auto-fire; SkillOpt (github.com/microsoft/SkillOpt) noted as an accuracy-preserving
  skill-distillation experiment, explicitly not a token tool.

## 8. What we deliberately do NOT do

- No model downgrade on any code-writing path (`dispatch`, `project`, `company`, `loop`) — ever,
  in this design. Revisit only with Phase 4 telemetry in hand and per-path evals.
- No raw-API context-editing betas (subscription-only compliance stands).
- No engine-side AI (FTS recall is deterministic; embeddings deferred behind the same interface).
- No auto-installing MCP/skills from recommendations — operator approves; governor enforces.
- No second code-intel MCP loaded alongside gitnexus.

## 9. Measuring success

Two weeks after Phase 1+2: usage report's >150k-context and 8h+ shares fall; ledger shows
handoffs at lower occupancy and fresh loop iterations; memory acceptance tests (§5) pass; loop
goal-met rate and dispatch re-work rate **unchanged or better** — the quality line every economy
decision answers to.
