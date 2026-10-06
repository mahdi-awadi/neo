# Context Sweet Spot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every project session inside a data-derived context sweet spot. The engine hands a
session off only at a task boundary or a safe, committed checkpoint. It shows the band, records
every reset with its reason, and measures whether the next session resumed cleanly.

**Architecture:** `context-policy.ts` stays the one policy: `decideContext` gains a boundary
argument and returns `{verdict, reason, band}`. A new pure `context-checkpoint.ts` turns raw stream
events (usage, tool use/result) into "safe checkpoint now" and "resume orientation" facts. It steers
the worker through the existing governor `PreToolUse` hook. The pipeline, dispatch, todo queue and
loops only call these seams. The ledger's `context_events` table is the single record.

**Tech Stack:** Bun + TypeScript, `bun:test`, `bun:sqlite`, Claude Agent SDK hooks.

**Spec:** `docs/superpowers/specs/2026-10-06-context-sweet-spot-design.md` · **ADR:** `docs/adr/0014-context-handoffs-happen-at-boundaries-not-at-thresholds.md` · **Branch:** `feat/context-sweet-spot` (on `fix/context-window-from-sdk`)

## Global Constraints

- Thresholds are `contextPolicy` knobs: `sweetSpotPct` 0.40, `checkpointPct` 0.60, `emergencyPct` 0.90, `handoffNoteMaxChars` 20000, `handoffOrientationMaxSteps` 70. A legacy `handoffPct` in config.json is honoured as `sweetSpotPct`.
- No AI in the engine: every decision is a pure function of measured numbers + git state.
- Fail open: a measurement/git/ledger error never destroys a session and never throws into a worker path (ADR-0010 `faults.contain`).
- Never hand off with uncommitted work (ignoring `HANDOFF.md`) unless the band is `emergency`.
- A guessed window (ADR-0013) never triggers a band rule; it only turns an emergency clear into a handoff.
- Do NOT restart the daemon. `bunx tsc --noEmit` + `bun test` green before each commit.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A follow-up the operator sends while a session is closing for a handoff must reach the fresh session, not vanish (Task 7 test).
2. Two gates must not run two handoffs on one folder at once (settle + an incoming message; a dispatch end + the todo release). `awaitHandoff` serialises them (Tasks 4, 7, 8 tests).
3. A worker that keeps calling tools after the steer only ever gets denials, including a `Bash` that chains `git commit && rm -rf x` (Task 6 test).
4. A non-git folder must never arm a mid-task checkpoint, and must not block a boundary handoff (Tasks 3, 6 tests).
5. A note bigger than the cap is cut at the cap with a pointer, never sent whole (Task 4 test).

---

### Task 1: Policy core — knobs, boundaries, bands

**Files:**
- Modify: `src/engine/context-policy.ts` (ContextPolicyCfg, decideContext, new contextBand)
- Modify: `src/config.ts:324-345` (defaults + legacy key), `src/engine/pipeline.ts`, `src/engine/dispatch.ts`, `src/engine/loops.ts` (call sites read `.verdict`)
- Test: `tests/context-policy.test.ts`

**Interfaces — Produces:**
```ts
export type ContextBoundary = "resume" | "settled" | "checkpoint";
export type ContextBand = "healthy" | "above" | "heavy" | "emergency";
export type ContextReason = "emergency" | "above-sweet-spot" | "heavy" | "projected-overflow" | "stale-resume" | "max-turns" | "max-age";
export interface ContextDecision { verdict: ContextVerdict; reason?: ContextReason; band: ContextBand }
export function contextBand(occupancy: number, cfg: Pick<ContextPolicyCfg, "sweetSpotPct" | "checkpointPct" | "emergencyPct">): ContextBand;
export function decideContext(sig: ContextSignals, cfg: ContextPolicyCfg, ttlMs: number, at?: { boundary: ContextBoundary; projected?: number }): ContextDecision; // at defaults to {boundary:"resume"}
// ContextPolicyCfg: handoffPct → sweetSpotPct; + checkpointPct, handoffNoteMaxChars, handoffOrientationMaxSteps
```

- [ ] **Step 1: Failing tests** (replace the old matrix test; CFG fixture gets `sweetSpotPct: 0.4, checkpointPct: 0.6, emergencyPct: 0.9, handoffNoteMaxChars: 20000, handoffOrientationMaxSteps: 70`)

```ts
const sig = (occupancy: number, over: Partial<ContextSignals> = {}) => ({ occupancy, turns: 1, ageMs: 0, idleMs: 0, ...over });
test("contextBand splits occupancy at the three knobs", () => {
  expect([0.1, 0.4, 0.6, 0.9].map((o) => contextBand(o, CFG))).toEqual(["healthy", "above", "heavy", "emergency"]);
});
test("resume/settled boundaries hand off above the sweet spot, keep inside it", () => {
  for (const boundary of ["resume", "settled"] as const) {
    expect(decideContext(sig(0.39), CFG, 1e9, { boundary }).verdict).toBe("keep");
    expect(decideContext(sig(0.41), CFG, 1e9, { boundary })).toEqual({ verdict: "handoff", reason: "above-sweet-spot", band: "above" });
  }
});
test("a checkpoint hands off only in the heavy band, or when the plan projects past emergency", () => {
  expect(decideContext(sig(0.5), CFG, 1e9, { boundary: "checkpoint" }).verdict).toBe("keep");
  expect(decideContext(sig(0.61), CFG, 1e9, { boundary: "checkpoint" }).reason).toBe("heavy");
  expect(decideContext(sig(0.45), CFG, 1e9, { boundary: "checkpoint", projected: 1.05 }).reason).toBe("projected-overflow");
  expect(decideContext(sig(0.3), CFG, 1e9, { boundary: "checkpoint", projected: 1.5 }).verdict).toBe("keep"); // inside the sweet spot: never mid-task
});
test("emergency: clear only at a resume on a known window; otherwise hand off", () => {
  expect(decideContext(sig(0.92), CFG, 1e9, { boundary: "resume" }).verdict).toBe("clear");
  expect(decideContext(sig(0.92, { windowKnown: false }), CFG, 1e9, { boundary: "resume" }).verdict).toBe("handoff");
  expect(decideContext(sig(0.92), CFG, 1e9, { boundary: "settled" })).toEqual({ verdict: "handoff", reason: "emergency", band: "emergency" });
});
test("a guessed window drives no band rule — only turns/age/stale", () => {
  expect(decideContext(sig(0.7, { windowKnown: false }), CFG, 1e9, { boundary: "settled" }).verdict).toBe("keep");
  expect(decideContext(sig(0.1, { windowKnown: false, turns: 500 }), { ...CFG, maxTurns: 200 }, 1e9, { boundary: "settled" }).reason).toBe("max-turns");
});
test("stale-resume applies at a resume only", () => {
  const s = sig(0.36, { idleMs: 2e6 });
  expect(decideContext(s, CFG, 1e6, { boundary: "resume" }).reason).toBe("stale-resume");
  expect(decideContext(s, CFG, 1e6, { boundary: "settled" }).verdict).toBe("keep");
});
// tests/config.test.ts — uses the file's existing loadConfig-with-temp-config.json helper
test("config: the context band defaults to 0.40 / 0.60 / 0.90", () => {
  const cfg = loadWith({}); // helper: writes config.json in a temp dir, returns loadConfig() for it
  expect([cfg.contextPolicy.sweetSpotPct, cfg.contextPolicy.checkpointPct, cfg.contextPolicy.emergencyPct]).toEqual([0.4, 0.6, 0.9]);
});
test("config: a legacy contextPolicy.handoffPct is honoured as sweetSpotPct", () => {
  expect(loadWith({ contextPolicy: { handoffPct: 0.5 } }).contextPolicy.sweetSpotPct).toBe(0.5);
  expect(loadWith({ contextPolicy: { handoffPct: 0.5, sweetSpotPct: 0.3 } }).contextPolicy.sweetSpotPct).toBe(0.3);
});
```

- [ ] **Step 2:** `bun test tests/context-policy.test.ts` → FAIL (`contextBand` not exported).
- [ ] **Step 3: Implement**

```ts
export function contextBand(o: number, cfg: Pick<ContextPolicyCfg, "sweetSpotPct" | "checkpointPct" | "emergencyPct">): ContextBand {
  if (o >= cfg.emergencyPct) return "emergency";
  if (o >= cfg.checkpointPct) return "heavy";
  if (o >= cfg.sweetSpotPct) return "above";
  return "healthy";
}
export function decideContext(sig, cfg, ttlMs, at = { boundary: "resume" }): ContextDecision {
  const band = contextBand(sig.occupancy, cfg);
  const known = sig.windowKnown !== false;
  const hand = (reason: ContextReason): ContextDecision => ({ verdict: "handoff", reason, band });
  if (band === "emergency") return at.boundary === "resume" && known ? { verdict: "clear", reason: "emergency", band } : hand("emergency");
  if (at.boundary === "resume" && sig.idleMs >= ttlMs && sig.occupancy >= cfg.staleResumePct) return hand("stale-resume");
  if (known) {
    if (at.boundary === "checkpoint") {
      if (band === "heavy") return hand("heavy");
      if (band === "above" && (at.projected ?? 0) >= cfg.emergencyPct) return hand("projected-overflow");
      return { verdict: "keep", band };
    }
    if (band !== "healthy") return hand("above-sweet-spot");
  }
  if (at.boundary !== "checkpoint") {
    if (sig.turns >= cfg.maxTurns) return hand("max-turns");
    if (sig.ageMs >= cfg.maxAgeMs) return hand("max-age");
  }
  return { verdict: "keep", band };
}
```
`config.ts`: defaults `sweetSpotPct: 0.4, checkpointPct: 0.6, emergencyPct: 0.9, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70`; merge `const cp = fileCfg.contextPolicy ?? {}; contextPolicy: { ...DEFAULTS.contextPolicy, ...(cp.handoffPct !== undefined && cp.sweetSpotPct === undefined ? { sweetSpotPct: cp.handoffPct } : {}), ...cp }`. Call sites: `decideContext(...)` → `decideContext(...).verdict` (behaviour-preserving until Tasks 7–9).

- [ ] **Step 4:** `bun test && bunx tsc --noEmit` → green.
- [ ] **Step 5:** commit `feat(context): one policy, three boundaries — sweet spot 0.40 / checkpoint 0.60 / emergency 0.90 from transcript data`.

### Task 2: Ledger — context_events carries reason, boundary, detail

**Files:** Modify `src/engine/ledger.ts` (schema migration + interface), Test `tests/ledger.test.ts`

**Interfaces — Produces:**
```ts
export type ContextEventVerdict = "handoff" | "clear" | "deferred" | "resumed" | "fresh";
export interface ContextEventRow { id: number; folder: string; verdict: string; occupancy: number; at: number; reason?: string; boundary?: string; sessionId?: string; detail?: Record<string, unknown> }
recordContextEvent(folder: string, verdict: string, occupancy: number, at?: number, extra?: { reason?: string; boundary?: string; sessionId?: string; detail?: Record<string, unknown> }): number; // rowid
updateContextEventDetail(id: number, detail: Record<string, unknown>): void; // merges into existing detail
listContextEvents(opts?: number | { folder?: string; limit?: number }): ContextEventRow[]; // number = legacy limit
pendingHandoff(folder: string): ContextEventRow | undefined; // newest "handoff" with no "resumed" after it
```

- [ ] **Step 1: Failing tests**: record with extra → list returns reason/boundary/sessionId/detail; legacy 4-arg call still works (reason undefined); `updateContextEventDetail` merges; `pendingHandoff` returns the handoff, then undefined once a `resumed` row follows; an old DB without the columns migrates (create table with the old schema in a temp file, open it, record with extra).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** migration in the existing `PRAGMA table_info` style: add `reason TEXT, boundary TEXT, session_id TEXT, detail TEXT` when missing; `CREATE INDEX IF NOT EXISTS context_events_folder_at ON context_events(folder, at)`. `pendingHandoff`: `SELECT * FROM context_events WHERE folder=? AND verdict IN ('handoff','resumed') ORDER BY at DESC, rowid DESC LIMIT 1` → return if verdict is `handoff`.
- [ ] **Step 4/5:** green → commit `feat(ledger): context events record reason, boundary, session and detail`.

### Task 3: Git state — uncommitted work

**Files:** Modify `src/engine/dispatch-report.ts` (next to `lastCommitIn`), Test `tests/dispatch-report.test.ts`

**Interfaces — Produces:**
```ts
export function uncommittedIn(folder: string): string[] | undefined; // undefined = not a git repo / git failed; HANDOFF.md ignored
export function gitFacts(folder: string): { branch?: string; head?: string; uncommitted?: string[] };
```
- [ ] **Step 1: Failing tests** (temp git repo via `git init`, commit a file): clean → `[]`; modified file → `["a.txt"]`; only `HANDOFF.md` changed → `[]`; non-repo temp dir → `undefined`; `gitFacts` gives branch + `head` ("<sha7> <subject>").
- [ ] **Step 3:** `execFileSync("git", ["-C", folder, "status", "--porcelain"], {timeout: 5000})`; parse `line.slice(3)`; filter `basename !== "HANDOFF.md"` at repo root; catch → undefined. Same pattern as `lastCommitIn`.
- [ ] **Step 5:** commit `feat(dispatch-report): read uncommitted work and branch/HEAD facts from git`.

### Task 4: The handoff — note shape, engine facts, inline continuation, in-flight guard

**Files:** Modify `src/engine/context-policy.ts`, Test `tests/context-policy.test.ts`

**Interfaces — Consumes:** Task 1 `ContextDecision`, Task 2 ledger methods, Task 3 `gitFacts`/`uncommittedIn`.
**Produces:**
```ts
export const HANDOFF_SECTIONS = ["Goal", "Done", "Next steps", "Branch / commit", "Open decisions", "Gotchas"] as const;
export const HANDOFF_PROMPT: string; // asks for exactly those `## ` sections, overwrite HANDOFF.md, then stop
export const CHECKPOINT_STEER: string; // the deny reason at an armed checkpoint (same section list)
export function continuationBrief(task?: string): string; // "Continue …" + optional original brief (strips a previous prefix)
export function missingSections(note: string): string[];
export function engineFactsBlock(f: { reason?: string; occupancy: number; boundary: ContextBoundary; at: number } & ReturnType<typeof gitFacts>): string;
export function finalizeHandoffNote(folder: string, facts: …, fallback: () => string, since: number): { written: boolean; missing: string[] }; // appends facts; writes fallback when the note is absent or older than `since`
export function handoffPreamble(folder: string, ledger: Ledger, cfg: ContextPolicyCfg, now: number, sessionLabel?: string): { text: string; eventId: number } | undefined; // pending handoff → inline note (capped) + records "resumed"
export function trackHandoff(folder: string, p: Promise<unknown>): void;
export function awaitHandoff(folder: string): Promise<void>;
export interface HandoffDeps { …existing; decision?: ContextDecision; boundary?: ContextBoundary; notify?: (text: string, priority?: "alert") => void }
```
- [ ] **Step 1: Failing tests**
  - `HANDOFF_PROMPT` names every `HANDOFF_SECTIONS` heading (replaces the byte-identical fence test; the memory-flush test keeps its prefix assertion).
  - `missingSections("## Goal\n## Done")` → the other four.
  - `finalizeHandoffNote` with a fresh note appends `## Engine facts` (branch, HEAD, uncommitted, reason, occupancy); with no note writes the fallback + facts and returns `written:false`.
  - `handoffPreamble`: no pending → undefined; pending + note 30k chars, cap 20k → text holds the first 20k chars and the line "(note truncated — read HANDOFF.md for the rest)"; a `resumed` row is recorded with detail `{ handoffId }`; a second call → undefined.
  - `runHandoff` records `handoff` with `reason`/`boundary`/`sessionId` + detail `{ written, missing, branch, head }`, calls `notify` once with the project and percent, and with `priority:"alert"` when `decision.band === "emergency"`.
  - `awaitHandoff` resolves only after a tracked handoff promise settles; an untracked folder resolves at once; a rejected tracked promise still resolves `awaitHandoff` (never throws).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement. `runHandoff` wraps its body in `trackHandoff(folder, body)`. It takes `since = now()` before the turn, then runs `finalizeHandoffNote` after it. It keeps clearing the resume state exactly as today.
- [ ] **Step 4/5:** green → commit `feat(context): a handoff note with fixed sections + engine facts; continuations get it inline; one handoff per folder at a time`.

### Task 5: Stream callbacks + the hook steer

**Files:** Modify `src/engine/session-runner.ts` (RunHandlers, consumeStream, buildGovernorHook, sdkOptions), Test `tests/governor-hook.test.ts`, `tests/session-runner.test.ts` (or the existing stream test file)

**Interfaces — Produces:**
```ts
// RunHandlers additions
onUsage?: (model: string | undefined, usage: Record<string, number>) => void;
onToolUse?: (id: string | undefined, name: string, input: unknown) => void;
onToolResult?: (id: string | undefined, isError: boolean) => void;
contextSteer?: (toolName: string, input: unknown) => string | undefined; // a reason = deny
export function buildGovernorHook(folder: string, steer?: RunHandlers["contextSteer"]);
```
- [ ] **Step 1: Failing tests**: hook with a steer returning "stop" on `Edit` → `permissionDecision: "deny"` + reason "stop"; steer returning undefined → today's verdicts unchanged; a throwing steer → falls through to today's verdict (never throws). A fake query stream with an assistant message (usage + model + one tool_use) and a user tool_result (`is_error: true`) → `onUsage("claude-opus-5-5", usage)`, `onToolUse("t1","Bash",{command})`, `onToolResult("t1", true)` called in that order.
- [ ] **Step 3:** emit in `consumeStream` (assistant: `msg.message.usage` → onUsage once per message; each `tool_use` block → onToolUse; user `tool_result` → onToolResult). Hook: `const steered = safe(() => steer?.(input.tool_name, input.tool_input)); if (steered) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: steered } };` before `decide`. `sdkOptions` passes `handlers.contextSteer`.
- [ ] **Step 5:** commit `feat(session-runner): raw usage/tool stream callbacks; the governor hook can deny at a context checkpoint`.

### Task 6: The checkpoint watch + resume probe (pure)

**Files:** Create `src/engine/context-checkpoint.ts`, Test `tests/context-checkpoint.test.ts`

**Interfaces — Consumes:** Task 1 `decideContext`, `ContextPolicyCfg`; Task 3 `uncommittedIn` (injected).
**Produces:**
```ts
export interface CheckpointWatch {
  onUsage(model: string | undefined, usage: Record<string, number>): void;
  onToolUse(id: string | undefined, name: string, input: unknown): void;
  onToolResult(id: string | undefined, isError: boolean): void;
  steer(toolName: string, input: unknown): string | undefined;
  armed(): { at: number; decision: ContextDecision; occupancy: number } | undefined;
  disarm(): void;
  occupancy(): number | undefined;
}
export function createCheckpointWatch(o: { folder: string; cfg: ContextPolicyCfg; windows: () => Record<string, number>; now?: () => number; uncommitted?: (folder: string) => string[] | undefined; onArm?: (a: NonNullable<ReturnType<CheckpointWatch["armed"]>>) => void }): CheckpointWatch;
export function steerAllows(folder: string, toolName: string, input: unknown): boolean;
export interface ResumeProbe { onUsage(): void; onToolUse(id: string | undefined, name: string, input: unknown): void; report(): { productive: boolean; steps: number } }
export function createResumeProbe(onProductive?: (r: { productive: true; steps: number }) => void): ResumeProbe;
```
- [ ] **Step 1: Failing tests**
  - usage 650k on `claude-opus-5-5` (window 1M) + successful `git commit` + clean tree → armed, reason `heavy`, `onArm` called once.
  - the same at 500k → not armed; at 650k with a dirty tree → not armed; non-git (`uncommitted` → undefined) → not armed; unknown model window → not armed.
  - a failed commit (`onToolResult(id, true)`) → not armed.
  - TodoWrite plan: first call at 0.30 with 0/5 done; next at 0.45 with 1/5 done → projected 0.45 + 4×0.15 = 1.05 → armed `projected-overflow`.
  - `steerAllows`: `Read` ✓, `Write {file_path: <folder>/HANDOFF.md}` ✓, `Write src/x.ts` ✗, `Bash "git add HANDOFF.md && git commit -m x"` ✓, `Bash "git commit -m x && rm -rf y"` ✗, `Bash "npm test"` ✗, `mcp__x__y` ✗.
  - armed `steer("Edit", …)` → `CHECKPOINT_STEER`; `steer("Read", …)` → undefined; unarmed → undefined.
  - probe: 3 usage calls, then `Edit` → `onProductive({steps:3})` once; `report()` before any edit → `{productive:false, steps:n}`.
- [ ] **Step 3:** implement; occupancy = `(input + cache_read + cache_creation) / windows()[model]`; `windowKnown` = window present. Projection from the first TodoWrite snapshot `{occ0, done0}`: growth = (occ − occ0)/(done − done0) when done > done0. Bash split on `&&`, `;`, `||`, `|`, then every segment must match `^git\s+(status|diff|log|show|add|commit|rev-parse|branch)\b`.
- [ ] **Step 5:** commit `feat(context): checkpoint watch arms at a safe, committed point; resume probe measures orientation`.

### Task 7: Pipeline — settle handoffs, checkpoint continuation, no lost follow-ups, inline note

**Files:** Modify `src/engine/pipeline.ts` (`applyContextPolicy`, `handleMessage` branch 1, `startSession`), Test `tests/pipeline.test.ts`

**Interfaces — Consumes:** Tasks 1–6.

- [ ] **Step 1: Failing tests** (existing fake `start` seam + `signals` seam + temp git folder):
  1. A session that settles at 0.45 (signals stub) with a clean tree → `run.close()` called, `handoff` seam called once with `decision.reason === "above-sweet-spot"`, `boundary:"settled"`.
  2. Settles at 0.30 → no close, no handoff.
  3. Settles at 0.45 with a dirty tree → no close; one `deferred` row; a second settle → still one row.
  4. Message arrives while the control is `closed()` and a handoff is tracked → the message is not pushed into the closed control; after the handoff resolves a fresh session starts whose task contains the message.
  5. A fresh start in a folder with a pending handoff → first task begins with the inline note; `resumed` row exists; after the fake stream emits 2 usage + an `Edit`, its detail has `steps: 2, success: true`.
  6. Checkpoint path: the fake stream emits usage 650k (window recorded 1M) + a successful commit (clean tree) → the hook steer is armed; a fresh HANDOFF.md is written; settle → no handoff turn, the session id is cleared, a `handoff` row with `boundary:"checkpoint"`, and a second `start` call whose task begins with `continuationBrief()` + the inline note.
- [ ] **Step 3:** implement:
  - `applyContextPolicy`: `await awaitHandoff(folder)` first. Use `decideContext(..., {boundary:"resume"})`. A handoff with uncommitted work outside emergency → keep + `deferred` (`boundary:"resume"`). A clear → `recordContextEvent(..., {reason, boundary})` + `reply(..., "alert")`.
  - `startSession`: create `watch = createCheckpointWatch(...)` (Claude provider only) and pass `onUsage/onToolUse/onToolResult/contextSteer` handlers. On a fresh start: `handoffPreamble` replaces the pointer line when pending, plus a `createResumeProbe` whose `onProductive` calls `updateContextEventDetail`. Track the latest `result.sessionId` from `onTurnComplete`.
  - `onSettled` → `faults.contain("pipeline.contextSettle", …)`: skip if `queued()>0`; on an armed watch → `pendingClose = {kind:"checkpoint", …}`; else decide `settled` → clean check → `pendingClose = {kind:"handoff", decision}`; `trackHandoff(folder, closing promise)`; `run.close()`.
  - `run.done` handler: `pendingClose?.kind === "checkpoint"` → `finalizeHandoffNote` (fresh → no turn; stale → `runHandoff`) → clear id + record + `resumeSession(info, continuationBrief(), chatId, …)`; else decide `settled` (or use `pendingClose.decision`) → `runHandoff` with `decision`, `boundary`, `notify`. Resolve the tracked promise in `finally`.
  - `handleMessage` branch 1: `if (control && live.status === "running" && control.closed?.() === true) { await awaitHandoff(live.order.folder); /* re-read entry, fall through to the resume path */ }`.
- [ ] **Step 5:** commit `feat(pipeline): hand off at settle while the cache is warm; continue past a safe checkpoint; never drop a message sent mid-close`.

### Task 8: Dispatch + todo queue — end-of-run handoff, checkpoint continuation

**Files:** Modify `src/engine/dispatch.ts` (gate, run handlers, end bookkeeping, `DispatchHooks.onEnd`), `src/engine/todo-queue.ts` (`finish`), Test `tests/dispatch.test.ts`, `tests/todo-queue.test.ts`

**Interfaces — Produces:** `DispatchHooks.onEnd(end: { orderId; ok; summary; continuation?: string })`.
- [ ] **Step 1: Failing tests**
  1. Dispatch ends at 0.45 with a clean tree → `handoff` seam called with `boundary:"settled"` before `onEnd` resolves. At 0.30 → not called.
  2. The dispatch gate awaits a tracked handoff for the folder before measuring.
  3. With `hooks.onEnd` set: the stream arms the checkpoint (650k + commit + clean) and the note is fresh at settle → `onEnd` receives `continuation === continuationBrief(task)`, the result line says "handed off at a safe checkpoint (65%) — continuing in a fresh session". Without `hooks.onEnd` → no steer (hook allows `Edit`).
  4. Todo queue: `finish` with `continuation` marks the todo `done` (result "handed off at a checkpoint → #N"), adds `#N` with that brief at queue position 1, and releases it.
  5. A fresh dispatch with a pending handoff → the order task contains the inline note; a `resumed` row exists.
- [ ] **Step 3:** implement as in Task 7, inside the existing background continuation. The end-of-run handoff runs after the `recordSession` bookkeeping and before `hooks.onEnd`, inside `trackHandoff`. Use `todo.submit` semantics via `ledger.addTodo` + `move(id, 1)`.
- [ ] **Step 5:** commit `feat(dispatch): hand off a finished dispatch above the sweet spot; a safe checkpoint continues as a head-of-queue todo`.

### Task 9: Loops — record fresh starts

**Files:** Modify `src/engine/loops.ts:485-495`, Test `tests/loop-context-gate.test.ts`
- [ ] **Step 1:** failing test: a loop resume at 0.45 starts fresh and records `fresh` with `reason:"above-sweet-spot"`, `boundary:"resume"`.
- [ ] **Step 3:** `const d = decideContext(ctx, cfg.contextPolicy, ttlMs, { boundary: "resume" }); if (d.verdict !== "keep") deps.store?.recordContextEvent(loop.folder, "fresh", ctx.occupancy, undefined, { reason: d.reason, boundary: "resume", sessionId: id });`
- [ ] **Step 5:** commit `feat(loops): a loop's fresh start is recorded with its reason`.

### Task 10: Visibility — /status, dashboard, console

**Files:** Modify `src/engine/commands.ts` (`renderList`), `src/engine/dashboard.ts`, `src/frontends/web.ts` (project card + Recent card), wire cfg through callers (`telegram.ts`, `web-channel.ts`), Test `tests/commands.test.ts`, `tests/dashboard.test.ts`, `tests/web*.test.ts`
**Produces:** `DashProject.ctxBand?: ContextBand; lastReset?: { verdict: string; reason?: string; at: number }`; `DashState.contextEvents: Array<{ project: string; verdict: string; reason?: string; occupancy: number; at: number; boundary?: string; success?: boolean }>`; `CommandDeps.contextPolicy?` (bands).
- [ ] **Step 1: Failing tests**: `/status` line at 0.52 → contains `ctx 52% above`; at 0.2 → `ctx 20%` with no band word; a recent handoff → `↻ <age> above-sweet-spot`. Dashboard row → `ctxBand`, `lastReset`; `contextEvents` newest first, limit 20, folder → project basename. Console HTML contains `renderCtx` and a "Context resets" card.
- [ ] **Step 3:** implement; console: `<span class="ctx b-above">52%</span>` with CSS colours per band; Recent tab card rows.
- [ ] **Step 5:** commit `feat(console): ctx% with its sweet-spot band, the last reset, and a context-reset timeline`.

### Task 11: Docs

**Files:** `docs/CONFIG.md` (knobs), `docs/HISTORY.md` (entry), `CLAUDE.md` status line, `docs/loops.md` untouched.
- [ ] Update the knob table and the history; mention restart-gated. Commit `docs: context sweet spot — knobs, ADR-0014, history`.

### Final: verification + review

- [ ] `bunx tsc --noEmit` and `bun test`. Paste the counts.
- [ ] `superpowers:requesting-code-review` on `git diff fix/context-window-from-sdk...feat/context-sweet-spot`; fix confirmed findings.
- [ ] Check merges: `git merge-tree` against `master`, `fix/console-feed-window`, `feat/out-of-folder-writes-allow` and the other open `fix/*` branches. Report conflicts.
- [ ] Remove the worktree folder (`git worktree remove`), keep the branch. Do NOT restart the daemon.
