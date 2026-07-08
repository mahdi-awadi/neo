# Context Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions never rot or hit the context wall: at safe boundaries the engine measures a session's real context occupancy and either keeps it, runs a handoff-note turn then clears it, or clears it immediately.

**Architecture:** A new deterministic module `context-policy.ts` (no AI) reads the session's own transcript JSONL for measured signals and returns keep/handoff/clear. The pipeline consults it pre-resume and post-completion; a handoff turn writes `HANDOFF.md` in the project before the persisted session id is dropped; fresh sessions get a "read HANDOFF.md first" prefix when the file exists. Ledger gains a `context_events` audit table; /status + dashboard show `ctx NN%`.

**Tech Stack:** Bun + TypeScript, `bun:test`, node:fs. No new dependencies. **Execute AFTER the session-liveness plan** (it touches `pipeline.ts`/`dispatch.ts` first; this plan builds on the merged result).

**Spec:** `docs/superpowers/specs/2026-07-08-context-policy-design.md`

## Global Constraints

- TDD: failing test first. Verification per task: `bun test ./tests/*.test.ts` (NEVER bare `bun test`) plus `bunx tsc --noEmit`; both green before every commit.
- Fail OPEN on measurement: missing/unparseable transcript → `keep`. A read error must never destroy a session. Policy/observer code never throws into a worker path.
- Config defaults, verbatim from the spec: `handoffPct` 0.65 · `emergencyPct` 0.85 · `maxTurns` 200 · `maxAgeMs` 604_800_000 (7d) · `handoffTimeoutMs` 180_000. Context window constant: 200_000.
- Tainted ingress runs are untouched (they persist nothing).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: `context-policy.ts` — signals + verdicts + config

**Files:**
- Create: `src/engine/context-policy.ts`
- Modify: `src/config.ts` (`contextPolicy` block)
- Test: `tests/context-policy.test.ts` (create), `tests/config.test.ts` (append)

**Interfaces:**
- Consumes: transcript JSONL layout documented in `src/engine/usage.ts` (assistant lines carry `message.usage` + ISO `timestamp`).
- Produces (later tasks use these exact names):
  - `export interface ContextSignals { occupancy: number; turns: number; ageMs: number }`
  - `export type ContextVerdict = "keep" | "handoff" | "clear"`
  - `export interface ContextPolicyCfg { handoffPct: number; emergencyPct: number; maxTurns: number; maxAgeMs: number; handoffTimeoutMs: number }`
  - `export function decideContext(sig: ContextSignals, cfg: ContextPolicyCfg): ContextVerdict`
  - `export function sessionContext(folder: string, sdkSessionId: string, opts?: { projectsDir?: string; now?: () => number }): ContextSignals`
  - `export function encodeCwd(folder: string): string`
  - `export const CONTEXT_WINDOW_TOKENS = 200_000`
  - `NeoConfig.contextPolicy: ContextPolicyCfg`

- [ ] **Step 1: Write the failing tests**

Create `tests/context-policy.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decideContext, sessionContext, encodeCwd, CONTEXT_WINDOW_TOKENS } from "../src/engine/context-policy";

const CFG = { handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000 };

test("decideContext verdict matrix", () => {
  expect(decideContext({ occupancy: 0.1, turns: 5, ageMs: 0 }, CFG)).toBe("keep");
  expect(decideContext({ occupancy: 0.65, turns: 5, ageMs: 0 }, CFG)).toBe("handoff"); // at threshold
  expect(decideContext({ occupancy: 0.2, turns: 200, ageMs: 0 }, CFG)).toBe("handoff"); // turns
  expect(decideContext({ occupancy: 0.2, turns: 5, ageMs: 604_800_000 }, CFG)).toBe("handoff"); // age
  expect(decideContext({ occupancy: 0.85, turns: 5, ageMs: 0 }, CFG)).toBe("clear"); // emergency wins over handoff
  expect(decideContext({ occupancy: 0.99, turns: 300, ageMs: 999_999_999 }, CFG)).toBe("clear");
});

test("encodeCwd matches Claude Code's project-dir encoding", () => {
  expect(encodeCwd("/home/neo")).toBe("-home-neo");
  expect(encodeCwd("/home/neo/agent")).toBe("-home-neo-agent");
  expect(encodeCwd("/home/my.app")).toBe("-home-my-app"); // dots encode too
});

test("sessionContext reads occupancy/turns/age from the transcript JSONL", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "neo-ctx-"));
  const dir = join(projectsDir, encodeCwd("/p/gold"));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-08T00:00:00.000Z", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 9_000, output_tokens: 500 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-08T01:00:00.000Z", message: { usage: { input_tokens: 2_000, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 8_000, output_tokens: 700 } } }),
  ].join("\n");
  writeFileSync(join(dir, "sess-1.jsonl"), lines);
  const now = Date.parse("2026-07-08T02:00:00.000Z");
  const sig = sessionContext("/p/gold", "sess-1", { projectsDir, now: () => now });
  expect(sig.turns).toBe(2);
  expect(sig.occupancy).toBeCloseTo((2_000 + 120_000 + 8_000) / CONTEXT_WINDOW_TOKENS, 5); // LAST turn's input-side tokens
  expect(sig.ageMs).toBe(2 * 3_600_000); // now - first line
});

test("sessionContext fails OPEN on a missing transcript", () => {
  expect(sessionContext("/nowhere", "nope", { projectsDir: "/nonexistent" })).toEqual({ occupancy: 0, turns: 0, ageMs: 0 });
});
```

Append to `tests/config.test.ts`:

```ts
test("contextPolicy defaults per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.contextPolicy).toEqual({ handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/context-policy.test.ts tests/config.test.ts`
Expected: FAIL — module does not exist; config field missing.

- [ ] **Step 3: Implement**

Create `src/engine/context-policy.ts`:

```ts
// Deterministic context policy — NO AI. Measures a session's real context load from its own
// transcript JSONL (same source of truth as usage.ts) and decides, at safe boundaries only,
// whether to keep it, hand off + clear it, or clear it immediately. Fail OPEN on read errors:
// a measurement problem must never destroy a session.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONTEXT_WINDOW_TOKENS = 200_000;

export interface ContextSignals {
  occupancy: number; // last turn's input-side tokens / CONTEXT_WINDOW_TOKENS
  turns: number;
  ageMs: number;
}

export type ContextVerdict = "keep" | "handoff" | "clear";

export interface ContextPolicyCfg {
  handoffPct: number;
  emergencyPct: number;
  maxTurns: number;
  maxAgeMs: number;
  handoffTimeoutMs: number;
}

/** Claude Code's project-dir encoding for a cwd: every "/" and "." becomes "-". */
export function encodeCwd(folder: string): string {
  return folder.replace(/[/.]/g, "-");
}

export function decideContext(sig: ContextSignals, cfg: ContextPolicyCfg): ContextVerdict {
  if (sig.occupancy >= cfg.emergencyPct) return "clear";
  if (sig.occupancy >= cfg.handoffPct || sig.turns >= cfg.maxTurns || sig.ageMs >= cfg.maxAgeMs) return "handoff";
  return "keep";
}

/** Measured signals for one session, from ~/.claude/projects/<encodeCwd(folder)>/<id>.jsonl. */
export function sessionContext(
  folder: string,
  sdkSessionId: string,
  opts: { projectsDir?: string; now?: () => number } = {},
): ContextSignals {
  const none: ContextSignals = { occupancy: 0, turns: 0, ageMs: 0 };
  if (!folder || !sdkSessionId) return none;
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const now = opts.now ?? (() => Date.now());
  const path = join(projectsDir, encodeCwd(folder), `${sdkSessionId}.jsonl`);
  try {
    if (!existsSync(path)) return none;
    let turns = 0;
    let firstTs = 0;
    let lastInputSide = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { type?: string; timestamp?: string; message?: { usage?: Record<string, number> } };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (!firstTs && Number.isFinite(ts)) firstTs = ts;
      const u = obj.type === "assistant" ? obj.message?.usage : undefined;
      if (!u) continue;
      turns++;
      lastInputSide = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    return {
      occupancy: lastInputSide / CONTEXT_WINDOW_TOKENS,
      turns,
      ageMs: firstTs ? Math.max(0, now() - firstTs) : 0,
    };
  } catch {
    return none; // fail OPEN
  }
}
```

`src/config.ts`: import the type (`import type { ContextPolicyCfg } from "./engine/context-policy";`), add `contextPolicy: ContextPolicyCfg;` to `NeoConfig`, add to `DEFAULTS`:

```ts
  contextPolicy: { handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 7 * 24 * 3600 * 1000, handoffTimeoutMs: 180_000 },
```

and in `loadConfig`'s return: `contextPolicy: { ...DEFAULTS.contextPolicy, ...(fileCfg.contextPolicy ?? {}) },`.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/context-policy.ts src/config.ts tests/context-policy.test.ts tests/config.test.ts
git commit -m "feat(neo): context-policy — measured session signals + keep/handoff/clear verdicts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Handoff runner + ledger `context_events` + session clearing

**Files:**
- Modify: `src/engine/context-policy.ts` (HANDOFF_PROMPT + runHandoff)
- Modify: `src/engine/ledger.ts` (`context_events` table, `recordContextEvent`, `clearSessionsFor`)
- Test: `tests/context-policy.test.ts` (append), `tests/ledger.test.ts` (append)

**Interfaces:**
- Consumes: `runOrder` from `session-runner.ts`; `Registry.setSdkSessionId`; Task 1's types.
- Produces:
  - `export const HANDOFF_PROMPT: string`
  - `export interface HandoffDeps { registry: Registry; ledger: Ledger; run?: typeof runOrder; now?: () => number }`
  - `export async function runHandoff(session: SessionInfo, cfg: ContextPolicyCfg, deps: HandoffDeps): Promise<void>` — runs the handoff turn (bounded by `cfg.handoffTimeoutMs`), then ALWAYS clears: `registry.setSdkSessionId(session.id, "")` + `ledger.clearSessionsFor(session.order.folder)` + `ledger.recordContextEvent(...)`.
  - `Ledger.recordContextEvent(folder: string, verdict: string, occupancy: number, at?: number): void`
  - `Ledger.listContextEvents(limit?: number): Array<{ folder: string; verdict: string; occupancy: number; at: number }>`
  - `Ledger.clearSessionsFor(folder: string): void` — after this, `lastSessionFor(folder, anyChat)` returns `undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ledger.test.ts` (reuse its `openLedger(":memory:")` pattern):

```ts
test("context events record + list, and clearSessionsFor wipes resume targets", () => {
  const l = openLedger(":memory:");
  l.recordContextEvent("/p/gold", "handoff", 0.71, 123);
  expect(l.listContextEvents()[0]).toMatchObject({ folder: "/p/gold", verdict: "handoff", occupancy: 0.71, at: 123 });
  const order = { id: "o9", source: "neo" as const, folder: "/p/gold", task: "t", chatId: 5, createdAt: 0 };
  l.recordOrder(order);
  l.recordSession("o9", "sess-9");
  expect(l.lastSessionFor("/p/gold", 5)).toBe("sess-9");
  l.clearSessionsFor("/p/gold");
  expect(l.lastSessionFor("/p/gold", 5)).toBeUndefined();
});
```

Append to `tests/context-policy.test.ts`:

```ts
test("runHandoff runs the handoff turn against the persisted session, then clears it", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "h1", source: "neo", folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.setSdkSessionId(s.id, "fat-session");
  const order = { id: "h1", source: "neo" as const, folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 };
  ledger.recordOrder(order);
  ledger.recordSession("h1", "fat-session");
  let sawResume: string | undefined;
  let sawTask: string | undefined;
  const fakeRun = async (o: Order, _h: RunHandlers, d?: { resume?: string }) => {
    sawResume = d?.resume;
    sawTask = o.task;
    return { ok: true, sessionId: "fat-session", summary: "written", costUsd: 0 };
  };
  await runHandoff(s, { ...CFG }, { registry, ledger, run: fakeRun as never, now: () => 9 });
  expect(sawResume).toBe("fat-session");
  expect(sawTask).toContain("HANDOFF.md");
  expect(registry.get(s.id)?.sdkSessionId).toBe(""); // cleared
  expect(ledger.lastSessionFor("/p/gold", 1)).toBeUndefined(); // cleared
  expect(ledger.listContextEvents()[0]?.verdict).toBe("handoff");
});

test("runHandoff clears even when the handoff turn times out", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "h2", source: "neo", folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.setSdkSessionId(s.id, "fat-2");
  const never = () => new Promise<never>(() => {});
  await runHandoff(s, { ...CFG, handoffTimeoutMs: 5 }, { registry, ledger, run: never as never });
  expect(registry.get(s.id)?.sdkSessionId).toBe("");
});
```

(Add the imports these need: `createRegistry`, `openLedger`, `runHandoff`, plus `Order`/`RunHandlers` types — mirror the import style of `tests/ingress.test.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/context-policy.test.ts tests/ledger.test.ts`
Expected: FAIL — missing ledger methods and `runHandoff`.

- [ ] **Step 3: Implement**

`src/engine/ledger.ts` — in `openLedger`, create the table alongside the existing ones:

```ts
  db.run(`CREATE TABLE IF NOT EXISTS context_events (
    folder TEXT NOT NULL, verdict TEXT NOT NULL, occupancy REAL NOT NULL, at INTEGER NOT NULL)`);
```

and add to the returned object (mirroring the file's existing prepared-statement style):

```ts
    recordContextEvent(folder, verdict, occupancy, at = Date.now()) {
      db.run("INSERT INTO context_events (folder, verdict, occupancy, at) VALUES (?, ?, ?, ?)", [folder, verdict, occupancy, at]);
    },
    listContextEvents(limit = 50) {
      return db.query("SELECT folder, verdict, occupancy, at FROM context_events ORDER BY at DESC LIMIT ?").all(limit) as never;
    },
    clearSessionsFor(folder) {
      // Sessions are keyed by order id; wipe every session row whose order is for this folder.
      db.run(
        "DELETE FROM sessions WHERE order_id IN (SELECT id FROM orders WHERE folder = ?)",
        [folder],
      );
    },
```

(Adjust table/column names to the file's actual schema for orders/sessions — read `ledger.ts` first; `lastSessionFor` shows the real join. The contract is the test: after `clearSessionsFor(folder)`, `lastSessionFor(folder, chat)` is `undefined`.) Add the three signatures to the `Ledger` interface.

`src/engine/context-policy.ts` — append:

```ts
import type { Order, SessionInfo } from "../types";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import { runOrder } from "./session-runner";

export const HANDOFF_PROMPT =
  "Write a concise state-of-work handoff to HANDOFF.md in the project root: what is in flight, " +
  "decisions made, blockers, and next steps. Overwrite any existing HANDOFF.md. Then stop — do not continue other work.";

export interface HandoffDeps {
  registry: Registry;
  ledger: Ledger;
  run?: typeof runOrder;
  now?: () => number;
}

/** Run the handoff turn against the fat session (bounded), then ALWAYS clear its resume state. */
export async function runHandoff(session: SessionInfo, cfg: ContextPolicyCfg, deps: HandoffDeps): Promise<void> {
  const run = deps.run ?? runOrder;
  const now = deps.now ?? (() => Date.now());
  const sig = sessionContext(session.order.folder, session.sdkSessionId);
  const order: Order = { id: crypto.randomUUID(), source: "neo", folder: session.order.folder, task: HANDOFF_PROMPT, chatId: session.order.chatId, createdAt: now() };
  try {
    await Promise.race([
      run(order, { onMessage: () => {}, onEscalation: async () => "deny" }, { resume: session.sdkSessionId || undefined, effort: "low" }),
      new Promise((res) => setTimeout(res, cfg.handoffTimeoutMs)),
    ]);
  } catch {
    // the clear below is the point; a failed handoff turn must not prevent it
  }
  try {
    deps.registry.setSdkSessionId(session.id, "");
    deps.ledger.clearSessionsFor(session.order.folder);
    deps.ledger.recordContextEvent(session.order.folder, "handoff", sig.occupancy, now());
  } catch {
    // observer-grade bookkeeping — never throw into a worker path
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/context-policy.ts src/engine/ledger.ts tests/context-policy.test.ts tests/ledger.test.ts
git commit -m "feat(neo): handoff runner + context_events audit + session clearing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pipeline boundaries — pre-resume verdicts, post-completion handoff, HANDOFF.md prefix

**Files:**
- Modify: `src/engine/pipeline.ts`
- Test: `tests/pipeline.test.ts` (append)

**Interfaces:**
- Consumes: `sessionContext`, `decideContext`, `runHandoff`, `HANDOFF_PROMPT` (Tasks 1-2); `deps.cfg.contextPolicy`.
- Produces: `PipelineDeps` gains optional test seams: `signals?: typeof sessionContext` and `handoff?: typeof runHandoff` (default to the real ones). No public API change otherwise.

Behavior to implement (each bullet gets a test):
1. **Pre-resume (step 5 of `handleMessage` and the idle-resume branch):** before passing a persisted id as `resume`, compute `decideContext(signals(folder, id), cfg.contextPolicy)`. `clear` → drop the resume id, `ledger.clearSessionsFor(folder)`, `ledger.recordContextEvent(folder, "clear", occupancy)`, start fresh. `handoff` → `await runHandoff(...)` first (which clears), then start fresh.
2. **Post-completion (in `startSession`'s `run.done.then`):** after the session id is persisted and status set idle, evaluate the policy; on `handoff`, `void runHandoff(...)` in the background (do not block the completion path). On `clear` verdict post-completion, treat it as `handoff` too (the session is warm — a handoff attempt is still bounded and safe).
3. **HANDOFF.md prefix:** when starting a session with NO resume id and `existsSync(join(folder, "HANDOFF.md"))`, prefix the order task with `"Read HANDOFF.md first — it is the previous session's state-of-work note.\n\n"`.
4. The handoff turn itself must not recurse: `runHandoff` uses `runOrder` directly (not the pipeline), so nothing re-enters these boundaries — assert no recursion by construction (no test needed beyond the existing ones).

Boundary notes: the spec's "idle sweep" boundary is covered by the post-completion check (every
engine-started run passes through `run.done.then` before it can go idle), so `idle.ts` is not
modified. The loop-runner path does not route through `handleMessage`; wiring the policy into
loops is DEFERRED (documented in CLAUDE.md's next-steps) — loops are bounded per-iteration
already and their sessions are cleared whenever they are next opened via the pipeline.

- [ ] **Step 1: Write the failing tests**

Append to `tests/pipeline.test.ts` (adapting to its fixture style; `signals`/`handoff` seams make these deterministic):

```ts
test("pre-resume: clear verdict starts fresh instead of resuming a near-full session", async () => {
  const deps = makeDeps();
  // Seed a resumable session for the folder
  deps.ledger.recordOrder({ id: "p1", source: "neo", folder: "/tmp", task: "x", chatId: 9, createdAt: 0 });
  deps.ledger.recordSession("p1", "fat-id");
  let seenResume: string | undefined = "unset";
  const fakeStart = (_o: Order, _h: RunHandlers, d?: RunDeps) => {
    seenResume = d?.resume;
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
  await handleMessage("/open /tmp: continue", 9, {
    ...deps,
    start: fakeStart as never,
    signals: () => ({ occupancy: 0.9, turns: 10, ageMs: 0 }), // emergency
  });
  expect(seenResume).toBeUndefined(); // fresh, not resumed
  expect(deps.ledger.lastSessionFor("/tmp", 9)).toBeUndefined(); // cleared
  expect(deps.ledger.listContextEvents()[0]?.verdict).toBe("clear");
});

test("pre-resume: handoff verdict runs the handoff first, then starts fresh", async () => {
  const deps = makeDeps();
  deps.ledger.recordOrder({ id: "p2", source: "neo", folder: "/tmp", task: "x", chatId: 9, createdAt: 0 });
  deps.ledger.recordSession("p2", "fat-2");
  const calls: string[] = [];
  const fakeStart = (_o: Order, _h: RunHandlers, d?: RunDeps) => {
    calls.push(`start:${d?.resume ?? "fresh"}`);
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
  await handleMessage("/open /tmp: continue", 9, {
    ...deps,
    start: fakeStart as never,
    signals: () => ({ occupancy: 0.7, turns: 10, ageMs: 0 }),
    handoff: async (s) => { calls.push("handoff"); deps.ledger.clearSessionsFor(s.order.folder); },
  });
  expect(calls[0]).toBe("handoff");
  expect(calls[1]).toBe("start:fresh");
});

test("fresh start reads HANDOFF.md when it exists", async () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-ho-"));
  writeFileSync(join(folder, "HANDOFF.md"), "state");
  const deps = makeDeps();
  let seenTask = "";
  const fakeStart = (o: Order) => {
    seenTask = o.task;
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
  await handleMessage(`/open ${folder}: continue the work`, 9, { ...deps, start: fakeStart as never });
  expect(seenTask.startsWith("Read HANDOFF.md first")).toBe(true);
});

test("post-completion handoff fires when the finished session is fat", async () => {
  const deps = makeDeps();
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => { resolveDone = res; });
  const fakeStart = () => ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, done }) as unknown as SessionRun;
  let handoffCalled = false;
  await handleMessage("/open /tmp: work", 9, {
    ...deps,
    start: fakeStart as never,
    signals: () => ({ occupancy: 0.7, turns: 10, ageMs: 0 }),
    handoff: async () => { handoffCalled = true; },
  });
  resolveDone({ ok: true, sessionId: "s-done", summary: "done", costUsd: 0 });
  await new Promise((r) => setTimeout(r, 0));
  expect(handoffCalled).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/pipeline.test.ts`
Expected: FAIL — `signals`/`handoff` unknown; no policy behavior.

- [ ] **Step 3: Implement**

In `src/engine/pipeline.ts`:

1. Imports: `import { sessionContext, decideContext, runHandoff } from "./context-policy";` and `import { existsSync } from "node:fs";` + `import { join } from "node:path";`.
2. `PipelineDeps` gains:

```ts
  /** Test seams for the context policy (default: real transcript measurement + handoff run). */
  signals?: typeof sessionContext;
  handoff?: typeof runHandoff;
```

3. Add a private helper above `handleMessage`:

```ts
/** Apply the context policy to a persisted resume id. Returns the id to actually resume with
 *  ("" = start fresh). Never throws (fail open = keep the id). */
async function applyContextPolicy(
  folder: string,
  sessionInfo: { id: string; order: Order; sdkSessionId: string; name: string } | undefined,
  resumeId: string,
  deps: PipelineDeps,
): Promise<string> {
  if (!resumeId) return "";
  try {
    const signals = deps.signals ?? sessionContext;
    const sig = signals(folder, resumeId);
    const verdict = decideContext(sig, deps.cfg.contextPolicy);
    if (verdict === "keep") return resumeId;
    if (verdict === "clear") {
      deps.ledger.clearSessionsFor(folder);
      deps.ledger.recordContextEvent(folder, "clear", sig.occupancy);
      return "";
    }
    // handoff: run it against the fat session (bounded), which clears; then fresh.
    const handoff = deps.handoff ?? runHandoff;
    const target = sessionInfo ?? { id: "", name: "", sdkSessionId: resumeId, order: { id: "", source: "neo" as const, folder, task: "", chatId: 0, createdAt: 0 } };
    await handoff({ ...target, status: "idle", startedAt: 0, lastActivityAt: 0 } as SessionInfo, deps.cfg.contextPolicy, { registry: deps.registry, ledger: deps.ledger });
    return "";
  } catch {
    return resumeId; // fail open
  }
}
```

4. **Idle-resume branch** (`handleMessage` step 1, the `resumed` path): before calling `startSession`, run `const resumeId = await applyContextPolicy(live.order.folder, live, live.sdkSessionId, deps);` and pass `runConfigFor(live.id, registry, deps, chatId, resumeId)`.
5. **New-order branch** (step 5): `const resume = await applyContextPolicy(parsed.folder, undefined, ledger.lastSessionFor(parsed.folder, parsed.chatId) ?? "", deps);` then use `resume || undefined` as before.
6. **HANDOFF.md prefix** — in `startSession`, before calling `start`, when `!runDeps.resume && existsSync(join(order.folder, "HANDOFF.md"))`:

```ts
  order = { ...order, task: `Read HANDOFF.md first — it is the previous session's state-of-work note.\n\n${order.task}` };
```

(change the `order` parameter binding to `let order` or reassign into a local.)
7. **Post-completion** — in `run.done.then`, after `registry.detachControl(registryId)`, add:

```ts
    try {
      if (result.sessionId) {
        const signals = deps.signals ?? sessionContext;
        const sig = signals(order.folder, result.sessionId);
        if (decideContext(sig, deps.cfg.contextPolicy) !== "keep") {
          const handoff = deps.handoff ?? runHandoff;
          const info = registry.get(registryId);
          if (info) void handoff(info, deps.cfg.contextPolicy, { registry, ledger });
        }
      }
    } catch {
      // policy is an observer — never break the completion path
    }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean. `makeDeps` must set `cfg` with a real `contextPolicy` (use `loadConfig("/nonexistent-dir")` or an inline object with the spec defaults).

- [ ] **Step 5: Commit**

```bash
git add src/engine/pipeline.ts tests/pipeline.test.ts
git commit -m "feat(neo): context policy wired into pipeline boundaries (pre-resume, post-done, HANDOFF.md)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: ctx% observability + docs sync

**Files:**
- Modify: `src/engine/commands.ts` (renderList `ctx NN%`), `src/engine/dashboard.ts` (same)
- Modify: `CLAUDE.md` (status section)
- Test: `tests/commands.test.ts` (append)

**Interfaces:**
- Consumes: `sessionContext` (Task 1). `CommandDeps`/dashboard builders gain an optional `signals?: typeof sessionContext` seam for tests.

- [ ] **Step 1: Write the failing test**

Append to `tests/commands.test.ts`:

```ts
test("/status shows ctx% for sessions with a persisted sdk session id", () => {
  const { deps } = makeDeps();
  const s = deps.registry.add({ id: "cx", source: "neo", folder: "/p/gold", task: "t", chatId: 1, createdAt: 0 }, 0);
  deps.registry.setSdkSessionId(s.id, "sess-x");
  const out = handleCommand("/status", 1, { ...deps, signals: () => ({ occupancy: 0.42, turns: 3, ageMs: 0 }) });
  expect(out.text).toContain("ctx 42%");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`commands.ts`: add `signals?: typeof sessionContext` to `CommandDeps`; in `renderList`, for sessions with a `sdkSessionId`, compute `const sig = (deps.signals ?? sessionContext)(s.order.folder, s.sdkSessionId)` (wrapped in try/catch → skip on error) and append ` · ctx ${Math.round(sig.occupancy * 100)}%` to the line. `dashboard.ts`: add `ctxPct: Math.round(sig.occupancy * 100)` to each row the same way (0 when no session id / on error).

`CLAUDE.md`: add one status line after the governor-hardening entry:

```markdown
**Context policy + session liveness — live:** sessions are measured (transcript-derived ctx%) and
handoff-cleared at safe boundaries before they rot or hit the wall (`context-policy.ts`, HANDOFF.md
notes); dispatch is non-blocking (the company is always free; sub-runs report back, bounded by
`dispatchTimeoutMs`); a stuck-watchdog alerts the admin when a running session goes silent. Specs:
`docs/superpowers/specs/2026-07-08-context-policy-design.md`,
`docs/superpowers/specs/2026-07-08-session-liveness-design.md`.
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/commands.ts src/engine/dashboard.ts CLAUDE.md tests/commands.test.ts
git commit -m "feat(neo): ctx% in /status + dashboard; docs sync for context policy + liveness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
