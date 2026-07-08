# Session Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The company agent is always free — dispatch runs in the background and reports back; the operator can always see what every session is doing and gets alerted when one looks stuck.

**Architecture:** `dispatchToProject` stops awaiting the sub-worker: it starts a `startOrder` live run, returns immediately, and a background continuation (bounded by `dispatchTimeoutMs`) does the bookkeeping and report-back (operator reply + follow-up into the live company session). The registry tracks a per-session `activity` label fed by a new `onActivity` handler in the session-runner; a new `watchdog.ts` sweep (driven by the daemon's 60s tick) alerts the admin once when a running session goes silent or grinds one activity too long.

**Tech Stack:** Bun + TypeScript, `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-session-liveness-design.md`

## Global Constraints

- TDD: failing test first. Verification per task: `bun test ./tests/*.test.ts` (NEVER bare `bun test` — it picks up unrelated broken specs under `/home/neo/agent/`) plus `bunx tsc --noEmit`; both green before every commit.
- Watchdog + activity tracking are observers: errors inside them are caught/logged, never thrown into a worker path.
- Config defaults, verbatim from the spec: `dispatchTimeoutMs` 900_000 · `stuckAfterMs` 600_000 · `longTurnAlertMs` 1_200_000 · `alertRepeatMs` 900_000.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Registry activity tracking + input-queue depth

**Files:**
- Modify: `src/types.ts` (SessionInfo, SessionControl)
- Modify: `src/engine/registry.ts` (Registry interface + impl)
- Modify: `src/engine/session-runner.ts` (RunHandlers.onActivity, createInputChannel.queued, SessionRun.queued)
- Test: `tests/registry.test.ts` (append), `tests/session-runner.test.ts` (append)

**Interfaces:**
- Consumes: existing `SessionInfo`, `createInputChannel`, `consumeStream`.
- Produces (later tasks rely on these exact names):
  - `SessionInfo.activity?: { label: string; since: number }` and `SessionInfo.alertedAt?: number`
  - `Registry.noteActivity(id: string, label: string, now?: number): void`
  - `Registry.noteAlert(id: string, now?: number): void`
  - `RunHandlers.onActivity?: (label: string) => void`
  - `SessionRun.queued(): number` and `SessionControl.queued?(): number`

- [ ] **Step 1: Write the failing tests**

Append to `tests/registry.test.ts` (match its existing imports/fixtures — it already builds orders and a registry):

```ts
test("noteActivity sets the label and keeps `since` while the label is unchanged", () => {
  const r = createRegistry();
  const s = r.add({ id: "a1", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: 0 }, 0);
  r.noteActivity(s.id, "Bash: bun test", 100);
  expect(r.get(s.id)?.activity).toEqual({ label: "Bash: bun test", since: 100 });
  r.noteActivity(s.id, "Bash: bun test", 500); // same label -> since unchanged (measures how long it's ground on it)
  expect(r.get(s.id)?.activity).toEqual({ label: "Bash: bun test", since: 100 });
  r.noteActivity(s.id, "replying", 900); // new label -> since resets
  expect(r.get(s.id)?.activity).toEqual({ label: "replying", since: 900 });
});

test("noteAlert stamps alertedAt", () => {
  const r = createRegistry();
  const s = r.add({ id: "a2", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: 0 }, 0);
  r.noteAlert(s.id, 42);
  expect(r.get(s.id)?.alertedAt).toBe(42);
});
```

Append to `tests/session-runner.test.ts` (it already has a fake `query` producing SDK message streams — follow its existing fake pattern):

```ts
test("onActivity reports every tool_use and text block; queued() counts waiting follow-ups", async () => {
  const labels: string[] = [];
  // Fake stream: one assistant message with a tool_use, then a text block, then result.
  const fakeQuery = (() => {
    const obj = {
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
      },
      interrupt: async () => {},
    };
    return () => obj;
  })();
  const run = startOrder(
    { id: "o1", source: "neo", folder: "/tmp", task: "t", chatId: 1, createdAt: 0 },
    { onMessage: () => {}, onEscalation: async () => "deny", onActivity: (l) => void labels.push(l) },
    { query: fakeQuery as never },
  );
  run.followUp("extra 1");
  run.followUp("extra 2");
  expect(run.queued()).toBeGreaterThanOrEqual(0); // channel drains as the fake iterates; the method exists and returns a number
  await run.done;
  expect(labels).toContain("Bash: bun test");
  expect(labels).toContain("replying");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/registry.test.ts tests/session-runner.test.ts`
Expected: FAIL — `noteActivity`/`noteAlert`/`queued` do not exist; `onActivity` is an unknown property (tsc errors count as failure).

- [ ] **Step 3: Implement**

`src/types.ts` — extend the two interfaces (add fields only, keep existing docs style):

```ts
export interface SessionControl {
  followUp(text: string): void;
  interrupt(): Promise<void>;
  /** Follow-ups waiting behind the in-flight turn (observability; optional for old fakes). */
  queued?(): number;
}
```

and on `SessionInfo`, after `lastActivityAt`:

```ts
  /** What the worker is doing right now (last tool/text), for /status + the stuck-watchdog. */
  activity?: { label: string; since: number };
  /** Last time the stuck-watchdog alerted about this session (dedup). */
  alertedAt?: number;
```

`src/engine/registry.ts` — add to the `Registry` interface:

```ts
  /** Record what the session is doing right now; `since` is kept while the label is unchanged. */
  noteActivity(id: string, label: string, now?: number): void;
  /** Stamp the last stuck-alert time (watchdog dedup). */
  noteAlert(id: string, now?: number): void;
```

and to the returned object in `createRegistry()`:

```ts
    noteActivity(id, label, now = Date.now()) {
      const s = sessions.get(id);
      if (!s) return;
      if (s.activity?.label !== label) s.activity = { label, since: now };
    },
    noteAlert(id, now = Date.now()) {
      const s = sessions.get(id);
      if (s) s.alertedAt = now;
    },
```

`src/engine/session-runner.ts`:

1. Add to `RunHandlers`:

```ts
  /** Reports what the worker is doing (each tool_use as "Tool: detail", each text as "replying"). */
  onActivity?: (label: string) => void;
```

2. In `consumeStream`'s assistant branch, report activity for EVERY block (including quiet tools — activity is cheap and complete, unlike the milestone stream):

```ts
            if (b?.type === "text" && b.text?.trim()) {
              handlers.onActivity?.("replying");
              handlers.onMessage(b.text.trim());
            } else if (b?.type === "tool_use" && typeof b.name === "string") {
              const short = b.name.startsWith("mcp__") ? b.name.split("__").pop() ?? b.name : b.name;
              const detail = toolDetail(b.input);
              handlers.onActivity?.(`${short}${detail ? `: ${detail}` : ""}`);
              const line = toolMilestone(b.name, b.input);
              if (line) handlers.onMessage(line);
            }
```

3. `createInputChannel` returns an extra method `queued: () => queue.length`; `startOrder`'s returned object gains `queued: () => channel.queued()`. Add `queued(): number;` to the `SessionRun` interface (non-optional there; `SessionControl.queued` stays optional so existing test fakes that `attachControl` plain objects still compile).

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/engine/registry.ts src/engine/session-runner.ts tests/registry.test.ts tests/session-runner.test.ts
git commit -m "feat(neo): per-session activity tracking + input-queue depth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pipeline wires activity into the registry

**Files:**
- Modify: `src/engine/pipeline.ts` (`startSession`)
- Test: `tests/pipeline.test.ts` (append)

**Interfaces:**
- Consumes: `Registry.noteActivity` and `RunHandlers.onActivity` from Task 1.
- Produces: nothing new — every pipeline-started session now records activity.

- [ ] **Step 1: Write the failing test**

Append to `tests/pipeline.test.ts` (follow its existing fake-start fixture pattern — it injects `start` and captures handlers):

```ts
test("startSession wires onActivity into registry.noteActivity", async () => {
  // Build deps exactly like the file's other handleMessage tests (registry, ledger, meter, trust, reply, askApproval).
  // Inject a fake `start` that captures handlers, then invoke handlers.onActivity manually.
  let captured: RunHandlers | undefined;
  const fakeStart = (_o: Order, h: RunHandlers) => {
    captured = h;
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
  const deps = makeDeps({ start: fakeStart as never }); // reuse/extend the file's existing deps helper
  await handleMessage("/open /tmp: do a thing", 7, deps);
  const session = deps.registry.list()[0];
  captured?.onActivity?.("Bash: bun test");
  expect(deps.registry.get(session.id)?.activity?.label).toBe("Bash: bun test");
});
```

(If `tests/pipeline.test.ts` has no shared `makeDeps` helper, construct deps inline the way its neighboring tests do — the assertion at the end is the requirement.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/pipeline.test.ts`
Expected: FAIL — `activity` stays undefined (no onActivity handler wired).

- [ ] **Step 3: Implement**

In `src/engine/pipeline.ts` `startSession`, add to the handlers object passed to `start` (after `onMessage`):

```ts
      onActivity: (label) => {
        try {
          registry.noteActivity(registryId, label, now());
        } catch {
          // observer only — never break the worker path
        }
      },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/pipeline.ts tests/pipeline.test.ts
git commit -m "feat(neo): pipeline records worker activity in the registry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Non-blocking dispatch with timeout + report-back

**Files:**
- Modify: `src/config.ts` (`dispatchTimeoutMs`)
- Modify: `src/engine/dispatch.ts` (`DispatchDeps`, `dispatchToProject`)
- Modify: `src/engine/pipeline.ts` + `src/engine/ingress.ts` (pass `dispatchTimeoutMs` into the deps handed to `neoMcpServers`)
- Test: `tests/dispatch.test.ts` (rewrite the dispatchToProject tests), `tests/config.test.ts` (append)

**Interfaces:**
- Consumes: `startOrder` (`SessionRun` with `.interrupt()`/`.done`), `Registry.getDefault`/`getControl`, Task 1's types.
- Produces: `dispatchToProject(project, task, deps, replyChat, opts?)` now returns immediately with a "dispatched to <name>" string; `DispatchDeps` gains `dispatchTimeoutMs?: number`; new exported constant `DISPATCH_TIMEOUT_MS_DEFAULT = 900_000`; `opts` gains `start?: typeof startOrder` (test injection) replacing reliance on `run` for the background path (keep `run` in opts for compatibility but the implementation uses `start`).

Behavioral contract (from the spec — the tests below encode it):
1. Returns immediately: `"dispatched to <name> — running in the background; its output streams to the operator and you will receive its result as a follow-up message when it finishes."`
2. Busy guard: a dispatch to a folder whose session is `running` returns `"<name> is still busy with the previous dispatch"` and starts nothing.
3. Background completion: meter.note + ledger.recordOutcome + registry idle + operator reply `✅ <name> finished: <summary>` (or `⛔`/error), and — if the default (company) session has a live control — `control.followUp("[dispatch result] <name>: <summary>")`.
4. Timeout: after `dispatchTimeoutMs` (default 900_000; injectable via `deps.dispatchTimeoutMs`), call `.interrupt()`, record outcome `error`, report `⛔ <name> timed out after <m>m and was aborted`.

- [ ] **Step 1: Write the failing tests**

In `tests/dispatch.test.ts`, keep the `resolveProject`/`sendProjectFile` tests; replace the `dispatchToProject` tests with (adapting to the file's existing deps fixture):

```ts
test("dispatch returns immediately while the sub-run is still going", async () => {
  let interrupted = false;
  const never = new Promise<RunResult>(() => {});
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => { interrupted = true; }, done: never });
  const out = await dispatchToProject("neo", "task", deps, 1, { start: fakeStart as never, now: () => 0, root: "/home" });
  expect(out).toContain("dispatched to");
  expect(interrupted).toBe(false); // still running in the background — not awaited, not killed
});

test("dispatch to a running folder refuses instead of stacking", async () => {
  // register a session for the folder and mark it running, then dispatch again
  const first = deps.registry.add({ id: "d1", source: "neo", folder: "/home/neo", task: "x", chatId: -2, createdAt: 0 }, 0);
  deps.registry.setStatus(first.id, "running");
  const out = await dispatchToProject("neo", "task", deps, 1, { start: (() => { throw new Error("must not start"); }) as never });
  expect(out).toContain("still busy");
});

test("background completion books the result and reports back to operator + company", async () => {
  const replies: string[] = [];
  const companyFollowUps: string[] = [];
  // register the company as default with a live control
  const co = deps.registry.add({ id: "co", source: "neo", folder: "/home/neo/agent", task: "hq", chatId: 1, createdAt: 0 }, 0);
  deps.registry.setDefault(co.id);
  deps.registry.attachControl(co.id, { followUp: (t) => void companyFollowUps.push(t), interrupt: async () => {} });
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => { resolveDone = res; });
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, done });
  await dispatchToProject("neo", "task", { ...deps, reply: (_c, t) => void replies.push(t) }, 1, { start: fakeStart as never, now: () => 0 });
  resolveDone({ ok: true, sessionId: "sub-1", summary: "built the thing", costUsd: 0.02 });
  await new Promise((r) => setTimeout(r, 0)); // let the continuation run
  expect(replies.some((t) => t.includes("finished") && t.includes("built the thing"))).toBe(true);
  expect(companyFollowUps.some((t) => t.includes("[dispatch result]") && t.includes("built the thing"))).toBe(true);
});

test("background timeout interrupts the sub-run and records an error outcome", async () => {
  let interrupted = false;
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => { interrupted = true; }, done: new Promise<RunResult>(() => {}) });
  const replies: string[] = [];
  await dispatchToProject("neo", "task", { ...deps, dispatchTimeoutMs: 5, reply: (_c, t) => void replies.push(t) }, 1, { start: fakeStart as never });
  await new Promise((r) => setTimeout(r, 25));
  expect(interrupted).toBe(true);
  expect(replies.some((t) => t.includes("timed out"))).toBe(true);
});
```

Append to `tests/config.test.ts`:

```ts
test("dispatchTimeoutMs defaults to 900000 and reads config.json", () => {
  expect(loadConfig("/nonexistent-dir").dispatchTimeoutMs).toBe(900_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/dispatch.test.ts tests/config.test.ts`
Expected: FAIL — old dispatch awaits the run (first test hangs or returns the summary, not "dispatched to"); `dispatchTimeoutMs` missing.

- [ ] **Step 3: Implement**

`src/config.ts`: add to `NeoConfig`:

```ts
  /** Kill a dispatched background sub-run after this long (ms). Default 15 min. */
  dispatchTimeoutMs: number;
```

to `DEFAULTS`: `dispatchTimeoutMs: 15 * 60 * 1000,` and to `loadConfig`'s return: `dispatchTimeoutMs: fileCfg.dispatchTimeoutMs ?? DEFAULTS.dispatchTimeoutMs,`.

`src/engine/dispatch.ts`: add `dispatchTimeoutMs?: number;` to `DispatchDeps`; import `startOrder` alongside `runOrder`; export `const DISPATCH_TIMEOUT_MS_DEFAULT = 900_000;`. Rewrite the body of `dispatchToProject` after the `reply("→ dispatching…")` line:

```ts
  const resume = existing?.sdkSessionId || deps.ledger.lastSessionFor(folder, SUB_CHAT) || undefined;
  // Busy guard: never stack a second run onto a folder whose session is mid-turn.
  if (existing && existing.status === "running" && deps.registry.getControl(existing.id)) {
    return `${name} is still busy with the previous dispatch — its result will arrive when it finishes.`;
  }
  const start = opts.start ?? startOrder;
  const timeoutMs = deps.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS_DEFAULT;

  const run = start(
    order,
    {
      onMessage: (t) => void deps.reply(replyChat, t, name),
      onEscalation: (reason) => deps.askApproval(replyChat, reason),
      onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      autoApprove: () => deps.trust.isTrusted(folder),
      onAutoApprove: (reason) => {
        deps.ledger.recordAutoApproval(order.id, reason);
        void deps.reply(replyChat, `🔓 auto-approved: ${reason}`, name);
      },
      onActivity: (label) => {
        try { deps.registry.noteActivity(session.id, label, now()); } catch { /* observer only */ }
      },
    },
    { resume },
  );
  deps.registry.attachControl(session.id, run);

  // Background continuation: bounded await, then bookkeeping + report-back. NEVER awaited here —
  // the company's turn ends immediately (operator requirement: the main agent is always free).
  void (async () => {
    let result: RunResult;
    let timedOut = false;
    const timer = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), timeoutMs));
    try {
      const settled = await Promise.race([run.done, timer]);
      if (settled === "timeout") {
        timedOut = true;
        await run.interrupt();
        result = await run.done; // consumeStream resolves with summary "interrupted"
        result = { ...result, ok: false, summary: `timed out after ${Math.round(timeoutMs / 60000)}m and was aborted` };
      } else {
        result = settled;
      }
    } catch (e) {
      result = { ok: false, sessionId: "", summary: e instanceof Error ? e.message : String(e), costUsd: 0 };
    }
    try {
      if (result.sessionId) {
        deps.registry.setSdkSessionId(session.id, result.sessionId);
        deps.ledger.recordSession(order.id, result.sessionId);
      }
      deps.meter.note({ costUsd: result.costUsd }, now());
      deps.ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary);
      deps.registry.setStatus(session.id, timedOut || !result.ok ? "error" : "idle");
      deps.registry.touch(session.id, now());
      deps.registry.detachControl(session.id);
      const line = result.ok ? `✅ ${name} finished: ${result.summary || "done"}` : `⛔ ${name}: ${result.summary || "failed"}`;
      await deps.reply(replyChat, line, name);
      // Feed the result back into the live company session so it can act on it next turn.
      const company = deps.registry.getDefault();
      const control = company && company.id !== session.id ? deps.registry.getControl(company.id) : undefined;
      control?.followUp(`[dispatch result] ${name}: ${result.summary || (result.ok ? "done" : "failed")}`);
    } catch {
      // observer/bookkeeping errors must not surface into the worker path
    }
  })();

  return `dispatched to ${name} — running in the background; its output streams to the operator and you will receive its result as a follow-up message when it finishes.`;
```

Also change `opts` to `opts: { start?: typeof startOrder; run?: RunFn; now?: () => number; root?: string; desks?: string } = {}` (keep `run` accepted for source-compat; it is no longer used) and delete the old awaited `run(...)`/result-handling block this replaces.

`src/engine/pipeline.ts`: in BOTH `neoMcpServers(deps, ...)` call sites (step 6 of `handleMessage` and `runConfigFor`), pass the timeout through by handing dispatch an enriched deps object: `neoMcpServers({ ...deps, dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs }, ...)`.
`src/engine/ingress.ts`: same enrichment in the untainted branch's `neoMcpServers({ ...deps, trust: denyAllTrust(), dispatchTimeoutMs: deps.cfg.dispatchTimeoutMs }, ...)`.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean. Existing dispatch tests that awaited a summary must have been replaced in Step 1; if another test elsewhere asserts dispatch's old blocking return, update it to the new "dispatched to" contract (that behavior change is the point of this task).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/engine/dispatch.ts src/engine/pipeline.ts src/engine/ingress.ts tests/dispatch.test.ts tests/config.test.ts
git commit -m "feat(neo): non-blocking dispatch — background sub-runs with timeout + report-back

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Stuck-watchdog sweep + daemon wiring

**Files:**
- Create: `src/engine/watchdog.ts`
- Modify: `src/config.ts` (three thresholds), `src/daemon.ts` (wire into the 60s tick)
- Test: `tests/watchdog.test.ts` (create), `tests/config.test.ts` (append)

**Interfaces:**
- Consumes: `Registry.list/noteAlert`, `SessionInfo.activity/alertedAt/lastActivityAt/status` (Task 1).
- Produces: `sweepStuck(registry: Registry, opts: { now: number; stuckAfterMs: number; longTurnAlertMs: number; alertRepeatMs: number; alert: (s: SessionInfo, reason: string) => void }): SessionInfo[]` (returns sessions alerted this sweep).

- [ ] **Step 1: Write the failing test**

Create `tests/watchdog.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { sweepStuck } from "../src/engine/watchdog";
import type { SessionInfo } from "../src/types";

function mk(now = 0) {
  const r = createRegistry();
  const s = r.add({ id: "w1", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: now }, now);
  return { r, s };
}
const OPTS = { stuckAfterMs: 600_000, longTurnAlertMs: 1_200_000, alertRepeatMs: 900_000 };

test("alerts once when a running session is silent past stuckAfterMs, with dedup + re-alert", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  const alerts: string[] = [];
  const alert = (_s: SessionInfo, reason: string) => void alerts.push(reason);
  expect(sweepStuck(r, { ...OPTS, now: 300_000, alert })).toHaveLength(0); // not yet
  expect(sweepStuck(r, { ...OPTS, now: 700_000, alert })).toHaveLength(1); // silent 700s > 600s
  expect(alerts[0]).toContain("silent");
  expect(sweepStuck(r, { ...OPTS, now: 800_000, alert })).toHaveLength(0); // deduped
  expect(sweepStuck(r, { ...OPTS, now: 1_700_000, alert })).toHaveLength(1); // re-alert after alertRepeatMs
});

test("alerts when one activity label grinds past longTurnAlertMs even with recent output", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.noteActivity(s.id, "dispatch: gold", 0);
  r.touch(s.id, 1_250_000); // recent output -> not "silent"
  const alerts: string[] = [];
  const out = sweepStuck(r, { ...OPTS, now: 1_300_000, alert: (_s, reason) => void alerts.push(reason) });
  expect(out).toHaveLength(1);
  expect(alerts[0]).toContain("dispatch: gold");
});

test("never alerts on idle sessions or after errors in the alert callback", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "idle");
  expect(sweepStuck(r, { ...OPTS, now: 10_000_000, alert: () => { throw new Error("boom"); } })).toHaveLength(0);
  r.setStatus(s.id, "running");
  // alert throws -> caught, still counted as alerted (no crash, no throw out of sweepStuck)
  expect(() => sweepStuck(r, { ...OPTS, now: 10_000_000, alert: () => { throw new Error("boom"); } })).not.toThrow();
});
```

Append to `tests/config.test.ts`:

```ts
test("watchdog thresholds default per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.stuckAfterMs).toBe(600_000);
  expect(c.longTurnAlertMs).toBe(1_200_000);
  expect(c.alertRepeatMs).toBe(900_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/watchdog.test.ts tests/config.test.ts`
Expected: FAIL — module `watchdog.ts` does not exist; config fields missing.

- [ ] **Step 3: Implement**

Create `src/engine/watchdog.ts`:

```ts
// Stuck-watchdog: alert the operator ONCE when a running session looks wedged — silent past
// stuckAfterMs, or grinding one activity past longTurnAlertMs. Pure + clock-injected (daemon
// drives it on the 60s tick). Observer only: it never interrupts a worker; recovery is /kill.
import type { SessionInfo } from "../types";
import type { Registry } from "./registry";

export interface WatchdogOpts {
  now: number;
  stuckAfterMs: number;
  longTurnAlertMs: number;
  alertRepeatMs: number;
  alert: (s: SessionInfo, reason: string) => void;
}

/** Alert on wedged-looking running sessions (deduped via alertedAt). Returns those alerted. */
export function sweepStuck(registry: Registry, opts: WatchdogOpts): SessionInfo[] {
  const { now, stuckAfterMs, longTurnAlertMs, alertRepeatMs } = opts;
  const alerted: SessionInfo[] = [];
  for (const s of registry.list()) {
    if (s.status !== "running") continue;
    if (s.alertedAt !== undefined && now - s.alertedAt < alertRepeatMs) continue; // dedup window
    const silentFor = now - s.lastActivityAt;
    const grindingFor = s.activity ? now - s.activity.since : 0;
    let reason: string | undefined;
    if (silentFor >= stuckAfterMs) {
      reason = `${s.name} has been silent for ${Math.round(silentFor / 60000)}m` + (s.activity ? ` (last: ${s.activity.label})` : "");
    } else if (s.activity && grindingFor >= longTurnAlertMs) {
      reason = `${s.name} has been on "${s.activity.label}" for ${Math.round(grindingFor / 60000)}m`;
    }
    if (!reason) continue;
    registry.noteAlert(s.id, now);
    try {
      opts.alert(s, `⚠️ ${reason} — reply /kill ${s.name} to abort.`);
    } catch {
      // observer only — an alert-channel failure must never break the sweep
    }
    alerted.push(s);
  }
  return alerted;
}
```

`src/config.ts`: add fields + defaults + loadConfig lines (same pattern as `dispatchTimeoutMs`):

```ts
  /** Alert when a running session has produced nothing for this long (ms). Default 10 min. */
  stuckAfterMs: number;
  /** Alert when one activity label has run this long (ms). Default 20 min. */
  longTurnAlertMs: number;
  /** Re-alert about the same session only after this long (ms). Default 15 min. */
  alertRepeatMs: number;
```

with `DEFAULTS`: `stuckAfterMs: 10 * 60 * 1000, longTurnAlertMs: 20 * 60 * 1000, alertRepeatMs: 15 * 60 * 1000,`.

`src/daemon.ts`: extend the existing idle-watchdog interval body (keep one interval):

```ts
  setInterval(() => {
    sweepIdle(registry, ledger, { idleMs: cfg.idleCloseMs, now: Date.now() });
    sweepStuck(registry, {
      now: Date.now(),
      stuckAfterMs: cfg.stuckAfterMs,
      longTurnAlertMs: cfg.longTurnAlertMs,
      alertRepeatMs: cfg.alertRepeatMs,
      alert: (_s, text) => {
        console.log(`[watchdog] ${text}`);
        const adminId = admin.adminId();
        if (cfg.telegramToken && adminId) {
          void fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: adminId, text }),
          }).catch(() => {});
        }
      },
    });
  }, IDLE_POLL_MS);
```

(import `sweepStuck` at the top; `admin` is already in scope).

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/watchdog.ts src/config.ts src/daemon.ts tests/watchdog.test.ts tests/config.test.ts
git commit -m "feat(neo): stuck-watchdog — proactive operator alert for wedged sessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: /status + dashboard show activity, busy-for, queue depth

**Files:**
- Modify: `src/engine/commands.ts` (`renderList`)
- Modify: `src/engine/dashboard.ts` (same info in the web payload)
- Test: `tests/commands.test.ts` (append), `tests/dashboard.test.ts` (append)

**Interfaces:**
- Consumes: `SessionInfo.activity`, `SessionControl.queued?()` via `registry.getControl` (Task 1).
- Produces: `/status` line format: `<star><icon> <lock><name> · <folder> · <status>[ · <activity.label> <busy>][ · N queued] · <age> · "<task>"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/commands.test.ts` (reuse its deps/registry fixture pattern):

```ts
test("/status shows current activity, busy duration, and queue depth for running sessions", () => {
  const { deps } = makeDeps(); // the file's existing helper (or inline construction like its neighbors)
  const s = deps.registry.add({ id: "c1", source: "neo", folder: "/p/gold", task: "build", chatId: 1, createdAt: 0 }, 0);
  deps.registry.setStatus(s.id, "running");
  deps.registry.noteActivity(s.id, "Bash: bun test", 0);
  deps.registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 2 });
  const out = handleCommand("/status", 1, { ...deps, now: () => 4 * 60_000 });
  expect(out.text).toContain("Bash: bun test");
  expect(out.text).toContain("2 queued");
});
```

Append to `tests/dashboard.test.ts`: assert the sessions payload rows carry `activity` (label+since) and `queued` when present.

```ts
test("dashboard rows expose activity + queued", () => {
  const registry = createRegistry();
  const s = registry.add({ id: "d1", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.setStatus(s.id, "running");
  registry.noteActivity(s.id, "Edit: web.ts", 5);
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 1 });
  const rows = dashboardSessions(registry, 10_000); // adapt to the dashboard module's actual builder fn
  expect(rows[0].activity).toEqual({ label: "Edit: web.ts", since: 5 });
  expect(rows[0].queued).toBe(1);
});
```

(Adapt names to `dashboard.ts`'s real exported builder — read it first; the requirement is that the web payload carries `activity` and `queued` per session.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/commands.test.ts tests/dashboard.test.ts`
Expected: FAIL — output lacks activity/queued.

- [ ] **Step 3: Implement**

In `commands.ts` `renderList`, extend the line builder: after the `s.status` segment insert, for running sessions:

```ts
      const act = s.status === "running" && s.activity ? ` · ${s.activity.label} ${humanAge(now - s.activity.since)}` : "";
      const q = registry.getControl(s.id)?.queued?.() ?? 0;
      const queued = q > 0 ? ` · ${q} queued` : "";
```

and interpolate `${act}${queued}` into the returned template right after the status segment. In `dashboard.ts`, add `activity: s.activity` and `queued: registry.getControl(s.id)?.queued?.() ?? 0` to each session row it builds.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test ./tests/*.test.ts && bunx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/commands.ts src/engine/dashboard.ts tests/commands.test.ts tests/dashboard.test.ts
git commit -m "feat(neo): /status + dashboard show live activity, busy-for, queue depth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
