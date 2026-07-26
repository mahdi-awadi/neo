# Engine Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, structured event log to the engine (a ledger `events` table + `recordEvent`/`listEvents`, instrumentation at the API-retry / session-lifecycle / dispatch-lifecycle points, and an `/events` operator command) so instability leaves a diagnosable trail.

**Architecture:** One new ledger audit table following the existing `context_events`/`cache_observations` precedent. Call-sites that already hold the `Ledger` (`pipeline.ts`, `dispatch.ts`) record events directly; the pure SDK core (`session-runner.ts`) emits via a thin optional `onEvent` handler wired to `recordEvent`. The query surface is one `/events` command in the shared `commands.ts` registry — zero frontend changes.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun test`, `bunx tsc --noEmit`.

## Global Constraints

- TDD: write the failing test first, watch it fail, then minimal code. `bunx tsc --noEmit` + `bun test` green before any task is "done." Commit per logical piece.
- No AI in the engine; deterministic. Machine-local state stays untracked (events live in the existing ledger sqlite, gitignored under `company/`).
- `recordEvent` is a single INSERT on the hot path; retention is amortised (prune every 1000 inserts, keep newest 50_000).
- Log kinds + structured metadata (ids, counts, timings, error codes/short strings) — NEVER full message bodies.
- `scope` field values are exactly `"interactive"` (pipeline.ts) and `"dispatch"` (dispatch.ts).
- Do NOT restart/reload the daemon. Do NOT deploy.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `src/engine/ledger.ts` — MODIFY: add `EngineEvent` interface, `events` table + indexes in `openLedger`, `recordEvent`/`listEvents` on the `Ledger` interface + impl, `EVENTS_KEEP`/`EVENTS_PRUNE_INTERVAL` consts.
- `src/engine/session-runner.ts` — MODIFY: add optional `onEvent?: (kind: string, data?: Record<string, unknown>) => void` to `RunHandlers`; emit `session_start` (runOrder + startOrder), `sdk_api_retry` (in `consumeStream`), `session_interrupted` (catch block).
- `src/engine/dispatch.ts` — MODIFY: record `dispatch_refused`/`dispatch_queued`/`dispatch_start`/`dispatch_abort`/`dispatch_end` + `api_retry`/`api_giveup` (scope `"dispatch"`); wire `onEvent` → `recordEvent`.
- `src/engine/pipeline.ts` — MODIFY: record `api_retry`/`api_giveup` (scope `"interactive"`); wire `onEvent` → `recordEvent`.
- `src/engine/commands.ts` — MODIFY: add `/events` command + `renderEvents(ledger, kind?)`.
- Tests: `tests/ledger.test.ts`, `tests/session-runner.test.ts`, `tests/dispatch.test.ts`, `tests/pipeline.test.ts`, `tests/commands.test.ts` (all MODIFY — append).

---

### Task 1: Ledger `events` table + `recordEvent`/`listEvents`

**Files:**
- Modify: `src/engine/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Produces:
  - `export interface EngineEvent { kind: string; at: number; orderId?: string; sessionId?: string; folder?: string; data?: Record<string, unknown>; }`
  - `recordEvent(kind: string, input?: { orderId?: string; sessionId?: string; folder?: string; data?: Record<string, unknown>; at?: number }): void`
  - `listEvents(opts?: { kind?: string; orderId?: string; limit?: number }): EngineEvent[]` — newest-first, default limit 50.
  - `export const EVENTS_KEEP = 50_000; export const EVENTS_PRUNE_INTERVAL = 1000;`

- [ ] **Step 1: Write failing tests** (append to `tests/ledger.test.ts`):

```ts
test("recordEvent then listEvents round-trips kind, columns, and parsed data, newest-first", () => {
  const l = openLedger(":memory:");
  l.recordEvent("api_retry", { orderId: "o1", folder: "/p/safari", data: { attempt: 1, delayMs: 30000 }, at: 100 });
  l.recordEvent("dispatch_start", { orderId: "o2", folder: "/p/gold", data: { resume: false }, at: 200 });
  const events = l.listEvents();
  expect(events[0]).toEqual({ kind: "dispatch_start", at: 200, orderId: "o2", folder: "/p/gold", data: { resume: false } });
  expect(events[1]).toMatchObject({ kind: "api_retry", at: 100, orderId: "o1", data: { attempt: 1, delayMs: 30000 } });
});

test("listEvents filters by kind and by orderId, and respects limit", () => {
  const l = openLedger(":memory:");
  l.recordEvent("api_retry", { orderId: "a", at: 1 });
  l.recordEvent("api_giveup", { orderId: "a", at: 2 });
  l.recordEvent("api_retry", { orderId: "b", at: 3 });
  expect(l.listEvents({ kind: "api_retry" }).map((e) => e.orderId)).toEqual(["b", "a"]);
  expect(l.listEvents({ orderId: "a" }).map((e) => e.kind)).toEqual(["api_giveup", "api_retry"]);
  expect(l.listEvents({ limit: 1 })).toHaveLength(1);
});

test("recordEvent with no data reads back data: undefined", () => {
  const l = openLedger(":memory:");
  l.recordEvent("session_interrupted", { at: 5 });
  expect(l.listEvents()[0]).toEqual({ kind: "session_interrupted", at: 5, orderId: undefined, sessionId: undefined, folder: undefined, data: undefined });
});

test("events retention keeps at most EVENTS_KEEP rows after the prune interval", () => {
  const l = openLedger(":memory:");
  const total = EVENTS_KEEP + EVENTS_PRUNE_INTERVAL + 5;
  for (let i = 0; i < total; i++) l.recordEvent("tick", { at: i });
  const count = l.listEvents({ limit: total }).length;
  expect(count).toBeLessThanOrEqual(EVENTS_KEEP);
  expect(count).toBeGreaterThan(EVENTS_KEEP - EVENTS_PRUNE_INTERVAL - 1); // pruned in coarse batches
});
```

Add `EVENTS_KEEP, EVENTS_PRUNE_INTERVAL` to the existing import line at the top of the test file:
`import { openLedger, EVENTS_KEEP, EVENTS_PRUNE_INTERVAL } from "../src/engine/ledger";`

- [ ] **Step 2: Run to verify fail** — `bun test tests/ledger.test.ts` → FAIL (`recordEvent` not a function).

- [ ] **Step 3: Implement.** In `ledger.ts`:

Add near `ROUTE_KEEP`:
```ts
/** Diagnostic event log retention: prune in coarse batches so the hot path stays a single insert. */
export const EVENTS_KEEP = 50_000;
export const EVENTS_PRUNE_INTERVAL = 1000;
```

Add the interface after `ConversationMessage`:
```ts
/** One structured engine event (diagnostic trail). `data` is small structured metadata —
 *  ids/counts/timings/error codes/short messages — NEVER a full message body. */
export interface EngineEvent {
  kind: string;
  at: number;
  orderId?: string;
  sessionId?: string;
  folder?: string;
  data?: Record<string, unknown>;
}
```

Add to the `Ledger` interface:
```ts
  /** Append one diagnostic event (single cheap INSERT; retention amortised — see EVENTS_KEEP). */
  recordEvent(
    kind: string,
    input?: { orderId?: string; sessionId?: string; folder?: string; data?: Record<string, unknown>; at?: number },
  ): void;
  /** Recent events, newest-first. Filter by kind and/or orderId; capped by `limit` (default 50). */
  listEvents(opts?: { kind?: string; orderId?: string; limit?: number }): EngineEvent[];
```

Add the table + indexes in `openLedger` (after the `message_routes` table):
```ts
  // Structured diagnostic event log — API errors/retries, session + dispatch lifecycle transitions.
  // The persistent trail to diagnose instability from (throttle loops, wedged dispatches, stalls).
  db.run(
    `CREATE TABLE IF NOT EXISTS events (
       kind TEXT NOT NULL, at INTEGER NOT NULL,
       order_id TEXT, session_id TEXT, folder TEXT, data TEXT
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events (kind, at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_order_at ON events (order_id, at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_at ON events (at)`);
  let eventInserts = 0;
```

Add the two methods to the returned object (near `recordContextEvent`):
```ts
    recordEvent(kind, input = {}) {
      db.query(`INSERT INTO events (kind, at, order_id, session_id, folder, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
        kind,
        input.at ?? Date.now(),
        input.orderId ?? null,
        input.sessionId ?? null,
        input.folder ?? null,
        input.data ? JSON.stringify(input.data) : null,
      );
      // Amortised retention: prune only every EVENTS_PRUNE_INTERVAL inserts, so the common path
      // stays a single insert (never a DELETE-per-insert).
      if (++eventInserts % EVENTS_PRUNE_INTERVAL === 0) {
        db.query(
          `DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY at DESC, rowid DESC LIMIT ?)`,
        ).run(EVENTS_KEEP);
      }
    },
    listEvents(opts = {}) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (opts.kind) { where.push("kind = ?"); params.push(opts.kind); }
      if (opts.orderId) { where.push("order_id = ?"); params.push(opts.orderId); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      params.push(opts.limit ?? 50);
      const rows = db
        .query(`SELECT kind, at, order_id, session_id, folder, data FROM events ${clause} ORDER BY at DESC, rowid DESC LIMIT ?`)
        .all(...params) as Array<{ kind: string; at: number; order_id: string | null; session_id: string | null; folder: string | null; data: string | null }>;
      return rows.map((r) => {
        let data: Record<string, unknown> | undefined;
        if (r.data) { try { data = JSON.parse(r.data); } catch { data = undefined; } }
        return { kind: r.kind, at: r.at, orderId: r.order_id ?? undefined, sessionId: r.session_id ?? undefined, folder: r.folder ?? undefined, data };
      });
    },
```

- [ ] **Step 4: Run** — `bun test tests/ledger.test.ts` → PASS. Then `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `feat(events): ledger events table + recordEvent/listEvents with amortised retention`.

---

### Task 2: `onEvent` handler + session-lifecycle events in session-runner

**Files:**
- Modify: `src/engine/session-runner.ts`
- Test: `tests/session-runner.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RunHandlers.onEvent?: (kind: string, data?: Record<string, unknown>) => void`. Emitted kinds: `session_start` `{ folder, resume }`, `sdk_api_retry` `{ attempt, max }`, `session_interrupted` `{}` (no data).

- [ ] **Step 1: Write failing tests** (append to `tests/session-runner.test.ts`):

```ts
test("onEvent fires session_start with the resume flag, and sdk_api_retry on the SDK's own retry", async () => {
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  const q = () =>
    (async function* () {
      yield { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5 };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (kind, data) => events.push({ kind, data }) },
    { query: q as never, resume: "sess-prev" },
  );
  expect(events[0]).toEqual({ kind: "session_start", data: { folder: "/tmp", resume: true } });
  expect(events.some((e) => e.kind === "sdk_api_retry" && (e.data as any).attempt === 2 && (e.data as any).max === 5)).toBe(true);
});

test("onEvent fires session_interrupted when the SDK stream throws (interrupt/idle-close)", async () => {
  const events: string[] = [];
  const q = () =>
    Object.assign(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" };
        throw new Error("Claude Code returned an error result: interrupted");
      })(),
      { interrupt: async () => {} },
    );
  const run = startOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (k) => events.push(k) }, { query: q as never });
  await run.done;
  expect(events).toContain("session_start");
  expect(events).toContain("session_interrupted");
});
```

- [ ] **Step 2: Run to verify fail** — `bun test tests/session-runner.test.ts` → FAIL (session_start not emitted).

- [ ] **Step 3: Implement.** In `session-runner.ts`:

Add to `RunHandlers` (after `onTurnComplete`):
```ts
  /** Structured diagnostic events (session lifecycle). The engine wires this to ledger.recordEvent;
   *  a bare worker leaves it unset. NEVER carries message bodies — kinds + small metadata only. */
  onEvent?: (kind: string, data?: Record<string, unknown>) => void;
```

In `consumeStream`, in the `catch` block, after `if (!summary) summary = "interrupted";`:
```ts
    handlers.onEvent?.("session_interrupted");
```

In `consumeStream`, in the `system/api_retry` branch, after the existing `onActivity` line:
```ts
        handlers.onEvent?.("sdk_api_retry", { attempt: msg.attempt ?? null, max: msg.max_retries ?? null });
```

In `runOrder`, before `return consumeStream(...)`:
```ts
  handlers.onEvent?.("session_start", { folder: order.folder, resume: !!deps.resume });
```

In `startOrder`, after `const channel = ...` and before `const queryObj = ...`:
```ts
  handlers.onEvent?.("session_start", { folder: order.folder, resume: !!deps.resume });
```

- [ ] **Step 4: Run** — `bun test tests/session-runner.test.ts` → PASS. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `feat(events): onEvent handler + session lifecycle events in session-runner`.

---

### Task 3: Dispatch lifecycle + API-retry events in dispatch.ts

**Files:**
- Modify: `src/engine/dispatch.ts`
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- Consumes: `ledger.recordEvent` (Task 1), `RunHandlers.onEvent` (Task 2).
- Produces (all recorded via `deps.ledger.recordEvent`, `folder`/`orderId` attached where known): `dispatch_refused` `{project, reason}`, `dispatch_queued` `{project}`, `dispatch_start` `{project, resume, ceilingMs, stallMs}`, `api_retry` `{scope:"dispatch", project, kind, attempt, max, delayMs, source, resetsAt?}`, `api_giveup` `{scope:"dispatch", project, kind, attempts}`, `dispatch_abort` `{project, limit}`, `dispatch_end` `{project, ok, timedOut, costUsd, apiError?}`.

- [ ] **Step 1: Write failing tests** (append to `tests/dispatch.test.ts`). Use the existing `makeDeps()`/`root` harness:

```ts
test("dispatch records dispatch_start then dispatch_end in the event log", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const done = Promise.resolve<RunResult>({ ok: true, sessionId: "s9", summary: "all green", costUsd: 0.02 });
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done });
  await dispatchToProject("eticket-v3", "task", d, 1, { start: fakeStart as never, now: () => 1000, root });
  await new Promise((r) => setTimeout(r, 5)); // let the background continuation settle
  const kinds = d.ledger.listEvents({ limit: 50 }).map((e) => e.kind);
  expect(kinds).toContain("dispatch_start");
  expect(kinds).toContain("dispatch_end");
  const end = d.ledger.listEvents({ kind: "dispatch_end" })[0];
  expect(end.data).toMatchObject({ ok: true, timedOut: false });
});

test("a refused dispatch (unknown project) records dispatch_refused with reason not_found", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const { d } = makeDeps();
  await dispatchToProject("nope", "task", d, 1, { root, now: () => 0 });
  const ev = d.ledger.listEvents({ kind: "dispatch_refused" })[0];
  expect(ev.data).toMatchObject({ reason: "not_found" });
});

test("a queued-behind-busy dispatch records dispatch_queued", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const first = d.registry.add({ id: "d1", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: -2, createdAt: 0 }, 0);
  d.registry.setStatus(first.id, "running");
  d.registry.attachControl(first.id, { followUp: () => {}, queued: () => 0, interrupt: async () => {} });
  await dispatchToProject("eticket-v3", "run docker ps", d, 1, { start: (() => { throw new Error("no start"); }) as never, root, now: () => 0 });
  expect(d.ledger.listEvents({ kind: "dispatch_queued" })).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify fail** — `bun test tests/dispatch.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `dispatchToProject` (dispatch.ts) add `recordEvent` calls (all reference `deps.ledger`; use `project` from the arg, `folder` once resolved, `order.id` once built):

At the `draining` refusal:
```ts
    deps.ledger.recordEvent("dispatch_refused", { folder, data: { project, reason: "draining" } }); // NOTE: folder not resolved yet here
```
Correction — draining/cooldown fire before `folder` is resolved, so omit `folder` there:
```ts
  if (deps.lifecycle?.draining()) {
    deps.ledger.recordEvent("dispatch_refused", { data: { project, reason: "draining" } });
    return "Neo is reloading — dispatch refused; retry after the restart (open sessions are preserved).";
  }
  if (deps.cooldown?.activeAt(now())) {
    deps.ledger.recordEvent("dispatch_refused", { data: { project, reason: "cooldown" } });
    return apiHoldMessage(deps.cooldown.remainingMs(now()));
  }
  const folder = resolveProject(project, opts.root, opts.desks);
  if (!folder) {
    deps.ledger.recordEvent("dispatch_refused", { data: { project, reason: "not_found" } });
    return `No project or desk named "${project}" was found — check the name.`;
  }
```

In the busy-with-live-control branch (after `control.followUp(order.task)`):
```ts
      deps.ledger.recordEvent("dispatch_queued", { orderId: order.id, folder, data: { project: name } });
```

In the busy-no-control refusal (the `return` after the `if (control?.followUp)` block):
```ts
    deps.ledger.recordEvent("dispatch_refused", { orderId: order.id, folder, data: { project: name, reason: "busy_no_control" } });
    return (
      `${name} is busy — ${status}. ...`
```

Inside the background continuation, right after `const startedAt = now();` (dispatch_start — `gatedResume` is settled by then):
```ts
    deps.ledger.recordEvent("dispatch_start", { orderId: order.id, folder, data: { project: name, resume: !!gatedResume, ceilingMs, stallMs } });
```

In `onTurnComplete`, inside `if (kind) { ... }`, when a retry is scheduled (after `retryingUntil = ...`):
```ts
              deps.ledger.recordEvent("api_retry", { orderId: order.id, folder, data: { scope: "dispatch", project: name, kind, attempt, max: MAX_API_RETRIES, delayMs, source, resetsAt } });
```
(Requires capturing `source` from `resolveApiRetryDelayMs` — change the destructure to `const { delayMs, resetsAt, source } = resolveApiRetryDelayMs({...})` and import nothing new.)

And the give-up branch (after the `apiFailureNotice` reply):
```ts
            deps.ledger.recordEvent("api_giveup", { orderId: order.id, folder, data: { scope: "dispatch", project: name, kind, attempts: apiRetries } });
```

At the hard-abort point (after `timedOut = true; await run.interrupt();`):
```ts
        deps.ledger.recordEvent("dispatch_abort", { orderId: order.id, folder, data: { project: name, limit } });
```

In the bookkeeping block, right after `deps.ledger.recordOutcome(...)`:
```ts
      deps.ledger.recordEvent("dispatch_end", { orderId: order.id, sessionId: result.sessionId || undefined, folder, data: { project: name, ok: result.ok, timedOut, costUsd: result.costUsd, apiError: result.apiError } });
```

Wire `onEvent` into the `start(order, { ... })` handlers block:
```ts
        onEvent: (kind, data) => deps.ledger.recordEvent(kind, { orderId: order.id, folder, data }),
```

- [ ] **Step 4: Run** — `bun test tests/dispatch.test.ts` → PASS. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `feat(events): dispatch lifecycle + api-retry events`.

---

### Task 4: API-retry events in the interactive pipeline

**Files:**
- Modify: `src/engine/pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `ledger.recordEvent` (Task 1), `RunHandlers.onEvent` (Task 2).
- Produces: `api_retry` `{scope:"interactive", project, kind, attempt, max, delayMs, source, resetsAt?}`, `api_giveup` `{scope:"interactive", project, kind, attempts}`; wires `onEvent` → `recordEvent`.

- [ ] **Step 1: Write failing test.** First inspect `tests/pipeline.test.ts` for the existing throttle/retry test harness (search for `apiError` / `onTurnComplete` / `resolveApiRetryDelayMs` usage) and mirror it. The test asserts:

```ts
test("a throttled turn records an api_retry event in the ledger (interactive scope)", async () => {
  // build deps with an in-memory ledger, a fake start whose handlers.onTurnComplete is invoked
  // with { ok:false, apiError:"rate_limit", ... }, sleep:()=>Promise.resolve(), now fixed.
  // after handleMessage + a tick:
  const ev = deps.ledger.listEvents({ kind: "api_retry" })[0];
  expect(ev.data).toMatchObject({ scope: "interactive", kind: "rate_limit", attempt: 1 });
});
```
(Write it concretely against the file's existing fake-`start` helper — do not invent a new harness.)

- [ ] **Step 2: Run to verify fail** — `bun test tests/pipeline.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `startSession` (pipeline.ts), `onTurnComplete`:

Capture `source`: `const { delayMs, resetsAt, source } = resolveApiRetryDelayMs({...})`.

In the give-up branch (before/after `apiFailureNotice` reply):
```ts
          ledger.recordEvent("api_giveup", { orderId: order.id, folder: order.folder, data: { scope: "interactive", project, kind, attempts: apiRetries } });
```
After scheduling the retry (after the `apiRetryNotice` reply):
```ts
        ledger.recordEvent("api_retry", { orderId: order.id, folder: order.folder, data: { scope: "interactive", project, kind, attempt, max: MAX_API_RETRIES, delayMs, source, resetsAt } });
```
Import `MAX_API_RETRIES` from `./api-retry` (add to the existing import list).

Wire `onEvent` into the `start(order, { ... })` handlers block:
```ts
      onEvent: (kind, data) => ledger.recordEvent(kind, { orderId: order.id, folder: order.folder, data }),
```

- [ ] **Step 4: Run** — `bun test tests/pipeline.test.ts` → PASS. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `feat(events): interactive-pipeline api-retry events`.

---

### Task 5: `/events` operator command

**Files:**
- Modify: `src/engine/commands.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `ledger.listEvents` (Task 1). `CommandDeps.ledger` already exists.
- Produces: an `/events` entry in `COMMANDS`, `renderEvents(ledger: Ledger, kind?: string): string`.

- [ ] **Step 1: Write failing tests.** Inspect `tests/commands.test.ts` for the `deps` builder, then:

```ts
test("/events renders recent events newest-first; a kind arg filters", () => {
  const deps = makeCommandDeps(); // existing helper in the test file
  deps.ledger.recordEvent("dispatch_start", { folder: "/p/gold", data: { project: "gold" }, at: 1 });
  deps.ledger.recordEvent("api_retry", { folder: "/p/safari", data: { project: "safari", attempt: 1, delayMs: 30000 } , at: 2});
  const all = handleCommand("/events", 1, deps)!;
  expect(all.text).toContain("api_retry");
  expect(all.text).toContain("dispatch_start");
  const filtered = handleCommand("/events api_retry", 1, deps)!;
  expect(filtered.text).toContain("api_retry");
  expect(filtered.text).not.toContain("dispatch_start");
});

test("/events with no events shows a friendly line", () => {
  const deps = makeCommandDeps();
  expect(handleCommand("/events", 1, deps)!.text).toContain("No events");
});

test("/events is advertised in telegramCommands", () => {
  expect(telegramCommands().some((c) => c.command === "events")).toBe(true);
});
```
(Use the test file's real deps-builder name; if it inlines an object literal, mirror that.)

- [ ] **Step 2: Run to verify fail** — `bun test tests/commands.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `commands.ts`, add to `COMMANDS` (after `recent`):
```ts
  {
    name: "events",
    usage: "/events [<kind>]",
    summary: "recent engine diagnostic events (API retries, dispatch + session lifecycle)",
    run: ({ deps, args }) => ({ text: renderEvents(deps.ledger, args.trim() || undefined) }),
  },
```
Add the renderer (near `renderRecent`):
```ts
function renderEvents(ledger: Ledger, kind?: string): string {
  const events = ledger.listEvents({ kind, limit: 20 });
  if (events.length === 0) return kind ? `No events of kind "${kind}".` : "No events yet.";
  return events
    .map((e) => {
      const t = new Date(e.at).toISOString().slice(11, 19); // HH:MM:SS
      const where = e.folder ? ` · ${e.folder.split("/").pop()}` : "";
      const data = e.data ? " · " + Object.entries(e.data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join(" ") : "";
      return `${t} · ${e.kind}${where}${data}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run** — `bun test tests/commands.test.ts` → PASS. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `feat(events): /events operator command`.

---

### Task 6: Full green + docs sync

- [ ] **Step 1:** `bunx tsc --noEmit` → clean; `bun test` → all green (no regressions).
- [ ] **Step 2:** Note in the design spec's "What needs a reload" that it's implemented on branch `feat/engine-event-log`, pending operator reload. Update `docs/HISTORY.md` only if the repo convention is to log each feature there (check first; if so, one line).
- [ ] **Step 3: Commit** any doc sync — `docs(events): note event-log shipped on branch, pending reload`.

## Self-review notes

- Spec coverage: table+helper (Task 1) ✓; api-retry/usage points (Tasks 3,4 — at the call-sites, since api-retry.ts/usage.ts are pure) ✓; session-runner lifecycle (Task 2) ✓; dispatch lifecycle (Task 3) ✓; queryable surface (Task 5) ✓; privacy — data is small metadata only, no bodies ✓.
- Type consistency: `recordEvent`/`listEvents`/`EngineEvent` names identical across tasks; `scope` values fixed to `"interactive"`/`"dispatch"`; `MAX_API_RETRIES` imported where `max` is recorded.
- The pipeline/commands tests (Tasks 4,5) deliberately say "inspect the existing harness first" because those test files' fixture builders must be reused verbatim, not reinvented — the executor confirms the real helper name before writing.
