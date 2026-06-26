# Loop Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Claude Code's `/loop` + `/goal` configuration model into Neo's engine-owned loop — a `Goal` union (verifiable command + LLM-judge worker), a `Trigger` union (manual + interval + cron) with a daemon scheduler, and per-loop bounds wiring the budget meter into the stop condition.

**Architecture:** Enrich the three inputs the existing `runLoop` primitive already takes — `check` (goal), `maxIterations`/`shouldStop` (bounds), and a new declarative `trigger`. A deterministic, AI-free `scheduler.ts` fires due loops through the existing governed `runProjectLoop`; loop state persists in the ledger so cron loops survive restart. The only AI is inside SDK workers (the loop worker and the read-only judge worker).

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun:test`, `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- `bunx tsc --noEmit` and `bun test` must both be green before any task is "done".
- TDD: write the failing test first, watch it fail, then minimal code.
- Commit per task. Every commit message ends with the trailer (verbatim):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Conventional commit prefixes: `feat(neo): …` / `refactor(neo): …`.
- **No AI in the engine.** The scheduler, cron matcher, bounds, and verdict parsing are deterministic. AI lives only inside SDK workers.
- Loop workers run as `source:"neo"` (the subscription firewall path) and **auto-deny escalations** (`onEscalation: () => "deny"`). The judge worker runs **read-only** (denies `Write`/`Edit`/`Bash`).
- Reconciliations vs. the spec (`docs/superpowers/specs/2026-06-26-loop-runtime-design.md`): (a) `Bounds` carries `{ maxIterations, budgetUsd? }`; per-command timeouts live on the `Goal` (`timeoutMs`), not on `Bounds`. (b) The meter-throttle stop surfaces via the existing `LoopOutcome.reason: "stopped"` (the meter is wired through `shouldStop`); the spec's "throttled" wording maps to "stopped".

---

## File Structure

| File | Responsibility |
| :--- | :--- |
| `src/engine/session-runner.ts` *(modify)* | export `runConfig`; add `disallowedTools` passthrough for read-only workers |
| `src/engine/goal.ts` *(modify)* | `Goal` union, `commandGoal` (unchanged), `judgeGoal` (read-only worker), `makeGoalCheck` |
| `src/engine/loop-runner.ts` *(modify)* | budget accumulation + `over-budget` stop; cost on `iterate`; `spentUsd` on outcome |
| `src/engine/project-loop.ts` *(modify)* | take `goal: Goal` + `bounds: Bounds`; thread cost; auto-deny escalations |
| `src/engine/trigger.ts` *(create)* | `Trigger` union, `cronMatches`, `isDue` |
| `src/engine/scheduler.ts` *(create)* | `SchedulableLoop`, `LoopStateStore`, `tickScheduler` |
| `src/engine/ledger.ts` *(modify)* | implement `LoopStateStore` (loop_state table) |
| `src/engine/loops.ts` *(modify)* | extended `LoopDef`, the loop library, `/loop` command incl. on/off |
| `src/config.ts` *(modify)* | `loopSchedulerEnabled` |
| `src/daemon.ts` *(modify)* | scheduler tick interval + frontend store wiring |
| `src/frontends/telegram.ts` *(modify)* | pass `store` + `shouldStop` into the `/loop` deps |

---

## Task 1: Read-only worker option (session-runner)

**Files:**
- Modify: `src/engine/session-runner.ts` (`RunDeps` interface; `runConfig` function ~line 239-246)
- Test: `tests/session-runner-config.test.ts` (create)

**Interfaces:**
- Produces: `runConfig(deps: RunDeps): Record<string, unknown>` (now exported) — forwards `disallowedTools?: string[]` into SDK options. `RunDeps` gains `disallowedTools?: string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/session-runner-config.test.ts`:

```ts
import { test, expect } from "bun:test";
import { runConfig } from "../src/engine/session-runner";

test("runConfig forwards disallowedTools when present", () => {
  expect(runConfig({ disallowedTools: ["Write", "Edit", "Bash"] })).toMatchObject({
    disallowedTools: ["Write", "Edit", "Bash"],
  });
});

test("runConfig omits disallowedTools when absent", () => {
  expect(runConfig({})).not.toHaveProperty("disallowedTools");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session-runner-config.test.ts`
Expected: FAIL — `runConfig` is not exported (`Export named 'runConfig' not found`).

- [ ] **Step 3: Add the field and export the helper**

In `src/engine/session-runner.ts`, add `disallowedTools?: string[];` to the `RunDeps` interface (next to `resume?`), then change `runConfig` to be exported and forward the field:

```ts
// Only-defined keys survive into the SDK options (so absent fields aren't sent as undefined).
export function runConfig(deps: RunDeps): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (deps.resume) c.resume = deps.resume;
  if (deps.effort) c.effort = deps.effort;
  if (deps.mcpServers) c.mcpServers = deps.mcpServers;
  if (deps.disallowedTools) c.disallowedTools = deps.disallowedTools;
  return c;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/session-runner-config.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/session-runner.ts tests/session-runner-config.test.ts
git commit -m "feat(neo): session-runner forwards disallowedTools (read-only worker option)"
```

---

## Task 2: Goal union — `judgeGoal` + `makeGoalCheck` (goal.ts)

**Files:**
- Modify: `src/engine/goal.ts`
- Test: `tests/goal.test.ts` (create)

**Interfaces:**
- Consumes: `runConfig`/`disallowedTools` (Task 1), `runOrder` + `RunResult` from `session-runner`, `Order` from `types`.
- Produces:
  - `type Goal = { kind: "command"; command: string[]; timeoutMs?: number } | { kind: "judge"; criteria: string; timeoutMs?: number }`
  - `judgeGoal(opts: { criteria: string; cwd: string; run?: typeof runOrder; timeoutMs?: number }): GoalCheck`
  - `makeGoalCheck(goal: Goal, deps: { cwd: string; run?: typeof runOrder }): GoalCheck`
  - `commandGoal` unchanged; `GoalCheck` unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/goal.test.ts`:

```ts
import { test, expect } from "bun:test";
import { judgeGoal, makeGoalCheck } from "../src/engine/goal";
import type { RunResult } from "../src/engine/session-runner";

const ok = (summary: string): RunResult => ({ ok: true, sessionId: "s", summary, costUsd: 0 });

test("judgeGoal is met when the worker votes DONE", async () => {
  const check = judgeGoal({
    criteria: "docs match",
    cwd: "/p",
    run: async (_o, h) => {
      h.onMessage("looks consistent\nVERDICT: DONE — docs in sync");
      return ok("");
    },
  });
  const r = await check();
  expect(r.met).toBe(true);
  expect(r.detail.toLowerCase()).toContain("done");
});

test("judgeGoal continues when the worker votes CONTINUE", async () => {
  const check = judgeGoal({
    criteria: "docs match",
    cwd: "/p",
    run: async (_o, h) => {
      h.onMessage("VERDICT: CONTINUE — README is stale");
      return ok("");
    },
  });
  expect((await check()).met).toBe(false);
});

test("judgeGoal defaults to not-met when the verdict is unparseable", async () => {
  const check = judgeGoal({ criteria: "x", cwd: "/p", run: async () => ok("I am unsure") });
  expect((await check()).met).toBe(false);
});

test("judgeGoal runs the worker read-only (denies Write/Edit/Bash)", async () => {
  let captured: { disallowedTools?: string[] } | undefined;
  const check = judgeGoal({
    criteria: "x",
    cwd: "/p",
    run: async (_o, _h, deps) => {
      captured = deps;
      return ok("VERDICT: CONTINUE");
    },
  });
  await check();
  expect(captured?.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
});

test("makeGoalCheck dispatches to the judge for kind:judge", async () => {
  const check = makeGoalCheck(
    { kind: "judge", criteria: "x" },
    { cwd: "/p", run: async (_o, h) => (h.onMessage("VERDICT: DONE"), ok("")) },
  );
  expect((await check()).met).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/goal.test.ts`
Expected: FAIL — `judgeGoal`/`makeGoalCheck` not exported.

- [ ] **Step 3: Implement the goal union**

Append to `src/engine/goal.ts` (and add the two imports at the top):

```ts
import { runOrder } from "./session-runner";
import type { Order } from "../types";

export type Goal =
  | { kind: "command"; command: string[]; timeoutMs?: number }
  | { kind: "judge"; criteria: string; timeoutMs?: number };

const JUDGE_CHAT_ID = -1; // judge runs aren't bound to a chat
const READONLY_DENY = ["Write", "Edit", "NotebookEdit", "Bash"];

function judgePrompt(criteria: string): string {
  return [
    "You are a STRICT, READ-ONLY verifier. Do not modify, create, or run anything that changes state.",
    "Inspect the project and decide whether the following condition holds:",
    "",
    criteria,
    "",
    "Explain your reasoning briefly, then on the FINAL line output EXACTLY one of:",
    "VERDICT: DONE — <one-line reason>",
    "VERDICT: CONTINUE — <what is still missing>",
  ].join("\n");
}

/** LLM-as-judge goal: a fresh, read-only worker returns the verdict. Engine stays AI-free —
 * it only parses the worker's strict last line. Unparseable ⇒ not met (never falsely "done"). */
export function judgeGoal(opts: {
  criteria: string;
  cwd: string;
  run?: typeof runOrder;
  timeoutMs?: number;
}): GoalCheck {
  const run = opts.run ?? runOrder;
  return async () => {
    const order: Order = {
      id: crypto.randomUUID(),
      source: "neo",
      folder: opts.cwd,
      task: judgePrompt(opts.criteria),
      chatId: JUDGE_CHAT_ID,
      createdAt: Date.now(),
    };
    let text = "";
    const result = await run(
      order,
      { onMessage: (t) => void (text += `${t}\n`), onEscalation: async () => "deny" },
      { disallowedTools: READONLY_DENY },
    );
    const blob = `${text}\n${result.summary}`;
    const met = /^\s*VERDICT:\s*DONE\b/im.test(blob);
    const reason = (blob.match(/VERDICT:\s*(?:DONE|CONTINUE)\s*[—-]?\s*(.*)$/im)?.[1] ?? "").trim();
    return { met, detail: `judge: ${met ? "done" : "continue"}${reason ? ` — ${reason}` : ""}` };
  };
}

/** Build the GoalCheck for a declarative Goal. Verifiable command is preferred; judge is for
 * docs/refactor-style sweeps (docs/loops.md). */
export function makeGoalCheck(goal: Goal, deps: { cwd: string; run?: typeof runOrder }): GoalCheck {
  if (goal.kind === "command") {
    return commandGoal({ command: goal.command, cwd: deps.cwd, timeoutMs: goal.timeoutMs });
  }
  return judgeGoal({ criteria: goal.criteria, cwd: deps.cwd, run: deps.run, timeoutMs: goal.timeoutMs });
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/goal.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/goal.ts tests/goal.test.ts
git commit -m "feat(neo): Goal union — add LLM-judge goal (read-only worker) + makeGoalCheck"
```

---

## Task 3: Bounds + cost guard (loop-runner.ts)

**Files:**
- Modify: `src/engine/loop-runner.ts`
- Test: `tests/loop-runner.test.ts` (append)

**Interfaces:**
- Produces:
  - `LoopSpec.iterate` returns `{ sessionId: string; summary: string; costUsd?: number }`
  - `LoopSpec` gains `budgetUsd?: number`
  - `LoopOutcome.reason` becomes `"goal-met" | "max-iterations" | "over-budget" | "stopped"`; `LoopOutcome` gains `spentUsd: number`

- [ ] **Step 1: Write the failing test**

Append to `tests/loop-runner.test.ts`:

```ts
test("runLoop stops with over-budget once spent reaches budgetUsd", async () => {
  let iterated = 0;
  const out = await runLoop({
    check: async () => ({ met: false, detail: "red" }),
    iterate: async () => (iterated++, { sessionId: "s", summary: "", costUsd: 2 }),
    maxIterations: 10,
    budgetUsd: 3,
  });
  // iter1 spends 2 (<3, continue), iter2 spends 2 → 4 (≥3, stop before iter3)
  expect(out.reason).toBe("over-budget");
  expect(iterated).toBe(2);
  expect(out.spentUsd).toBe(4);
});

test("runLoop accumulates spentUsd across iterations", async () => {
  const checks = [false, true];
  let ci = 0;
  const out = await runLoop({
    check: async () => ({ met: checks[ci++], detail: "c" }),
    iterate: async () => ({ sessionId: "s", summary: "", costUsd: 1.5 }),
    maxIterations: 5,
  });
  expect(out.met).toBe(true);
  expect(out.spentUsd).toBe(1.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/loop-runner.test.ts`
Expected: FAIL — `over-budget` not a valid reason / `spentUsd` undefined.

- [ ] **Step 3: Replace the loop primitive**

Replace the `LoopSpec`, `LoopOutcome`, and `runLoop` definitions in `src/engine/loop-runner.ts` with:

```ts
export interface LoopSpec {
  /** Run one iteration. Returns the new SDK session id (to resume next time) and its cost. */
  iterate: (resumeId: string | undefined, n: number) => Promise<{ sessionId: string; summary: string; costUsd?: number }>;
  /** Verifiable goal check — deterministic, engine-side. */
  check: () => Promise<{ met: boolean; detail: string }>;
  /** Hard bound: give up after this many iterations even if the goal isn't met. */
  maxIterations: number;
  /** Optional cost ceiling (USD, summed across iterations). */
  budgetUsd?: number;
  /** Optional kill-switch / throttle checked before each iteration (usage cap, /kill, etc.). */
  shouldStop?: () => boolean;
  /** Optional progress reporter (one line per iteration). */
  onProgress?: (msg: string) => void;
}

export interface LoopOutcome {
  met: boolean;
  iterations: number;
  reason: "goal-met" | "max-iterations" | "over-budget" | "stopped";
  lastDetail: string;
  spentUsd: number;
}

export async function runLoop(spec: LoopSpec): Promise<LoopOutcome> {
  let resumeId: string | undefined;
  let lastDetail = "";
  let spentUsd = 0;

  for (let n = 0; ; n++) {
    const goal = await spec.check();
    lastDetail = goal.detail;
    if (goal.met) return { met: true, iterations: n, reason: "goal-met", lastDetail, spentUsd };
    if (n >= spec.maxIterations) return { met: false, iterations: n, reason: "max-iterations", lastDetail, spentUsd };
    if (spec.budgetUsd !== undefined && spentUsd >= spec.budgetUsd)
      return { met: false, iterations: n, reason: "over-budget", lastDetail, spentUsd };
    if (spec.shouldStop?.()) return { met: false, iterations: n, reason: "stopped", lastDetail, spentUsd };

    spec.onProgress?.(`iteration ${n + 1}: ${goal.detail}`);
    const r = await spec.iterate(resumeId, n + 1);
    resumeId = r.sessionId;
    spentUsd += r.costUsd ?? 0;
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/loop-runner.test.ts && bunx tsc --noEmit`
Expected: the four original tests + two new ones PASS. (tsc will flag `project-loop.ts` until Task 4 — that is expected; finish Task 4 before claiming green across the repo.)

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop-runner.ts tests/loop-runner.test.ts
git commit -m "feat(neo): loop-runner — budget ceiling (over-budget) + spentUsd accounting"
```

---

## Task 4: Project-loop migration to Goal + Bounds (project-loop.ts)

**Files:**
- Modify: `src/engine/project-loop.ts`
- Test: `tests/project-loop.test.ts` (rewrite the two existing tests)

**Interfaces:**
- Consumes: `makeGoalCheck`/`Goal` (Task 2), updated `runLoop` (Task 3), `runOrder`/`RunResult`.
- Produces:
  - `interface Bounds { maxIterations: number; budgetUsd?: number }`
  - `interface ProjectLoopOpts { folder: string; prompt: string; goal: Goal; bounds: Bounds; onProgress?: (msg: string) => void; shouldStop?: () => boolean }`
  - `runProjectLoop(opts: ProjectLoopOpts, deps?: { run?: typeof runOrder; check?: GoalCheck }): Promise<LoopOutcome>`

- [ ] **Step 1: Rewrite the failing tests**

Replace the contents of `tests/project-loop.test.ts` with:

```ts
import { test, expect } from "bun:test";
import { runProjectLoop } from "../src/engine/project-loop";
import type { RunResult } from "../src/engine/session-runner";

const ok = (sessionId: string, costUsd = 0): RunResult => ({ ok: true, sessionId, summary: "", costUsd });

test("runProjectLoop runs the worker until the goal passes, resuming each time", async () => {
  const checks = [false, false, true];
  let ci = 0;
  let runs = 0;
  const resumes: Array<string | undefined> = [];
  const out = await runProjectLoop(
    { folder: "/p/gold", prompt: "make tests pass", goal: { kind: "command", command: ["true"] }, bounds: { maxIterations: 5 } },
    {
      run: async (_o, h, d) => {
        runs++;
        resumes.push(d?.resume);
        h.onMessage("working");
        return ok(`s${runs}`);
      },
      check: async () => ({ met: checks[ci++] ?? true, detail: "c" }),
    },
  );
  expect(out.met).toBe(true);
  expect(runs).toBe(2);
  expect(resumes).toEqual([undefined, "s1"]); // first fresh, then resume the prior session
});

test("loop workers auto-deny risky escalations (no autonomous push/deploy)", async () => {
  let decision: "allow" | "deny" | undefined;
  await runProjectLoop(
    { folder: "/p/gold", prompt: "x", goal: { kind: "command", command: ["true"] }, bounds: { maxIterations: 1 } },
    {
      run: async (_o, h) => {
        decision = await h.onEscalation("git push");
        return ok("s");
      },
      check: async () => ({ met: false, detail: "" }),
    },
  );
  expect(decision).toBe("deny");
});

test("runProjectLoop stops over-budget using worker cost", async () => {
  const out = await runProjectLoop(
    { folder: "/p", prompt: "x", goal: { kind: "command", command: ["false"] }, bounds: { maxIterations: 10, budgetUsd: 1 } },
    { run: async (_o, _h) => ok("s", 1), check: async () => ({ met: false, detail: "" }) },
  );
  expect(out.reason).toBe("over-budget");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/project-loop.test.ts`
Expected: FAIL — `goalCommand` no longer the shape / `bounds` unknown.

- [ ] **Step 3: Rewrite project-loop**

Replace the body of `src/engine/project-loop.ts` with:

```ts
// Integration: run a verifiable OR judged loop on a project by composing the governed SDK worker
// (session-runner) with the loop primitive (loop-runner) and a Goal (goal). Each iteration opens
// the folder and resumes the prior session so the worker keeps its context; the engine checks the
// goal between iterations. Escalations are AUTO-DENIED: an autonomous loop can read/edit/test/
// commit, but never push/deploy/rm. This is the safe shape for "Neo works while you sleep".
import { runLoop, type LoopOutcome } from "./loop-runner";
import { makeGoalCheck, type Goal, type GoalCheck } from "./goal";
import { runOrder } from "./session-runner";
import type { Order } from "../types";

const LOOP_CHAT_ID = -1; // loops aren't bound to a chat

export interface Bounds {
  maxIterations: number;
  /** Optional cost ceiling (USD) summed across iterations (incl. judge runs). */
  budgetUsd?: number;
}

export interface ProjectLoopOpts {
  folder: string;
  /** What the worker should attempt each iteration. */
  prompt: string;
  /** The goal: a verifiable command or an LLM-judge condition. */
  goal: Goal;
  bounds: Bounds;
  onProgress?: (msg: string) => void;
  shouldStop?: () => boolean;
}

export async function runProjectLoop(
  opts: ProjectLoopOpts,
  deps: { run?: typeof runOrder; check?: GoalCheck } = {},
): Promise<LoopOutcome> {
  const run = deps.run ?? runOrder;
  const check = deps.check ?? makeGoalCheck(opts.goal, { cwd: opts.folder, run });

  return runLoop({
    maxIterations: opts.bounds.maxIterations,
    budgetUsd: opts.bounds.budgetUsd,
    shouldStop: opts.shouldStop,
    onProgress: opts.onProgress,
    check,
    iterate: async (resumeId) => {
      const order: Order = {
        id: crypto.randomUUID(),
        source: "neo",
        folder: opts.folder,
        task: opts.prompt,
        chatId: LOOP_CHAT_ID,
        createdAt: Date.now(),
      };
      const result = await run(
        order,
        {
          onMessage: (t) => opts.onProgress?.(t),
          onEscalation: async () => "deny", // autonomous loop never does risky/irreversible ops
        },
        resumeId ? { resume: resumeId } : {},
      );
      return { sessionId: result.sessionId, summary: result.summary, costUsd: result.costUsd };
    },
  });
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/project-loop.test.ts && bunx tsc --noEmit`
Expected: PASS. tsc will now flag `loops.ts` (still on the old `LoopDef`) — expected until Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/engine/project-loop.ts tests/project-loop.test.ts
git commit -m "refactor(neo): project-loop takes Goal + Bounds (verifiable or judge)"
```

---

## Task 5: Trigger union + cron matcher (trigger.ts)

**Files:**
- Create: `src/engine/trigger.ts`
- Test: `tests/trigger.test.ts` (create)

**Interfaces:**
- Produces:
  - `type Trigger = { kind: "manual" } | { kind: "interval"; everyMs: number } | { kind: "cron"; expr: string }`
  - `cronMatches(expr: string, at: number): boolean`
  - `isDue(trigger: Trigger, lastRun: number | undefined, now: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/trigger.test.ts`:

```ts
import { test, expect } from "bun:test";
import { cronMatches, isDue } from "../src/engine/trigger";

const at = (s: string) => new Date(s).getTime(); // local time

test("cronMatches wildcard fires every minute", () => {
  expect(cronMatches("* * * * *", at("2026-06-26T03:30:00"))).toBe(true);
});

test("cronMatches specific minute and hour", () => {
  expect(cronMatches("30 3 * * *", at("2026-06-26T03:30:00"))).toBe(true);
  expect(cronMatches("30 3 * * *", at("2026-06-26T03:31:00"))).toBe(false);
  expect(cronMatches("30 3 * * *", at("2026-06-26T04:30:00"))).toBe(false);
});

test("cronMatches steps, ranges, and lists", () => {
  expect(cronMatches("*/15 * * * *", at("2026-06-26T03:45:00"))).toBe(true);
  expect(cronMatches("*/15 * * * *", at("2026-06-26T03:46:00"))).toBe(false);
  expect(cronMatches("0 9-17 * * *", at("2026-06-26T13:00:00"))).toBe(true);
  expect(cronMatches("0 9-17 * * *", at("2026-06-26T18:00:00"))).toBe(false);
  expect(cronMatches("0 0 1,15 * *", at("2026-06-15T00:00:00"))).toBe(true);
});

test("cronMatches day-of-week treats 0 and 7 as Sunday", () => {
  // 2026-06-28 is a Sunday
  expect(cronMatches("0 0 * * 0", at("2026-06-28T00:00:00"))).toBe(true);
  expect(cronMatches("0 0 * * 7", at("2026-06-28T00:00:00"))).toBe(true);
  expect(cronMatches("0 0 * * 1", at("2026-06-28T00:00:00"))).toBe(false);
});

test("isDue: manual never fires via the scheduler", () => {
  expect(isDue({ kind: "manual" }, undefined, at("2026-06-26T03:30:00"))).toBe(false);
});

test("isDue: interval respects everyMs", () => {
  const now = at("2026-06-26T03:30:00");
  expect(isDue({ kind: "interval", everyMs: 60_000 }, undefined, now)).toBe(true);
  expect(isDue({ kind: "interval", everyMs: 3_600_000 }, now - 60_000, now)).toBe(false);
  expect(isDue({ kind: "interval", everyMs: 3_600_000 }, now - 3_600_000, now)).toBe(true);
});

test("isDue: cron fires on a match but not twice in the same minute", () => {
  const now = at("2026-06-26T03:30:00");
  expect(isDue({ kind: "cron", expr: "30 3 * * *" }, undefined, now)).toBe(true);
  expect(isDue({ kind: "cron", expr: "30 3 * * *" }, now - 1000, now)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trigger.test.ts`
Expected: FAIL — module `trigger` not found.

- [ ] **Step 3: Implement trigger.ts**

Create `src/engine/trigger.ts`:

```ts
// Trigger model + a tiny, dependency-free 5-field cron matcher. AI-free and deterministic — the
// scheduler asks isDue() each tick. Supports `*`, `n`, `*/n`, `a-b`, `a,b`; day-of-week 0 or 7 = Sun.
// No L/W/?/name-aliases (YAGNI). Local timezone, matching Claude Code's cron semantics.

export type Trigger =
  | { kind: "manual" }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expr: string };

function fieldMatches(spec: string, value: number, min: number, max: number): boolean {
  return spec.split(",").some((part) => {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      step = Number(part.slice(slash + 1));
      range = part.slice(0, slash);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step < 1) return false;
    for (let v = lo; v <= hi; v += step) if (v === value) return true;
    return false;
  });
}

export function cronMatches(expr: string, at: number): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  const d = new Date(at);
  const day = d.getDay(); // 0=Sun..6=Sat

  const domMatch = fieldMatches(dom, d.getDate(), 1, 31);
  const dowMatch = fieldMatches(dow, day, 0, 7) || (day === 0 && fieldMatches(dow, 7, 0, 7));
  // vixie-cron: when BOTH dom and dow are restricted, a date matches if EITHER matches.
  const dayOk = dom !== "*" && dow !== "*" ? domMatch || dowMatch : domMatch && dowMatch;

  return (
    fieldMatches(min, d.getMinutes(), 0, 59) &&
    fieldMatches(hour, d.getHours(), 0, 23) &&
    fieldMatches(mon, d.getMonth() + 1, 1, 12) &&
    dayOk
  );
}

/** Is this trigger due to fire now, given when it last ran? Manual never fires via the scheduler. */
export function isDue(trigger: Trigger, lastRun: number | undefined, now: number): boolean {
  switch (trigger.kind) {
    case "manual":
      return false;
    case "interval":
      return now - (lastRun ?? 0) >= trigger.everyMs;
    case "cron":
      return cronMatches(trigger.expr, now) && (lastRun === undefined || now - lastRun >= 60_000);
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/trigger.test.ts && bunx tsc --noEmit`
Expected: PASS (tsc still flags `loops.ts` until Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/engine/trigger.ts tests/trigger.test.ts
git commit -m "feat(neo): Trigger union + dependency-free 5-field cron matcher (isDue)"
```

---

## Task 6: Scheduler (scheduler.ts)

**Files:**
- Create: `src/engine/scheduler.ts`
- Test: `tests/scheduler.test.ts` (create)

**Interfaces:**
- Consumes: `isDue`/`Trigger` (Task 5).
- Produces:
  - `interface SchedulableLoop { name: string; folder: string; trigger: Trigger; enabledByDefault?: boolean }`
  - `interface LoopStateStore { getLastRun(name): number | undefined; setLastRun(name, at): void; isEnabled(name): boolean | undefined; setEnabled(name, on): void }`
  - `tickScheduler<T extends SchedulableLoop>(deps: { loops: T[]; store: LoopStateStore; isFolderBusy: (folder: string) => boolean; throttled: () => boolean; now: number; start: (def: T) => void }): void`

- [ ] **Step 1: Write the failing test**

Create `tests/scheduler.test.ts`:

```ts
import { test, expect } from "bun:test";
import { tickScheduler, type SchedulableLoop, type LoopStateStore } from "../src/engine/scheduler";

function memStore(init: Record<string, { lastRun?: number; enabled?: boolean }> = {}): LoopStateStore {
  const s = new Map(Object.entries(init));
  return {
    getLastRun: (n) => s.get(n)?.lastRun,
    setLastRun: (n, at) => void s.set(n, { ...s.get(n), lastRun: at }),
    isEnabled: (n) => s.get(n)?.enabled,
    setEnabled: (n, on) => void s.set(n, { ...s.get(n), enabled: on }),
  };
}
const loop = (over: Partial<SchedulableLoop> = {}): SchedulableLoop => ({
  name: "l",
  folder: "/p",
  trigger: { kind: "interval", everyMs: 1000 },
  enabledByDefault: true,
  ...over,
});

test("fires a due, enabled, free, unthrottled loop and records lastRun before starting", () => {
  const started: string[] = [];
  const store = memStore();
  tickScheduler({ loops: [loop()], store, isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual(["l"]);
  expect(store.getLastRun("l")).toBe(10_000);
});

test("skips when the folder is busy", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore(), isFolderBusy: () => true, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("skips when throttled", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore(), isFolderBusy: () => false, throttled: () => true, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("explicit disabled overrides enabledByDefault", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore({ l: { enabled: false } }), isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("skips manual loops entirely", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop({ trigger: { kind: "manual" } })], store: memStore(), isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL — module `scheduler` not found.

- [ ] **Step 3: Implement scheduler.ts**

Create `src/engine/scheduler.ts`:

```ts
// The loop scheduler: a deterministic, AI-free tick. Each fire, it starts every loop whose trigger
// is due AND is enabled AND whose folder isn't already busy AND isn't throttled by the budget meter.
// lastRun is written BEFORE starting so a long loop spanning ticks never double-fires. The daemon
// runs tickScheduler on a 60s interval beside the idle watchdog (see daemon.ts).
import { isDue, type Trigger } from "./trigger";

export interface SchedulableLoop {
  name: string;
  folder: string;
  trigger: Trigger;
  enabledByDefault?: boolean;
}

export interface LoopStateStore {
  getLastRun(name: string): number | undefined;
  setLastRun(name: string, at: number): void;
  /** Explicit on/off override; undefined ⇒ use the loop's enabledByDefault. */
  isEnabled(name: string): boolean | undefined;
  setEnabled(name: string, on: boolean): void;
}

export interface TickDeps<T extends SchedulableLoop> {
  loops: T[];
  store: LoopStateStore;
  isFolderBusy: (folder: string) => boolean;
  throttled: () => boolean;
  now: number;
  start: (def: T) => void;
}

export function tickScheduler<T extends SchedulableLoop>(deps: TickDeps<T>): void {
  for (const def of deps.loops) {
    const enabled = deps.store.isEnabled(def.name) ?? def.enabledByDefault ?? false;
    if (!enabled) continue;
    if (!isDue(def.trigger, deps.store.getLastRun(def.name), deps.now)) continue;
    if (deps.isFolderBusy(def.folder)) continue;
    if (deps.throttled()) continue;
    deps.store.setLastRun(def.name, deps.now); // record before starting → no double-fire
    deps.start(def);
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/scheduler.test.ts && bunx tsc --noEmit`
Expected: PASS (tsc still flags `loops.ts` until Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/engine/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(neo): loop scheduler tick (due + enabled + free + unthrottled)"
```

---

## Task 7: Ledger implements LoopStateStore (ledger.ts)

**Files:**
- Modify: `src/engine/ledger.ts` (`Ledger` interface; `openLedger` table DDL + returned object)
- Test: `tests/loop-state.test.ts` (create)

**Interfaces:**
- Consumes: `LoopStateStore` (Task 6).
- Produces: `Ledger` now structurally satisfies `LoopStateStore` (adds `getLastRun`, `setLastRun`, `isEnabled`, `setEnabled`).

- [ ] **Step 1: Write the failing test**

Create `tests/loop-state.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";

test("ledger persists loop last-run and enabled state independently", () => {
  const l = openLedger(":memory:");
  expect(l.getLastRun("docs-sweep")).toBeUndefined();
  expect(l.isEnabled("docs-sweep")).toBeUndefined();

  l.setLastRun("docs-sweep", 12345);
  expect(l.getLastRun("docs-sweep")).toBe(12345);

  l.setEnabled("docs-sweep", true);
  expect(l.isEnabled("docs-sweep")).toBe(true);
  expect(l.getLastRun("docs-sweep")).toBe(12345); // unchanged by the enabled write

  l.setEnabled("docs-sweep", false);
  expect(l.isEnabled("docs-sweep")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/loop-state.test.ts`
Expected: FAIL — `getLastRun` is not a function.

- [ ] **Step 3: Add the table, interface members, and methods**

In `src/engine/ledger.ts`:

(a) Add to the `Ledger` interface (after `conversation(...)`):

```ts
  /** Loop scheduler state — last fire time + explicit enable override (LoopStateStore). */
  getLastRun(name: string): number | undefined;
  setLastRun(name: string, at: number): void;
  isEnabled(name: string): boolean | undefined;
  setEnabled(name: string, on: boolean): void;
```

(b) Add the table DDL inside `openLedger`, after the `messages` index `db.run(...)`:

```ts
  db.run(
    `CREATE TABLE IF NOT EXISTS loop_state (
       name TEXT PRIMARY KEY, last_run INTEGER, enabled INTEGER
     )`,
  );
```

(c) Add the four methods to the returned object (after `conversation`):

```ts
    getLastRun(name) {
      const row = db.query(`SELECT last_run FROM loop_state WHERE name = ?`).get(name) as
        | { last_run: number | null }
        | null;
      return row && row.last_run != null ? row.last_run : undefined;
    },
    setLastRun(name, at) {
      db.query(
        `INSERT INTO loop_state (name, last_run) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run`,
      ).run(name, at);
    },
    isEnabled(name) {
      const row = db.query(`SELECT enabled FROM loop_state WHERE name = ?`).get(name) as
        | { enabled: number | null }
        | null;
      return row && row.enabled != null ? row.enabled === 1 : undefined;
    },
    setEnabled(name, on) {
      db.query(
        `INSERT INTO loop_state (name, enabled) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled`,
      ).run(name, on ? 1 : 0);
    },
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/loop-state.test.ts && bunx tsc --noEmit`
Expected: PASS (tsc still flags `loops.ts` until Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/engine/ledger.ts tests/loop-state.test.ts
git commit -m "feat(neo): ledger persists loop state (last-run + enabled) — LoopStateStore"
```

---

## Task 8: Extended LoopDef + library + `/loop` UX (loops.ts)

**Files:**
- Modify: `src/engine/loops.ts`
- Test: `tests/loops.test.ts` (keep existing; append on/off test)

**Interfaces:**
- Consumes: `runProjectLoop`/`Bounds` (Task 4), `Goal`/`GoalCheck` (Task 2), `Trigger` (Task 5), `SchedulableLoop`/`LoopStateStore` (Task 6), `LoopOutcome` (Task 3), `runOrder` (type).
- Produces: extended `LoopDef extends SchedulableLoop` with `{ usage; summary; prompt; goal: Goal; bounds: Bounds }`; `LOOPS`; `matchLoop`; `listLoops(store?)`; `startLoop`; `handleLoop`; `LoopDeps` gains `shouldStop?`, `store?`.

- [ ] **Step 1: Write the failing test**

Append to `tests/loops.test.ts`:

```ts
test("/loop <name> on enables a scheduled loop via the store", () => {
  const replies: string[] = [];
  const enabled = new Map<string, boolean>();
  const store = {
    getLastRun: () => undefined,
    setLastRun: () => {},
    isEnabled: (n: string) => enabled.get(n),
    setEnabled: (n: string, on: boolean) => void enabled.set(n, on),
  };
  const handled = handleLoop("/loop docs-sweep on", 1, { reply: (_c, t) => void replies.push(t), store });
  expect(handled).toBe(true);
  expect(enabled.get("docs-sweep")).toBe(true);
  expect(replies.join("\n").toLowerCase()).toContain("on");
});

test("/loop <name> off disables it", () => {
  const enabled = new Map<string, boolean>([["docs-sweep", true]]);
  const store = {
    getLastRun: () => undefined,
    setLastRun: () => {},
    isEnabled: (n: string) => enabled.get(n),
    setEnabled: (n: string, on: boolean) => void enabled.set(n, on),
  };
  handleLoop("/loop docs-sweep off", 1, { reply: () => {}, store });
  expect(enabled.get("docs-sweep")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/loops.test.ts`
Expected: FAIL — `store` not accepted / on-off not handled (and tsc errors on the old `LoopDef`).

- [ ] **Step 3: Rewrite loops.ts**

Replace the contents of `src/engine/loops.ts` with:

```ts
// The /loop command: a registry of named loops the operator can fire and the scheduler can run.
// Each loop bundles a folder, a worker prompt, a Goal (verifiable command or LLM-judge), a Trigger
// (manual/interval/cron), and Bounds (iterations + budget). /loop lists them; /loop <name> starts
// one now; /loop <name> on|off toggles its schedule. Work runs through runProjectLoop, so it's
// governed and escalation-auto-denied (never pushes/deploys). See docs/loops.md.
import { runProjectLoop, type Bounds } from "./project-loop";
import type { Goal, GoalCheck } from "./goal";
import type { Trigger } from "./trigger";
import type { SchedulableLoop, LoopStateStore } from "./scheduler";
import type { LoopOutcome } from "./loop-runner";
import type { runOrder } from "./session-runner";

export interface LoopDef extends SchedulableLoop {
  name: string; // canonical key, e.g. "gold-gofmt"
  usage: string; // "/loop gold gofmt"
  summary: string;
  folder: string; // where the worker opens
  prompt: string; // what the worker attempts each iteration
  goal: Goal; // verifiable command or LLM-judge
  trigger: Trigger; // manual / interval / cron
  bounds: Bounds; // maxIterations + optional budgetUsd
  enabledByDefault?: boolean; // for scheduled loops
}

export interface LoopDeps {
  reply: (chatId: number, text: string) => void | Promise<void>;
  /** Injectable worker runner (tests); defaults to the real session-runner. */
  run?: typeof runOrder;
  /** Injectable goal (tests); defaults to the loop's Goal. */
  check?: GoalCheck;
  /** Throttle / kill-switch wired in by the daemon (meter.shouldThrottle). */
  shouldStop?: () => boolean;
  /** Loop state store (for /loop <name> on|off and schedule status). */
  store?: LoopStateStore;
  now?: () => number;
}

const GOLD_GOFMT: LoopDef = {
  name: "gold-gofmt",
  usage: "/loop gold gofmt",
  summary: "format gold/server with gofmt and commit (never pushes)",
  folder: "/home/gold",
  prompt:
    "Run `gofmt -w server/` to fix Go formatting across the server module, then confirm `gofmt -l server/` prints nothing. Commit the formatting changes with a message like 'style: gofmt'. Do NOT push.",
  goal: { kind: "command", command: ["sh", "-c", 'test -z "$(gofmt -l server/)"'], timeoutMs: 60_000 },
  trigger: { kind: "manual" },
  bounds: { maxIterations: 3 },
};

const GREEN: LoopDef = {
  name: "green",
  usage: "/loop green",
  summary: "run bun test + tsc until green (never pushes)",
  folder: "/home/neo",
  prompt:
    "Run `bun test` and `bunx tsc --noEmit`. Diagnose and fix any failures you find, then re-run. Do NOT push or deploy.",
  goal: { kind: "command", command: ["sh", "-c", "bun test && bunx tsc --noEmit"], timeoutMs: 300_000 },
  trigger: { kind: "manual" },
  bounds: { maxIterations: 5, budgetUsd: 5 },
};

const ERROR_SWEEP: LoopDef = {
  name: "error-sweep",
  usage: "/loop error-sweep",
  summary: "nightly: scan logs, root-cause + fix unaddressed errors (never pushes)",
  folder: "/home/neo",
  prompt:
    "Scan `data/unaddressed-errors.log` and the app logs for errors. Root-cause and fix each one, committing per fix. Do NOT push or deploy.",
  goal: { kind: "command", command: ["sh", "-c", "test ! -s data/unaddressed-errors.log"], timeoutMs: 120_000 },
  trigger: { kind: "cron", expr: "30 3 * * *" },
  bounds: { maxIterations: 4, budgetUsd: 10 },
  enabledByDefault: false,
};

const DOCS_SWEEP: LoopDef = {
  name: "docs-sweep",
  usage: "/loop docs-sweep",
  summary: "nightly: sync docs to the day's diff — LLM-judge (never pushes)",
  folder: "/home/neo",
  prompt: "Review today's `git diff` and update the docs to match it. Commit the doc updates. Do NOT push.",
  goal: {
    kind: "judge",
    criteria:
      "The repo's docs accurately reflect today's code changes: every changed command, config flag, or public behavior is documented, and no doc references a removed feature.",
    timeoutMs: 120_000,
  },
  trigger: { kind: "cron", expr: "45 3 * * *" },
  bounds: { maxIterations: 3, budgetUsd: 10 },
  enabledByDefault: false,
};

export const LOOPS: LoopDef[] = [GOLD_GOFMT, GREEN, ERROR_SWEEP, DOCS_SWEEP];

export function matchLoop(args: string): LoopDef | undefined {
  const key = args.trim().toLowerCase().replace(/\s+/g, "-");
  return LOOPS.find((l) => l.name === key);
}

export interface LoopInfo {
  name: string;
  usage: string;
  summary: string;
  scheduled: boolean;
  enabled?: boolean;
}

/** The available loops as render-friendly rows. Pass the store to include schedule on/off state. */
export function listLoops(store?: LoopStateStore): LoopInfo[] {
  return LOOPS.map((l) => ({
    name: l.name,
    usage: l.usage,
    summary: l.summary,
    scheduled: l.trigger.kind !== "manual",
    enabled: store ? (store.isEnabled(l.name) ?? l.enabledByDefault ?? false) : undefined,
  }));
}

function schedLabel(l: LoopDef, store?: LoopStateStore): string {
  if (l.trigger.kind === "manual") return "";
  const cadence = l.trigger.kind === "cron" ? l.trigger.expr : `every ${Math.round(l.trigger.everyMs / 60_000)}m`;
  const on = store?.isEnabled(l.name) ?? l.enabledByDefault ?? false;
  return ` [${cadence}: ${on ? "on" : "off"}]`;
}

function formatLoops(store?: LoopStateStore): string {
  return ["Available loops:", ...LOOPS.map((l) => `${l.usage} — ${l.summary}${schedLabel(l, store)}`)].join("\n");
}

/** Run a loop end to end, streaming progress and a final outcome line to the channel. */
export async function startLoop(loop: LoopDef, chatId: number, deps: LoopDeps): Promise<LoopOutcome> {
  await deps.reply(chatId, `🔁 ${loop.name}: starting on ${loop.folder}…`);
  const out = await runProjectLoop(
    {
      folder: loop.folder,
      prompt: loop.prompt,
      goal: loop.goal,
      bounds: loop.bounds,
      onProgress: (m) => void deps.reply(chatId, m.length > 220 ? `${m.slice(0, 220)}…` : m),
      shouldStop: deps.shouldStop,
    },
    { run: deps.run, check: deps.check },
  );
  await deps.reply(
    chatId,
    `🔁 ${loop.name}: ${out.met ? "✅ goal met" : `⚠️ ${out.reason}`} after ${out.iterations} iteration(s) — ${out.lastDetail}`,
  );
  return out;
}

/** Parse + dispatch a /loop command. Returns true if it was a /loop (handled), else false. */
export function handleLoop(text: string, chatId: number, deps: LoopDeps): boolean {
  const t = text.trim();
  if (t !== "/loop" && !t.startsWith("/loop ")) return false;
  const args = t.slice("/loop".length).trim();
  if (!args) {
    void deps.reply(chatId, formatLoops(deps.store));
    return true;
  }
  // "<name> on|off" — toggle a schedule.
  const toggle = args.match(/^(.*?)\s+(on|off)$/i);
  if (toggle) {
    const loop = matchLoop(toggle[1]);
    if (!loop) {
      void deps.reply(chatId, `No loop "${toggle[1]}".\n\n${formatLoops(deps.store)}`);
      return true;
    }
    if (!deps.store) {
      void deps.reply(chatId, "Schedule control is unavailable right now.");
      return true;
    }
    const on = toggle[2].toLowerCase() === "on";
    deps.store.setEnabled(loop.name, on);
    void deps.reply(chatId, `🔁 ${loop.name}: schedule ${on ? "on" : "off"}`);
    return true;
  }
  const loop = matchLoop(args);
  if (!loop) {
    void deps.reply(chatId, `No loop "${args}".\n\n${formatLoops(deps.store)}`);
    return true;
  }
  void startLoop(loop, chatId, deps); // background; streams via deps.reply
  return true;
}
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: ALL tests PASS, tsc clean across the whole repo (Tasks 1–8 now consistent).

- [ ] **Step 5: Commit**

```bash
git add src/engine/loops.ts tests/loops.test.ts
git commit -m "feat(neo): declarative loop library (goal+trigger+bounds) + /loop on|off"
```

---

## Task 9: Wire config + daemon scheduler + Telegram store

**Files:**
- Modify: `src/config.ts` (`NeoConfig`, `DEFAULTS`, `loadConfig`)
- Modify: `src/daemon.ts` (scheduler interval + frontend wiring)
- Modify: `src/frontends/telegram.ts` (pass `store` + `shouldStop` into `/loop` deps — lines ~192 and ~330)
- Test: `tests/config.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `tickScheduler`/`LOOPS`/`startLoop` (Tasks 6, 8), `ledger` as `LoopStateStore` (Task 7), `registry.findByFolder` (existing), `meter.shouldThrottle` (existing).
- Produces: `NeoConfig.loopSchedulerEnabled: boolean`.

- [ ] **Step 1: Write the failing config test**

Append to `tests/config.test.ts` (create the file with this content if it does not exist):

```ts
import { test, expect, afterEach } from "bun:test";
import { loadConfig } from "../src/config";

afterEach(() => {
  delete process.env.NEO_LOOP_SCHEDULER;
});

test("loopSchedulerEnabled defaults to true", () => {
  expect(loadConfig("/nonexistent-dir").loopSchedulerEnabled).toBe(true);
});

test("NEO_LOOP_SCHEDULER=0 disables the scheduler", () => {
  process.env.NEO_LOOP_SCHEDULER = "0";
  expect(loadConfig("/nonexistent-dir").loopSchedulerEnabled).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `loopSchedulerEnabled` is `undefined`.

- [ ] **Step 3: Add the config field**

In `src/config.ts`:

(a) Add to the `NeoConfig` interface:

```ts
  /** When true (default), the daemon runs the loop scheduler. Disable with NEO_LOOP_SCHEDULER=0. */
  loopSchedulerEnabled: boolean;
```

(b) Add to the returned object in `loadConfig` (before the closing `};`):

```ts
    loopSchedulerEnabled:
      process.env.NEO_LOOP_SCHEDULER === "0" ? false : (fileCfg.loopSchedulerEnabled ?? true),
```

- [ ] **Step 4: Run config test**

Run: `bun test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the scheduler into the daemon**

In `src/daemon.ts`:

(a) Add imports near the other engine imports:

```ts
import { LOOPS, startLoop } from "./engine/loops";
import { tickScheduler } from "./engine/scheduler";
```

(b) Add a constant near `IDLE_POLL_MS`:

```ts
const LOOP_TICK_MS = 60 * 1000; // scheduler tick — evaluate loop triggers once a minute
```

(c) After the idle-watchdog `setInterval(...)` (around `daemon.ts:62`), add:

```ts
  // Loop scheduler — fire due cron/interval loops through the governed runProjectLoop. AI-free.
  if (cfg.loopSchedulerEnabled) {
    setInterval(
      () =>
        tickScheduler({
          loops: LOOPS,
          store: ledger, // Ledger implements LoopStateStore
          isFolderBusy: (folder) => registry.findByFolder(folder) !== undefined,
          throttled: () => meter.shouldThrottle(),
          now: Date.now(),
          start: (def) =>
            void startLoop(def, -1 /* not chat-bound */, {
              reply: (_c, t) => console.log(`[loop ${def.name}] ${t}`),
              shouldStop: () => meter.shouldThrottle(),
              store: ledger,
            }),
        }),
      LOOP_TICK_MS,
    );
    console.log(`  loops     -> scheduler on, tick every ${LOOP_TICK_MS / 1000}s (${LOOPS.length} loops)`);
  } else {
    console.log("  loops     -> scheduler OFF (NEO_LOOP_SCHEDULER=0)");
  }
```

- [ ] **Step 6: Pass the store into the Telegram `/loop` deps**

In `src/frontends/telegram.ts`, update the `handleLoop` call (~line 192) and the `startLoop` call (~line 330) to include `store` and `shouldStop`. The handler has `ledger` and `meter` in scope (they are parameters of `startTelegram`):

```ts
// ~line 192
if (
  handleLoop(ctx.message.text, chatId, {
    reply: (cid, t) => void bot.api.sendMessage(cid, t),
    store: ledger,
    shouldStop: () => meter.shouldThrottle(),
  })
)
  return;
```

```ts
// ~line 330
if (loop)
  void startLoop(loop, ctx.chat?.id ?? 0, {
    reply: (cid, t) => void bot.api.sendMessage(cid, t),
    store: ledger,
    shouldStop: () => meter.shouldThrottle(),
  });
```

- [ ] **Step 7: Full verification**

Run: `bun test && bunx tsc --noEmit`
Expected: ALL green, tsc clean.

Then confirm the daemon boots and logs the scheduler line (it does not need a Telegram token to print this — but `main()` only starts frontends when a token is set; the scheduler log prints regardless). If you have a `.env`, run:

Run: `timeout 5 bun run src/daemon.ts 2>&1 | grep -E "loops|scheduler"`
Expected: a line like `loops -> scheduler on, tick every 60s (4 loops)`.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/daemon.ts src/frontends/telegram.ts tests/config.test.ts
git commit -m "feat(neo): wire loop scheduler into the daemon + Telegram /loop store"
```

---

## Out of scope (documented seams, not built)

- **Event triggers** (`{ kind: "event" }`) — the `isDue()` and `LoopStateStore` seams accommodate them; see spec §7.
- **In-iteration `Stop`-hook guard** — spec §6.
- **Web "Loops" tab schedule-state rendering** — `listLoops(ledger)` already returns `scheduled`/`enabled`; surfacing on/off toggles in `src/frontends/web.ts` is a cosmetic follow-up.
- **Dynamic self-paced intervals**, **cloud routines**, **desktop tasks**, **runtime loop CRUD** — see spec §2 non-goals.

---

## Self-Review

**Spec coverage:**
- Goal union (verifiable + judge) → Task 2 ✓
- Bounds + cost guard (budgetUsd + meter→shouldStop) → Tasks 3, 4, 9 ✓
- Trigger union + cron matcher → Task 5 ✓
- Scheduler + ledger persistence + daemon wiring → Tasks 6, 7, 9 ✓
- Declarative library + `/loop` UX → Task 8 ✓
- Governance/firewall/read-only judge → Tasks 1, 2, 4 ✓
- Stop-hook + event triggers + web tab → documented as out-of-scope ✓

**Placeholder scan:** none — every step ships real code, exact commands, and expected output.

**Type consistency:** `Goal` (goal.ts) consumed by `makeGoalCheck`/`runProjectLoop`/`LoopDef`; `Bounds` (project-loop.ts) consumed by `LoopDef`/`runProjectLoop`; `Trigger` (trigger.ts) consumed by `isDue`/`SchedulableLoop`/`LoopDef`; `LoopStateStore`/`SchedulableLoop` (scheduler.ts) consumed by `ledger`/`loops`/`daemon`; `RunResult.costUsd` → `iterate().costUsd` → `LoopOutcome.spentUsd`. `LoopDef extends SchedulableLoop`, so `tickScheduler(LOOPS)` typechecks. Names verified consistent across tasks.
