# Engine Upgrades from Hermes & OpenClaw — Design

**Date:** 2026-07-23 · **Status:** adopted into the roadmap (reshapes Phase 2, extends Phase 4, adds Phase 5)
**Sources:** deep research on Nous Research's **Hermes Agent** (the upstream of the operator's
memory-plan doc; ~100k★) and **OpenClaw** (Steinberger's self-hosted assistant; ~100k★ and the
closest public analog to Neo — including its full 2026 security incident record).

**Method:** every candidate idea was filtered through Neo's standing laws — quality invariant,
no magic numbers (signals/ratios/choices), no AI in the engine, the compliance firewall, one
code-intel MCP — and through OpenClaw's *failures* as negative evidence. What follows is what
survived, what was rejected, and why.

---

## 1. First, the validation: Neo's core bets are empirically confirmed

OpenClaw's incident record (42k+ exposed instances, 93% with auth-bypass conditions; CVE-2026-25253
token exfiltration through the Control UI; 800+ malicious marketplace skills with infostealer
payloads; memory-poisoning as a time-shifted injection channel; corporate device bans) is a
field experiment Neo never had to run. Its lessons map one-to-one onto choices Neo already made:

| OpenClaw failure | Neo's existing counter-design |
|---|---|
| Prompt injection through inbound messages (>79% success rates against leading agents; OWASP calls it architectural) | Customer-tainted briefs run with **zero tools + no MCP** — injection has no blast radius, by code not prompt |
| Marketplace skills as malware vector (ClawHavoc) | No marketplace; loops/skills are first-party, operator-authored, governor-gated |
| Agents widening their own capabilities | Default-escalate governor; autonomous paths auto-deny |
| Operators not knowing their exposure | (gap — adopted below as `security audit`) |

**Doctrine line added:** capability packs (skills, loop defs) remain first-party or operator-vetted;
Neo never installs third-party capability content without explicit operator approval. Agent-to-agent
content channels (the Moltbook lesson) are out of scope permanently.

## 2. Phase 2 (memory) — reshaped by the Hermes model

The memory plan doc turns out to be a community port of Hermes' memory system; we now design from
the upstream, which is materially better-specified:

1. **Hard-capped memory files where an over-cap write ERRORS** and forces same-turn
   consolidation — the cap *is* the curation mechanism. Per the no-magic-numbers law the caps are
   ratios of the reading session's context window (`memory.snapshotMaxPct`), with Hermes'
   measured values (~800 tokens agent-notes + ~500 tokens user-profile) as documented cold-start
   fallbacks. Two files, two concerns: `MEMORY.md` (facts/conventions/workarounds) and `USER.md`
   (operator profile) per scope (company + per-project).
2. **Frozen-snapshot injection**: the engine injects memory files verbatim at worker start and
   never mutates them mid-session; writes land next session. Deliberate synergy with Phase 1's
   learned-TTL work: a static prefix maximizes prompt-cache hits — memory and cache economics
   reinforce each other.
3. **A 3-op memory write surface** (`add` / `replace` / `remove`) with: exact-duplicate
   rejection, ambiguity errors on non-unique replace targets, and a deterministic **engine-side
   scan on every write** (prompt-injection patterns, credentials, invisible Unicode) — the
   governor pattern applied to memory, and the direct counter to OpenClaw's memory-poisoning
   channel. Drift detection: externally modified memory files are backed up, never silently
   overwritten.
4. **Pre-handoff memory flush** (OpenClaw's best mechanic): at every context-policy boundary
   (handoff, idle-close, dispatch wrap-up), before the state note, the worker is told to write
   durable facts to the memory files — so knowledge escapes to disk *before* the context dies.
   Slots directly into `runHandoff` / the grace-window prompt; one prompt change, no new machinery.
5. **Daily notes + nightly distillation ("dreaming") as a built-in Neo loop.** Dated
   `memory/log/YYYY-MM-DD.md` files are indexed but never injected (today + yesterday optional).
   A nightly loop — running on the cheap-eligible profile, `freshSession: true` — reviews recent
   logs and promotes durable items into the capped files under **hard rate limits** (config,
   operator choices, Hermes-Dreaming's measured defaults as fallbacks: max 3 mutations,
   max +250 net chars per run, add/replace/remove score thresholds, supersession confidence),
   with pre-mutation backups and a human-readable `DREAMS.md` audit diary. **Zero writes is a
   successful run.** The community's unanimous finding — *staleness, not capacity, is the failure
   mode* — makes supersession/unlearning the loop's primary job, not accumulation.
6. **Separate recall layer**: bun:sqlite **FTS5 over dated logs + ledger events** as a
   `memory_search` tool with source/date/heading citations (keyword-first per YAGNI; embeddings
   remain a defined upgrade slot behind the same interface). Curated files answer "who am I
   working for"; recall answers "what did we do last week" — different layers, never merged.
7. **Ground-truth hierarchy + conflict markers**: the injected snapshot is declared
   authoritative to the worker; the distiller marks contradictions (`CONFLICT:` entries) rather
   than silently overwriting — the operator resolves them (or the dreaming loop does, above its
   supersession-confidence threshold).

## 3. Phase 4 (governance & ops) — extended

8. **`neo security audit [--fix]`** — a deterministic self-audit command (CLI + `/audit`) with
   structured check IDs: web-console bind/auth posture, Telegram allowlist state, token/cookie
   hygiene, secrets file permissions, gitignore coverage of runtime data, tool-policy drift in
   loop defs, exposed-port checks. OpenClaw's entire crisis was operators not knowing their
   posture; Neo ships the check, with `--fix` for the mechanical items.
9. **Web console = attack surface** (the CVE-2026-25253 lesson: loopback is not a boundary once
   a browser UI exists): audit Neo's web console for URL/parameter-driven credential flows,
   fail-closed session-cookie validation, and no token ever reachable via a crafted link.
   Concrete review task against `web.ts`/`web-channel.ts`.
10. **Scheduler hardening invariants** (Hermes cron + OpenClaw bounds): (a) an agent-created
    loop (the deferred `create_loop` tool) inherits a **frozen tool policy** — scheduling can
    never widen capabilities; (b) scheduled runs get **no scheduling tools** (no recursive
    cron); (c) worker-profile drift fails closed — if a loop's pinned profile references a model
    no longer configured, the run skips and alerts rather than silently substituting;
    (d) `[SILENT]`-style suppressed loop output is still **archived** in the ledger (quiet ≠
    unrecorded).
11. **Model failover, loud-by-default**: `fallbackModel` arrays per worker path (the SDK
    supports it) with backoff cooldowns wired into the existing `api-retry.ts` machinery — and
    the Hermes/OpenClaw rule that an operator-*pinned* model fails visibly instead of silently
    falling back (quality invariant applied to failure paths).

## 4. New Phase 5 — the proactivity layer

What OpenClaw users love most, rebuilt on Neo's governed primitives:

12. **Heartbeat with a silence contract**: one built-in periodic loop where the company reviews
    everything pending (inbox, running sessions, commitments, yesterday's log) and must answer
    `HEARTBEAT_OK` to stay silent — replies at/below the sentinel are dropped; anything else
    reaches the operator. Cost-bounded by design: `freshSession`, light context, active-hours
    window, and the rate-limit governor gate. This generalizes Neo's per-loop quiet rule to
    *everything*, on the loop runtime that already exists.
13. **Commitment inference**: at natural boundaries (handoff/idle-close capture — the same
    cheap-model pass Phase 2 adds), extract explicit commitments ("I'll check the deploy
    tomorrow") into a ledger `commitments` table; the heartbeat delivers due check-ins
    deterministically. AI extracts (in a worker); the engine schedules and delivers.
14. **Trigger vocabulary**: extend the `Trigger` union with `at` (one-shot, self-disabling),
    `on-exit` (a watched command/process ends), and `stream-command` (line-driven from a watched
    command's output) — plus per-loop delivery modes (`announce` / `webhook` / `none`).
    Deterministic matchers, same scheduler.
15. **Named queue modes for inbound messages**: today a message to a busy session has one
    hardcoded behavior (queued follow-up). Adopt OpenClaw's explicit vocabulary — `steer`
    (inject now), `followup` (queue, default), `collect` (batch into one turn), `interrupt` —
    as a per-message/per-session policy on the existing input-channel seam.

## 5. Explicitly rejected (and why)

- **Embedding our own agent loop** (OpenClaw's pi): Neo's bet is the Claude Code harness via the
  Agent SDK — compaction, tools, and skills maintained upstream. Unchanged.
- **Nodes / Canvas / voice**: out of scope for a work engine; each adds attack surface (macOS
  `system.run` is approval-gated RCE by OpenClaw's own admission).
- **Skill/plugin marketplace**: ClawHavoc is what that becomes without signing. First-party only.
- **Vector embeddings now**: keyword-FTS first (YAGNI, and Hermes' own recall layer is FTS5);
  the interface leaves the slot open.
- **Merging channels into shared sessions by default**: Neo's per-project isolation stands;
  OpenClaw's `dmScope` complexity is a consequence of not having it.

## 6. Sequencing

- **Phase 2 (next build):** items 1-7 — this document now *supersedes* the memory-plan doc as
  Phase 2's source spec (same architecture, upstream detail, plus flush + dreaming + scan).
- **Phase 4:** items 8-11 join the existing telemetry/governance scope. Item 9 (console audit)
  is worth doing early — it is cheap and OpenClaw's worst CVE lives on exactly that surface.
- **Phase 5:** items 12-15 after memory exists (heartbeat and commitments consume it).
- Every numeric above (caps, rate limits, intervals, thresholds) enters config under the
  no-magic-numbers law: ratio or operator choice, with the sourced community-measured value as
  its documented cold-start fallback.
