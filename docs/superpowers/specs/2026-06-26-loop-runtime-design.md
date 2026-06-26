# Spec — Complete Neo's loop runtime (the Claude Code config model, engine-native)

- **Status:** Draft for review
- **Date:** 2026-06-26
- **Author:** Neo (operator) + Claude
- **Topic:** Bring Claude Code's `/loop` + `/goal` configuration model into Neo's engine-owned loop.
- **Related:** `docs/loops.md` (autonomy model), `docs/sdk-notes.md`, `MVP-PLAN.md` Phase 4.

## 1. Why

Neo already has a loop *skeleton* that is structurally correct:

- `src/engine/loop-runner.ts` — `runLoop(spec)`: `iterate → check goal → maxIterations bound → shouldStop kill-switch → onProgress`.
- `src/engine/goal.ts` — `commandGoal()`: a verifiable goal (run a command, exit 0 = met).
- `src/engine/project-loop.ts` — `runProjectLoop()`: composes the governed SDK worker with the loop primitive; escalations auto-denied.
- `src/engine/loops.ts` — the `/loop` command: a hardcoded registry with **one** loop (`gold-gofmt`), manual trigger only.

Measured against the autonomy model in `docs/loops.md` and Claude Code's own loop feature, three things are missing — the operator's words: *"it lacks goal and other loop configuration."*

| Axis | `docs/loops.md` vision / Claude Code | Neo today | Gap this spec closes |
|---|---|---|---|
| **Goal** | verifiable **and** LLM-judge, model-checked, with a budget clause | one fixed verifiable command | add a `Goal` union (`command` + `judge`) |
| **Trigger** | manual + scheduled (cron) + event | manual `/loop <name>` only | add a `Trigger` union (`manual` + `interval` + `cron`) + a daemon scheduler |
| **Bounds** | `--max-turns` + token/cost budget | `maxIterations` only; cost guard unused | add `budgetUsd` cap + wire `meter.shouldThrottle()` into `shouldStop` |

### 1.1 Research finding that fixes the architecture

`/loop`, `/goal`, and the cron scheduler are features of the **Claude Code CLI/REPL** (and, for routines, Anthropic **cloud**) — **not** of the Agent SDK. Confirmed from the SDK docs: *"Only commands that work without an interactive terminal are dispatchable through the SDK; the `system/init` message lists the ones available in your session"* — that list is context plumbing only (`clear`, `compact`, `context`, `usage`). `/loop`'s scheduler *"checks every second … fires between your turns"* — that lives in the long-running REPL, which `query()` does not have.

**Consequence:** Neo *must* own loop + goal + scheduler in the engine. This is not a workaround — it is the only correct design, and it is what keeps Neo's core principle intact: **AI decides, the engine acts and governs**, with no AI in the engine. The SDK supplies the primitives we build on: `resume` (continue a session), `maxTurns` (hard turn cap), and the `Stop` hook (the exact mechanism `/goal` is a wrapper around — reserved here as a future enhancement, §6).

## 2. Goals / Non-goals

**Goals**
1. A `Goal` discriminated union: verifiable `command` (today) + new `judge` (LLM-as-judge via a worker).
2. A `Trigger` discriminated union: `manual` + `interval` + `cron`, with an AI-free 5-field cron matcher.
3. Per-loop `bounds`: `maxIterations` + `budgetUsd` + `timeoutMs`, with the budget meter wired into the loop's stop condition.
4. A deterministic, AI-free **scheduler** in the daemon that fires due loops through the existing governed `runProjectLoop`, surviving restart via ledger-persisted `lastRun`.
5. A declarative loop **library** (replacing the single hardcoded def) plus `/loop` command + web-tab surfacing.

**Non-goals (YAGNI — explicitly deferred)**
- **Event triggers** (PR-opened / error-logged / board-task / GitHub / API). Deferred behind the `isDue()` seam; see §7.
- **Cloud routines / desktop scheduled tasks.** Out of scope — Neo is a single self-hosted daemon.
- **Dynamic self-paced intervals** (Claude Code's "pick the next delay"). Cron + fixed interval cover Neo's first loops; revisit later.
- **Operator CRUD of loop defs at runtime.** The library is defined in code; enable/disable is the only runtime control. No persisted user-authored loop store yet.
- **The `Stop`-hook in-iteration guard.** Documented as a future enhancement (§6), not built now.

## 3. Design overview

Everything plugs into the three inputs `runLoop` already takes. We enrich them; the loop algorithm is unchanged.

```
LoopDef (declarative)
  ├─ trigger:  Trigger   ──▶ scheduler decides WHEN to fire  (new: scheduler.ts + trigger.ts)
  ├─ goal:     Goal      ──▶ makeGoalCheck() → runLoop.check (new: goal.ts union + judgeGoal)
  ├─ bounds:   Bounds    ──▶ runLoop.maxIterations + budget/throttle → shouldStop (new wiring)
  ├─ folder, prompt      ──▶ runProjectLoop → governed SDK worker (unchanged)
```

Data flow of one scheduled fire:

```
daemon tick (60s)                       scheduler.tick(now)
  └─ for each LoopDef:
       isDue(trigger, lastRun, now)?  ──┐
       not already running in registry? │ all true ─▶ runProjectLoop(def)  (governed; escalations auto-denied)
       !meter.shouldThrottle()?       ──┘                 │
                                                          ├─ iterate: runOrder(resume) → costUsd
                                                          ├─ check:   makeGoalCheck(goal)   (command exit-code | judge worker verdict)
                                                          └─ stop:    goal met | maxIterations | budgetUsd | meter throttle | /kill
       store.setLastRun(name, now)  ◀──────────────────── on completion
```

## 4. Detailed design

### 4.1 Goal model — `Goal` union (`src/engine/goal.ts`)

```ts
export type Goal =
  | { kind: "command"; command: string[]; timeoutMs?: number } // verifiable — engine runs it, exit 0 = met
  | { kind: "judge"; criteria: string; timeoutMs?: number };   // LLM-judge — a worker returns the verdict

export type GoalCheck = () => Promise<{ met: boolean; detail: string }>;

/** Build a GoalCheck from a Goal. `cwd` is the loop's folder; `run` is the worker runner (judge only). */
export function makeGoalCheck(goal: Goal, deps: { cwd: string; run?: typeof runOrder }): GoalCheck;

export function commandGoal(opts: { command: string[]; cwd: string; timeoutMs?: number }): GoalCheck; // unchanged
export function judgeGoal(opts: { criteria: string; cwd: string; run?: typeof runOrder; timeoutMs?: number }): GoalCheck; // new
```

- `command` — unchanged `commandGoal`. **Preferred** (verifiable, least brittle — `docs/loops.md`).
- `judge` — mirrors `/goal`: a model judges whether the criteria hold. To keep the **engine AI-free and the firewall intact**, the verdict comes from a **worker**, not from engine code calling a model:
  - It issues a `runOrder` call (`source:"neo"`, subscription — *your own work*, judging *your* project) with a **read-only** tool policy: a `canUseTool`/handler that denies `Write`, `Edit`, and any `Bash` (so the judge cannot "fix, then declare done") and auto-denies escalations.
  - The prompt embeds the criteria and demands a strict last line: `VERDICT: DONE` or `VERDICT: CONTINUE — <reason>`.
  - The engine **parses deterministically**: `met = /^VERDICT:\s*DONE\b/m` against the worker's final text. **Absent/unparseable ⇒ not met** (safe default: never falsely declare done). `detail` = the reason.
  - Judge runs count toward `bounds.budgetUsd` (their `costUsd` is metered like any worker run).
- Rejected alternative: trust the loop worker's self-report — that is the worker grading its own homework. The separate read-only judge is the robust shape and matches how `/goal` uses a *separate* evaluator.

### 4.2 Bounds + cost guard (`src/engine/loop-runner.ts`, `project-loop.ts`)

```ts
export interface Bounds { maxIterations: number; budgetUsd?: number; timeoutMs?: number }
```

- `iterate()` already returns the worker result; extend its return with `costUsd` (from `RunResult.costUsd`). `runLoop` accumulates `spentUsd`.
- New stop conditions, checked before each iteration (alongside the existing `maxIterations` and `shouldStop`):
  - `budgetUsd` set and `spentUsd >= budgetUsd` ⇒ stop.
  - `shouldStop()` (the daemon passes `() => meter.shouldThrottle()`) ⇒ stop — a loop **yields to your interactive reserve** rather than draining the subscription (the "load-bearing" cost guard from `docs/loops.md`).
- `LoopOutcome.reason` gains `"over-budget" | "throttled"` (in addition to `goal-met | max-iterations | stopped`).

### 4.3 Trigger model + cron matcher (`src/engine/trigger.ts` — new)

```ts
export type Trigger =
  | { kind: "manual" }                       // only the /loop command starts it
  | { kind: "interval"; everyMs: number }    // fixed cadence
  | { kind: "cron"; expr: string };          // 5-field cron, local tz

/** Is this trigger due to fire now, given when it last ran? Manual is never due via the scheduler. */
export function isDue(trigger: Trigger, lastRun: number | undefined, now: number): boolean;

/** Minimal, dependency-free 5-field cron: `min hour dom month dow`. Supports *, n, */n, a-b, a,b. */
export function cronMatches(expr: string, at: number): boolean;
```

- `interval`: `now - (lastRun ?? 0) >= everyMs`.
- `cron`: `cronMatches(expr, now)` **and** not already fired this minute (`lastRun === undefined || now - lastRun >= 60_000`). Tick is 60s, so a matching minute fires once.
- `manual`: always `false` here — started only by the `/loop <name>` command (§4.5).
- Cron matcher is deliberately a tiny port (no `L`/`W`/`?`/name-aliases) — AI-free, unit-tested with an injected timestamp. Local timezone, matching Claude Code semantics.

### 4.4 Scheduler (`src/engine/scheduler.ts` — new; wired in `src/daemon.ts`)

```ts
export interface LoopStateStore {
  getLastRun(name: string): number | undefined;
  setLastRun(name: string, at: number): void;
  isEnabled(name: string): boolean;          // schedule on/off; defaults to the def's `enabledByDefault`
  setEnabled(name: string, on: boolean): void;
}

export function tickScheduler(deps: {
  loops: LoopDef[];
  store: LoopStateStore;
  registry: Registry;            // skip if a session for this folder is already live
  meter: Meter;                  // skip if throttled
  now: number;
  start: (def: LoopDef) => Promise<LoopOutcome>;   // defaults to a runProjectLoop wrapper
}): Promise<void>;
```

- For each enabled loop: if `isDue(def.trigger, store.getLastRun(name), now)` **and** no live session for `def.folder` in the registry **and** `!meter.shouldThrottle(now)` → `store.setLastRun(name, now)` then `start(def)` (fire-and-stream; not awaited in the tick).
- `setLastRun` is written **before** starting, so a long loop spanning multiple ticks does not double-fire.
- Persistence: `LoopStateStore` is implemented by the **ledger** (new small table/methods) so cron loops survive a daemon restart. Tests use an in-memory store.
- Daemon wiring: a second `setInterval(..., 60_000)` beside the idle watchdog (`daemon.ts:62`), guarded by config so it can be disabled (`config.loopSchedulerEnabled`, default on; the kill-switch analog of `CLAUDE_CODE_DISABLE_CRON`).

### 4.5 Declarative library + `/loop` UX (`src/engine/loops.ts`, `src/frontends/*`)

Extend `LoopDef`:

```ts
export interface LoopDef {
  name: string; usage: string; summary: string;
  folder: string; prompt: string;
  goal: Goal;                 // replaces goalCommand
  trigger: Trigger;           // new
  bounds: Bounds;             // replaces bare maxIterations/timeoutMs
  enabledByDefault?: boolean; // for scheduled loops
}
```

Shipped library (replacing the lone `gold-gofmt`, which stays as a `command` example):

| Loop | Trigger | Goal | Notes |
|---|---|---|---|
| `gold-gofmt` | manual | command (`gofmt -l server/` empty) | unchanged example |
| `green` | manual | command (`bun test` + `tsc --noEmit` exit 0) | "make it green" before marking work done |
| `error-sweep` | cron nightly | command (a scan script exits 0 = no unaddressed errors) | verifiable per `docs/loops.md` |
| `docs-sweep` | cron nightly | judge (`docs reflect today's diff`) | LLM-judge reserved for docs/refactor sweeps |

`/loop` command:
- `/loop` — list loops with trigger, last-run, next-fire, enabled-state.
- `/loop <name>` — run now (manual override, even for scheduled loops).
- `/loop <name> on|off` — enable/disable a schedule (`store.setEnabled`).
- Unknown name → list (today's behavior).

Web "Loops" tab: render the same list + state (read-only first; on/off later).

## 5. Governance & compliance (unchanged invariants, restated)

- **Firewall:** every loop iteration and every judge run is a `source:"neo"` worker on the subscription — *your own work*. The provider router still refuses `customer → subscription`. No change.
- **Approval gate:** loop workers auto-deny escalations (existing `onEscalation: () => "deny"`); the judge worker is **read-only** (denies Write/Edit/Bash). No autonomous push/deploy/delete.
- **No AI in the engine:** the scheduler, cron matcher, bounds, and verdict parsing are deterministic. The only AI is inside the worker (loop) and the judge worker — both governed SDK calls.
- **Cost guard:** `meter.shouldThrottle()` gates both scheduler start and per-iteration continuation, protecting interactive headroom.

## 6. Future enhancement — in-iteration `Stop`-hook guard (documented, not built)

The SDK `Stop` hook is the primitive `/goal` wraps. Neo could install a deterministic (command-based) `Stop` hook on the loop worker's `query()` so a single iteration can't end **before** it has surfaced the evidence the goal checks (e.g. "you haven't run the tests yet — keep going"). This tightens each iteration without putting AI in the engine. Caveat from the SDK docs: *"hooks may not fire when the agent hits the max_turns limit"* — so `bounds.maxIterations` / `maxTurns` remains the **hard** stop, never the only stop. Deferred to a follow-up.

## 7. Future enhancement — event triggers (documented, not built)

Add `{ kind: "event"; … }` to `Trigger` and an event source (file/log watcher, board task, or a webhook → ledger row) that the scheduler drains. The `isDue()` seam and the `LoopStateStore` already accommodate it. This is the path to `docs/loops.md`'s error-sweep-on-new-error and board-task triggers.

## 8. File-by-file change map

| File | Change |
|---|---|
| `src/engine/goal.ts` | add `Goal` union, `makeGoalCheck`, `judgeGoal`; keep `commandGoal` |
| `src/engine/loop-runner.ts` | `iterate` returns `costUsd`; accumulate `spentUsd`; `budgetUsd`/throttle stops; new `reason`s |
| `src/engine/project-loop.ts` | take `goal: Goal` + `bounds`; thread cost; pass read-only deps to judge |
| `src/engine/trigger.ts` | **new** — `Trigger`, `isDue`, `cronMatches` |
| `src/engine/scheduler.ts` | **new** — `tickScheduler`, `LoopStateStore` |
| `src/engine/loops.ts` | extend `LoopDef`; ship library; `/loop <name> on/off`; richer listing |
| `src/engine/ledger.ts` | implement `LoopStateStore` (last-run + enabled persistence) |
| `src/daemon.ts` | second `setInterval` → `tickScheduler`; config gate |
| `src/config.ts` | `loopSchedulerEnabled` (default true) |
| `src/frontends/telegram.ts`, `web.ts` | surface trigger/last-run/next-fire/enabled |
| `tests/*` | one test file per module below (TDD) |

## 9. Testing strategy (TDD — write the failing test first)

- `goal.test.ts` — `command` met/not-met (existing); `judge` parses `VERDICT: DONE`/`CONTINUE`; unparseable ⇒ not-met; judge handler denies Write/Edit/Bash.
- `loop-runner.test.ts` — existing behaviors hold; **new**: stops `over-budget` when `spentUsd ≥ budgetUsd`; stops `throttled` when `shouldStop` fires; cost accumulates across iterations.
- `trigger.test.ts` — `cronMatches` across `*`, `n`, `*/n`, `a-b`, `a,b`, dom/dow; `isDue` for interval/cron/manual; no double-fire within a minute.
- `scheduler.test.ts` — fires due + enabled + not-running + not-throttled; skips when a session is live, throttled, or disabled; writes `lastRun` before starting; injected `now` + fake `start`.
- `loops.test.ts` — extended `LoopDef`s match/list; `/loop <name> on|off` toggles; run-now path.

Every step: `bunx tsc --noEmit` + `bun test` green before the next; commit per logical step.

## 10. Build sequence (one connected spec, 5 TDD steps)

1. **Goal union** — `Goal`, `makeGoalCheck`, `judgeGoal`; migrate `commandGoal` callers.
2. **Bounds + cost guard** — `budgetUsd`, cost accumulation, `meter` into `shouldStop`, new outcome reasons.
3. **Trigger + cron** — `trigger.ts` (`isDue`, `cronMatches`).
4. **Scheduler** — `scheduler.ts` + `LoopStateStore` (ledger) + `daemon.ts` wiring + config gate.
5. **Library + `/loop` UX** — extended `LoopDef`s, the four loops, command + web surfacing.

## 11. Risks / open items

- **Judge brittleness** — mitigated by strict output contract, read-only policy, safe-default-to-not-met, and reserving judge for docs/refactor loops (verifiable goals preferred everywhere else).
- **Cron correctness** — mitigated by a small, fully unit-tested matcher with an injected clock; no external dependency.
- **Double-fire across restarts** — mitigated by persisting `lastRun` in the ledger and the registry "already running" guard.
- **Cost of judge runs** — they count against `budgetUsd` and the meter; nightly cadence keeps them cheap.

## 12. Self-review notes

- No placeholders/TBDs; every section is concrete.
- Scope is bounded: events, routines, desktop tasks, dynamic pacing, Stop-hook guard, and runtime loop CRUD are explicitly deferred with seams identified.
- Consistent with existing types (`LoopSpec`, `LoopOutcome`, `GoalCheck`, `RunResult`, `Meter`, `Order`) and the daemon's existing 60s-interval pattern.
- Compliance invariants restated and preserved (firewall, approval gate, no-AI-in-engine, cost guard).
