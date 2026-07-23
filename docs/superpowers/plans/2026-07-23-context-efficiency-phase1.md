# Context Efficiency Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every worker path through config-driven model/effort/skills profiles, stop loops and stale resumes from accumulating context, and de-hardcode the remaining timing/window constants.

**Architecture:** A new pure module `worker-profile.ts` folds per-path config profiles into the existing `RunDeps` seam (`session-runner.ts`), so every launch site changes by one line. Loop context gating and cache-aware resume extend the existing deterministic `context-policy.ts` — no AI in the engine.

**Tech Stack:** Bun + TypeScript, bun:test, @anthropic-ai/claude-agent-sdk (options: `model`, `effort`, `skills`, `maxTurns`, `env`).

**Spec:** `docs/superpowers/specs/2026-07-23-context-efficiency-design.md`

## Global Constraints

- **No magic numbers** (design spec principle 2): every operational value is *derived from a
  measured signal*, *a ratio of a measured capacity*, or *an explicit operator choice* — fixed
  absolutes only as documented cold-start fallbacks naming the signal that supersedes them.
- No USD/budget thinking: the deployment is subscription-based; nothing new may be denominated in
  dollars (operator decision 2026-07-23 — existing meter retires in Phase 4).
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

### Task 5: cache-aware resume — LEARNED cache TTL, not a fixed hour

Smart-value rule: the resume-staleness threshold is **derived from observed cache behavior**. On
every resume, the first post-resume assistant turn's `cache_read_input_tokens` (in the transcript)
says whether the prompt cache was still warm for that idle gap. The ledger accumulates
`(gapMs, hit)` observations; the effective TTL is computed from them. The provider-documented TTL
(`cacheTtlFallbackMs`, operator choice) is used ONLY until enough observations exist.

**Files:**
- Modify: `src/engine/context-policy.ts` (`ContextPolicyCfg`, `ContextSignals.idleMs`, `decideContext`, new `effectiveCacheTtlMs`), `src/engine/ledger.ts` (table `cache_observations(gap_ms INTEGER, hit INTEGER, at INTEGER)` + `recordCacheObservation`/`listCacheObservations`, following the existing `context_events` pattern at its `:251-259`), `src/engine/pipeline.ts` (record an observation where a resumed session's first result lands — the post-run check site `:336-343` already reads the transcript), `src/config.ts` (DEFAULTS.contextPolicy)
- Test: `tests/context-policy.test.ts`, `tests/ledger.test.ts`

**Interfaces:**
- Produces: `ContextPolicyCfg` gains `staleResumePct: number` (a ratio — default `0.35`), `cacheTtlFallbackMs: number` (operator choice/fallback — default the provider-documented `3_600_000`), `cacheTtlMinObservations: number` (default `5`); `ContextSignals` gains `idleMs: number` (0 = fail-open); pure `effectiveCacheTtlMs(obs: { gapMs: number; hit: boolean }[], cfg): number`; `decideContext(signals, cfg, ttlMs)` takes the effective TTL as an argument (stays pure).

- [ ] **Step 1: Write the failing tests** (append; reuse the file's fixture helpers)

```ts
test("effectiveCacheTtlMs: with too few observations, returns the fallback", () => {
  expect(effectiveCacheTtlMs([], POLICY)).toBe(POLICY.cacheTtlFallbackMs);
  expect(effectiveCacheTtlMs([{ gapMs: 60_000, hit: true }], POLICY)).toBe(POLICY.cacheTtlFallbackMs);
});

test("effectiveCacheTtlMs: learns the boundary between observed hits and misses", () => {
  const obs = [
    { gapMs: 10 * 60_000, hit: true }, { gapMs: 30 * 60_000, hit: true },
    { gapMs: 50 * 60_000, hit: true }, { gapMs: 70 * 60_000, hit: false },
    { gapMs: 90 * 60_000, hit: false },
  ];
  // deterministic midpoint between the longest observed hit and the shortest observed miss
  expect(effectiveCacheTtlMs(obs, POLICY)).toBe((50 * 60_000 + 70 * 60_000) / 2);
});

test("decideContext: idle past the effective TTL + fat transcript → handoff; either alone → keep", () => {
  const ttl = 3_600_000;
  expect(decideContext({ occupancy: 0.4, turns: 10, ageMs: 0, idleMs: 2 * ttl }, POLICY, ttl)).toBe("handoff");
  expect(decideContext({ occupancy: 0.2, turns: 10, ageMs: 0, idleMs: 2 * ttl }, POLICY, ttl)).toBe("keep");
  expect(decideContext({ occupancy: 0.4, turns: 10, ageMs: 0, idleMs: 60_000 }, POLICY, ttl)).toBe("keep");
});

test("sessionContext reports idleMs from the transcript mtime; 0 on any error (fail-open)", async () => {
  const { folder, id } = writeFakeTranscript();
  expect((await sessionContext(folder, id)).idleMs).toBeGreaterThanOrEqual(0);
  expect((await sessionContext("/nope", "missing")).idleMs).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/context-policy.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
/** Deterministic learned TTL: midpoint between the longest idle gap that still hit the prompt
 *  cache and the shortest gap that missed. Falls back to the provider-documented TTL until
 *  cacheTtlMinObservations exist or the observations don't yet bracket the boundary. */
export function effectiveCacheTtlMs(
  obs: { gapMs: number; hit: boolean }[],
  cfg: ContextPolicyCfg,
): number {
  if (obs.length < cfg.cacheTtlMinObservations) return cfg.cacheTtlFallbackMs;
  const hits = obs.filter((o) => o.hit).map((o) => o.gapMs);
  const misses = obs.filter((o) => !o.hit).map((o) => o.gapMs);
  if (!hits.length || !misses.length) return cfg.cacheTtlFallbackMs;
  const hi = Math.max(...hits);
  const lo = Math.min(...misses);
  return lo > hi ? (hi + lo) / 2 : cfg.cacheTtlFallbackMs; // overlapping data → not learnable yet
}
```

  `decideContext` adds (between emergency and handoff rules): `if (s.idleMs >= ttlMs && s.occupancy >= cfg.staleResumePct) return "handoff";`.
  `sessionContext` computes `idleMs = Math.max(0, Date.now() - statSync(path).mtimeMs)` inside the existing try/catch.
  Ledger: `cache_observations` table + record/list (cap reads to the most recent 50 — `listCacheObservations(50)`).
  Pipeline: at the resume sites, after the first post-resume result, parse that turn's `cache_read_input_tokens` from the transcript (same read path `sessionContext` uses) and `recordCacheObservation(gapMs, cacheRead > 0)`; callers of `decideContext` pass `effectiveCacheTtlMs(ledger.listCacheObservations(50), cfg.contextPolicy)`.
  `DEFAULTS.contextPolicy` gains `{ staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 }` — each documented as ratio / provider-fact fallback / choice per the no-magic-numbers rule.

- [ ] **Step 4: Full run** — `bun test && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit** — `git commit -m "feat(context): cache-aware resume with LEARNED cache TTL (ledger observations; provider TTL as cold-start fallback)"`

---

### Task 6: derived heartbeat + per-model context window (no new fixed knobs)

Smart-value rule: the daemon tick and the context window are **derived**, not configured numbers.
The tick derives from the enabled loops' own trigger definitions (cron's one-minute resolution is
a fact of cron, not tuning); the window derives from the model id the session's transcript itself
reports, via a facts-map that config can override per model.

**Files:**
- Create: `src/engine/heartbeat.ts` (pure derivation)
- Modify: `src/daemon.ts:30,32` (replace both fixed 60s constants with the derived heartbeat — one timer drives the idle sweep AND the scheduler tick), `src/engine/context-policy.ts:13` (`CONTEXT_WINDOW_TOKENS` → `windowTokensFor(model)`; `sessionContext` already parses the transcript — also read the last assistant message's `message.model`), `src/config.ts` (`contextPolicy.windowTokensByModel?: Record<string, number>` — an *override map*, not a number)
- Test: `tests/heartbeat.test.ts` (new), `tests/context-policy.test.ts`

**Interfaces:**
- Produces: `heartbeatMs(loops: EffectiveLoop[]): number`; `windowTokensFor(model: string | undefined, overrides?: Record<string, number>): number`. (Match the real `Trigger` union field names in `src/engine/loops.ts` when implementing — the interval trigger's period field.)

- [ ] **Step 1: Failing tests**

```ts
import { test, expect } from "bun:test";
import { heartbeatMs, CRON_RESOLUTION_MS } from "../src/engine/heartbeat";
import { windowTokensFor } from "../src/engine/context-policy";

test("heartbeat derives from enabled triggers: cron resolution by default, faster only if a shorter interval loop is enabled", () => {
  expect(heartbeatMs([])).toBe(CRON_RESOLUTION_MS); // nothing enabled → cron resolution floor
  expect(heartbeatMs([{ enabled: true, trigger: { kind: "cron", expr: "0 6 * * *" } }])).toBe(CRON_RESOLUTION_MS);
  expect(heartbeatMs([{ enabled: true, trigger: { kind: "interval", everyMs: 30_000 } }])).toBe(30_000);
  expect(heartbeatMs([{ enabled: false, trigger: { kind: "interval", everyMs: 5_000 } }])).toBe(CRON_RESOLUTION_MS); // disabled loops don't drive the tick
});

test("window tokens derive from the session's model via the facts map, with config override winning", () => {
  expect(windowTokensFor(undefined)).toBe(200_000);                       // unknown model → conservative default fact
  expect(windowTokensFor("weird-model", { "weird-model": 500_000 })).toBe(500_000); // override map (config) wins
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

```ts
// heartbeat.ts — the daemon's single derived tick. Cron expressions resolve at minute granularity
// (a property of cron, not a tuning choice); an enabled interval trigger shorter than that pulls
// the tick down to its own period. Disabled loops contribute nothing.
export const CRON_RESOLUTION_MS = 60_000;
export function heartbeatMs(loops: { enabled: boolean; trigger: { kind: string; everyMs?: number } }[]): number {
  const intervals = loops
    .filter((l) => l.enabled && l.trigger.kind === "interval" && typeof l.trigger.everyMs === "number")
    .map((l) => l.trigger.everyMs as number);
  return Math.min(CRON_RESOLUTION_MS, ...intervals);
}
```

```ts
// context-policy.ts — context windows are model FACTS (facts-map, overridable in config), never
// one global constant. Key = the model id the transcript's assistant messages report.
const MODEL_WINDOW_TOKENS: Record<string, number> = { default: 200_000 };
export function windowTokensFor(model: string | undefined, overrides?: Record<string, number>): number {
  const m = { ...MODEL_WINDOW_TOKENS, ...overrides };
  return (model !== undefined && m[model]) || m.default;
}
```

  `sessionContext` captures `message.model` from the last assistant line it already parses and
  divides occupancy by `windowTokensFor(model, cfg.windowTokensByModel)`. `daemon.ts` computes
  `heartbeatMs(effectiveLoops(...))` each sweep (re-derived, so enabling a fast loop speeds the
  tick with no restart) and uses it for BOTH the idle sweep and the scheduler tick.

- [ ] **Step 4: Full run** — `bun test && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit** — `git commit -m "feat(engine): derived daemon heartbeat + per-model context window (no fixed tick/window numbers)"`

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

- **Spec coverage:** design Phase 1 items 1→Tasks 1-3, 2→Task 4, 3→Task 5 (learned cache TTL per the smart-value layer), 4→Task 6 (derived heartbeat + per-model window), 5→Task 7. Phases 2-4 are explicitly separate future plans; the memory system (spec §5, from `Claude-Code-Memory-Plan-v`) gets its own task-level plan when Phase 2 starts.
- **Type consistency:** `RunDeps.model/skills/maxTurns/env` (Task 1) = what `profileDeps` sets (Task 3) = what `runConfig` forwards; `WorkerPathName` (Task 2) = `profileDeps` path param; `gateResume`/`freshSession`/`runDeps` names match between loop-runner, project-loop, and loops.ts.
- **Quality invariant verified:** default config produces byte-identical SDK options for every path vs today (pinned by Task 2's `toEqual` test on the whole `workers` object); economy overrides exist only as documented opt-ins in `docs/CONFIG.md`, fenced to non-code paths.
