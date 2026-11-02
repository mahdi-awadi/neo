# World-class multi-project coding agent: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Read `CLAUDE.md` first.

**Status:** PLAN ONLY. Waiting for operator approval. No engine code is changed by this document.

**Source:** the research report `docs/research/reports/Neo world class coding agent.md` (2026-11-02)
and its nine notes under `docs/research/research_notes/Neo world class coding agent/`. The report
has the evidence and the status of every idea (Done / Partial / Missing / Planned / Rejected). This
plan turns its 20-item roadmap into phased, TDD engine work.

**Relation to earlier plans:** this plan **absorbs** `docs/superpowers/plans/2026-10-04-neo-research-improvements.md`
(P0–P8) and the proposals A–H in `docs/research/2026-11-02-dsh-superagent-and-neo-improvements.md`.
Where a task below already exists there, it is referenced by its old number and not restated; where
the research changed it, the change is stated. The superseded-by table at the end maps every old item.

**Goal:** the operator's five stated problems, in order. (1) Bugs are found at the cause, not the
symptom. (2) Work and knowledge flow between projects, and the engine acts across dev, production
and several hosts without a worker ever touching prod. (3) Tokens, cost and time are spent on
verified work only. (4) "Done" is assigned by the engine, never read from a worker's prose.
(5) Knowledge lives in indexes the engine owns (code, history, decisions, incidents), not in a
model's memory.

**One move, applied at every seam:** record the fact, verify it in code, and only then let it flow.
A report is a claim until the gate runs. A cause is a record before an edit. A deploy is a state
machine only an operator message can advance. A commit carries its trace id. An incident is a row
the next worker searches.

**Architecture:** every phase is a deterministic engine change (ledger, governor, dispatch, loops,
producers, frontends, in-process MCP tools). AI stays inside workers. The engine gates, runs
commands, counts, routes and records. Each phase lands behind config with today's behaviour as the
default, so an un-configured daemon behaves exactly as now.

**Tech stack:** Bun + TypeScript, `bun:sqlite` ledger (next schema = migration 9), grammy,
`@anthropic-ai/claude-agent-sdk` 0.3.291 (pinned; latest 0.3.316), `@openai/codex-sdk` 0.145.0
(pinned). Meilisearch + vector DB + codebase-memory MCP run **outside** `src/` as services.

## Global constraints

- No AI in the engine. A gate, a check, a lint, a matcher or a counter is code. Judgement runs in a
  worker. The engine never parses a worker's prose to decide a status.
- Customer firewall unchanged: `source:"customer"` never reaches the subscription; customer text
  never reaches a worker with tools (`TAINTED_DISALLOWED_TOOLS`, no MCP, auto-memory off).
- Governor stays default-escalate (ADR-0006, hook first). A new rule may only make it stricter on
  autonomous paths. Trust never lifts a fence (ADR-0011). Autonomy widens only by an operator tap or
  command, never by worker text, a loop or a timeout.
- Prod is reachable only through engine-owned tools backed by credentials the engine holds. No
  worker ever gets a prod shell, a prod key or a prod secret. Break-glass is operator-only.
- No hardcoding: every number, path or token is a `config.json` knob with env → file → default
  precedence (`src/config.ts`) and a `docs/CONFIG.md` entry. Defaults keep today's behaviour.
- Never a second table for the same thing: acceptance rides on `project_todos`; the attention table
  (ADR-0018) stays the one board; the `events` table stays the one audit trail; no second memory
  store, no engine-side embeddings, no second code-intel MCP (spec 2026-07-23 §8).
- Restart-gated: every phase changes daemon code. Report "needs a restart" and stop. Never restart
  without the operator (ADR-0009).
- Branch per phase off `master` (`feat/wcca-<N>-<slug>`); never commit to `master` directly.
  `bunx tsc --noEmit` + `bun test` green before a task is done. One commit per task. Commit trailer:
  the model that actually wrote the commit.
- Each phase opens with its DESIGN step: `CONTEXT.md` terms + one ADR per real decision with the
  rejected alternatives. Docs land in the same commit as the behaviour (`docs/CONFIG.md`,
  `docs/HISTORY.md`, `docs/loops.md` for loops, `README.md` where it lists commands).
- Preamble ceiling: `briefWithProjectDocs` is 4,521 of 5,000 chars. Any new preamble line either
  displaces text or the ceiling is re-decided by the operator in its own ADR (decision 10). Never
  nudge the ceiling test.
- Operator-facing console text follows the engineering baseline (i18n catalogues, AR + EN).
  Telegram lines go through `format.ts` / `priority.ts`.

## Phase order and why

| Phase | What | Size | Why this position |
|---|---|---|---|
| **W0** | Activate and secure the baseline: operator restart, Codex fail-closed, SDK pin decision | S | Half of ADR-0012–0021 is merged but not running. Everything below is measured against the live baseline, not the merged one. |
| **W1** | Verified done: structured report, engine-assigned status, acceptance items, clean-checkout gate, assertion lint, fresh-context reviewer, cost per verified task | L | Feeds problems 1, 3 and 4 and every later phase. Absorbs P3 and dsh A. |
| **W2** | Find the bug: loop hygiene (P1), cause gate, `what_changed`, scoped observability MCP, reproduce-first fix gate, error-sweep as a product loop, incident rows | L | The operator's first problem. Needs W1's report as its output contract and P1's gate for the loop. |
| **W3** | Own the PR: `pr_links`, gated `pr-reactions`, etiquette | M | The biggest field gap for a coding agent; all primitives exist. Absorbs P5.3/5.4 and dsh B. |
| **W4** | Efficiency: honest accounting, cache prefix, context measurement from the SDK, subagent caps, docs audit, background-task wake spike | M | Measurable leaks, small knobs. Needs W1 for the cost-per-verified-task metric. |
| **W5** | Act across hosts: host registry, engine-owned deploy tools, `NEO_ENV`, environment-aware governor rules (first P4 content), deploy state machine | L | Problem 2's "act between servers" half, fenced. Needs operator decisions 6 and 7. |
| **W6** | Cross-project: `neo.yaml` registry, blast radius, change-sets, handoff files, contract gates, project inbox, `ask(project)` | L | Problem 2's "talk between projects" half. Needs W1 (done gate) and W5 (environments). |
| **W7** | Index the why: commit trailers, `history`/`decisions`/`incidents` indexes, one search MCP with a project filter, memory write-protection, `/memory`, corrections → checks | M–L | Problem 5's new value. Most work is in the index service, not `src/`. Needs W2's incident rows. |
| **W8** | Optional and gated: worktree per todo (P6), `dispatch_many`, UI before/after evidence, static-analysis signals, company layer (P8) | L | Only when the operator wants parallel work on one project; P8 keeps its own spec first. |

**Plan depth:** W0–W3 are written as full task tables (files, interfaces, tests that must pin).
W4–W8 list tasks, files and pinning tests; before each is built it gets its own expansion
(`docs/superpowers/plans/<date>-wcca-w<N>.md`) against the code as it is then.

## Operator decisions this plan needs (asked through `ask_operator` at the phase that needs them)

1. **W0:** the restart that activates ADR-0012–0021 (migrations v5→v8), per the restart checklist
   in `HANDOFF.md`.
2. **W0:** bump the SDK pin to ≥ 0.3.311 (non-retryable-error fix, `blockWritesOutsideWorkingDirectories`,
   `McpServerToolPolicy`; note 2.1.302 flips SDK subagents to foreground-by-default). Needs its own restart.
3. **W0:** Codex fail-closed default (`approvalPolicy: "never"`, `sandboxMode: "read-only"`,
   `networkAccessEnabled: false`); whether any folder may opt into `workspace-write`.
4. **W2:** `ask_operator` for loop workers (old P1 task 1.7; ADR-0004 rejected it for cost).
5. **W2:** the observability stack (Grafana/Loki/Tempo vs SigNoz; GlitchTip vs self-hosted
   Sentry) and the data policy: may redacted production telemetry be returned to a subscription
   worker at all. Redaction happens in the log pipeline, before any MCP.
6. **W5:** prod access shape: a forced-command `neo-deploy` user per host (recommended) vs a
   runner per host; whether any host may ever run a worker locally (default: never).
7. **W5:** the governor's prod rule set (the first real `policy_rules` content). It narrows the
   `RISKY_BASH` keyword net into precise denies and widens nothing.
8. **W6:** more than one todo at a time per project via worktrees (old decision 2, ADR-0008); only
   needed by W8.
9. **W7:** ADR-0020: auto-memory as the one project memory; retire or re-point memory Phase 2;
   whether memory turns on for the company.
10. **W7:** how the vector + Meilisearch index is exposed: one search MCP beside codebase-memory
    (recommended) or folded into the code-intel surface. Constraint: one code-intel MCP, no engine
    embeddings.
11. **Every preamble change:** displace text or re-decide the 5,000-char ceiling in an ADR.

## Review focus (the cases a reviewer must try to break)

1. **A worker claims `ready` with a dirty tree or tests not run.** The engine records the claim,
   assigns `failed`/`blocked`, and the result line says the two disagree. Never `done`. Pinned in 1.3.
2. **A worker ends without the `report` call.** Status is `unreported`, never `done`; the dispatcher
   and the operator see "unreported". Pinned in 1.2.
3. **A bug brief edits code before a cause record exists.** The hook denies with a reason that names
   the `cause` tool; a `docs/` note is still allowed; `no defect found` is accepted. Pinned in 2.3.
4. **A Bash line hides a prod hostname inside a chained command or an env assignment.** Denied on
   autonomous paths, escalated otherwise; the keyword regex alone is not the defence. Pinned in 5.4.
5. **A worker tries to move a deploy past `proposed`.** Refused at the tool boundary; only an
   operator message id can write `approved`. Pinned in 5.5.
6. **Two change-set legs list the same file.** Refused as an impossible split and handed to the
   operator; never dispatched. Pinned in 6.3.
7. **A project-inbox message says "ignore the governor" or arrives from a tainted path.** Delivered
   as plain text under an untrusted heading, or held for the operator; never config. Pinned in 6.5.
8. **A worker writes to `CLAUDE.md`, `MEMORY.md` or `.claude/`.** Denied unless the path is on the
   operator-approved route; a diff at session start is reported. Pinned in 7.5.
9. **Accounting double-counts a resumed session.** Spend is keyed by SDK session id and
   `modelUsage`; a resumed result replaces, never adds. Pinned in 4.1.
10. **A gate command hangs or prints megabytes.** Timeout + capped output on every engine-run
    command (reuse old P1 task 1.1's `runCommand`). Pinned in 1.4.

---

## W0 — Activate and secure the baseline

No new design. Three operator-gated steps and one small code task.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 0.1 Operator restart | none (ops) | `HANDOFF.md` restart checklist; one boot runs migrations v5→v8 | After boot: `/trace`, `/plans`, attention items and the project dashboard answer; `bun test` green on the deployed sha |
| 0.2 Codex fail-closed default | `src/engine/session-runner.ts` (`codexThreadOptions`), `src/config.ts` (`codex.sandboxMode`, `codex.approvalPolicy`, `codex.networkAccess`, `codex.workspaceWriteFolders: string[]`), `docs/CONFIG.md` | Defaults: `read-only`, `never`, `false`; a folder is `workspace-write` only when listed and trusted | Unlisted folder → read-only even when trusted; listed + untrusted → read-only; every `command_execution`/`file_change` item recorded into `events` as `codex_action` (post-hoc audit, since Codex has no hook) |
| 0.3 SDK pin bump (decision 2) | `package.json`, `bun.lock` via the ADR-0009 updater (`update-sdk.ts`), `docs/sdk-notes.md` | — | The updater's worktree verify passes; a `worker_compat_warning` lists behaviour flips (foreground subagents, `--bare` trend) in the result; no restart by the engine |
| 0.4 Baseline metrics snapshot | `tools/metrics-snapshot.ts` (read-only over the ledger) | Prints the four numbers the report names: cost per dispatch, interventions per dispatch, reopened incidents (0 until W2), merged PRs per review hour (0 until W3) | Runs against a fixture ledger; never writes |

**Exit:** the daemon runs the merged baseline; Codex cannot write or reach the network unless the
operator listed the folder; the four metrics have a "before" value.

---

## W1 — Verified done

**DESIGN:** terms **Claim** (the worker's structured end-of-work report), **Verdict** (the status
the engine assigns after the gate), **Check** (a project-declared command), **Acceptance item**
(one schema-validated criterion on a todo with an engine-only `passes` flag), **Evidence** (command,
exit code, bounded output). ADR `0022-done-is-assigned-by-the-engine-never-read-from-prose.md`.
Rejected: parsing the worker's last paragraph; a hard deny on editing test files (TDD convention);
a second-vendor reviewer (no measured gain over a fresh same-model session).

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 1.1 `report` tool (dsh A) | `src/engine/report-tool.ts` (new, pure Zod schema + normaliser), wired in `dispatch.ts` `neoMcpServers` beside `ask_operator`; attached on operator paths only | `Claim { status: ready\|blocked\|failed\|dropped\|handback; summary (≤ 240 chars); ran: {cmd, exit}[]; changed: string[]; ref: {pr?\|commit?}\|null; risks: string[]; assumptions: string[]; handback?: {reason} }` | Schema rejects a missing status, a bundled multi-status, a placeholder PR number, a summary over the cap; `handback` requires a reason; customer paths never get the tool |
| 1.2 Claim stored, `unreported` fallback | `dispatch.ts` settle path, `ledger.ts` (`dispatch_end` gains `claim` JSON + `verdict` + `verdict_reason`), migration 9 | `Verdict = Claim.status \| "unreported" \| engine override` | A run that settles with no claim → `unreported`; the dispatcher inbox line and the operator result both say so; never `done` |
| 1.3 Project checks + clean-checkout gate (old P3.1/3.2, sharpened) | `src/engine/checks.ts` (new): read `<folder>/.neo/checks.json`; `src/engine/verify.ts` (new): run checks in a **clean worktree** at HEAD (extract the worktree steps from `update-sdk.ts`, never copy), bounded by `runCommand` (old 1.1) | `resolveChecks(folder, override?)`, `verify(folder, claim): Verdict + Evidence[]`; `dispatchCheckRetries` (default 2): on failure the same session is resumed with the failing output | Dirty tree + `ready` → `blocked` with reason "uncommitted changes"; checks fail → resume up to N, then `failed`; "no checks declared" is shown, never green; the worktree is removed after the gate (worktrees are temporary) |
| 1.4 `Stop` hook keeps the turn alive while the gate fails | `session-runner.ts` hooks (beside the governor hook) | `Stop` → `decision: "block"` with the failing evidence, capped by `stopHookMaxContinues` (default 8, the SDK cap) | A failing gate blocks the stop with the evidence text; the cap ends it as `failed`; a passing gate never blocks; hooks stay synchronous and never throw (fail-open proven in ADR-0006) |
| 1.5 Evidence in the result line (old P3.3) | `dispatch-report.ts` | `✓ 2/2 checks · +120 −30 in 6 files · $1.84 · claim ready = verdict ready`, or `✗ bun test exit 1 · claim ready ≠ verdict failed` | Priority stays `result`; the disagreement form is pinned; chunking survives tables |
| 1.6 Acceptance items on todos | `todo-queue.ts`, `project_todos` gains `acceptance` (JSON array of `{id, text, check?: string[]}`) + `passes` (JSON) in migration 9; the `dispatch`/`todo` tools accept `acceptance` | Only `verify()` flips `passes`; a worker cannot (no tool exposes it) | Items with a `check` flip on exit 0 in the clean checkout; items without one stay `unverified` and are listed; JSON, not Markdown, per the harness-design finding |
| 1.7 Assertion-weakening diff lint | `src/engine/diff-lint.ts` (new, pure): scan the settle diff for deleted test files, deleted `test(`/`it(`/`expect(`, `.skip`, `.only`, `--no-verify`, `// @ts-ignore` added in src | `lintDiff(diff): Finding[]`; findings ride on the result line and the ledger, never deny | A deleted assertion is flagged; a test file edited to add a case is not; `.only` left in is flagged; zero findings prints nothing |
| 1.8 Fresh-context reviewer with gate evidence (old P3.4 re-pointed) | `goal.ts` `judgePrompt`, `worker-profile.ts` `judge` profile; an `AgentDefinition` with `tools: ["Read","Grep","Glob"]`, `omitClaudeMd` optional | Input: the diff + `Evidence[]`, never the worker's transcript; output: `DEFICIENCY:` lines (capped `judgeMaxDeficiencies`) | The reviewer has no write tools (governor denies even if asked); deficiencies are parsed in order; "skip style" is in the rubric; cost is booked to the dispatch |
| 1.9 Cost per verified-solved task | `ledger.ts` derived query; `/usage` and the project dashboard gain the number | `verifiedCostUsd(project, window)` = sum of dispatch cost incl. retries and reviewer where verdict = ready | Retries are included once; an `unreported` run counts as unsolved; the number matches a fixture by hand |

**Exit:** no dispatch is "done" unless the engine ran the project's checks and they passed; every
result shows the claim beside the verdict; the ledger holds the evidence.

---

## W2 — Find the bug

**DESIGN:** terms **Cause record**, **Reproduction gate**, **Incident**, **What-changed window**,
**Observability profile**. ADRs `0023-a-bug-fix-starts-with-a-cause-record.md` and
`0024-production-is-diagnosed-through-read-only-tools-fenced-at-the-data-layer.md`.
Rejected: a summariser over bulk telemetry (the Datadog finding); a mutation-testing gate on every
dispatch (marginal over coverage); an AI triage classifier in the engine.

**2.0 Loop hygiene first (old P1, unchanged):** tasks 1.1–1.6 of the 2026-10-04 plan
(`LoopDef.gate`, `runCommand`, script-only loops, silence token, `at` trigger, honest judge
budget + daily cap, permission denials in the digest) plus the ADR-0004 gaps: loop prompts get the
dispatch preamble behind `LoopDef.preamble: true` (default false, so no built-in is re-priced) and,
by decision 4, `ask_operator`. The error-sweep below needs the gate, the budget and the preamble.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 2.1 Brief kind | `dispatch` tool gains `kind: feature\|bug\|chore\|investigate` (default `feature`); stored on the todo and the order | `Order.kind` | A bug brief is the only kind that arms 2.3; the company's brief writer is told the field exists (tool description, not preamble) |
| 2.2 `cause` tool | `src/engine/cause-tool.ts` (new, Zod), attached with `report` | `Cause { file, line, condition, firstWrongState, whyUpstream, rejected: string[] } \| { noDefectFound: {evidence} }` stored in `events` as `cause_recorded` with cause id | Schema rejects a cause without `whyUpstream`; `noDefectFound` needs evidence; one cause per brief may be revised (new row, same brief) |
| 2.3 Cause gate in the governor | `governor.ts` `decide()` (one shared rule for hook + `canUseTool`, ADR-0006) | For `kind: bug` and no cause row: `Edit`/`Write` under the project → deny with reason naming the tool; paths under `docs/`, `.neo/` and test files stay allowed (reproduction first) | Review focus 3; the rule is inert for other kinds; customer paths unchanged (zero tools) |
| 2.4 Reproduction gate | `verify.ts` gains `reproduce(folder, test, base, head)`: run the named test at the base commit (clean worktree) and at HEAD | `Verdict` for a bug claim requires fail-on-base then pass-on-head; otherwise `blocked: "no failing-then-passing test"` | A test that passes on base is refused; a flaky test (two runs disagree) is reported as flaky, not fixed; the worktree is removed |
| 2.5 `what_changed(project, since)` | `src/engine/what-changed.ts` (new, pure over `git-read.ts` + ledger), exposed as an in-process MCP tool on operator paths | Returns commits (all tracked repos of the project and its `dependsOn` once W6 exists), lockfile/dependency diffs, config and `.env.example` diffs, migrations, and ledger events (deploys from `probe`, updater runs, loop fires, approvals) in the window | Bounded reads with timeouts; a non-repo folder returns only ledger events; the output is capped and says so; `since` accepts a sha, a date or `last-deploy` |
| 2.6 Scoped observability MCP profile | `pipeline.ts`/`dispatch.ts` `neoMcpServers` gains `observability` (opt-in like `playwright`); `config.json` `observability: { kind: grafana\|signoz\|sentry, args, enforcedMatchers }` | For Grafana: `--disable-write`, `--loki-enforced-matchers {project="<folder>",env="<env>"}`; operator paths only; tools default-escalate on autonomous paths unless allow-listed in the governor | The server is never attached on ingress/customer paths; the matchers are derived from the folder, never from the brief; a missing binary degrades to "observability unavailable" in the brief, never a crash |
| 2.7 Count-first + hypothesis lines | `dispatch.ts` preamble (decision 11) | One line: count before query (`query_loki_stats` first), one hypothesis per query, recurse until exhausted; one line: a bug brief ends with a cause record | `tests/dispatch.test.ts` ceiling test unchanged unless an ADR raises it; the lines are present only when `observability` or `kind: bug` applies (assembled, not static) |
| 2.8 `incident` rows | migration 9: `incidents(id, project, fingerprint, source, trace_id, cause_id, fix_sha, test_path, what_changed_from, what_changed_to, opened_at, resolved_at, reopened_count)`; `ledger.ts` CRUD | Written by the error-sweep (2.9) and by any bug dispatch whose verdict is `ready` | Same fingerprint reopened → `reopened_count` +1, never a second row; indexed by `(project, fingerprint)` and `(resolved_at)` |
| 2.9 Error-sweep as a product loop | `loops.ts`: `error-sweep` becomes a per-project loop definition (data, via `tools/create-loop.ts`), gated (2.0) on "new fingerprint since last run" from the tracker read (GlitchTip/Sentry/Grafana via 2.6), selection top-N by events × users × recency with no open todo, `errorSweepMaxSessionsPerDay` | Output contract: a todo with reproduction + hypothesis, or a PR only when 2.4 passed; dedupe by `(project, fingerprint)` | A fingerprint with an open todo is skipped; the daily cap pauses with a digest line; the loop never pushes or deploys (standing rule); a cross-service finding opens a ticket, never a PR |
| 2.10 Nightly action-item sweep | a built-in script-only loop (2.0): every incident with no linked todo or no `test_path` after `incidentActionGraceDays` → attention item | — | Pure ledger; zero model tokens; one attention row per incident, reconciled (ADR-0018) |
| 2.11 Bisect step | `docs/loops/` recipe + a `what_changed`-driven brief template: `git bisect run` with a worker-written oracle script under `.neo/` | — | The oracle is reviewed by 1.7's lint (no `exit 0` stub); bisect runs in a clean worktree |

**Exit:** a bug dispatch cannot edit code before naming a cause, cannot be "fixed" without a
failing-then-passing test, can ask "what changed since the last deploy", can read production
telemetry through a fenced read-only tool, and leaves an incident row that the next worker and the
nightly sweep can find.

---

## W3 — Own the PR to the end

**DESIGN:** terms **PR link**, **Reaction**, **Round**. ADR `0025-the-session-that-opened-a-pr-owns-it-until-it-closes.md`.
Rejected: GitHub webhooks (ADR-0018 keeps polling); a per-PR babysitter loop; auto-merge of any kind.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 3.1 `pr_links` (old P5.3) | migration 9: `pr_links(repo, pr, folder, todo_id, sdk_session_id, branch, state, rounds, created_at, closed_at)`; written after settle from `gh pr list --head <branch> --json number,url,state` | — | No `gh` or no PR → no row, no error; reopened PR → same row |
| 3.2 Owner resolution | `reply-routing.ts` `deliverIntoFolder` gains `byPrLink(repo, pr)`; a closed session resumes by `sdk_session_id` (cross-SDK guard applies) | — | A PR with no link → attention item only (today's behaviour); a link to a dead session restarts cold with the PR context, once |
| 3.3 `pr-reactions` gated loop (old P5.4) | built-in loop, disabled by default; gate (2.0) runs `gh pr checks` + new review comments for open links; on a failed check or a human comment it delivers the log/comment into the owning session; `prReactionMaxRounds` then raises a decision | Round = one distinct CI run or one review submission, counted on the row across restarts | A green PR never wakes a worker; bot comments count toward the cap but never authorise work; after N rounds the operator gets one decision, not a stream |
| 3.4 Etiquette lines | preamble (decision 11) or a `.claude/rules/pr.md` shipped by the engine on operator paths | Resolve a fixed thread silently; one factual reason for a declined suggestion; never a top-level "fixed everything" comment; report ready without waiting for merge; the operator merges | Assertion on the assembled preamble; the rule file is path-scoped so it costs nothing off-PR |
| 3.5 One merge/close notice | `producers/github.ts` + priority `result` | When a linked PR merges or closes: one line to the Decisions channel with the todo and verdict; the row is `closed` | Exactly one notice per PR across restarts (dedupe by row state) |
| 3.6 Merged-PRs-per-review-hour metric | `ledger.ts` derived query from `pr_links` + decisions answered | — | Matches a fixture; shown in `/usage` |

**Exit:** CI failures and review comments reach the session that opened the PR, bounded by rounds,
with the operator seeing one decision and one outcome per PR.

---

## W4 — Efficiency

**DESIGN:** terms **Spend window**, **Stable prefix**. ADR `0026-spend-is-keyed-by-sdk-session-and-persisted.md`.
Rejected: Economy mode on any code-writing path (spec 2026-07-23 §8 stands); a model router in
the engine.

| Task | Files | Pins |
|---|---|---|
| 4.1 Accounting on `modelUsage`, persisted window, judge counted | `budget.ts` (window rows in the ledger keyed by SDK session id; a resumed result **replaces** the row), `loop-runner.ts` (judge cost added), `session-runner.ts` (read `modelUsage`, `costBasis`) | Review focus 9; restart keeps the window; judge cost appears in the loop digest and against `Bounds.budgetUsd`; `/usage` shows interactive vs background from `workClass` |
| 4.2 Stable cached prefix | `dispatch.ts` brief assembly order: preamble → project docs pointer → brief; no timestamp, run id or queue position above the brief; `subagentPromptCacheTtl` knob per worker profile (`workers.<path>.subagentCacheTtl`, default unset) | A test pins that the first N chars of two briefs for the same folder are identical; `ephemeral_1h_input_tokens` is recorded per run into `cache_observations` |
| 4.3 Context from the SDK | `context-policy.ts` reads `getContextUsage({detail:'summary'})` when the SDK offers it, JSONL parsing stays as fallback; `PreCompact` hook archives the transcript path + a task-state snapshot into the ledger; `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC=1` in `workerEnv` by default | Occupancy from the SDK equals the fixture; a compaction leaves a `compact_boundary` event with `pre_tokens`; GC does not delete a transcript a handoff still needs |
| 4.4 Subagent contracts and caps | `agent-teams.ts` and every engine-shipped `AgentDefinition`: `maxTurns`, `omitClaudeMd` for searchers, an explicit return contract (evidence `path:line`); `workers.<path>.maxBudgetUsd`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` in `workerEnv` | A searcher definition has no write tools; the budget refuses spawn at the cap and the result says so |
| 4.5 Docs-audit loop | `docs-sweep` gains a script gate: flag `CLAUDE.md` > 200 lines, `.claude/rules` missing path scopes, ADRs that conflict with a newer one without `Superseded`; report-only | Zero tokens when nothing is flagged; findings are attention items |
| 4.6 Background-task wake spike | `docs/sdk-notes.md` + a `tests/sdk-live/` probe (skipped in CI): does a streaming-input session parked idle wake on `task_notification`? | If yes: the preamble's no-background-wait line relaxes for commands the engine can see (`task_started`/`task_progress` count as activity in `liveness.ts`); if no: the contract stays and the note says why |
| 4.7 `startup()` prewarm (deferred unless cheap) | `session-runner.ts` | Only if the spike in 4.6 shows the subprocess handshake dominates dispatch start |

**Exit:** the budget survives a restart, the judge is counted, a dispatch's prefix is cacheable,
context is measured by the SDK, and the ledger reports cost per verified task.

---

## W5 — Act across hosts (dev, staging, production)

**DESIGN:** terms **Host**, **Environment**, **Deploy tool**, **Deploy state**, **Break-glass**.
ADRs `0027-production-is-reached-only-through-engine-owned-tools.md` and
`0028-a-deploy-is-a-state-machine-only-an-operator-message-advances.md`. Rejected: a runner on prod
hosts (until the SSH surface proves insufficient); Docker's TCP port 2375; worker-held SSH keys;
agent-enabled auto-merge or auto-deploy.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 5.1 Host registry | `config.ts` `hosts: { <name>: { ssh: user@host, dockerContext?, env: dev\|staging\|prod, projects: string[] } }`; migration 9: `hosts(name, env, last_heartbeat, versions JSON)`; `producers/probe.ts` heartbeats each host through the `health` tool | `deploy:<project>:<env>` replaces `deploy:<project>`; per-environment `deployedVersionUrl` in the project config | Unreachable host → attention item "host unreachable"; "N commits not deployed to prod" item from the existing commits-since read; the dashboard shows versions per env |
| 5.2 Engine-owned deploy tools | `src/engine/deploy-tools.ts` (new): in-process MCP tools `deploy_pull`, `deploy_up`, `deploy_rollback`, `prod_logs`, `prod_health`; implementations shell to `ssh <neo-deploy@host> <verb> <project>` using a key path from `.env` (`NEO_DEPLOY_KEY`) that only the engine reads | On the host: a `neo-deploy` user, `authorized_keys` with `restrict,command="/usr/local/bin/neo-deploy-shim"`; the shim accepts only `pull\|up\|rollback\|logs\|health <project>` | The key path is never in `workerEnv`; a tool call with an unregistered project is refused; output is bounded; every call is an `events` row with cause |
| 5.3 `NEO_ENV` injection | `worker-profile.ts`: `workerEnv.NEO_ENV` from the registry for the folder (absent = `dev`); `SessionStart` hook writes it to `CLAUDE_ENV_FILE` | A worker cannot override it (the governor denies `export NEO_ENV=` in Bash) | A folder with no host → `dev`; the project baseline rule "unknown env = startup error" is a preamble line already (engineering baseline item 2) |
| 5.4 Environment-aware governor rules (first P4 content) | `policy_rules` table + `src/engine/policy.ts` (old P4.1/4.2, unchanged shape); seed rules from the registry: Bash containing a prod host, a prod Docker context, `ssh <prod>`, `DOCKER_HOST=ssh://`, `kubectl --context <prod>`, paths under `deploy/prod/` → `deny` on autonomous paths, `ask` otherwise | `matchRule` runs before `RISKY_BASH` (which stays as defence in depth) | Review focus 4; chained and env-prefixed commands are caught; a trusted folder is still denied on autonomous paths; customer paths unchanged |
| 5.5 Deploy state machine | migration 9: `deploys(id, project, env, host, digest, prev_digest, state, approved_by_msg, cause, at)`; states `proposed → approved → deploying → verifying(1/2) → live \| rolled_back`; `deploy-tools.ts` only ever creates `proposed`; the Telegram/web reply to the proposal card writes `approved` with the operator message id | Verification: `prod_health` sampled over two consecutive windows (`deployVerifyWindowMs`, default 5 min); breach = health failing or error rate > `deployErrorRateFactor` (2×) of the pre-deploy baseline in both windows → `deploy_rollback` to `prev_digest` | Review focus 5; a single breached window does not roll back; rollback needs no rebuild (digest); every transition carries a cause; a daemon restart mid-deploy resumes from the stored state at boot |
| 5.6 Break-glass | the same tools with `force: true` + a cause id; only the admin's chat may invoke; ledgered as `alert` | Proposable by a worker (a decision card), never executable by one | A worker calling with `force` is refused at the tool boundary |
| 5.7 Secrets per environment | docs + `/audit` check (old P4.7): prod secrets exist only on the prod host (SOPS/age or `.env` chmod 600 there); the dev server holds no prod key | — | `/audit` flags a prod key found under `/home` |

**Exit:** the operator can say "deploy X to prod" and the engine proposes, the operator approves,
the engine deploys by digest, verifies over two windows and rolls back on breach, while no worker
ever held a credential or a shell on prod.

---

## W6 — Cross-project

**DESIGN:** terms **Project registry** (`neo.yaml`), **Blast radius**, **Change-set**, **Leg**,
**Handoff file**, **Project inbox**. ADR `0029-a-cross-project-change-is-a-change-set-the-engine-orders.md`.
Rejected: a second board; Claude Code cross-session sockets (headless workers cannot reach them);
a transaction across repos (no product does it; legs are sequenced and verified instead).

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 6.1 `neo.yaml` registry | `src/engine/project-registry.ts` (new): read `<folder>/neo.yaml` with Backstage field names (`kind`, `spec.type`, `spec.lifecycle`, `spec.owner`, `spec.providesApis`, `spec.consumesApis`, `spec.dependsOn`) + `environments: { dev: {host, deployedVersionUrl}, prod: {...} }`; merges with the existing per-project config (never a second place) | `registry(): Project[]`, `blastRadius(project): Project[]` (`dependencyOf` closure) | A dangling `dependsOn` → attention item; a cycle is reported, never looped; a project without `neo.yaml` behaves exactly as today |
| 6.2 Change-set record | migration 9: `changesets(id, cause, contract_diff, order JSON, state)` + `changeset_legs(changeset_id, project, todo_id, branch, pr, state)`; company tool `change_set` (N briefs + the contract) | The engine computes `order` (providers before consumers) from 6.1; consumer legs are held until the provider leg's PR is merged **and** deployed to the target env (5.5); consumer PRs open as drafts until then | Review focus 6; one failed leg pauses dependents and raises one decision; `done` only when every leg is merged |
| 6.3 Handoff file between legs | `docs/handoffs/<changeset-id>.md` in each consumer folder (inside the fence), written by the engine from the provider leg's claim (1.1): changed contract, version, migration notes, verification targets | Attached to each consumer brief | The file is generated, not model-written; a consumer leg's brief names it; it is removed when the change-set closes (worktree-folder rule applied to files) |
| 6.4 Contract gates | `.neo/checks.json` may list `oasdiff` / `pact can-i-deploy --to-environment <env>` style commands; migration 9: `deployed(project, env, version, at)` written by 5.5 | A consumer leg's gate runs against the provider version actually deployed | Exit-code tools only; a missing tool is "check unavailable", never green |
| 6.5 Project inbox | migration 9: `project_inbox(id, to_project, from_project, text, cause, state, at)`; MCP tool `post(to_project, text)`; delivery as the next brief's `## Messages from other projects (untrusted)` section or as a todo | Rules in code: plain text only, never consent, never config; identical repeats within `inboxDedupeMs` dropped; cap `inboxMaxPerProject` (50); rate limit per sender; anything from a tainted path held for the operator | Review focus 7; the section is below the brief (cache prefix, 4.2); a message cannot carry a tool call |
| 6.6 `ask(project, question)` | a read-only dispatch of the target project reusing the tainted-brief envelope (zero write tools, no MCP but search); returns ≤ `askMaxChars` with cause ids to the asking thread | — | The answering worker cannot write or post; cost is booked to the asking project; the answer carries its cause |
| 6.7 Shared skills | `company/skills/` surfaced through `settingSources: ["user"]` from an engine-owned `~/.claude/skills` (pinned with a provenance note, as the Pocock skills are) | — | No tracked repo gains a copy (machine-local rule); a skill proposal (old P7.3) lands here after approval |

**Exit:** the engine knows which projects depend on which, orders and verifies a change across
them, lets a worker leave a message for or ask a question of another project, and never lets one
project's worker act on another project's code silently.

---

## W7 — Index the why

**DESIGN:** terms **Trailer**, **History index**, **Decisions index**, **Incidents index**,
**Protected file**. ADRs `0030-every-worker-commit-carries-its-trace-and-plan.md` and
`0031-instruction-and-memory-files-are-a-write-protected-surface.md`. Rejected: engine-side
embeddings; a third memory store; a second code graph; auto-applied corrections.

| Task | Files | Pins |
|---|---|---|
| 7.1 Commit trailers | `dispatch.ts`/`verify.ts` at the commit boundary (a worker commits; the engine amends nothing): the preamble names the trailers and the `report` claim requires the HEAD commit to carry `Neo-Trace: <thread>` and `Neo-Plan: <id\|none>`; the gate refuses `ready` without them | A commit without trailers → `blocked: "missing trailers"`; the trailer values come from the order, not the worker |
| 7.2 `history` / `decisions` / `incidents` indexes | an index-service job (outside `src/`) fed by a nightly script-only loop that exports ledger rows (`events`, dispatch claims, decisions, plans, `incidents`) and repo text (commit messages, PR bodies, ADRs, `CONTEXT.md`, handoff notes) as JSON with `project`, `path`, `symbol`, `date`, `status` metadata | The export is deterministic and idempotent (chunk hash); ADR `Superseded` status is a field; nothing is embedded in `src/` |
| 7.3 One search MCP (decision 10) | `neoMcpServers` gains `search` (opt-in like `playwright`): tools `search_code(q, project?)`, `search_history`, `search_decisions`, `search_incidents`, `search_all_projects(q)`; `project` filter defaults to the folder's project; per-query `semanticRatio` chosen by the tool from query shape (identifier-like → low) | A worker in A cannot get B's code without `search_all_projects`; tools are few and non-overlapping with codebase-memory; attached on operator paths only |
| 7.4 Index service layout (outside `src/`, documented in `docs/search.md`) | one Meilisearch index per project for code (filterable `project, path, lang, symbol, git_sha, mtime`), AST-aware chunks with class + imports, post-commit hook upserting by chunk hash; federated multi-search weights the current project higher | Documented, with the measured reasons from the report; the engine only calls the MCP |
| 7.5 Protected files | `governor.ts` rule: `Write`/`Edit` to `CLAUDE.md`, `MEMORY.md`, `.claude/**`, `memory/**` → deny on autonomous paths, escalate otherwise, unless the operator-approved route (a decision card with the diff) applies; `SessionStart` hook diffs these files against the last session and posts a line if they changed | Review focus 8; tainted briefs already disable auto-memory (unchanged); after the pin bump, `permissions.blockWritesOutsideWorkingDirectories` is set too |
| 7.6 `/memory` + typed corrections (old P2) | `commands.ts` `/memory [list\|forget <id>\|show]` over the auto-memory dir (ADR-0020) and Phase 2 files if kept (decision 9); a correction typed by the operator is stored as `feedback` | Only the admin; a forget is a ledgered event |
| 7.7 Corrections → checks (old P7, narrowed) | `correction` events (old 7.1); the dream loop proposes, per repeated correction, a **rule or check** (a `policy_rules` row, a `.neo/checks.json` entry or a `.claude/rules/*.md` line) as a decision card; never a prose memory line | Nothing applies without a tap; a correction seen once proposes nothing; the proposal shows the exact rule text |

**Exit:** "why does this code exist", "what did we decide", and "has this broken before" are
answerable by search over engine-owned indexes; instruction and memory files cannot be rewritten by
a worker; repeated corrections become checks.

---

## W8 — Optional and gated

| Task | Source | Gate |
|---|---|---|
| 8.1 Worktree per todo, `parallelSlots`, branch `neo/todo-<id>` binds the PR (3.1) | old P6.1/6.2, dsh F | decision 8 |
| 8.2 `dispatch_many` + synthesis todo | old P6.3 | 8.1 |
| 8.3 Before/after UI evidence as a claim artefact + console/network error check via Playwright | dsh H | decision 11 (preamble line) |
| 8.4 Static/architecture gates as report signals (Semgrep/CodeQL/dependency-cruiser findings indexed per path, never a verdict) | report §4 | a project declares them in `.neo/checks.json` with `signal: true` |
| 8.5 Company layer (goals on the board, departments, evening plan / weekly review) | old P8 | its own spec first |

---

## Superseded-by table

| Old item | New home |
|---|---|
| 2026-10-04 P0 (approval board, typed yes/no, `/now`) | unchanged, still P0; build before or alongside W1 (not re-planned here) |
| P0.4 Codex spike | W0.2 (fail-closed default, no spike needed: the SDK note confirms no hook surface) |
| P1 (zero-token loops) | W2.0 verbatim + preamble flag |
| P2 (brief, `/memory`) | brief unchanged (P2); `/memory` → W7.6 |
| P3 (verified done) | W1.3, 1.5, 1.8 (sharpened: clean checkout, engine-assigned status, evidence to the reviewer) |
| P4 (rules, `/never`, grants, offers, scan, `/audit`) | rules table + first content → W5.4; `/audit` → W5.7; grants/offers/scan unchanged (P4) |
| P5.1/5.2 (`/fire`, proposed loops) | unchanged (P5) |
| P5.3/5.4 (PR links, reactions) | W3 |
| P6 | W8.1/8.2 |
| P7 | W7.7 (narrowed to rules/checks, never prose) |
| P8 | W8.5 |
| dsh A (structured report) | W1.1/1.2 |
| dsh B (own the PR) | W3 |
| dsh C (result/ack rules) | W1.5 (result line) + a company prompt rule (no engine change) |
| dsh D (verbatim order + handback) | handback → W1.1 status; verbatim order → one brief section below the preamble (W4.2 order) |
| dsh E (observe mode for loops) | W2.0 as `LoopDef.observe` (read-only run, report only) |
| dsh F (worktree per todo) | W8.1 |
| dsh G (restart recovery note) | W1.2: a re-dispatch after `unreported`/abnormal end carries the line |
| dsh H (UI evidence) | W8.3 |
| dsh spike (background wake) | W4.6 |

## Metrics (the only benchmark that matters is the ledger)

Recorded by W0.4 before, and by `/usage` after each phase:

- cost per verified-solved task (W1.9), including retries and the reviewer;
- interventions per dispatch (decisions + escalations answered per `dispatch_end`);
- reopened incidents per fingerprint (W2.8 `reopened_count`);
- merged PRs per review hour (W3.6);
- claim ≠ verdict rate (W1.2), which should fall as the gates bite.

Each gate ships as a config flag with a measured reason. The weekly review is where a gate that no
longer earns its cost is switched off.

## Self-review

- **Coverage:** every roadmap item 0–20 in the report maps to a task: 0→W0.1, 1→W0.2, 2→W1,
  3→W2.2–2.3, 4→W2.5, 5→W2.6, 6→W3, 7→W2.0, 8→W2.8–2.10, 9→W4.1, 10→W4.2–4.3, 11→W4.6, 12→W5.1–5.4,
  13→W5.5, 14→W6.1–6.4, 15→W6.5–6.6, 16→W7.1–7.4, 17→W7.5–7.7, 18→W1.8 + W8.3/8.4, 19→W8.1, 20→W0.3.
- **Standing decisions untouched:** compliance; Gemini for customers; no AI in the engine; operator-
  only autonomy widening; never restart without permission; polling not webhooks; one todo per
  project unless decision 8; no model downgrade on code paths; worktrees temporary; trust never
  lifts the fence; timeout never means allow; loops never push or deploy; no second memory store,
  engine embeddings or second code-intel MCP.
- **Names checked across phases:** `runCommand` (W2.0 / old 1.1) is used by W1.3, 1.4, 2.4, 2.5,
  5.2; `Claim`/`Verdict` (W1.1/1.2) are used by 1.5, 1.6, 2.4, 2.9, 3.3, 6.2, 6.3, 7.1;
  `policy_rules`/`matchRule` (W5.4) are used by 7.5 and 7.7; `incidents` (W2.8) by 2.10, 7.2, 7.3;
  `deployed` (W6.4) is written by 5.5; `neoMcpServers` opt-in flags: `playwright` (exists),
  `observability` (2.6), `search` (7.3).
- **Migration 9 contents (one migration, all phases):** `dispatch_end.claim/verdict/verdict_reason`,
  `project_todos.acceptance/passes`, `incidents`, `pr_links`, `hosts`, `deploys`, `deployed`,
  `changesets`, `changeset_legs`, `project_inbox`, `policy_rules` (if P4.1 has not landed), spend
  window rows. Tables are created idempotently so a phase can ship before the others use them.
- **Defaults:** every knob defaults to today's behaviour. The two deliberate exceptions are W0.2
  (Codex fail-closed, operator decision 3) and W7.5 (protected files deny on autonomous paths),
  because both close a documented attack surface and widen nothing.
