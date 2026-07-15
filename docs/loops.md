# Loops & Automations — reference (the autonomy model for Neo)

Saved because Neo's company-engine autonomy **is** a loop runtime. Distilled from field practice;
the last section maps it onto Neo.

> **Status (2026-06-26): the core loop runtime is implemented.** The trigger→action→goal model
> below is now engine-native: `Goal` union (verifiable command + LLM-judge worker) in
> `src/engine/goal.ts`; `Trigger` union (manual/interval/cron) + matcher in `src/engine/trigger.ts`;
> per-loop bounds (`maxIterations` + `budgetUsd`) wired to the budget meter in
> `src/engine/loop-runner.ts`; a deterministic scheduler in `src/engine/scheduler.ts` fired from the
> daemon (every 60s, `NEO_LOOP_SCHEDULER`); the loop library + `/loop` command (list · run · on/off)
> in `src/engine/loops.ts`. Design + plan:
> `docs/superpowers/specs/2026-06-26-loop-runtime-design.md`,
> `docs/superpowers/plans/2026-06-26-loop-runtime.md`. Deferred: event triggers, the in-iteration
> Stop-hook guard, dynamic self-paced intervals.
>
> **Shipped built-in loops** (code-defined in `src/engine/loops.ts`) are generic, deployment-neutral
> examples that maintain the engine's *own* repo, so they work on a fresh clone: `green` (run `bun
> test` + `bunx tsc --noEmit` until green — verifiable, manual), `error-sweep` (nightly cron;
> root-cause + fix unaddressed errors — verifiable), and `docs-sweep` (nightly cron; sync docs to the
> day's diff — LLM-judge). Each runs through `runProjectLoop`, so it's governed +
> escalation-auto-denied (never pushes/deploys). Operators author their own project loops from the
> web console (see the CRUD note below); built-ins stay run/toggle-only.
>
> **Data-driven loop CRUD — live (2026-06-28).** Loop *definitions* are data (ledger `loop_defs`),
> merged with the built-in library by `effectiveLoops()` and re-read each tick, so an operator
> authors/edits/deletes loops from the admin web console (Loops tab + `/api/loop/{create,update,delete,enable}`)
> with no restart. Validated input + `/home` folder fence (`src/engine/loop-validate.ts`), admin-gated;
> built-ins stay run/toggle-only. Spec/plan:
> `docs/superpowers/specs/2026-06-27-loop-crud-design.md`, `docs/superpowers/plans/2026-06-28-loop-crud.md`.
>
> **Scheduled-loop output → operator — live (2026-07-10).** A scheduled fire now streams **only** the
> worker's real text to the operator's Telegram chat (the admin id, resolved at fire time so a late
> TOFU admin still works), tagged with the loop's `#project` — the same streaming style as dispatch.
> There is **no** start/iteration/outcome chrome, so a loop that emits no worker text sends nothing
> (silent success): a nightly reminder loop stays quiet when there's nothing to report. Falls back to
> daemon stdout when there's no admin/token yet. `runProjectLoop` gained an
> `onMessage` sink (worker text) split from `onProgress` (engine chrome); `startScheduledLoop`
> (`src/engine/loops.ts`) forwards worker text only, delivered by `sendOperatorLine`
> (`src/frontends/telegram.ts`). The interactive `/loop` path keeps `startLoop`'s start/progress/outcome
> chrome.

## What a loop is

A way to let an AI agent work autonomously toward a goal, removing the human from the inner cycle.
Two parts: a **trigger** (what starts it) and a **goal** (when it stops).

## Triggers — how a loop starts

- **Manual** — you tell it to run. (Sometimes necessary, but keeps a human in the loop.)
- **Scheduled** — cron / time-based (e.g. nightly).
- **Action** — fires on an event (PR opened, error logged, board task assigned).

To actually remove the human, prefer **scheduled** or **action** triggers over manual.

## Goals — when a loop stops

- **Verifiable** — a deterministic check. Best kind, least brittle. e.g. "100% test coverage",
  "every page < 50ms", "no unaddressed errors in logs", "`bun test` + `tsc` green".
- **LLM-as-judge** — the model decides it's done. Flexible but brittle (taste left to the model).
  e.g. "refactor until satisfied", "docs are complete". Mitigate by giving explicit criteria
  ("be strict about simplicity", "every line DRY", a scoring rubric).

## The loop library (concrete, reusable)

| Loop | Trigger | Goal type | What it does |
|---|---|---|---|
| **Sub-50ms page load** | manual / PR | verifiable | optimize every page/modal/sidebar, re-measure under the same conditions, until all load < 50ms |
| **Overnight docs sweep** | nightly | LLM-judge | review the day's diff, update docs to match, open a PR |
| **Refactor-until-happy** | nightly / manual | LLM-judge | refactor until the architecture is clean (DRY/simple); after each step live-test + review + commit; track progress in a `.md` |
| **Logging coverage** | manual | LLM-judge | add logging until every important path produces useful, tested logs |
| **Production error sweep** | nightly | verifiable (no unaddressed errors) | scan prod logs → root-cause → fix → verify → PR → ping with findings (or "none") |
| **SEO/GEO visibility** | weekly | verifiable (no critical issues) | audit → rank gaps → fix highest-leverage → re-crawl → repeat |
| **Full product evaluation** | manual | LLM-judge | generate N realistic scenarios + success criteria → run all under the same conditions → fix root causes → rerun until every scenario meets the bar |

Common shape: **define success criteria up front → act → re-measure under identical conditions →
repeat until the goal holds**, tracking progress in a markdown file as it loops.

## Caveats

- **Goal design is the hard part.** Verifiable goals work great; LLM-judge goals are brittle.
- **Not for day-0 feature building.** "Loop until you build a permissioning system" doesn't work —
  the agent's direction is unpredictable. Loops are for **convergence to a measurable state**, not
  open-ended creation.
- **Loops are expensive.** They churn tokens autonomously — minutes to *days*. Watch the budget.

## How this maps to Neo (why we saved this)

Neo's company-engine autonomy is a loop runtime, and the existing pieces already line up:

- **Trigger** = a department's cron schedule, a board event (new/assigned task), or a manual order.
- **Action** = work a board task via a governed SDK worker — exactly what Neo does today per `/open`.
- **Goal** = verifiable (the task's `bun test`/`tsc` green, an acceptance check, the board drained) or
  LLM-judge (the worker reports done). **Prefer verifiable goals for Neo's loops**; reserve LLM-judge
  for refactor/docs-style sweeps.
- **Governance still applies every iteration** — firewall + approval gate + usage guard. Loops remove
  the human from the *kickoff*, not from the irreversible/external actions, which still escalate.
- **Cost guard is load-bearing here** — loops are token-hungry, so gate loop-driven background work on
  the usage/interactive-reserve guard, never draining the plan you use yourself.
- **The board makes loops safe + resumable** — progress lives on the board, not in a session, so a
  loop survives idle-close / restart. That reuses Neo's existing idle-close + resume.

**First loops worth shipping in Neo** (each a department/scheduler behavior, verifiable-goal first):
nightly **docs-sweep** per active project · **error-sweep** over a project's logs · a **test/coverage**
loop that runs until green before a board task is marked done.

This is the design backbone for the scheduler when we build the company engine.
