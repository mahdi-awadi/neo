# Neo research (2026-10-04): idea → code map

**Input:** the five files in [`2026-10-04-neo-research/`](2026-10-04-neo-research/) (the operator's
`neo-research.zip`). **Checked against:** `master` @ `58b00a8` with the codebase-memory map
(`home-neo`), `MVP-PLAN.md`, `docs/HISTORY.md`, ADR-0001…0011, the specs under
`docs/superpowers/specs/`, the open plan `docs/superpowers/plans/2026-09-06-claude-app-feature-parity.md`
(branch `docs/claude-app-feature-parity-plan`) and the SDK research
`docs/research/2026-10-01-agent-sdk-features-and-model-routing.md` (branch `dev`).

**Important:** the research read the repo at `60b87b9` (2026-07-28). `master` is 101 commits newer.
Several "gaps" in the research are closed now. This map uses the current code.

Status: **Done** = exists and works · **Partial** = a base exists to extend · **Missing** = nothing
yet · **Rejected** = an earlier decision says no.

Verdicts: **Keep** (in the plan) · **Merge** (folded into another kept item) · **Defer** (sound, but
not now) · **Drop** (does not fit Neo).

## 1. The July reliability issues (research "step 0")

| # | Issue (2026-07-25 investigation) | Status today | Where | Verdict |
|---|---|---|---|---|
| 1 | Follow-ups land only at turn end | Missing | `session-runner.ts` input channel; no steer path | **Keep** → P0 `/now` |
| 2 | Stale "waiting Nm" label | Done | derived session state, `liveness.ts`, `session-status.ts` (spec 2026-09-18) | — |
| 3 | Telegram sends dropped / out of order | Done | `frontends/telegram-flood.ts` flood gate, ADR-0010 | — |
| 4 | Typed reply cannot answer Allow/Deny | Partial | escalation is a tracked decision (`escalation.ts`), but the resolver is Telegram's in-memory `pending` map (`telegram.ts:239,821`); web has its own map (`web-channel.ts:131`); a typed message never reaches either | **Keep** → P0 |
| 5 | Non-reply answer goes to the company | Partial | one-shot focus is a deliberate design (spec 2026-07-16); `/pin` exists | **Merge** into P0 (an open escalation captures the next typed yes/no in that chat). Auto-pin: **Drop** (re-opens the one-shot decision) |
| 6 | Backoff parks a worker for hours | Done | `api-retry.ts`: only `rejected` governs | — |
| 7 | Queued dispatch interleaves, no result | Done | ADR-0007 dispatcher inbox, ADR-0008 todo queue | — |
| — | Codex runs bypass the governor | Partial | `codexThreadOptions` (`session-runner.ts:600`): `workspace-write` + `on-request` by default; no governor mapping, no proof of what `on-request` does headless | **Keep** → P0 (spike, then fail-closed mapping) |

## 2. Productivity deep-dive (`neo-productivity-deep-dive.md`)

| Id | Idea | Status | Existing code to extend | Verdict |
|---|---|---|---|---|
| A1 | Script gate before waking the model | Partial | two hard-coded gates: `dreamGateOutcome`, `secretaryGateOutcome` (`loops.ts:370,428`), called in `startLoop`/`startScheduledLoop`/`daemon.ts:238` | **Keep** → P1 (generalise into `LoopDef.gate`) |
| A2 | Script-only loops | Missing | `commandGoal` spawn logic (`goal.ts:17`) | **Keep** → P1 |
| A3 | Silence sentinel, grouped failure alerts, "no output for N runs" | Partial | scheduled fires are already silent when empty; `faults` dedupe by signature (ADR-0010); loop `onError` alert in `daemon.ts` | **Keep** → P1 |
| B1 | Authenticated `/fire/:loop` with text | Missing | `frontends/web.ts` routes, `launchLoop` | **Keep** → P5 |
| B2 | GitHub / CI / Sentry triggers | Missing | — | **Merge** into P1 gate (poll with `gh`), webhook receiver **Defer** |
| B3 | Email-to-task for the operator | Missing | customer inbox (`inbox.ts`, gateway) | **Drop** for now: it puts operator orders on the customer email ingress, the firewall's most sensitive edge; needs its own operator decision |
| B4 | `at` and `on-exit` triggers | Missing | `trigger.ts` union (`manual`/`interval`/`cron`) | **Keep** `at` → P1. `on-exit`: **Merge** into gate (a gate script can test a pid/file) |
| C1 | Checks on every dispatch, resume on failure | Partial | loop iterate→check→resume (`loop-runner.ts`), `commandGoal`; dispatch ends when settled (ADR-0007) | **Keep** → P3 |
| C2 | Rubric grader with deficiency list | Partial | `judgeGoal` returns DONE/CONTINUE + one reason (`goal.ts:73`) | **Keep** → P3 |
| C3 | Evidence card per run | Partial | dispatch result + stop point (`dispatch-report.ts`), cost in `dispatch_end` | **Keep** → P3 (data contract only) |
| C4 | CI/review results back to the PR's session | Missing | resume by `sdk_session_id` (`reply-routing.ts` `deliverIntoFolder`) | **Keep** → P5 |
| D1 | Git worktree per concurrent task | Missing | todo queue runs one per project (ADR-0008); updater already uses a worktree (`update-sdk.ts`); SDK `projectConfigRoot` exists in 0.3.289 | **Keep** → P6, opt-in per project (amends ADR-0008) |
| D2 | `dispatch_many` fan-out | Missing | `dispatch` MCP tool, todo queue | **Keep** → P6 |
| D3 | Board-driven dispatch | Partial | todo queue = per-project durable board | **Merge** into P8 |
| D4 | Leases / run linkage | Done (mostly) | todo states + boot reconciliation (ADR-0007/0008), `worker_compat_warning` | **Drop** (no new gap) |
| E1 | Corrections captured as events | Missing | `events` table, deny path in escalation, `/kill` | **Keep** → P7 |
| E2 | Promote/demote rules in the dream loop | Partial | `memory-dream` loop, dream budgets, `CONFLICT:` markers | **Keep** → P7 |
| E3 | Staged skill proposals, operator-approved | Missing | decisions (`ask_operator`), path fence | **Keep** → P7 |
| E4 | Curator for agent-written skills | Missing | — | **Defer** (no agent-written skills exist yet) |
| E5 | Bi-temporal memory facts | Missing | `memory-recall.ts` FTS | **Defer** (YAGNI; `CONFLICT:` markers cover it today) |
| E6 | Repeated work → scripts | Missing | — | **Defer** (needs E1 data first) |
| F1 | One allow/ask/block table with globs (Bash, paths, MCP servers) | Partial | `governor.ts` `decide()` + governor hook (ADR-0006), trust store | **Keep** → P4 (block/ask rules first: trust is ON by default, so precise *deny* rules are the gap) |
| F2 | Scoped grants (Once / This task / 1h / Always) | Missing | Allow/Deny buttons | **Keep** → P4 |
| F3 | Learned escalation, offered not applied | Missing | escalation decisions in the ledger | **Keep** → P4 |
| F4 | Proactive work read-only by default | Partial | loops auto-deny escalations; `READONLY_DENY` | **Merge** into P2 (the brief runs read-only) |
| F5 | Content checks on outbound sends | Missing | memory write scan (`memory.ts`) is the pattern; inbox Send (`inbox-actions.ts`) | **Keep** → P4 |
| F6 | `/never <pattern>` | Missing | — | **Keep** → P4 (writes an F1 block rule) |
| F7 | SDK additions: `permission_denials`, tags, prewarm, "no human input" marker | Partial | SDK 0.3.289 has `permission_denials`, `tagSession`, `forkSession`, `prewarm`/`startup`, `taskBudget` (checked in `sdk.d.ts`) | **Keep** `permission_denials` → P1. Prewarm, session tags, "no human input" marker: **Defer** (relayed text already carries engine tags such as `[dispatch result]`) |
| G1 | Repo-owned workflow file | Missing | — | **Merge**: only the "project declares its checks" part → P3. Full YAML workflows: **Drop** (YAGNI) |
| G2 | Playbooks `/run <name>` | Done (equivalent) | a manual-trigger loop is a playbook | **Drop** |
| H1 | Per-loop daily run cap, "paused at cap" | Partial | `Bounds.budgetUsd` per fire; budget undercounts judge runs (known bug) | **Keep** → P1 (with the judge-cost fix) |
| H2 | Prompt regression evals | Missing | — | **Defer** (gate for E3 auto-apply, which is not proposed) |
| H3 | Ranked repo map in the brief | Done (equivalent) | dispatch preamble makes codebase-memory mandatory | **Drop** |

## 3. Neo vs new agents (`neo-vs-new-agents.md`)

| # | Idea | Maps to | Verdict |
|---|---|---|---|
| 1 | Dependable Telegram loop | §1 above | **Keep** (P0, only what is still open) |
| 2 | Heartbeat + morning brief with silence rule | spec 2026-07-23 item 12; `secretary` loop is a decisions-only digest | **Keep** → P2 |
| 2b | Commitment check-ins | spec item 13 | **Defer** (needs an extraction pass; P2 first) |
| 3 | Automations from chat | `tools/create-loop.ts`, `loop-validate.ts` | **Keep** → P5 (company proposes a loop as a decision; operator taps to create) |
| 4 | Per-connector read/send/deny + Codex gap + `/audit` | F1, P0, spec item 8 | **Keep** → P0 / P4 |
| 5 | Corrections → skills | E1–E3 | **Keep** → P7 |
| 6 | Named departments | worker profiles, memory scopes | **Keep** → P8 |
| 7 | Memory controls (show/forget/pin) | memory MCP tools exist; no operator command | **Keep** → P2 (`/memory`) |

## 4. One-person company (`neo-one-person-company.md`)

| Idea | Status | Verdict |
|---|---|---|
| Work board (goals → items → verifier) | Partial: `project_todos` (ADR-0008) | **Keep** → P8, extend `project_todos`, never a second table |
| Verifier-gated done | P3 checks | **Merge** into P3 |
| Departments as config | Partial: `workers` profiles, `memory.scopes` | **Keep** → P8 |
| Evening plan / morning brief / weekly review | P2 brief | **Keep** brief → P2; evening plan + weekly review → P8 |
| Earned autonomy L0–L3, computed and applied by the engine | Missing | **Drop** auto-promotion: autonomy must widen only by an operator tap (same rule as F3). The *offer* is P4 F3 |
| Facts store / "never do X" | memory + P4 F6 | **Merge** |
| Operator-only policy changes | Done: admin-gated web, TOFU admin | — (invariant, kept) |
| Finance department | MVP Phase 4 (`finance.ts` port) | **Defer** to its own Phase 4 plan |

## 5. Channels + Neo Deck (`neo-channels-design.md`, `channels-research-notes.md`)

| Idea | Status | Verdict |
|---|---|---|
| Answer `AskUserQuestion` with option buttons | **Done** (structured questions, `structured-question.ts`) | — (research was stale) |
| Any channel answers an approval, first answer wins | Missing | **Keep** → P0 (engine-owned pending-approval registry) |
| Typed yes/no resolves an open approval | Missing | **Keep** → P0 |
| Coloured Allow/Deny, disable after tap | Partial (buttons removed after tap) | **Keep** → P0 (Bot API `style`) |
| Full `OperatorHub` + `Channel` interface refactor | Partial: `operator-bus.ts` | **Defer**: worth it when a third operator channel is wanted; P0 builds its first piece (shared pending approvals) |
| Progress card edited in place | Partial: tool lines filtered, progress digest (ADR-0007) | **Defer** |
| Neo Deck PWA / Telegram Mini App | Overlaps the open Agent View plan (2026-09-06) | **Merge**: no new plan; add a Mini App `initData` entry to that plan's Phase C when it is approved |
| ntfy / Web Push / Pushover / email digest / Slack | Missing | **Drop** for now: the unmuted Decisions group already is the push channel |
| Voice notes → transcription | Missing | **Defer**: an AI read needing a provider-router route and a provider choice (operator) |
| Plan approval pre-authorises listed steps | Missing | **Drop**: conflicts with per-call default-escalate; P4 "This task" grants give the same relief inside the governor |
| Focus per operator (not per chat) | Rejected | **Drop**: spec 2026-07-21 kept routing per surface on purpose |
| Passkey login / run without Telegram | Missing | **Defer** |
| Generative UI (A2UI, MCP Apps, AG-UI) | Missing | **Drop** (research itself says not yet) |

## 6. Items dropped because a standing decision says no

- Screen-driving cloud computers, skill marketplaces, self-modifying engine code, cross-tenant
  memory, a classifier as approval authority — rejected in the research and in spec 2026-07-23 §5.
- Anything that moves customer I/O off Gemini or gives customer text a tooled worker — CLAUDE.md
  firewall.
- Re-opening subscription compliance — CLAUDE.md "do not re-litigate".
