# Context Efficiency Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every worker path through config-driven model/effort/skills profiles, stop loops and stale resumes from accumulating context, and de-hardcode the remaining timing/window constants.

**Architecture:** A new pure module `worker-profile.ts` folds per-path config profiles into the existing `RunDeps` seam (`session-runner.ts`), so every launch site changes by one line. Loop context gating and cache-aware resume extend the existing deterministic `context-policy.ts` — no AI in the engine.

**Tech Stack:** Bun + TypeScript, bun:test, @anthropic-ai/claude-agent-sdk (options: `model`, `effort`, `skills`, `maxTurns`, `env`).

**Spec:** `docs/superpowers/specs/2026-07-23-context-efficiency-design.md`

## Global Constraints

- Every new value lives in config (env > config.json > `DEFAULTS`) — zero hardcoded numbers in engine logic.
- Unset profile fields inherit today's behavior (SDK/CLI default model, default effort).
- Engine stays AI-free and deterministic; fail-open on measurement errors (context-policy pattern).
- `bunx tsc --noEmit` and `bun test` green before every commit; one commit per task.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: RunDeps carries model / skills / maxTurns / env

**Files:**
- Modify: `src/engine/session-runner.ts:84-94` (RunDeps), `:312-319` (runConfig)
- Test: `tests/session-runner.test.ts`

**Interfaces:**
- Produces: `RunDeps` gains `model?: string; skills?: "all" | string[]; maxTurns?: number; env?: Record<string, string>`. `runConfig(deps)` forwards them (env merged over `process.env`). Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests** (append to `tests/session-runner.test.ts`)

```ts
test("runConfig forwards model/skills/maxTurns and merges env over process.env", () => {
  const c = runConfig({ model: "haiku", skills: [], maxTurns: 12, env: { NEO_TEST_FLAG: "1" } });
  expect(c.model).toBe("haiku");
  expect(c.skills).toEqual([]);
  expect(c.maxTurns).toBe(12);
  const env = c.env as Record<string, string | undefined>;
  expect(env.NEO_TEST_FLAG).toBe("1");
  expect(env.PATH).toBeDefined(); // process.env preserved underneath
});

test("runConfig still omits every unset key", () => {
  expect(Object.keys(runConfig({}))).toEqual([]);
});

test("runConfig lets an explicit skills allowlist override the sdkOptions default", () => {
  // sdkOptions spreads runConfig() LAST, so skills from deps must win over skills:"all"
  const c = runConfig({ skills: ["superpowers:test-driven-development"] });
  expect(c.skills).toEqual(["superpowers:test-driven-development"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/session-runner.test.ts`
Expected: FAIL — `model`/`skills`/`maxTurns`/`env` unknown on RunDeps / missing from runConfig output.

- [ ] **Step 3: Implement** — extend `RunDeps` (after `disallowedTools`):

```ts
  /** SDK model override for this run ("haiku" | "sonnet" | "opus" | full id). Unset = inherit. */
  model?: string;
  /** Skills visible to this worker: "all" or an explicit allowlist ([] = none). Unset = "all". */
  skills?: "all" | string[];
  /** SDK cap on agentic turns for one run. Unset = uncapped. */
  maxTurns?: number;
  /** Extra env for the spawned worker (autocompact %, MCP output caps…), merged over process.env. */
  env?: Record<string, string>;
```

and in `runConfig`:

```ts
  if (deps.model) c.model = deps.model;
  if (deps.skills !== undefined) c.skills = deps.skills;
  if (deps.maxTurns) c.maxTurns = deps.maxTurns;
  if (deps.env) c.env = { ...process.env, ...deps.env };
```

- [ ] **Step 4: Run tests + typecheck** — `bun test tests/session-runner.test.ts && bunx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit** — `git add src/engine/session-runner.ts tests/session-runner.test.ts && git commit -m "feat(runner): RunDeps carries model/skills/maxTurns/env through to the SDK"`

---

### Task 2: `workers` profiles + `workerEnv` in config

**Files:**
- Modify: `src/config.ts` (interface after `contextPolicy`, DEFAULTS, loadConfig return)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `WorkerProfile { model?, effort?, skills?, maxTurns? }`, `NeoConfig.workers: Record<"company"|"project"|"dispatch"|"loop"|"judge"|"ingress"|"handoff", WorkerProfile>`, `NeoConfig.workerEnv: Record<string, string>`. Consumed by Task 3's `profileDeps`.

- [ ] **Step 1: Write the failing tests** (append to `tests/config.test.ts`; follow that file's existing tmp-dir/config.json fixture pattern)

```ts
test("worker profiles: per-path overrides merge from config.json over inherit-everything defaults", () => {
  const dir = mkTmpDir(); // reuse the file's existing helper for a temp cwd with a config.json
  writeConfig(dir, { workers: { handoff: { model: "haiku", effort: "low" } }, workerEnv: { MAX_MCP_OUTPUT_TOKENS: "12000" } });
  const cfg = loadConfig(dir);
  expect(cfg.workers.handoff.model).toBe("haiku");      // file override wins for that path
  expect(cfg.workers.company.effort).toBe("low");       // existing code behavior, now a default
  expect(cfg.workers.dispatch).toEqual({});             // code-writing paths inherit everything
  expect(cfg.workerEnv.MAX_MCP_OUTPUT_TOKENS).toBe("12000");
});

test("worker profiles: QUALITY INVARIANT — absent config changes no worker's model/effort/skills", () => {
  const cfg = loadConfig(mkTmpDir());
  // Only the two effort:"low" behaviors that already exist in code move into config; every
  // other path (all code-writing paths included) inherits the CLI default model untouched.
  expect(cfg.workers).toEqual({
    company: { effort: "low" }, project: {}, dispatch: {}, loop: {},
    judge: {}, ingress: { effort: "low" }, handoff: {},
  });
  expect(cfg.workerEnv).toEqual({});
});
```

- [ ] **Step 2: Run tests to verify they fail** — `bun test tests/config.test.ts` → FAIL (`workers` missing).

- [ ] **Step 3: Implement** — in `src/config.ts` add above `NeoConfig`:

```ts
/** Reasoning-effort levels accepted by the SDK. */
export type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Per-path worker launch profile. Unset fields inherit the CLI/SDK default (today's behavior). */
export interface WorkerProfile {
  model?: string;
  effort?: WorkerEffort;
  skills?: "all" | string[];
  maxTurns?: number;
}

export type WorkerPathName =
  | "company" | "project" | "dispatch" | "loop" | "judge" | "ingress" | "handoff";
```

in the `NeoConfig` interface (after `contextPolicy`):

```ts
  /** Per-launch-path worker profiles (model/effort/skills/maxTurns). See the context-efficiency
   *  design spec. Per-path objects REPLACE the default for that path when set in config.json. */
  workers: Record<WorkerPathName, WorkerProfile>;
  /** Extra env vars for every spawned worker (e.g. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
   *  MAX_MCP_OUTPUT_TOKENS, CLAUDE_CODE_SUBAGENT_MODEL), merged over process.env. */
  workerEnv: Record<string, string>;
```

in `DEFAULTS`:

```ts
  // QUALITY INVARIANT: defaults reproduce today's behavior EXACTLY. The only non-empty entries
  // are the two effort:"low" cases that already live in code (pipeline.ts:250, ingress.ts:68/71),
  // relocated here. Economy overrides (cheaper models on handoff/judge/ingress ONLY) are opt-in
  // via config.json — see docs/CONFIG.md "Economy mode" — never defaults, never code-writing paths.
  workers: {
    company: { effort: "low" },
    project: {},
    dispatch: {},
    loop: {},
    judge: {},
    ingress: { effort: "low" },
    handoff: {},
  } satisfies Record<WorkerPathName, WorkerProfile>,
  workerEnv: {} as Record<string, string>,
```

in `loadConfig`'s return (after `contextPolicy`):

```ts
    workers: { ...DEFAULTS.workers, ...(fileCfg.workers ?? {}) },
    workerEnv: fileCfg.workerEnv ?? DEFAULTS.workerEnv,
```

- [ ] **Step 4: Run** — `bun test tests/config.test.ts && bunx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(config): per-path worker profiles + workerEnv (no more hardcoded model/effort routing)"`

---

### Task 3: `worker-profile.ts` — fold a profile into RunDeps, wire all seven launch sites

**Files:**
- Create: `src/engine/worker-profile.ts`
- Modify: `src/engine/pipeline.ts:237-250` (runConfigFor + the :229 open-path base), `src/engine/dispatch.ts` (the startOrder deps near :215), `src/engine/ingress.ts:68-79`, `src/engine/context-policy.ts:158-165` (runHandoff deps gain `runDeps?: RunDeps`), `src/engine/loops.ts` (loop + judge run sites pass profiles via Task 4's `runDeps` opt)
- Test: `tests/worker-profile.test.ts` (new)

**Interfaces:**
- Consumes: `RunDeps` (Task 1), `NeoConfig.workers`/`workerEnv` (Task 2).
- Produces: `profileDeps(cfg: Pick<NeoConfig, "workers" | "workerEnv">, path: WorkerPathName, base?: RunDeps): RunDeps` — call-site `base` values win over the profile; `workerEnv` merges under any base `env`.

- [ ] **Step 1: Write the failing tests** (`tests/worker-profile.test.ts`)

```ts
import { test, expect } from "bun:test";
import { profileDeps } from "../src/engine/worker-profile";

const cfg = {
  workers: {
    company: { effort: "low" as const }, project: {}, dispatch: {},
    loop: { model: "sonnet", skills: [] as string[] },
    judge: { model: "haiku", effort: "low" as const },
    ingress: { effort: "low" as const }, handoff: { model: "haiku", effort: "low" as const },
  },
  workerEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" },
};

test("profileDeps folds the path profile + workerEnv into RunDeps", () => {
  const d = profileDeps(cfg, "loop");
  expect(d.model).toBe("sonnet");
  expect(d.skills).toEqual([]);
  expect(d.env).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" });
});

test("call-site base wins over the profile and keeps unrelated fields", () => {
  const d = profileDeps(cfg, "judge", { effort: "medium", disallowedTools: ["Write"] });
  expect(d.effort).toBe("medium");        // base beats profile
  expect(d.model).toBe("haiku");          // profile fills the gap
  expect(d.disallowedTools).toEqual(["Write"]);
});

test("empty profile + empty env adds nothing (inherit = today's behavior)", () => {
  expect(profileDeps({ workers: cfg.workers, workerEnv: {} }, "dispatch")).toEqual({});
});
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/worker-profile.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/engine/worker-profile.ts`:

```ts
// Fold a config worker profile into RunDeps for a launch path. Pure + deterministic: the ONLY
// place path→model/effort/skills/env routing happens, so no launch site hardcodes cost choices.
import type { NeoConfig, WorkerPathName } from "../config";
import type { RunDeps } from "./session-runner";

export function profileDeps(
  cfg: Pick<NeoConfig, "workers" | "workerEnv">,
  path: WorkerPathName,
  base: RunDeps = {},
): RunDeps {
  const p = cfg.workers[path] ?? {};
  const d: RunDeps = { ...base };
  if (p.model && d.model === undefined) d.model = p.model;
  if (p.effort && d.effort === undefined) d.effort = p.effort;
  if (p.skills !== undefined && d.skills === undefined) d.skills = p.skills;
  if (p.maxTurns && d.maxTurns === undefined) d.maxTurns = p.maxTurns;
  const env = { ...cfg.workerEnv, ...(base.env ?? {}) };
  if (Object.keys(env).length) d.env = env;
  return d;
}
```

- [ ] **Step 4: Wire the launch sites** (each is one line; run `bun test` after each):
  - `pipeline.ts:250`: replace `return isCompany ? { ...base, effort: "low" } : base;` with
    `return profileDeps(deps.cfg, isCompany ? "company" : "project", base);`
  - `pipeline.ts` `/open` path (:229 object): wrap that literal in `profileDeps(deps.cfg, "project", { ...existing })`.
  - `dispatch.ts` (~:215): where the dispatched worker's `RunDeps` object is assembled (resume/mcpServers), wrap it: `profileDeps(opts.cfg, "dispatch", existingDeps)` — `opts.cfg` already reaches dispatch for timeouts; reuse it.
  - `ingress.ts:68-79`: wrap both branches — tainted: `profileDeps(cfg, "ingress", { disallowedTools: TAINTED_DISALLOWED_TOOLS })`; operator-brief: `profileDeps(cfg, "ingress", { mcpServers: ... })`. Thread `cfg` through `IngressDeps` if not already present (it is — the mcpServers construction reads config fields; follow the same route).
  - `context-policy.ts` `runHandoff` deps: add `runDeps?: RunDeps` and change :163 to `{ resume: session.sdkSessionId || undefined, effort: "low", ...deps.runDeps }`; callers (`pipeline.ts:336-343` post-run check, `applyContextPolicy` sites, `dispatch.ts:228-249`) pass `runDeps: profileDeps(cfg, "handoff")`.
  - Loop + judge sites are wired in Task 4 (they need the new `runDeps` opt there).

  Existing tests pin behavior: the company-effort assertion in `tests/pipeline.test.ts` must still pass (the "low" now arrives via DEFAULTS.workers.company).

- [ ] **Step 5: Full run** — `bun test && bunx tsc --noEmit` → all green (the 5 pre-existing environment failures on this server excepted).

- [ ] **Step 6: Commit** — `git commit -m "feat(engine): route every worker launch through config worker profiles"`

---

### Task 4: loops accept RunDeps + context-gate their resume (closes the known gap)

**Files:**
- Modify: `src/engine/loop-runner.ts` (LoopSpec gains `gateResume?`), `src/engine/project-loop.ts` (ProjectLoopOpts gains `runDeps?` + `freshSession?` + `gateResume` wiring), `src/engine/loops.ts` (pass `profileDeps(cfg,"loop")` / `"judge"`; add optional `freshSession?: boolean` to the loop def type + validation passthrough in `loop-validate.ts`)
- Test: `tests/loop-context-gate.test.ts` (new)

**Interfaces:**
- Consumes: `profileDeps` (Task 3), `decideContext`/`sessionContext` (`context-policy.ts`).
- Produces: `LoopSpec.gateResume?: (resumeId: string) => Promise<string | undefined>`; `ProjectLoopOpts.runDeps?: RunDeps`; `ProjectLoopOpts.freshSession?: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from "bun:test";
import { runLoop } from "../src/engine/loop-runner";
import { runProjectLoop } from "../src/engine/project-loop";

test("runLoop passes each resumeId through gateResume; undefined verdict starts fresh", async () => {
  const seen: (string | undefined)[] = [];
  let met = false;
  await runLoop({
    maxIterations: 3,
    check: async () => ({ met, detail: "" }),
    gateResume: async (id) => (id === "s1" ? undefined : id), // drop the first session's context
    iterate: async (resumeId, n) => {
      seen.push(resumeId);
      if (n === 3) met = true;
      return { sessionId: `s${n}`, summary: "" };
    },
  });
  expect(seen).toEqual([undefined, undefined, "s2"]); // s1 was gated away → iteration 2 fresh
});

test("runProjectLoop forwards runDeps to every run and freshSession never resumes", async () => {
  const deps: unknown[] = [];
  const resumes: (string | undefined)[] = [];
  let calls = 0;
  await runProjectLoop(
    {
      folder: "/tmp", prompt: "p", freshSession: true,
      runDeps: { model: "sonnet", skills: [] },
      goal: { kind: "command", command: ["true"] },
      bounds: { maxIterations: 2 },
    },
    {
      check: async () => ({ met: ++calls > 2, detail: "" }),
      run: async (_o, _h, d) => {
        deps.push(d); resumes.push((d as { resume?: string }).resume);
        return { ok: true, sessionId: `s${calls}`, summary: "", costUsd: 0 };
      },
    },
  );
  expect(resumes).toEqual([undefined, undefined]);              // freshSession: no resume ever
  expect((deps[0] as { model?: string }).model).toBe("sonnet"); // runDeps reach the worker
});
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/loop-context-gate.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `loop-runner.ts`: add to `LoopSpec`:

```ts
  /** Engine-side gate on the carried session id before each resume: return the id to keep it,
   *  undefined to start the iteration fresh (context policy verdict, cache-staleness, …). */
  gateResume?: (resumeId: string) => Promise<string | undefined>;
```

and in `runLoop`, before `spec.iterate`:

```ts
    const gated = resumeId && spec.gateResume ? await spec.gateResume(resumeId) : resumeId;
    const r = await spec.iterate(gated, n + 1);
```

`project-loop.ts`: add to `ProjectLoopOpts`:

```ts
  /** RunDeps overlay for every iteration (model/effort/skills via profileDeps(cfg, "loop")). */
  runDeps?: RunDeps;
  /** Never resume across iterations — each one starts a fresh session (judge/report loops). */
  freshSession?: boolean;
  /** Resume gate (context policy); wired by the caller so this module stays config-free. */
  gateResume?: (resumeId: string) => Promise<string | undefined>;
```

pass `gateResume: opts.freshSession ? async () => undefined : opts.gateResume` into `runLoop`, and change the run call's deps to `{ ...opts.runDeps, ...(resumeId ? { resume: resumeId } : {}) }`.
`loops.ts` (`fireLoop`/run site): pass `runDeps: profileDeps(cfg, "loop")`, `freshSession: def.freshSession`, and `gateResume` built from context policy:

```ts
      gateResume: async (id) => {
        const ctx = await sessionContext(def.folder, id);
        return decideContext(ctx, cfg.contextPolicy) === "keep" ? id : undefined;
      },
```

The judge goal's worker run (`makeGoalCheck` deps in `goal.ts` call sites) gets `profileDeps(cfg, "judge", { disallowedTools: [...] })` — the judge's existing read-only denial list stays as the base.
`loop-validate.ts`: accept the optional boolean `freshSession` on custom loop input (default false) so web-CRUD loops can set it.

- [ ] **Step 4: Full run** — `bun test && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit** — `git commit -m "feat(loops): context-gated resume + freshSession + profile plumbing (closes the loop context gap)"`

---

### Task 5: cache-aware resume in the context policy

**Files:**
- Modify: `src/engine/context-policy.ts` (`ContextPolicyCfg`, `sessionContext` adds `idleMs` from transcript mtime, `decideContext` adds the stale-resume rule), `src/config.ts:110` (DEFAULTS.contextPolicy)
- Test: `tests/context-policy.test.ts`

**Interfaces:**
- Produces: `ContextPolicyCfg` gains `staleResumeMs: number` (default `60 * 60 * 1000` — the subscription's 1h prompt-cache TTL) and `staleResumePct: number` (default `0.35`); `ContextSignals` gains `idleMs: number` (0 when unmeasurable — fail-open).

- [ ] **Step 1: Write the failing tests** (append; reuse the file's existing fixture helpers for fake transcripts)

```ts
test("decideContext: stale + fat resume → handoff (cold cache would re-pay the whole context)", () => {
  const cfg = { ...POLICY, staleResumeMs: 3_600_000, staleResumePct: 0.35 };
  expect(decideContext({ occupancy: 0.4, turns: 10, ageMs: 0, idleMs: 2 * 3_600_000 }, cfg)).toBe("handoff");
});

test("decideContext: stale but small, or fresh but fat-below-handoffPct, stays keep", () => {
  const cfg = { ...POLICY, staleResumeMs: 3_600_000, staleResumePct: 0.35 };
  expect(decideContext({ occupancy: 0.2, turns: 10, ageMs: 0, idleMs: 2 * 3_600_000 }, cfg)).toBe("keep");
  expect(decideContext({ occupancy: 0.4, turns: 10, ageMs: 0, idleMs: 60_000 }, cfg)).toBe("keep");
});

test("sessionContext reports idleMs from the transcript file mtime and 0 on any error", async () => {
  const { folder, id } = writeFakeTranscript(); // existing helper in this test file
  const ctx = await sessionContext(folder, id);
  expect(ctx.idleMs).toBeGreaterThanOrEqual(0);
  const missing = await sessionContext("/nope", "missing");
  expect(missing.idleMs).toBe(0); // fail-open
});
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/context-policy.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `ContextPolicyCfg` gains the two fields (documented: "resume after a
  cache-cold gap re-pays full context — hand off instead when the transcript is already fat");
  `sessionContext` computes `idleMs = Math.max(0, Date.now() - statSync(path).mtimeMs)` inside the
  existing try/catch (0 on error); `decideContext` adds, between the emergency and handoff rules:

```ts
  if (s.idleMs >= cfg.staleResumeMs && s.occupancy >= cfg.staleResumePct) return "handoff";
```

  `DEFAULTS.contextPolicy` becomes
  `{ handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 7 * 24 * 3600 * 1000, handoffTimeoutMs: 180_000, staleResumeMs: 3_600_000, staleResumePct: 0.35 }`.
  All existing `decideContext` tests must keep passing (add `idleMs: 0` to their fixtures if the type requires it).

- [ ] **Step 4: Full run** — `bun test && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit** — `git commit -m "feat(context): cache-aware resume — hand off fat sessions after a cache-cold idle gap"`

---

### Task 6: de-hardcode `idlePollMs`, `loopTickMs`, `contextPolicy.windowTokens`

**Files:**
- Modify: `src/config.ts` (three knobs), `src/daemon.ts:30,32` (use cfg), `src/engine/context-policy.ts:13` (`CONTEXT_WINDOW_TOKENS` → `cfg.windowTokens` param with the constant as fallback default)
- Test: `tests/config.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("timing + window knobs are config with sane defaults", () => {
  const cfg = loadConfig(mkTmpDir());
  expect(cfg.idlePollMs).toBe(60_000);
  expect(cfg.loopTickMs).toBe(60_000);
  expect(cfg.contextPolicy.windowTokens).toBe(200_000);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** add `idlePollMs`/`loopTickMs` to `NeoConfig` + `DEFAULTS` + `loadConfig` (same `fileCfg.x ?? DEFAULTS.x` pattern), add `windowTokens` to `ContextPolicyCfg` + its default; `daemon.ts` reads `cfg.idlePollMs`/`cfg.loopTickMs`; `sessionContext`'s occupancy math divides by the configured `windowTokens` (threaded via the `ContextPolicyCfg` it already receives — keep the module-level constant only as the interface default).

- [ ] **Step 4: Full run** — `bun test && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit** — `git commit -m "chore(config): idlePollMs, loopTickMs, contextPolicy.windowTokens are config, not constants"`

---

### Task 7: CLAUDE.md diet + docs/CONFIG.md + config.example.json sync

**Files:**
- Create: `docs/HISTORY.md` (the phase-history narrative moved out of CLAUDE.md)
- Modify: `CLAUDE.md` (replace the per-phase "Current status" essays with a ≤10-line summary linking `docs/HISTORY.md`; target <200 lines total — official guidance), `docs/CONFIG.md` (document `workers`, `workerEnv`, the new contextPolicy + timing knobs), `config.example.json` — **quality-neutral env only, no model overrides**:

```json
  "workerEnv": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70",
    "MAX_MCP_OUTPUT_TOKENS": "12000"
  }
```

`docs/CONFIG.md` additionally gets an **"Economy mode (opt-in, measured)"** section documenting —
as operator choices, never defaults — the fenced overrides and their guardrail:

> Eligible paths only (their output is not project work product): `handoff`, `judge`, `ingress`.
> Example: `"workers": { "handoff": { "model": "haiku", "effort": "low" }, "judge": { "model": "haiku", "effort": "low" } }`.
> `CLAUDE_CODE_SUBAGENT_MODEL` is the same trade for subagents inside workers — set it only after
> reading the guardrail. Guardrail: watch ledger loop `goal-met` rate, iterations-to-green, and
> whether resumed sessions recover from handoff notes without re-asking, for two weeks; any
> regression → remove the override (a config flip). Code-writing paths (`company`, `project`,
> `dispatch`, `loop`) are NOT eligible — see the design spec's quality guarantee.

- [ ] **Step 1:** Move history; **Step 2:** `wc -l CLAUDE.md` < 200; **Step 3:** docs updated; **Step 4:** `bun test && bunx tsc --noEmit` (docs-only, still verify); **Step 5: Commit** — `git commit -m "docs: CLAUDE.md diet (history → docs/HISTORY.md) + document worker profiles"`

---

## Self-Review

- **Spec coverage:** design §3 Phase 1 items 1→Tasks 1-3, 2→Task 4, 3→Task 5, 4→Task 6, 5→Task 7. Phases 2-4 are explicitly separate future plans.
- **Type consistency:** `RunDeps.model/skills/maxTurns/env` (Task 1) = what `profileDeps` sets (Task 3) = what `runConfig` forwards; `WorkerPathName` (Task 2) = `profileDeps` path param; `gateResume`/`freshSession`/`runDeps` names match between loop-runner, project-loop, and loops.ts.
- **Quality invariant verified:** default config produces byte-identical SDK options for every path vs today (pinned by Task 2's `toEqual` test on the whole `workers` object); economy overrides exist only as documented opt-ins in `docs/CONFIG.md`, fenced to non-code paths.
