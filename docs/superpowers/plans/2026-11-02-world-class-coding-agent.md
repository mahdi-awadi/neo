# World-class multi-project coding agent: implementation plan (revision 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Read `CLAUDE.md` first. **Build against `dev`, not
> `master`.** `dev` is 249 commits ahead (ADR-0022 to ADR-0071) and holds most of the baseline.

**Status:** PLAN ONLY. Waiting for operator approval. No engine code is changed by this document.

**Source:** the research report `docs/research/reports/Neo world class coding agent.md` (2026-11-02),
its nine notes, and an operator review of revision 1 (2026-11-02). Revision 1 was written against
`master`; this revision was re-checked against `origin/dev` as of 2026-11-02.

## What changed in revision 2

**1. Subscription, not API spend.** Neo runs on the operator's Claude subscription. There is no
per-token invoice. "Cost" in this plan means **tokens, turns and time against the subscription's
rate-limit windows** (the 5-hour and 7-day windows the SDK reports as `rate_limit_event`, already
read by `usage.ts`). The SDK's `costUsd`/`modelUsage` figures stay as an internal proxy where the
engine already uses them (`budgetWindowUsd`, ADR-0001); every **new** knob and metric below is in
tokens or in window share, never dollars.

**2. The baseline is `dev`, and it already holds a lot of revision 1.** Re-checked items:

| Revision 1 proposed | On `dev` today | Effect on this plan |
|---|---|---|
| Project inbox + `ask(project)` (W6.5/6.6) | **Done:** `project_notes` send/ask, consult runs (ADR-0043, ADR-0050), `project_message` (ADR-0061) | Dropped. W6 keeps only the registry, change-sets and contract gates |
| Task-history/decisions index + search MCP (W7.2/7.3) | **Done:** task history in SQLite FTS5 + vectors in the shared Qdrant, change feed, firewall, `history_search`/`remember`/`forget` (ADR-0067, ledger v17) | W7 narrows to incidents, ADR/commit text, trailers and provenance **on top of** the task history |
| Worktree per todo (W8.1) | **Partial:** side lanes with a worktree per `code` lane (ADR-0057, `lane-worktree.ts`) | W8.1 becomes "N main-queue slots", reusing `lane-worktree.ts` |
| Static/security gates (W8.4) | **Done:** the shift-left security kit, semgrep per language, osv with Go call analysis, a fail-closed chained hook (ADR-0024/0030/0051/0066) | Only "findings as report signals" remains (W1.8) |
| Secret and credential isolation | **Partial:** the secret guard judges reads (ADR-0030/0039), MCP secrets via env (ADR-0062), relay keys never reach workers (`worker-env.ts`), an allowed SSH identity for prod-ops (ADR-0070). **Known limit (HANDOFF):** workers run as root, so the boundary is tool-level only | A separate worker uid is now an explicit W0 task and operator decision |
| No-background-wait contract (W4.6 spike) | **Changed:** long checks run in the background by order (ADR-0055); stall detector unchanged | The spike narrows to "does the engine consume `task_notification`" |
| `/now` steer, typed yes/no for approvals (old P0) | Mid-turn steer **adopted** (ADR-0050 takes `c12c46f`, priority `next`). Typed answers for approvals **ruled out** by the operator (`textAnswerRefusal`, ADR-0054/0071): an approval is released only by its card | Old P0.2/0.3 closed; not re-opened |
| SDK pin bump (W0.3) | **Done to 0.3.310** on `dev` | Only 2.1.314's `blockWritesOutsideWorkingDirectories` is still ahead of the pin |
| Standing rules, planner at max effort, finish non-stop, production-grade (W1 preamble lines) | **Done** (ADR-0063, `standing-rules.ts`); preamble ceiling is now 5,200 chars with the push rule (ADR-0069) | New preamble lines still need displacement or an ADR |
| "Done means live" | **Done** (ADR-0054): a fix on `dev` is not live until the running build contains it | The incident lifecycle (W2.8) reuses it |
| Core principle "no AI in the engine" | **Changed** (operator, 2026-10-28): AI decides anywhere it helps (a worker, the chief of staff picking a lane, a judge: Claude, Jev or ScaleDown); the engine enforces every decision deterministically, failing closed | Constraints below use the new wording. A classifier may propose; code enforces |
| Meilisearch | A **shared** Meilisearch v1.33 runs on the host; Neo has no key, and ADR-0067 chose SQLite FTS5 over it for history words (no answer when down, credentials) | A per-project **code** index on Meilisearch is a measured spike (W7.4), not a build |

**3. Operator-review dispositions.** Every point in the 2026-11-02 review was checked against the
code. None was wrong in substance; several were already known limits. Accepted as written: worker
isolation at the OS level; evidence bound to a revision; the reproduction gate with a test-only
patch; staged compatibility for breaking cross-project changes; migration-aware rollback with
`needs_operator`; held-out verification; UI verification in W1 by task kind; an observation period
for incidents; transcript content archived before GC; explicit tasks for observe mode, the recovery
note and the verbatim order; the token-per-verified-task formula; a `no_change_needed` outcome;
acceptance-item kinds; `runCommand` moved to W0; incremental migrations (that is the repo
convention; revision 1 was wrong); the merge metric renamed; a replay cohort; a no-progress
detector; idempotency keys plus boot reconcile; provenance on search results; verification
profiles. Accepted with a change: the cause record (the gate forces a *diagnosis before editing*,
so it gates on a *suspected* cause with observations; `supported` is assigned only by the
reproduction gate). The critique's reading that W2 lets a worker edit `.neo/` before a cause exists
was right about the risk and is closed by freezing the verification policy at dispatch start, so a
`.neo/` edit can never change the gate of the run that makes it.

## Goal

The operator's five stated problems, in order. (1) Bugs are found at the cause, not the symptom.
(2) Work and knowledge flow between projects, and the engine acts across dev, production and
several hosts without a worker ever touching prod. (3) Subscription windows are spent on verified
work only. (4) "Done" is assigned by the engine, never read from a worker's prose. (5) Knowledge
lives in indexes the engine owns, not in a model's memory.

**One move at every seam:** record the fact, verify it in code against a named revision, and only
then let it flow. A report is a claim until the gate runs. A cause is a record before an edit. A
deploy is a state machine only an operator message can advance. A commit carries its trace id. An
incident is a row the next worker searches.

**Architecture:** deterministic engine changes (ledger, governor, dispatch, loops, producers,
frontends, in-process MCP tools). AI may decide (worker, chief of staff, judge); engine code checks
and enforces every decision, failing closed. Each phase lands behind config with today's behaviour
as the default.

**Tech stack:** Bun + TypeScript, `bun:sqlite` ledger (`dev` is at migration v17; each phase adds its
own numbered migration), grammy, `@anthropic-ai/claude-agent-sdk` 0.3.310 (pinned on `dev`),
`@openai/codex-sdk` 0.145.0. Task history: `src/engine/history/` + the shared Qdrant. The security
kit: `tools/security/`. Codebase-memory MCP, Playwright and the shared browser run as services.

## Global constraints

- **AI decides, code enforces.** A gate, a check, a lint, a matcher or a counter is code. Any AI
  verdict (worker, chief of staff, judge, classifier) is checked and enforced by deterministic code
  with a fail-closed fallback. The engine never parses a worker's prose to assign a status.
- Customer firewall unchanged: `source:"customer"` never reaches the subscription; customer text
  never reaches a worker with tools; the task-history firewall (ADR-0067 D7) keeps customer rows out.
- Governor stays default-escalate (ADR-0006, hook first). A new rule may only make it stricter on
  autonomous paths. Trust never lifts a fence (ADR-0011). A `git push` is operator-only (ADR-0069).
  Autonomy widens only by an operator tap or command.
- **Prod is reached only through engine-owned tools backed by credentials the engine holds.**
  Today's exception, the prod-ops SSH identity (ADR-0070), stays until W5.2 replaces it; it is
  never widened to another project or key.
- **Done means live** (ADR-0054): nothing in this plan is "done" until the running build contains it.
- No hardcoding: every number, path or token is a `config.json` knob (env → file → default,
  `src/config.ts`) with a `docs/CONFIG.md` entry. Defaults keep today's behaviour.
- Never a second table for the same thing: acceptance rides on `project_todos`; attention (ADR-0018)
  is the one board; `events` is the one audit trail; project notes are the one inter-project
  channel; task history is the one archive; no engine-side embeddings, no second code-intel MCP.
- Restart-gated: every phase changes daemon code. Report "built on dev, not live" and stop. Never
  restart without the operator (ADR-0009).
- Branch per phase off `dev` (`feat/wcca-<N>-<slug>`). `bunx tsc --noEmit` + `bun test` green before
  a task is done. One commit per task, committed locally; push once at the end after asking
  (ADR-0069). Commit trailer: the model that actually wrote the commit.
- Each phase opens with its DESIGN step: `CONTEXT.md` terms + one ADR per real decision with the
  rejected alternatives, numbered after the newest on `dev` at the time. Docs land in the same commit.
- Preamble ceiling: 5,200 chars on `dev` (`tests/dispatch.test.ts` L1346). A new preamble line
  displaces text or the ceiling is re-decided in an ADR (decision 11). Never nudge the test.
- Every engine-run command goes through one bounded runner (`runCommand`, W0.4): timeout, capped
  output, scrubbed env.

## Phase order and why

| Phase | What | Size | Why this position |
|---|---|---|---|
| **W0** | Activate and secure the baseline: restart, Codex fail-closed, `runCommand`, worker uid, SDK sandbox, metrics snapshot | M | Half of ADR-0012–0071 is merged but not running; isolation is a known tool-level limit; every later gate needs the runner |
| **W1** | Verified done: claim + verdict bound to a revision, frozen verification policy, profiles by task kind, acceptance items, clean-checkout gate, held-out suite, assertion lint, fresh-context reviewer, no-progress detector, tokens per verified task | L | Feeds problems 1, 3, 4 and every later phase. Absorbs old P3 and dsh A |
| **W2** | Find the bug: loop hygiene (old P1), cause record with observations, reproduction gate on a test-only patch, `what_changed`, scoped observability MCP, error-sweep as a product loop, incident lifecycle | L | The operator's first problem. Needs W1's claim and gate |
| **W3** | Own the PR: `pr_links`, gated `pr-reactions` with idempotent rounds, etiquette, one notice | M | The biggest field gap; all primitives exist. Absorbs old P5.3/5.4 and dsh B |
| **W4** | Efficiency: window-aware accounting, stable cached prefix, SDK context measurement, transcript archive before GC, subagent caps, docs audit, `task_notification` spike, replay cohort | M | Measurable leaks, small knobs; the replay cohort makes harness changes comparable |
| **W5** | Act across hosts: host registry, engine-owned deploy tools, `NEO_ENV`, environment-aware rules (first `policy_rules` content), migration-aware deploy state machine | L | Problem 2's "act across servers" half. Needs decisions 6 and 7 |
| **W6** | Cross-project: `neo.yaml` registry, blast radius, change-sets with staged compatibility, handoff files, contract gates | M–L | Problem 2's "between projects" half, minus what project notes already cover |
| **W7** | Index the why: commit trailers, incidents and ADR/commit text in the task history, provenance on hits, protected instruction files, `/memory`, corrections → checks, a measured code-index spike | M | Problem 5's new value on top of ADR-0067 |
| **W8** | Optional and gated: N main-queue slots, `dispatch_many`, company layer | L | Only when the operator wants parallel main work |

**Plan depth:** W0–W3 are full task tables. W4–W8 list tasks, files and pinning tests; each gets its
own expansion before it is built (`docs/superpowers/plans/<date>-wcca-w<N>.md`).

## Operator decisions this plan needs (asked through `ask_operator` at the phase that needs them)

1. **W0:** the restart that activates everything on `dev` (migrations v5→v17 as the restart
   checklists in `HANDOFF.md` describe), then a second restart per phase as each lands.
2. **W0:** run workers under a separate unix user (`neo-worker`) with project folders group-writable
   and the engine's secrets readable by the engine uid only. This is the only change that makes the
   write fence and the secret guard OS-enforced instead of tool-level. Interim: the SDK sandbox
   (W0.6). Rejected alternative: keep root and rely on the guard (the HANDOFF already names the gap).
3. **W0:** Codex fail-closed default (`approvalPolicy: "never"`, `sandboxMode: "read-only"`,
   `networkAccessEnabled: false`); whether any folder may opt into `workspace-write`. Whether to
   re-port the unmerged `claude/project-thread-4zmkpd` ("route Codex runs through Neo's governor",
   2026-10-04, 21 files) onto `dev` or re-derive it.
4. **W2:** `ask_operator` for loop workers (old P1 task 1.7; ADR-0004 rejected it for cost).
5. **W2:** the observability stack (Grafana/Loki/Tempo vs SigNoz; GlitchTip vs self-hosted
   Sentry) and the data policy: may redacted production telemetry be returned to a subscription
   worker at all. Redaction runs in the log pipeline, before any MCP.
6. **W5:** prod access shape: a forced-command `neo-deploy` user per host, with the key held by the
   engine uid (recommended, replaces the ADR-0070 identity exception for deploys), vs a runner per
   host; whether any host may ever run a worker locally (default: never).
7. **W5:** the governor's prod rule set (the first real `policy_rules` content).
8. **W6/W8:** more than one main-queue todo at a time per project (amends ADR-0008 beyond side lanes).
9. **W7:** ADR-0020: auto-memory as the one project memory; retire or re-point memory Phase 2.
10. **W7:** whether a per-project **code** index on the shared Meilisearch is built at all: only if the
    W7.4 spike measures a lift over codebase-memory + grep on this host's repos, and only with Neo's
    own key and a no-answer-when-down mode (ADR-0067's reasons).
11. **Every preamble change:** displace text or re-decide the 5,200-char ceiling in an ADR.

## Review focus (the cases a reviewer must try to break)

1. **A worker edits `.neo/checks.json`, `package.json` scripts or a test config during the run.**
   The gate runs the policy frozen at dispatch start; the diff lint flags the policy change; the
   change takes effect for the next dispatch only after an operator tap. Pinned in 1.2.
2. **A worker claims `ready` with a dirty tree, tests not run, or HEAD moved after the gate.** The
   engine records the claim, assigns `blocked`/`failed`/`stale`, and the result line says the two
   disagree. Pinned in 1.3 and 1.4.
3. **A worker ends without the `report` call.** Status `unreported`, never `done`. Pinned in 1.3.
4. **A bug brief edits code before a cause record exists.** The hook denies with a reason naming the
   `cause` tool; a reproduction test under the test paths is allowed; `no_defect_found` with
   observations is accepted and routed to the reviewer. Pinned in 2.3.
5. **The regression test does not exist on the base commit.** The gate applies the test-only patch
   to base; a missing-module or setup error is classified `setup_error`, never counted as the
   required failure. Pinned in 2.4.
6. **A Bash line hides a prod hostname in a chained command, an env assignment or `sh -c`.** Denied on
   autonomous paths, escalated otherwise, through `bash-walk` (the shell reader ADR-0069 uses), not
   a regex. Pinned in 5.4.
7. **A worker tries to move a deploy past `proposed`, or a deploy with an irreversible migration
   breaches verification.** Refused at the tool boundary; the second case ends `needs_operator`,
   never an automatic rollback. Pinned in 5.5.
8. **A breaking cross-project change is dispatched provider-first.** Refused: a `breaking` change-set
   must have an expand leg, consumer legs and a contract leg. Pinned in 6.2.
9. **A worker writes to `CLAUDE.md`, `MEMORY.md` or `.claude/`.** Denied unless on the operator-approved
   route; a diff at session start is reported. Pinned in 7.5.
10. **A resumed session's result is summed into the window.** Spend is keyed by SDK session id and
    `modelUsage`; a resumed result replaces its row. Pinned in 4.1.
11. **A deploy, PR reaction or notice is retried after a crash.** Its idempotency key finds the
    external state first; nothing is done twice. Pinned in 3.3 and 5.5.
12. **A gate command hangs or prints megabytes, or sees an engine key.** `runCommand` times out, caps
    output and runs with the scrubbed env. Pinned in 0.4.

---

## W0 — Activate and secure the baseline

**DESIGN:** terms **Worker uid**, **Bounded command**. ADR `0072-workers-run-as-their-own-user-and-the-engine-keeps-the-keys.md`.
Rejected: root with a stronger guard (the guard parses tool calls; a script file or an absolute path
bypasses it, as ADR-0030 itself records).

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 0.1 Operator restart | none (ops) | the restart checklists in `HANDOFF.md`; migrations v5→v17 | After boot: `/list` shows `dev` 0 ahead; `/trace`, `/plans`, History tab, project notes answer; `bun test` green on the deployed sha |
| 0.2 Codex fail-closed default (decision 3) | `session-runner.ts` `codexThreadOptions`, `config.ts` (`codex.sandboxMode`, `codex.approvalPolicy`, `codex.networkAccess`, `codex.workspaceWriteFolders`), `docs/CONFIG.md` | Defaults `read-only`, `never`, `false`; `workspace-write` only for a listed **and** trusted folder | Unlisted → read-only even when trusted; every `command_execution`/`file_change` item → `events` `codex_action` (post-hoc audit; Codex has no hook) |
| 0.3 SDK pin | `package.json` via the ADR-0009 updater | 0.3.310 is on `dev`; move to ≥ 0.3.314 only for `blockWritesOutsideWorkingDirectories` (W7.5) | The updater's worktree verify passes; `worker_compat_warning` lists behaviour flips |
| 0.4 `runCommand` (old P1 task 1.1, moved here) | `src/engine/run-command.ts` (new): `Bun.spawn` with `timeoutMs`, `maxOutputChars`, `cwd`, env from `worker-env.ts` `strip` mode (engine keys and relay keys removed) | `runCommand(cmd: string[], opts): { exit, stdout, stderr, timedOut, truncated }` | Review focus 12; a hang ends at the timeout with `timedOut`; output is capped with a marker; the env has no engine key |
| 0.5 Worker uid (decision 2) | `session-runner.ts` spawn path (the SDK's custom process spawner, or `executable` under a setuid wrapper), `docs/deploy.md`: `neo-worker` user, project folders `g+w` with `neo` group, engine `.env` and `data/` 0600 owned by the engine uid | Workers cannot read the engine's `.env`, `data/*.db`, the deploy key (W5) or the history db directly | A worker Bash `cat /home/neo/.env` fails with EACCES (live probe recorded in `docs/sdk-notes.md`); the governor and guard are unchanged (defence in depth) |
| 0.6 SDK sandbox (interim and layer) | `session-runner.ts` `sdkOptions.sandbox`: `enabled` per worker profile (`workers.<path>.sandbox`), `filesystem.denyRead` for the engine's secret paths, `network.allowedDomains` from config, `excludedCommands: ["docker"]` (the SDK documents docker as incompatible), `failIfUnavailable: false` with a logged `sandbox_unavailable` event | Config, default off; Linux needs bubblewrap + socat (documented) | A profile with sandbox on gets the option; a missing bubblewrap logs and runs unsandboxed (never silently) |
| 0.7 Baseline metrics snapshot | `tools/metrics-snapshot.ts` (read-only over the ledger) | Tokens per dispatch, window share per day (from `rate_limit_event` utilisation), interventions per dispatch, reopened incidents (0 until W2), merged agent PRs per week (0 until W3) | Runs against a fixture ledger; never writes |

**Exit:** the daemon runs `dev`; Codex cannot write or reach the network unless listed; every engine
command is bounded and credential-free; a worker is a different user from the engine (or, until
decision 2, the sandbox layer is on and the gap is named in `/audit`).

---

## W1 — Verified done

**DESIGN:** terms **Claim**, **Verdict**, **Verification policy** (the frozen set of checks and the
files they depend on), **Verification profile** (what evidence a task kind needs), **Acceptance item**,
**Evidence** (command, exit, bounded output, bound to head sha, base sha, policy hash, environment id).
ADR `0073-done-is-assigned-by-the-engine-for-one-revision-under-a-frozen-policy.md`.
Rejected: parsing the worker's last paragraph; a hard deny on editing test files (TDD); a
second-vendor reviewer (no measured gain over a fresh same-model session); summing costs in dollars.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 1.1 `report` tool (dsh A) | `src/engine/report-tool.ts` (new, pure Zod + normaliser), wired in `dispatch.ts` `neoMcpServers` beside `ask_operator`; operator paths only | `Claim { status: ready\|blocked\|failed\|dropped\|no_change_needed\|handback; summary ≤ 240; ran: {cmd, exit}[]; changed: string[]; ref: {pr?\|commit?}\|null; risks[]; assumptions[]; evidence?: {kind, ref}[]; handback?: {reason} }` | Schema rejects a missing status, a bundled status, a placeholder PR, an over-cap summary; `no_change_needed` requires `evidence`; `handback` requires a reason; customer paths never get the tool |
| 1.2 Frozen verification policy | `src/engine/checks.ts` (new): `resolveChecks(folder, override?)` reads `.neo/checks.json`, expands script aliases to concrete commands, lists the files they depend on (`package.json`, `bunfig.toml`, test configs, the check scripts); `freezePolicy(folder)` hashes commands + dependency contents at dispatch start and stores `policy_hash` on the order | A change to a policy file during the run is a lint finding (1.7) and never changes the gate of that run; the new policy applies to later dispatches after an operator tap on the finding | Review focus 1; `.neo/checks.json` absent → "no checks declared", never green; an alias is resolved once and recorded |
| 1.3 Claim stored, verdict assigned, `unreported` fallback | `dispatch.ts` settle path; migration 18: `dispatch_end` gains `claim`, `verdict`, `verdict_reason`, `head_sha`, `base_sha`, `policy_hash`, `env_id` | `Verdict = Claim.status \| "unreported" \| "stale" \| engine override` | Review focus 2 and 3; a settle with no claim → `unreported`; the dispatcher inbox and the operator line both say so |
| 1.4 Clean-checkout gate, bound to a revision | `src/engine/verify.ts` (new): a clean worktree at `head_sha` (reuse `lane-worktree.ts`, never copy), the frozen checks through `runCommand`, the scrubbed env; `dispatchCheckRetries` (default 2) resumes the same session with the failing output | `verify(order): Verdict + Evidence[]`; evidence invalid when HEAD moves (`stale`) | Dirty tree + `ready` → `blocked` (the commit finish, ADR-0037, runs first); checks fail → resume up to N then `failed`; the worktree is removed after; HEAD moved after the gate → `stale`, re-verified before any deploy (W5) |
| 1.5 Verification profiles by task kind | `dispatch`/`todo add` gain `kind: feature\|bug\|chore\|docs\|ui\|migration\|contract\|investigate` (default `feature`; the chief of staff sets it like `lane`); `src/engine/verify-profile.ts` (pure) maps kind → required evidence | `docs`: checks only; `backend`/`feature`: checks + reviewer; `ui`: + before/after captures via Playwright with console and failed-request counts (dsh H); `migration`: + up/down on a scratch db + compatibility declaration; `contract`: + oasdiff/Pact exit codes (W6.4); `bug`: + the reproduction gate (W2.4) | A `ui` claim without both captures is `blocked: missing evidence`; a `docs` task never pays for a reviewer; a wrong kind can only add evidence, never remove it (the engine takes the union of the declared kind and what the diff touches) |
| 1.6 `Stop` hook keeps the turn alive while the gate fails | `session-runner.ts` hooks (beside the governor hook) | `Stop` → `decision: "block"` with the failing evidence, capped by `stopHookMaxContinues` (default 8) | A failing gate blocks the stop; the cap ends it `failed`; a passing gate never blocks; hooks stay synchronous and never throw |
| 1.7 Diff lint | `src/engine/diff-lint.ts` (new, pure): deleted test files, deleted `test(`/`it(`/`expect(`, `.skip`/`.only` left in, `--no-verify`, `@ts-ignore` added in src, **policy files changed (1.2)** | `lintDiff(diff, policy): Finding[]`; findings ride on the result line and the ledger; never a deny | A deleted assertion is flagged; a test file with an added case is not; a `package.json` scripts change is flagged as `policy_changed`; zero findings prints nothing |
| 1.8 Fresh-context reviewer with gate evidence (old P3.4 re-pointed) | `goal.ts` `judgePrompt`, `worker-profile.ts` `judge` profile; an `AgentDefinition` with `tools: ["Read","Grep","Glob"]`, `omitClaudeMd` optional | Input: the diff + `Evidence[]` + security-kit findings for the diff (ADR-0024) as signals, never the worker's transcript; output: `DEFICIENCY:` lines (capped) | No write tools; "skip style" in the rubric; a `no_change_needed` claim needs the reviewer's agreement; tokens booked to the dispatch |
| 1.9 Acceptance items on todos | `todo-queue.ts`; migration 18: `project_todos.acceptance` (JSON: `{id, text, kind: required-auto\|required-human\|info, check?: string[]}`) + `passes` (JSON) | `verify()` flips `required-auto`; the operator's tap flips `required-human`; `info` never blocks; completion = every `required-*` passes | A todo with an unmet `required-human` item ends `awaiting-operator`, never `done`; a worker cannot flip anything (no tool) |
| 1.10 Held-out suite (optional per project) | `company/heldout/<project>/` (engine-owned, outside the project folder, unreadable by workers after 0.5); `verify.ts` applies it in the clean worktree against the **non-test** part of the diff | Declared in `.neo/checks.json` as `heldOut: true` | A project without a held-out dir is unaffected; a held-out failure is `failed` with the evidence; workers never see the suite |
| 1.11 No-progress detector | `dispatch-report.ts` spin watch gains a **check-failure signature** counter (same failing command + same first error line N times, `checkFailureRepeat`, default 3) | On repeat: one read-only consult run (ADR-0050) for a fresh diagnosis delivered as a note, or `handback` | A worker that fails the same way three times is interrupted once with the diagnosis, never left to the stall clock |
| 1.12 Tokens per verified-solved task | `ledger.ts` derived query; `/usage` and the project dashboard | For a cohort (project × window): **total tokens of every attempt, retry and review ÷ distinct tasks with verdict `ready`**; beside it, tokens spent on tasks that ended `ready` | Retries counted once; `unreported` counts as unsolved; a fixture matches by hand |
| 1.13 Verbatim order + recovery note (dsh D/G, explicit) | `dispatch.ts` brief assembly: a `## Operator's order (verbatim)` section after the brief; a `## Resumed after an abnormal end` line (check tree, log and GitHub before any outside action) when the order resumes an `unreported`/aborted run | — | The section is below the preamble (cache prefix, W4.2); the recovery line appears only on a resume |

**Exit:** no dispatch is done unless the engine ran the frozen checks for that exact revision and they
passed; the evidence a task needs depends on its kind; the ledger holds the evidence; a stuck
worker is diagnosed, not just timed out.

---

## W2 — Find the bug

**DESIGN:** terms **Cause record** (suspected / supported), **Observation**, **Reproduction gate**,
**Incident** (open → fix_verified → deployed → observed → resolved), **What-changed window**,
**Observability profile**. ADRs `0074-a-bug-fix-starts-with-a-suspected-cause-and-ends-with-a-supported-one.md`
and `0075-production-is-diagnosed-through-read-only-tools-fenced-at-the-data-layer.md`.
Rejected: a summariser over bulk telemetry; a mutation-testing gate on every dispatch; an AI
triage verdict that the engine does not re-check.

**2.0 Loop hygiene (old P1, restated so this plan stands alone):**

| Task | One line |
|---|---|
| 2.0.1 `LoopDef.gate` | A script (`runCommand`) decides whether to wake a model at all; `dreamGateOutcome`/`secretaryGateOutcome` move onto it |
| 2.0.2 Script-only loops | A loop with a gate and no prompt runs the script and records it |
| 2.0.3 Silence token + quiet-loop alert | A reply that is exactly the token is silent; `loopQuietAlertAfter` fires once |
| 2.0.4 `at` trigger | One-shot; fires once after a missed window, then disables |
| 2.0.5 Honest budget | Judge tokens counted; `judgeGoal` honours `timeoutMs`; per-loop daily cap with "paused at cap" |
| 2.0.6 Denials in the digest | `permission_denials` from the result land in the loop digest |
| 2.0.7 Preamble for loops | `LoopDef.preamble: true` (default false) adds `briefWithProjectDocs`; `ask_operator` by decision 4 |
| 2.0.8 Observe mode (dsh E, explicit) | `LoopDef.observe: true` (default for a newly created loop): the run gets `READONLY_DENY`, its report is recorded and sent, nothing else; an operator tap turns it off |

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 2.1 Bug kind | W1.5's `kind: bug` | — | Only `bug` arms 2.3 and 2.4 |
| 2.2 `cause` tool | `src/engine/cause-tool.ts` (new, Zod), attached with `report` | `Cause { status: suspected; file, line, condition, firstWrongState, whyUpstream, observations: {kind: log\|trace\|test\|repro, ref, excerpt ≤ 400}[] (≥ 1), distinguishingExperiment, rejected: string[] } \| { noDefectFound: { observations (≥ 1) } }`; stored in `events` as `cause_recorded`; `supported` is set only by 2.4 | Rejects a cause with no observation or no `whyUpstream`; a worker cannot set `supported`; a revision is a new row on the same brief |
| 2.3 Cause gate in the governor | `governor.ts` `decide()` (one shared rule for hook + `canUseTool`) | For `kind: bug` and no cause row: `Edit`/`Write` under the project → deny naming the tool; test paths (from the policy's test globs), `docs/` and `.neo/scratch/` stay allowed | Review focus 4; inert for other kinds; customer paths unchanged |
| 2.4 Reproduction gate on a test-only patch | `verify.ts` `reproduce(order)`: split the diff into test-only and non-test; in a clean worktree at `base_sha` apply the test-only patch and run the named test; then at `head_sha`; classify `assertion_failure`, `setup_error`, `pass` | A `bug` claim is `ready` only with fail(base, assertion) + pass(head); `setup_error` on base → `blocked: reproduction not established`; two disagreeing runs → `flaky`; on success the cause row becomes `supported` | Review focus 5; a test that passes on base is refused; a `no_change_needed` claim needs `noDefectFound` + the reviewer (1.8) |
| 2.5 `what_changed(project, since)` | `src/engine/what-changed.ts` (new, pure over `git-read.ts` + ledger), an in-process MCP tool on operator paths | Commits of the project (and its `dependsOn` once W6.1 exists), lockfile/dependency diffs, config and `.env.example` diffs, migrations, ledger events (deploys from `probe`, updater runs, loop fires, approvals, `codex_action`) in the window; `since` = sha, date or `last-deploy` | Bounded reads; a non-repo folder returns ledger events only; output capped and says so |
| 2.6 Scoped observability MCP profile (decision 5) | `neoMcpServers` gains `observability` (opt-in like `playwright`); `config.json` `observability: { kind, args, enforcedMatchers }` | Grafana: `--disable-write`, `--loki-enforced-matchers {project="<folder>",env="<env>"}`; operator paths only; tools default-escalate on autonomous paths unless allow-listed | Never attached on ingress/customer paths; matchers derived from the folder, never the brief; a missing binary → "observability unavailable" in the brief |
| 2.7 Count-first + hypothesis lines (decision 11) | preamble, assembled only when `observability` or `kind: bug` applies | Count before query; one hypothesis per query; a bug brief ends with a cause record | Ceiling test unchanged unless an ADR raises it |
| 2.8 Incident lifecycle | migration 19: `incidents(id, project, fingerprint, source, trace_id, cause_id, fix_sha, test_path, what_changed_from, what_changed_to, state, opened_at, deployed_at, observed_until, resolved_at, reopened_count)`; states `open → fix_verified (W1 verdict ready) → deployed (W5 `deploys` live, or the `deploy:<project>` probe sees `fix_sha`) → observed (no new event for `incidentObserveDays`) → resolved`; a new event in `observed` → `open` with `reopened_count` +1 | Follows ADR-0054: a fix is done only when it runs | Same fingerprint never gets a second row; `deployed` needs a deploy fact, never the worker's word |
| 2.9 Error-sweep as a product loop | `error-sweep` as a per-project loop definition (`tools/create-loop.ts`), gate = "new fingerprint since last run" from the tracker read (2.6), selection top-N by events × users × recency with no open todo, `errorSweepMaxSessionsPerDay` | Output: a todo with reproduction + hypothesis, or a PR only when 2.4 passed; dedupe by `(project, fingerprint)` | A fingerprint with an open todo is skipped; the daily cap pauses with one digest line; never pushes (ADR-0069); a cross-service finding opens a ticket |
| 2.10 Nightly action-item sweep | a script-only loop: every incident without a linked todo or `test_path` after `incidentActionGraceDays` → attention item | — | Zero tokens; reconciled rows (ADR-0018) |
| 2.11 Bisect recipe | `docs/loops/bisect.prompt.md` + `what_changed`: `git bisect run` with a worker-written oracle under `.neo/scratch/` in a clean worktree | — | The oracle is linted (no `exit 0` stub); runs in a worktree |

**Exit:** a bug dispatch cannot edit code before naming a suspected cause with an observation, is
`ready` only when a test-only patch fails on base and passes on head, can ask what changed since the
last deploy, can read production telemetry through a fenced read-only tool, and leaves an incident
whose lifecycle follows the deploy, not the claim.

---

## W3 — Own the PR to the end

**DESIGN:** terms **PR link**, **Reaction**, **Round**, **Idempotency key**. ADR
`0076-the-session-that-opened-a-pr-owns-it-until-it-closes.md`. Rejected: webhooks (ADR-0018);
a per-PR babysitter loop; auto-merge; pushing during a task (ADR-0069).

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 3.1 `pr_links` (old P5.3) | migration 20: `pr_links(repo, pr, folder, todo_id, sdk_session_id, branch, state, rounds, last_event_key, created_at, closed_at)`; written after the operator-approved push from `gh pr list --head <branch>` | — | No `gh` or no PR → no row; reopened → same row |
| 3.2 Owner resolution | `reply-routing.ts` `deliverIntoFolder` gains `byPrLink(repo, pr)`; a closed session resumes by `sdk_session_id` (cross-SDK guard applies); a side-lane session (ADR-0057) is a valid owner | — | A PR with no link → attention item only; a dead session restarts cold with the PR context, once |
| 3.3 `pr-reactions` gated loop (old P5.4) | built-in loop, off by default; gate (2.0) polls `gh pr checks` + review comments for open links; delivers the failing log or comment into the owner; `prReactionMaxRounds` then one decision | Round = one distinct CI run id or review id; `last_event_key` is the idempotency key, so a crash mid-delivery never delivers twice; boot reconciles against `gh` before any delivery | Review focus 11; a green PR never wakes a worker; bot comments count toward the cap but never authorise work |
| 3.4 Etiquette rules | a path-scoped `.claude/rules/pr.md` shipped by the engine on operator paths (costs nothing off-PR), not a preamble line | Resolve a fixed thread silently; one factual reason for a declined suggestion; never a top-level "fixed everything"; ready without waiting for merge; the operator merges | Assertion on the assembled rules; the preamble is untouched |
| 3.5 One merge/close notice | `producers/github.ts` + priority `result` | One line to the Decisions channel with the todo and verdict; the row is `closed`; the incident (2.8) advances only when a deploy fact follows | Exactly one notice per PR across restarts |
| 3.6 Metrics | `ledger.ts` derived queries | Merged agent PRs per week; median hours from `ready` notice to merge; interventions per PR | Matches a fixture; shown in `/usage` |

---

## W4 — Efficiency (subscription windows, tokens, time)

**DESIGN:** terms **Window share**, **Stable prefix**, **Replay cohort**. ADR
`0077-spend-is-tokens-against-windows-keyed-by-sdk-session-and-persisted.md`. Rejected: Economy
mode on any code-writing path (spec 2026-07-23 §8 stands); a model router in the engine.

| Task | Files | Pins |
|---|---|---|
| 4.1 Accounting in tokens, keyed by session, persisted | `budget.ts`: window rows in the ledger keyed by SDK session id with `modelUsage` tokens (input, output, cache read, cache write) and the latest `rate_limit_event` utilisation; a resumed result **replaces** its row; `loop-runner.ts` adds judge tokens; `usage.ts` exposes window share | Review focus 10; restart keeps the window; judge tokens appear in the loop digest and against `Bounds`; `/usage` shows interactive vs background by `workClass`; the `budgetWindowUsd` knob keeps working as the proxy it is |
| 4.2 Stable cached prefix | `dispatch.ts` assembly order: preamble → standing rules → project docs pointer → brief → verbatim order → notes/messages; no timestamp, run id or queue position above the brief; `workers.<path>.subagentCacheTtl` (unset = SDK default) | The first N chars of two briefs for the same folder are identical; `ephemeral_1h_input_tokens` recorded per run into `cache_observations` |
| 4.3 Context from the SDK | `context-policy.ts` reads `getContextUsage({detail:'summary'})` when offered; JSONL parsing stays as fallback; `PreCompact` hook **archives the transcript content** (compressed, `transcriptArchiveKeepDays`) and a task-state snapshot before compaction; then `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC=1` in `workerEnv` | Occupancy equals the fixture; a compaction leaves `compact_boundary` with `pre_tokens`; GC never removes content a handoff or the history indexer still needs (archive first, GC second) |
| 4.4 Subagent contracts and caps | every engine-shipped `AgentDefinition` (`agent-teams.ts`, `planner`, consult): `maxTurns`, `omitClaudeMd` for searchers, a return contract (evidence `path:line`); `workers.<path>.maxBudgetTokens` → the SDK's budget option; `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` in `workerEnv` | A searcher has no write tools; the cap refuses spawn and the result says so |
| 4.5 Docs-audit loop | `docs-sweep` gains a script gate: `CLAUDE.md` > 200 lines, `.claude/rules` without path scopes, an ADR contradicted by a newer one without `Superseded`; report-only | Zero tokens when clean; findings are attention items |
| 4.6 `task_notification` spike (narrowed) | `tests/sdk-live/` probe (skipped in CI): does a streaming-input session parked idle wake on a background task's end? Does `liveness.ts` see `task_progress`? | If yes: `task_started`/`task_progress` count as activity; ADR-0055's contract is unchanged either way; the answer goes in `docs/sdk-notes.md` |
| 4.7 Replay cohort (operator-run) | `tools/replay.ts`: a cohort file of past todos (bug, feature, cross-service, "nothing is wrong") with starting sha, frozen policy and acceptance; runs each in a worktree under the current harness and compares verdict, tokens and interventions to the recorded run | Off by default (it spends window share); a cohort entry without a recorded verdict is skipped; results are a table in the ledger, never a push |

---

## W5 — Act across hosts (dev, staging, production)

**DESIGN:** terms **Host**, **Environment**, **Deploy tool**, **Deploy state**, **Migration
compatibility**, **Break-glass**. ADRs `0078-production-is-reached-only-through-engine-owned-tools.md`
(supersedes ADR-0070 for deploys) and `0079-a-deploy-is-a-state-machine-only-an-operator-message-advances.md`.
Rejected: a runner on prod hosts; Docker's TCP port; worker-held keys; agent-enabled auto-deploy.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 5.1 Host registry | `config.ts` `hosts: { <name>: { ssh, dockerContext?, env: dev\|staging\|prod, projects: string[] } }`; migration 21: `hosts(name, env, last_heartbeat, versions JSON)`; `producers/probe.ts` heartbeats through the `health` tool | `deploy:<project>:<env>` replaces `deploy:<project>`; per-environment `deployedVersionUrl` | Unreachable host → attention item; "N commits not deployed to prod" item; dashboard shows versions per env |
| 5.2 Engine-owned deploy tools (decision 6) | `src/engine/deploy-tools.ts` (new): in-process MCP tools `deploy_propose`, `prod_logs`, `prod_health`; the engine executes `ssh neo-deploy@host <verb> <project>` with a key readable by the engine uid only (W0.5) | On the host: `neo-deploy` user, `authorized_keys` with `restrict,command="neo-deploy-shim"`; the shim accepts only `pull\|up\|rollback\|logs\|health <project>` | The key path is never in `workerEnv`; an unregistered project is refused; output bounded; every call an `events` row with cause; the ADR-0070 identity entry for deploys is removed once this is live |
| 5.3 `NEO_ENV` per session | `worker-profile.ts`: `workerEnv.NEO_ENV` from the registry for the folder (absent = `dev`); `SessionStart` hook writes it to `CLAUDE_ENV_FILE`; the guard's `host.json` (ADR-0039) stays the host-level fact | The governor denies `export NEO_ENV=` in Bash | No host → `dev`; "unknown env = startup error" stays a baseline rule for project code |
| 5.4 Environment-aware rules (decision 7; first `policy_rules` content) | `policy_rules` table + `src/engine/policy.ts` (old P4.1/4.2 shape); seed rules from the registry: a prod host, a prod Docker context, `ssh <prod>`, `DOCKER_HOST=ssh://`, `kubectl --context <prod>`, `deploy/prod/**` → `deny` on autonomous paths, `ask` otherwise; matched through `bash-walk` | `matchRule` runs before `RISKY_BASH` (kept as defence in depth) | Review focus 6; chained, env-prefixed and `sh -c` forms are caught; a trusted folder is still denied on autonomous paths |
| 5.5 Deploy state machine | migration 21: `deploys(id, project, env, host, digest, prev_digest, built_from_sha, verified_policy_hash, migration_compat, state, approved_by_msg, idempotency_key, cause, at)`; states `proposed → approved → deploying → verifying(1/2) → live \| rolled_back \| failed \| rollback_failed \| needs_operator` | Only an operator message writes `approved`; `deploying` requires `built_from_sha` to have a `ready` verdict at that sha (W1.4; `stale` refuses); `migration_compat: backward\|forward_only` comes from the migration kind's evidence (W1.5): `forward_only` disables auto-rollback and routes a breach to `needs_operator`; verification = `prod_health` over two consecutive `deployVerifyWindowMs` windows, **severe** (health down, or no samples) → immediate action, **soft** (error rate > `deployErrorRateFactor` × baseline **and** ≥ `deployMinSamples`, or > `deployErrorAbsFloor` when the baseline is zero) → both windows; rollback = `up` with `prev_digest`; boot reconciles `deploying`/`verifying` rows against the host before resuming | Review focus 7 and 11; a single soft window does not roll back; a severe failure acts at once; `rollback_failed` is an alert; nothing runs twice after a crash |
| 5.6 Break-glass | the same tools with `force: true` + a cause id; only the admin's chat; ledgered as `alert` | Proposable by a worker, never executable by one | A worker call with `force` is refused |
| 5.7 Secrets per environment + `/audit` | docs + old P4.7 `/audit`: prod secrets exist only on the prod host (SOPS/age or `.env` 0600 there); the dev host holds no prod key except the engine-uid deploy key | — | `/audit` flags a prod key readable by the worker uid |

---

## W6 — Cross-project (what project notes do not cover)

**DESIGN:** terms **Project registry** (`neo.yaml`), **Blast radius**, **Change-set** (additive /
breaking), **Leg** (expand / consumer / contract), **Handoff file**, **Compatibility matrix**.
ADR `0080-a-cross-project-change-is-a-change-set-the-engine-orders-and-stages.md`.
Rejected: a second messaging channel (project notes exist); a cross-repo transaction; provider-first
order for breaking changes.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 6.1 `neo.yaml` registry | `src/engine/project-registry.ts` (new): Backstage field names (`kind`, `spec.type`, `spec.lifecycle`, `spec.owner`, `spec.providesApis`, `spec.consumesApis`, `spec.dependsOn`) + `environments: {dev: {host, deployedVersionUrl}, prod: {...}}` + `migrations: { compat: backward\|forward_only }`; merged with the existing per-project config | `registry()`, `blastRadius(project)` (`dependencyOf` closure) | A dangling `dependsOn` → attention item; a cycle is reported; a project without `neo.yaml` behaves as today |
| 6.2 Change-set record with staged compatibility | migration 22: `changesets(id, cause, kind: additive\|breaking, contract_diff, order JSON, state)` + `changeset_legs(changeset_id, project, role: expand\|consumer\|contract, todo_id, branch, pr, state)`; company tool `change_set` | `additive`: provider leg → consumer legs, consumers held until the provider is **deployed** to the target env (W5 `deployed`); `breaking`: `expand` leg (old + new contract) → consumer legs → `contract` leg (remove old), each held on the previous leg's deploy; consumer PRs draft until their hold lifts | Review focus 8; a breaking change-set without an expand leg is refused; one failed leg pauses dependents and raises one decision; done only when every leg is merged and deployed |
| 6.3 Handoff file between legs | `docs/handoffs/<changeset-id>.md` in each consumer folder, generated by the engine from the provider leg's claim (W1.1): changed contract, version, migration notes, verification targets | Attached to each consumer brief; removed when the change-set closes | Generated, not model-written; a consumer brief names it |
| 6.4 Contract gates + compatibility matrix | `.neo/checks.json` may list `oasdiff` / `pact can-i-deploy --to-environment <env>`; migration 22: `deployed(project, env, version, at)` written by W5.5 | A consumer leg's gate runs against the provider version actually deployed in the target env | Exit-code tools only; a missing tool is "check unavailable", never green |
| 6.5 Impossible splits | two legs listing the same file in `touches` are refused and handed to the operator to merge | — | Pinned |

---

## W7 — Index the why (on top of the task history)

**DESIGN:** terms **Trailer**, **Provenance**, **Protected file**. ADRs
`0081-every-worker-commit-carries-its-trace-and-plan.md` and
`0082-instruction-and-memory-files-are-a-write-protected-surface.md`. Rejected: a second archive
(ADR-0067 is the one); engine-side embeddings; a code graph beside codebase-memory; auto-applied
corrections.

| Task | Files | Pins |
|---|---|---|
| 7.1 Commit trailers | the preamble names `Neo-Trace: <thread>` and `Neo-Plan: <id\|none>`; the gate (W1.4) refuses `ready` when HEAD lacks them; values come from the order, not the worker | A commit without trailers → `blocked: missing trailers` |
| 7.2 New history sources | `history/sources.ts` gains `incident` (W2.8 rows), `adr` (ADR files with their status), `commit` (messages with trailers), `context` (`CONTEXT.md` terms); the change feed and the firewall apply unchanged | Each kind cites its source; an ADR's `Superseded` status is a field; secret-shaped chunks are still refused |
| 7.3 Provenance on every hit | `history/search.ts` results carry `git_sha`/`indexed_at`/`superseded` where the source has them; a `code`-adjacent hit (a note or incident naming a path) is re-checked against the current checkout and marked `stale` when the line moved | A superseded ADR hit says so; tombstones (`forget`) stay respected |
| 7.4 Code-index spike (decision 10) | `tools/history/eval.ts` cohort: codebase-memory + grep vs the same plus a Meilisearch per-project code index (AST-aware chunks, chunk-hash upsert) on this host's three largest repos; measure found-file rate and tokens per task | Build nothing in `src/` unless the lift is measured; if built, Neo's own key, `project` filter default, a no-answer-when-down mode |
| 7.5 Protected files | `governor.ts` rule: `Write`/`Edit` to `CLAUDE.md`, `MEMORY.md`, `.claude/**`, `memory/**` → deny on autonomous paths, escalate otherwise, unless the operator-approved route (a decision card with the diff) applies; `SessionStart` diffs these files against the last session and posts one line if they changed; `blockWritesOutsideWorkingDirectories` after 0.3 | Review focus 9; tainted briefs already disable auto-memory |
| 7.6 `/memory` + typed corrections (old P2) | `commands.ts` `/memory [list\|forget <id>\|show]` over the auto-memory dir (ADR-0020) and Phase 2 files if kept (decision 9); a typed correction is stored as `feedback` and `remember`ed into the task history | Only the admin; a forget is a ledgered event |
| 7.7 Corrections → checks (old P7, narrowed) | `correction` events (deny, `/kill`, a follow-up within `correctionWindowMs`); the dream loop proposes, per **repeated** correction, a rule or check (a `policy_rules` row, a `.neo/checks.json` entry, a `.claude/rules/*.md` line) as a decision card; never a prose memory line | Nothing applies without a tap; one occurrence proposes nothing; the card shows the exact rule text |

---

## W8 — Optional and gated

| Task | Source | Gate |
|---|---|---|
| 8.1 N main-queue slots per project, reusing `lane-worktree.ts`; branch `neo/todo-<id>` binds the PR (3.1) | old P6.1/6.2, dsh F, extends ADR-0057 | decision 8 |
| 8.2 `dispatch_many` + synthesis todo | old P6.3 | 8.1 |
| 8.3 Company layer (goals on the board, departments, evening plan / weekly review) | old P8 | its own spec first |

---

## Superseded-by table

| Old item | New home |
|---|---|
| 2026-10-04 P0.1 approval board (any channel resolves) | still open as P0; typed answers for approvals are **closed** by operator decision (ADR-0054/0071) |
| P0.2 typed yes/no | closed (see above) |
| P0.3 `/now` | done on `dev` (ADR-0050 steer with `priority: next`, `project_message`) |
| P0.4 Codex | W0.2 (+ decision 3 on the unmerged thread branch) |
| P1 | W2.0 (restated) |
| P2 brief/heartbeat | still P2; the unmerged `claude/project-thread-9r60dq` (morning brief, 2026-10-04) is a candidate re-port; `/memory` → W7.6 |
| P3 | W1.2–1.9 (frozen policy, revision binding, profiles, acceptance kinds) |
| P4 rules/`/audit` | W5.4 / W5.7; grants, offers, scan stay P4 |
| P5.1/5.2 | still P5 |
| P5.3/5.4 | W3 |
| P6 | W8.1/8.2 |
| P7 | W7.7 |
| P8 | W8.3 |
| dsh A | W1.1/1.3 · dsh B | W3 · dsh C | W1.3 result line + a company prompt rule · dsh D | W1.13 + `handback` · dsh E | W2.0.8 · dsh F | W8.1 · dsh G | W1.13 · dsh H | W1.5 `ui` profile · dsh spike | W4.6 |
| Revision 1 W6.5/6.6 (inbox, ask) | done on `dev` (ADR-0043/0050/0061) |
| Revision 1 W7.2/7.3 (indexes, search MCP) | done on `dev` (ADR-0067); residue in W7.2/7.3 |
| Revision 1 W8.4 (static gates) | done on `dev` (ADR-0024/0051/0066); signals in W1.8 |

## Metrics (the ledger is the only benchmark)

Recorded by W0.7 before, and by `/usage` after each phase:

- tokens per verified-solved task (W1.12), cohort total ÷ distinct `ready` tasks;
- window share per day, interactive vs background (W4.1);
- interventions per dispatch and per PR;
- claim ≠ verdict rate (W1.3), expected to fall as the gates bite;
- reopened incidents per fingerprint (W2.8);
- merged agent PRs per week and median hours from ready to merge (W3.6);
- the replay cohort (W4.7) when a harness change needs a like-for-like comparison.

Each gate ships as a config flag with a measured reason. The weekly review is where a gate that no
longer earns its window share is switched off.

## Self-review

- **Coverage:** every roadmap item 0–20 in the report maps to a task, and every accepted review
  point maps to one: isolation → W0.5/0.6; frozen policy → W1.2; revision binding → W1.3/1.4/5.5;
  profiles and UI → W1.5; held-out → W1.10; no-progress → W1.11; `no_change_needed` → W1.1/2.4;
  acceptance kinds → W1.9; `runCommand` → W0.4; cause observations → W2.2; test-only patch → W2.4;
  incident period → W2.8; staged compatibility → W6.2; migration rollback → W5.5; transcript
  archive → W4.3; replay → W4.7; idempotency → W3.3/5.5; provenance → W7.3; explicit inherited
  tasks → W1.13/W2.0.8; metrics → W1.12/W3.6.
- **Standing decisions untouched:** compliance; Gemini for customers; AI decides, code enforces;
  operator-only autonomy widening; never restart without permission; polling not webhooks; push is
  operator-only; one main todo per project unless decision 8; no model downgrade on code paths;
  worktrees temporary; trust never lifts the fence; timeout never means allow; loops never push;
  one archive (ADR-0067), no engine embeddings, no second code-intel MCP; typed answers never
  release an approval.
- **Migrations:** v18 (W1), v19 (W2), v20 (W3), v21 (W5), v22 (W6); each immutable, each with an
  upgrade test from the previous version's fixture, per `ledger-migrations.ts`'s rule.
- **Names checked:** `runCommand` (W0.4) used by W1.4, 1.10, 2.0.1, 2.4, 2.5, 5.2; `Claim`/`Verdict`
  (W1.1/1.3) by 1.4–1.12, 2.4, 2.8, 2.9, 3.3, 6.2, 6.3, 7.1; `policy_hash` by 1.2, 1.4, 5.5;
  `policy_rules`/`matchRule` (W5.4) by 7.5, 7.7; `incidents` (W2.8) by 2.10, 7.2; `deployed`
  (W6.4) by 5.5, 6.2; `neoMcpServers` opt-ins: `playwright` (exists), `observability` (2.6).
- **Defaults:** every knob defaults to today's behaviour. Deliberate exceptions: W0.2 (Codex
  fail-closed), W0.5/0.6 (isolation, by decision), W7.5 (protected files deny on autonomous paths).
