# Always-on company · 24h idle · per-project trust · file transfer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the company project always-on, keep normal projects awake ≥24h, add a persisted per-project full-auto-approve "trust" state, and add bidirectional file transfer on Telegram and the web console.

**Architecture:** All governance/logic lives in the engine (`src/engine/*`), tested without any channel; the Telegram and web frontends stay thin I/O. Trust is enforced in `session-runner`'s `canUseTool` via a per-escalation thunk, persisted in a new sqlite store, and audited in the ledger. File transfer reuses the existing in-process MCP-tool pattern (`dispatch.ts`) for outbound and a small engine helper for inbound.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `@anthropic-ai/claude-agent-sdk`, grammy (Telegram), `Bun.serve` (web). Tests: `bun test`. Types: `bunx tsc --noEmit`.

## Global Constraints

- TDD: write the failing test first, then minimal code. `bun test` AND `bunx tsc --noEmit` must be green before any task is "done".
- Commit per task. End every commit message with the trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **No AI in the engine.** Determinism only; the engine routes/governs/records.
- **Do NOT touch the customer→Gemini firewall** (`src/engine/provider-router.ts`). Trust applies only to operator (`source:"neo"`) work; customer work never carries trust.
- Trust = **full auto-approve** (including deploy/delete/push/payments) when a project is trusted — this is the operator's explicit choice and overrides the `CLAUDE.md` "never auto-approve" line.
- Trust is **off by default** (absence of a row), **per-project** (keyed by folder), and **persisted** across restarts.
- Test runner is `bun test <file>`; a single test by name: `bun test <file> -t "<name>"`.

---

## Part 1 — The company never goes off

### Task 1: `sweepIdle` skips the default project

**Files:**
- Modify: `src/engine/idle.ts:19-28`
- Test: `tests/idle.test.ts`

**Interfaces:**
- Consumes: `Registry.getDefault()` (exists), `Registry.setDefault(id)` (exists).
- Produces: no signature change — `sweepIdle` simply never returns/removes the default session.

- [ ] **Step 1: Write the failing test** — append to `tests/idle.test.ts`:

```ts
test("sweepIdle never closes the default project, however old", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  reg.add(o, 0); // lastActivityAt = 0 (ancient)
  reg.setStatus(o.id, "idle");
  reg.setDefault(o.id);
  reg.attachControl(o.id, fakeControl());

  const closed = sweepIdle(reg, led, { idleMs: 1000, now: 9_999_999 });

  expect(closed).toEqual([]);
  expect(reg.get("company")).toBeDefined(); // still registered
  expect(reg.getDefault()?.id).toBe("company");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/idle.test.ts -t "never closes the default"`
Expected: FAIL — the default session is currently swept and removed (`reg.get("company")` is undefined).

- [ ] **Step 3: Write minimal implementation** — in `src/engine/idle.ts`, add the guard as the first line of the loop body:

```ts
  for (const s of registry.list()) {
    if (s.id === registry.getDefault()?.id) continue; // the company is always-on — never close it
    const open = s.status === "running" || s.status === "idle";
    if (!open || now - s.lastActivityAt <= idleMs) continue;
    // ...unchanged below...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/idle.test.ts`
Expected: PASS (all idle tests, including the new one and the existing normal-session sweep).

- [ ] **Step 5: Commit**

```bash
git add src/engine/idle.ts tests/idle.test.ts
git commit -m "fix(neo): idle sweep never closes the always-on company" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Protect the default project from `/kill`

**Files:**
- Modify: `src/engine/commands.ts:112-119` (`killProject`), `src/engine/commands.ts:165-173` (`killSession`)
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `Registry.getDefault()`.
- Produces: `killProject`/`killSession` refuse when the target is the default; signatures unchanged.

- [ ] **Step 1: Write the failing test** — append to `tests/commands.test.ts`:

```ts
test("killProject refuses to kill the default company project", () => {
  const registry = createRegistry();
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(o, 0);
  registry.setDefault(o.id);
  const d = deps({ registry });

  const result = killProject("company", 1, d);

  expect(result.text).toContain("always-on");
  expect(registry.get("company")).toBeDefined(); // not removed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands.test.ts -t "refuses to kill the default"`
Expected: FAIL — `killProject` currently removes the session.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/commands.ts`, at the top of `killProject`:

```ts
export function killProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  const now = (deps.now ?? (() => Date.now()))();
  if (deps.registry.getDefault()?.id === id) {
    return { text: "🔒 the company is always-on and can't be stopped.", select: renderList(deps.registry, now, chatId).select };
  }
  if (deps.registry.get(id)) {
    void deps.registry.getControl(id)?.interrupt();
    deps.registry.setStatus(id, "done");
    deps.registry.remove(id);
  }
  return renderList(deps.registry, now, chatId);
}
```

And in `killSession` (used by `/kill <name>`), after resolving `session`:

```ts
function killSession(name: string, registry: Registry): string {
  if (!name) return "Usage: /kill <name>";
  const session = registry.findByName(name);
  if (!session) return `Session not found: ${name}`;
  if (registry.getDefault()?.id === session.id) return "🔒 the company is always-on and can't be stopped.";
  void registry.getControl(session.id)?.interrupt();
  registry.setStatus(session.id, "done");
  registry.remove(session.id);
  return `Killed session ${name}`;
}
```

> Note: this task references `renderList(registry, now, chatId)` with its CURRENT signature. Task 9 changes `renderList` to take `trust`; when you reach Task 9, update this `killProject` call accordingly (the plan repeats the final form there).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/commands.ts tests/commands.test.ts
git commit -m "feat(neo): refuse to /kill the always-on company" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Part 2 — Normal projects awake ≥ 24 h

### Task 3: Config `idleCloseMs` (default 24h) + daemon wiring

**Files:**
- Modify: `src/config.ts:7-26` (interface), `src/config.ts:28-34` (DEFAULTS), `src/config.ts:62-74` (return)
- Modify: `src/daemon.ts:21` and `:59` and `:66`
- Test: `tests/config.test.ts` (new)

**Interfaces:**
- Produces: `NeoConfig.idleCloseMs: number` (default `86_400_000`).

- [ ] **Step 1: Write the failing test** — create `tests/config.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";

const dir = () => mkdtempSync(join(tmpdir(), "neo-cfg-"));

test("idleCloseMs defaults to 24h", () => {
  expect(loadConfig(dir()).idleCloseMs).toBe(24 * 60 * 60 * 1000);
});

test("config.json overrides idleCloseMs", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ idleCloseMs: 1000 }));
  expect(loadConfig(d).idleCloseMs).toBe(1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `idleCloseMs` is `undefined` (property does not exist yet).

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts` add to the `NeoConfig` interface:

```ts
  /** Idle-close threshold for NORMAL projects in ms (the company is exempt). Default 24h. */
  idleCloseMs: number;
```

Add to `DEFAULTS`:

```ts
  idleCloseMs: 24 * 60 * 60 * 1000,
```

Add to the returned object in `loadConfig`:

```ts
    idleCloseMs: fileCfg.idleCloseMs ?? DEFAULTS.idleCloseMs,
```

- [ ] **Step 4: Wire the daemon to use it**

In `src/daemon.ts`, delete the line `const IDLE_CLOSE_MS = 10 * 60 * 1000;` and update the sweep + log:

```ts
  // Idle watchdog — shares the registry the pipeline registers sessions in. The company is exempt.
  setInterval(() => sweepIdle(registry, ledger, { idleMs: cfg.idleCloseMs, now: Date.now() }), IDLE_POLL_MS);
```

```ts
  console.log(`  idle      -> close normal projects after ${cfg.idleCloseMs / 3_600_000}h quiet, sweep every ${IDLE_POLL_MS / 1000}s (company exempt)`);
```

- [ ] **Step 5: Run checks**

Run: `bun test tests/config.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/daemon.ts tests/config.test.ts
git commit -m "feat(neo): configurable idleCloseMs, default 24h for normal projects" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Worker output counts as activity (touch on output)

**Files:**
- Modify: `src/engine/pipeline.ts:138-146` (`startSession`'s `onMessage`)
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `Registry.touch(id, now)` (exists).
- Produces: no signature change.

- [ ] **Step 1: Write the failing test** — append to `tests/pipeline.test.ts` (uses the existing `harness` + `fakeStart`):

```ts
test("worker output touches the session so producing output counts as activity", async () => {
  let handlers: RunHandlers | undefined;
  const fs = fakeStart({ onStart: (h) => (handlers = h) });
  const h = harness({ start: fs.start });
  let clock = 1000;
  await handleMessage("/open " + scratch() + " do work", 7, { ...h.base, now: () => clock });

  const id = h.registry.list()[0].id;
  clock = 5000;
  handlers!.onMessage("progress line"); // worker emits output at t=5000

  expect(h.registry.get(id)?.lastActivityAt).toBe(5000);
});
```

> If `fakeStart`'s `onStart` option does not exist in your copy of the test file, it does (see the top of `tests/pipeline.test.ts`). `harness` already wires `start`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline.test.ts -t "counts as activity"`
Expected: FAIL — `lastActivityAt` stays at the start time (1000), output does not touch.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/pipeline.ts`, change the `onMessage` handler inside `startSession`:

```ts
      onMessage: (t) => {
        registry.touch(registryId, now());
        void deps.reply(chatId, t, project);
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/pipeline.ts tests/pipeline.test.ts
git commit -m "feat(neo): worker output counts as activity for idle-close" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Part 3 — Per-project trust (full auto-approve)

### Task 5: Trust store (`trust.ts`)

**Files:**
- Create: `src/engine/trust.ts`
- Test: `tests/trust.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface TrustStore {
    isTrusted(folder: string): boolean;   // absent ⇒ false
    setTrust(folder: string, on: boolean): void;
    list(): string[];                     // trusted folders, sorted
  }
  export function openTrustStore(path: string): TrustStore;
  ```

- [ ] **Step 1: Write the failing test** — create `tests/trust.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTrustStore } from "../src/engine/trust";

test("a folder is untrusted by default; setTrust toggles it", () => {
  const t = openTrustStore(":memory:");
  expect(t.isTrusted("/p/a")).toBe(false);
  t.setTrust("/p/a", true);
  expect(t.isTrusted("/p/a")).toBe(true);
  expect(t.list()).toEqual(["/p/a"]);
  t.setTrust("/p/a", false);
  expect(t.isTrusted("/p/a")).toBe(false);
  expect(t.list()).toEqual([]);
});

test("trust persists across reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trust-")), "trust.db");
  openTrustStore(path).setTrust("/p/b", true);
  expect(openTrustStore(path).isTrusted("/p/b")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trust.test.ts`
Expected: FAIL — module `../src/engine/trust` not found.

- [ ] **Step 3: Write minimal implementation** — create `src/engine/trust.ts`:

```ts
// Per-project trust: when a folder is trusted, the engine auto-approves every tool for that
// project (full auto-approve, operator-chosen). Off by default = no row. Durable (its own
// sqlite file) so the choice survives restarts. No AI; the engine just records the toggle.
import { Database } from "bun:sqlite";

export interface TrustStore {
  /** Whether `folder` is trusted (auto-approve all). Absent ⇒ false. */
  isTrusted(folder: string): boolean;
  setTrust(folder: string, on: boolean): void;
  /** Trusted folders, sorted. */
  list(): string[];
}

export function openTrustStore(path: string): TrustStore {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS trust (folder TEXT PRIMARY KEY)`);
  return {
    isTrusted: (folder) => db.query(`SELECT 1 FROM trust WHERE folder = ?`).get(folder) !== null,
    setTrust: (folder, on) => {
      if (on) db.query(`INSERT OR IGNORE INTO trust (folder) VALUES (?)`).run(folder);
      else db.query(`DELETE FROM trust WHERE folder = ?`).run(folder);
    },
    list: () =>
      (db.query(`SELECT folder FROM trust ORDER BY folder`).all() as Array<{ folder: string }>).map((r) => r.folder),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/trust.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/trust.ts tests/trust.test.ts
git commit -m "feat(neo): per-project trust store (persisted, off by default)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Ledger audit of auto-approvals

**Files:**
- Modify: `src/engine/ledger.ts:6-15` (interface), `:17-36` (schema), `:37-91` (impl)
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Produces:
  ```ts
  recordAutoApproval(orderId: string, reason: string): void;
  autoApprovalsFor(orderId: string): string[]; // reasons, oldest first
  ```

- [ ] **Step 1: Write the failing test** — append to `tests/ledger.test.ts`:

```ts
test("records and reads auto-approvals for an order", () => {
  const led = openLedger(":memory:");
  led.recordAutoApproval("o1", "risky shell command: git push");
  led.recordAutoApproval("o1", "risky shell command: rm -rf build");
  expect(led.autoApprovalsFor("o1")).toEqual([
    "risky shell command: git push",
    "risky shell command: rm -rf build",
  ]);
  expect(led.autoApprovalsFor("o2")).toEqual([]);
});
```

> `tests/ledger.test.ts` already imports `openLedger`. If it does not, add `import { openLedger } from "../src/engine/ledger";`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ledger.test.ts -t "auto-approvals"`
Expected: FAIL — `recordAutoApproval` is not a function.

- [ ] **Step 3: Write minimal implementation**

Add to the `Ledger` interface:

```ts
  /** Audit: a risky action that trust auto-approved (the compensating control for the bypassed gate). */
  recordAutoApproval(orderId: string, reason: string): void;
  autoApprovalsFor(orderId: string): string[];
```

Add the table after the `outcomes` table creation:

```ts
  db.run(
    `CREATE TABLE IF NOT EXISTS auto_approvals (
       order_id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL
     )`,
  );
```

Add the methods to the returned object:

```ts
    recordAutoApproval(orderId, reason) {
      db.query(`INSERT INTO auto_approvals (order_id, reason, at) VALUES (?, ?, ?)`).run(orderId, reason, Date.now());
    },
    autoApprovalsFor(orderId) {
      return (
        db.query(`SELECT reason FROM auto_approvals WHERE order_id = ? ORDER BY at`).all(orderId) as Array<{ reason: string }>
      ).map((r) => r.reason);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ledger.ts tests/ledger.test.ts
git commit -m "feat(neo): ledger records trust auto-approvals (audit trail)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `canUseTool` auto-approves under trust

**Files:**
- Modify: `src/engine/session-runner.ts:25-34` (`RunHandlers`), `:84-94` (`buildCanUseTool`)
- Test: `tests/session-runner.test.ts`

**Interfaces:**
- Produces (on `RunHandlers`):
  ```ts
  autoApprove?: () => boolean;          // read PER escalation (a thunk, not a snapshot)
  onAutoApprove?: (reason: string) => void;
  ```
- Behavior: escalate verdict + `autoApprove()===true` ⇒ allow (echo input) + call `onAutoApprove(reason)`; never calls `onEscalation`. Otherwise unchanged.

- [ ] **Step 1: Write the failing test** — append to `tests/session-runner.test.ts` (reuses `fakeQuery` + `order` already in the file):

```ts
test("trust auto-approves a risky tool: allows, records via onAutoApprove, skips onEscalation", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "git push" } }]);
  const auto: string[] = [];
  let escalated = false;
  await runOrder(
    order(),
    {
      onMessage: () => {},
      onEscalation: async () => ((escalated = true), "deny"),
      autoApprove: () => true,
      onAutoApprove: (r) => auto.push(r),
    },
    { query: q },
  );
  expect(decisions[0].behavior).toBe("allow");
  expect(decisions[0].updatedInput).toEqual({ command: "git push" });
  expect(auto[0]).toContain("git push");
  expect(escalated).toBe(false);
});

test("trust off still escalates a risky tool", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "git push" } }]);
  let escalated = false;
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => ((escalated = true), "deny"), autoApprove: () => false },
    { query: q },
  );
  expect(escalated).toBe(true);
  expect(decisions[0].behavior).toBe("deny");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session-runner.test.ts -t "trust auto-approves"`
Expected: FAIL — `onAutoApprove` is never called; the risky tool escalates.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/session-runner.ts`, extend `RunHandlers`:

```ts
export interface RunHandlers {
  onMessage: (text: string) => void;
  onEscalation: (reason: string) => Promise<"allow" | "deny">;
  onCost?: (usd: number) => void;
  onRateLimit?: (info: RateLimitInfo) => void;
  /** When true (read per escalation), risky tools auto-approve instead of escalating. */
  autoApprove?: () => boolean;
  /** Called with the escalation reason when trust auto-approves it (for audit/FYI). */
  onAutoApprove?: (reason: string) => void;
}
```

Update `buildCanUseTool`:

```ts
function buildCanUseTool(handlers: RunHandlers) {
  return async (tool: string, input: Record<string, unknown>) => {
    const verdict = decide(tool, input);
    if ("allow" in verdict) {
      return { behavior: "allow", updatedInput: verdict.updatedInput ?? input };
    }
    // escalate verdict — auto-approve if this project is trusted (read the thunk NOW, not at start)
    if (handlers.autoApprove?.()) {
      handlers.onAutoApprove?.(verdict.escalate);
      return { behavior: "allow", updatedInput: input };
    }
    const decision = await handlers.onEscalation(verdict.escalate);
    if (decision === "allow") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: `denied by Neo: ${verdict.escalate}` };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/session-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/session-runner.ts tests/session-runner.test.ts
git commit -m "feat(neo): canUseTool auto-approves risky tools under trust" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire trust into the pipeline + dispatch

This task makes `trust` a REQUIRED dep on `PipelineDeps` (and therefore `EngineDeps`) and on `DispatchDeps`, so it also updates the test harnesses that build those deps.

**Files:**
- Modify: `src/engine/pipeline.ts:20-36` (`PipelineDeps`), `:127-164` (`startSession`)
- Modify: `src/engine/dispatch.ts:26-33` (`DispatchDeps`), `:86-96` (handlers)
- Test (update harnesses): `tests/pipeline.test.ts`, `tests/web.test.ts`, `tests/dispatch.test.ts`
- Test (new behavior): `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `TrustStore` (Task 5), `Ledger.recordAutoApproval` (Task 6), `RunHandlers.autoApprove/onAutoApprove` (Task 7).
- Produces: `PipelineDeps.trust: TrustStore`, `DispatchDeps.trust: TrustStore`.

- [ ] **Step 1: Write the failing test** — append to `tests/pipeline.test.ts`:

```ts
import { openTrustStore } from "../src/engine/trust";

test("a trusted project auto-approves: onAutoApprove records to the ledger and replies", async () => {
  let handlers: RunHandlers | undefined;
  const fs = fakeStart({ onStart: (h) => (handlers = h) });
  const folder = scratch();
  const trust = openTrustStore(":memory:");
  trust.setTrust(folder, true);
  const h = harness({ start: fs.start });

  await handleMessage("/open " + folder + " do it", 7, { ...h.base, trust });

  expect(handlers!.autoApprove?.()).toBe(true);
  handlers!.onAutoApprove?.("risky shell command: git push");

  const orderId = h.ledger.listRecent(1)[0].id;
  expect(h.ledger.autoApprovalsFor(orderId)).toContain("risky shell command: git push");
  expect(h.replies.some((r) => r.includes("auto-approved"))).toBe(true);
});
```

> Update the `harness()` helper's `base` object in `tests/pipeline.test.ts` to include `trust: openTrustStore(":memory:")` so every existing test still type-checks and the default (untrusted) path is exercised.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline.test.ts -t "auto-approves"`
Expected: FAIL — `deps.trust` is undefined / `autoApprove` not wired.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/pipeline.ts`, add to `PipelineDeps` (after `meter`):

```ts
  /** Per-project trust — when a folder is trusted, risky tools auto-approve. */
  trust: TrustStore;
```

Add the import at the top:

```ts
import type { TrustStore } from "./trust";
```

In `startSession`, extend the handlers passed to `start(...)`:

```ts
      onMessage: (t) => {
        registry.touch(registryId, now());
        void deps.reply(chatId, t, project);
      },
      onEscalation: (reason) => deps.askApproval(chatId, reason),
      onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      autoApprove: () => deps.trust.isTrusted(order.folder),
      onAutoApprove: (reason) => {
        deps.ledger.recordAutoApproval(order.id, reason);
        void deps.reply(chatId, `🔓 auto-approved: ${reason}`, project);
      },
```

- [ ] **Step 4: Wire trust into dispatch (sub-projects)**

In `src/engine/dispatch.ts`, add to `DispatchDeps`:

```ts
  trust: import("./trust").TrustStore;
```

> Cleaner: add `import type { TrustStore } from "./trust";` at the top and declare `trust: TrustStore;` in `DispatchDeps`.

In `dispatchToProject`, extend the handlers passed to `run(...)`:

```ts
      onMessage: (t) => void deps.reply(replyChat, t, name),
      onEscalation: (reason) => deps.askApproval(replyChat, reason),
      onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      autoApprove: () => deps.trust.isTrusted(folder),
      onAutoApprove: (reason) => {
        deps.ledger.recordAutoApproval(order.id, reason);
        void deps.reply(replyChat, `🔓 auto-approved: ${reason}`, name);
      },
```

- [ ] **Step 5: Fix the other harnesses that build these deps**

- `tests/web.test.ts`: in `app()`, add `trust: openTrustStore(":memory:")` to the `engine: { ... }` object, and `import { openTrustStore } from "../src/engine/trust";`.
- `tests/web-channel.test.ts`: in the `engine(start)` helper, add `trust: openTrustStore(":memory:")` to the returned object (+ the import). This helper builds `EngineDeps`, which now requires `trust`.
- `tests/dispatch.test.ts`: wherever a `DispatchDeps`-shaped object is built, add `trust: openTrustStore(":memory:")` (+ the import). Run `bun test tests/dispatch.test.ts` first to see the exact spots if tsc complains.

- [ ] **Step 6: Run full checks**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc clean; all tests PASS. (Fix any remaining `trust`-missing deps the compiler flags.)

- [ ] **Step 7: Commit**

```bash
git add src/engine/pipeline.ts src/engine/dispatch.ts tests/pipeline.test.ts tests/web.test.ts tests/dispatch.test.ts
git commit -m "feat(neo): wire per-project trust into pipeline and dispatch" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `/trust` command, `/list` 🔓 marker, and frontend threading

**Files:**
- Modify: `src/engine/commands.ts` — `CommandDeps` (12-19), command registry (51-92), `renderList` (135-154), `killProject`/`selectProject` call sites, new `trustCommand`
- Modify: `src/daemon.ts` (construct + thread `TrustStore`)
- Modify: `src/frontends/telegram.ts` (pass `trust` into pipeline + command deps)
- Modify: `src/engine/web-channel.ts` (pass `trust` into the inline command deps; it is already in `EngineDeps`)
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `TrustStore`.
- Produces: `CommandDeps.trust: TrustStore`; `/trust [on|off]` command; `renderList(registry, trust, now, chatId)`.

- [ ] **Step 1: Write the failing test** — append to `tests/commands.test.ts`:

```ts
import { openTrustStore } from "../src/engine/trust";

test("/trust on then /trust toggles and reports trust for the active project", () => {
  const registry = createRegistry();
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(o, 0);
  registry.setDefault(o.id); // free-text falls back to the company
  const trust = openTrustStore(":memory:");
  const d = { registry, ledger: openLedger(":memory:"), trust, now: () => 1 };

  expect(handleCommand("/trust on", 5, d)!.text).toContain("🔓");
  expect(trust.isTrusted("/home/neo/agent")).toBe(true);
  expect(handleCommand("/trust", 5, d)!.text).toContain("trusted");
  expect(handleCommand("/trust off", 5, d)!.text).toContain("🔒");
  expect(trust.isTrusted("/home/neo/agent")).toBe(false);
});
```

> Update the `deps()` helper in `tests/commands.test.ts` to include `trust: openTrustStore(":memory:")` so existing tests type-check.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands.test.ts -t "/trust"`
Expected: FAIL — unknown command `/trust` returns null.

- [ ] **Step 3: Add `trust` to `CommandDeps` and the command**

In `src/engine/commands.ts`, add to `CommandDeps`:

```ts
  /** Per-project trust store (for /trust and the 🔓 marker). */
  trust: import("./trust").TrustStore;
```

> Or add `import type { TrustStore } from "./trust";` at the top and `trust: TrustStore;`.

Add to the `COMMANDS` array (place after `kill`):

```ts
  {
    name: "trust",
    usage: "/trust [on|off]",
    summary: "auto-approve all actions for the active project (no Allow/Deny prompts)",
    run: ({ deps, args, chatId }) => trustCommand(args.trim(), chatId, deps),
  },
```

Add the helper function:

```ts
function trustCommand(arg: string, chatId: number, deps: CommandDeps): CommandResult {
  const target = deps.registry.findByChat(chatId) ?? deps.registry.getDefault();
  if (!target) return { text: "No active project to trust." };
  const folder = target.order.folder;
  if (arg === "on" || arg === "off") {
    deps.trust.setTrust(folder, arg === "on");
    return {
      text:
        arg === "on"
          ? `🔓 trusting ${target.name} (${folder}) — actions auto-approve, no prompts.`
          : `🔒 no longer trusting ${target.name} (${folder}) — actions will prompt again.`,
    };
  }
  const here = deps.trust.isTrusted(folder) ? "🔓 trusted" : "🔒 not trusted";
  const all = deps.trust.list();
  const list = all.length ? `\nTrusted: ${all.join(", ")}` : "";
  return { text: `${target.name} (${folder}): ${here}\nUsage: /trust on · /trust off${list}` };
}
```

- [ ] **Step 4: Add the 🔓 marker to `/list`**

Change `renderList`'s signature and call sites to thread `trust`:

```ts
function renderList(registry: Registry, trust: CommandDeps["trust"], now: number, chatId: number): CommandResult {
  const sessions = registry.list();
  if (sessions.length === 0) return { text: "No open projects." };
  const activeId = registry.findByChat(chatId)?.id;
  const select: SelectableProject[] = sessions.map((s) => ({
    label: s.name,
    id: s.id,
    active: s.id === activeId,
    folder: s.order.folder,
    status: s.status,
  }));
  const text = sessions
    .map((s) => {
      const star = s.id === activeId ? "★ " : "";
      const lock = trust.isTrusted(s.order.folder) ? "🔓 " : "";
      const task = s.order.task.length > 40 ? `${s.order.task.slice(0, 40)}…` : s.order.task;
      return `${star}${statusIcon(s.status)} ${lock}${s.name} · ${s.order.folder} · ${s.status} · ${humanAge(now - s.startedAt)} · "${task}"`;
    })
    .join("\n");
  return { text, select };
}
```

Update the three callers in `commands.ts`:

- `list` command `run`: `run: ({ deps, now, chatId }) => renderList(deps.registry, deps.trust, now, chatId),`
- `selectProject`: `return renderList(deps.registry, deps.trust, (deps.now ?? (() => Date.now()))(), chatId);`
- `killProject` (final form, superseding Task 2's note):

```ts
export function killProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  const now = (deps.now ?? (() => Date.now()))();
  if (deps.registry.getDefault()?.id === id) {
    return { text: "🔒 the company is always-on and can't be stopped.", select: renderList(deps.registry, deps.trust, now, chatId).select };
  }
  if (deps.registry.get(id)) {
    void deps.registry.getControl(id)?.interrupt();
    deps.registry.setStatus(id, "done");
    deps.registry.remove(id);
  }
  return renderList(deps.registry, deps.trust, now, chatId);
}
```

- [ ] **Step 5: Run command tests**

Run: `bun test tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 6: Thread `trust` through the daemon and frontends (glue — verified by tsc)**

In `src/daemon.ts`:
- Add import: `import { openTrustStore } from "./engine/trust";`
- After `const admin = openAdminStore("data/admin.db");`: `const trust = openTrustStore("data/trust.db");`
- Pass `trust` into Telegram: `startTelegram(cfg, ledger, admin, registry, meter, usage, trust);`
- Add `trust` to the web `engine` object: `{ engine: { cfg, ledger, registry, meter, trust }, ... }`.

In `src/frontends/telegram.ts`:
- Import the type: `import type { TrustStore } from "../engine/trust";`
- Add a `trust: TrustStore` parameter to `startTelegram(...)` (after `usage?`). It has no default — daemon always supplies it.
- Pass `trust` in the `handleMessage(...)` deps object: add `trust,`.
- Add `trust` to the THREE `CommandDeps` objects: the `handleCommand(...)` call and the `selectProject(...)`/`killProject(...)` calls in the callback handler — add `trust` to each `{ registry, ledger, usage }`.

In `src/engine/web-channel.ts`:
- `EngineDeps` already includes `trust` (it is `Omit<PipelineDeps, "reply" | "askApproval">`). Add `trust: opts.engine.trust` to the THREE inline `CommandDeps` objects (the `handleCommand(...)`, `engineSelectProject(...)`, `engineKillProject(...)` calls).

- [ ] **Step 7: Run full checks**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc clean; all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/engine/commands.ts src/engine/web-channel.ts src/frontends/telegram.ts src/daemon.ts tests/commands.test.ts
git commit -m "feat(neo): /trust command + 🔓 in /list; thread trust through frontends" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Part 4 — File transfer both ways

### Task 10: Inbound save helper (`files.ts`)

**Files:**
- Create: `src/engine/files.ts`
- Test: `tests/files.test.ts` (new)

**Interfaces:**
- Produces: `export function saveInbound(folder: string, filename: string, bytes: Uint8Array): string;` — writes to `<folder>/inbox/<sanitized>`, dedupes collisions, returns the absolute path.

- [ ] **Step 1: Write the failing test** — create `tests/files.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveInbound } from "../src/engine/files";

test("saveInbound writes under inbox/, sanitizes the name, returns the path", () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-files-"));
  const p = saveInbound(folder, "../../etc/pa ss.txt", new TextEncoder().encode("hi"));
  expect(p).toBe(join(folder, "inbox", "pa_ss.txt"));
  expect(readFileSync(p, "utf8")).toBe("hi");
});

test("saveInbound dedupes a colliding name", () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-files-"));
  const a = saveInbound(folder, "doc.pdf", new Uint8Array([1]));
  const b = saveInbound(folder, "doc.pdf", new Uint8Array([2]));
  expect(a).toBe(join(folder, "inbox", "doc.pdf"));
  expect(b).toBe(join(folder, "inbox", "doc-2.pdf"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/files.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** — create `src/engine/files.ts`:

```ts
// Inbound files: the operator attaches a file in a channel; the engine saves it into the
// target project's inbox/ so the worker can Read it. Name is sanitized (no path traversal)
// and de-duplicated. Pure filesystem helper — tested directly, no channel.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

/** Save `bytes` to `<folder>/inbox/<sanitized filename>`, deduping collisions. Returns the path. */
export function saveInbound(folder: string, filename: string, bytes: Uint8Array): string {
  const safe = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  const dir = join(folder, "inbox");
  mkdirSync(dir, { recursive: true });
  let target = join(dir, safe);
  if (existsSync(target)) {
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    for (let i = 2; existsSync(target); i++) target = join(dir, `${stem}-${i}${ext}`);
  }
  writeFileSync(target, bytes);
  return target;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/files.ts tests/files.test.ts
git commit -m "feat(neo): saveInbound helper for operator file uploads" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Outbound `send_file` tool + `neoMcpServers` + pipeline wiring

**Files:**
- Modify: `src/engine/dispatch.ts` — add `sendProjectFile`, `neoMcpServers` (replacing `dispatchMcpServers`), add `sendFile?` to `DispatchDeps`
- Modify: `src/engine/pipeline.ts` — `PipelineDeps.sendFile?`, `runConfigFor`, and the new-order `startSession` call (add mcpServers)
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // dispatch.ts
  export async function sendProjectFile(
    deps: { sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void> },
    chatId: number, folder: string, path: string, caption?: string,
  ): Promise<string>;
  export function neoMcpServers(
    deps: DispatchDeps, chatId: number, opts: { dispatch: boolean; folder: string },
  ): Record<string, unknown>;
  // pipeline.ts (PipelineDeps)
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
  ```

- [ ] **Step 1: Write the failing test** — append to `tests/dispatch.test.ts`:

```ts
import { sendProjectFile } from "../src/engine/dispatch";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("sendProjectFile sends a file inside the folder and refuses one outside it", async () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-send-"));
  writeFileSync(join(folder, "report.txt"), "ok");
  const sent: Array<{ path: string; caption?: string }> = [];
  const deps = { sendFile: (_c: number, path: string, caption?: string) => void sent.push({ path, caption }) };

  const ok = await sendProjectFile(deps, 1, folder, "report.txt", "here");
  expect(ok).toContain("sent");
  expect(sent[0].path).toBe(join(folder, "report.txt"));

  const bad = await sendProjectFile(deps, 1, folder, "../escape.txt");
  expect(bad).toContain("outside");
  expect(sent.length).toBe(1); // not sent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/dispatch.test.ts -t "sendProjectFile"`
Expected: FAIL — `sendProjectFile` not exported.

- [ ] **Step 3: Write `sendProjectFile` and the consolidated MCP builder**

In `src/engine/dispatch.ts`, add imports:

```ts
import { resolve, sep } from "node:path";
```

Add `sendFile?` to `DispatchDeps`:

```ts
  /** Deliver a worker-produced file back to the operator's channel (Telegram/web). */
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
```

Add the path-confined sender:

```ts
/** Send a file the worker produced, but only if `path` is inside `folder`. Returns a status string. */
export async function sendProjectFile(
  deps: { sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void> },
  chatId: number,
  folder: string,
  path: string,
  caption?: string,
): Promise<string> {
  const root = resolve(folder);
  const abs = resolve(folder, path);
  if (abs !== root && !abs.startsWith(root + sep)) return `refused: ${path} is outside the project folder`;
  if (!existsSync(abs)) return `not found: ${path}`;
  await deps.sendFile?.(chatId, abs, caption);
  return `sent ${path}`;
}
```

Replace `dispatchMcpServers` with `neoMcpServers` (keep `dispatch` as a tool inside it, conditional):

```ts
/** Build the project's in-process MCP tools: `send_file` always; `dispatch` only for the company. */
export function neoMcpServers(
  deps: DispatchDeps,
  replyChat: number,
  opts: { dispatch: boolean; folder: string },
): Record<string, unknown> {
  const tools = [
    tool(
      "send_file",
      "Send a file you produced in THIS project back to the operator (Telegram/web). `path` must be inside the project folder.",
      {
        path: z.string().describe("path to the file to send, inside the project folder"),
        caption: z.string().optional().describe("optional caption / note"),
      },
      async (args: { path: string; caption?: string }) => {
        const out = await sendProjectFile(deps, replyChat, opts.folder, args.path, args.caption);
        return { content: [{ type: "text" as const, text: out }] };
      },
    ),
  ];
  if (opts.dispatch) {
    tools.push(
      tool(
        "dispatch",
        "Open one of the operator's projects and run a self-contained task in it, then return its result. Use this for any order that belongs to a specific project (e.g. eticket-v3, gold). The target project does NOT see the operator's original message — only your `task` brief — so write `task` as a clear, complete prompt.",
        {
          project: z.string().describe('project folder name under /home, e.g. "eticket-v3"'),
          task: z.string().describe("a clear, self-contained brief/prompt for that project to execute"),
        },
        async (args: { project: string; task: string }) => {
          const out = await dispatchToProject(args.project, args.task, deps, replyChat);
          return { content: [{ type: "text" as const, text: out }] };
        },
      ),
    );
  }
  const server = createSdkMcpServer({ name: "neo", version: "1.0.0", tools });
  return { neo: server };
}
```

- [ ] **Step 4: Wire `neoMcpServers` into the pipeline**

In `src/engine/pipeline.ts`:
- Update the import: `import { neoMcpServers } from "./dispatch";` (replace `dispatchMcpServers`).
- Add to `PipelineDeps` (after `usage?`):

```ts
  /** Deliver a worker-produced file back to the channel (the `send_file` tool calls this). */
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
```

- Replace `runConfigFor` so EVERY project gets `send_file` (and the company also gets `dispatch` + low effort):

```ts
function runConfigFor(
  id: string,
  registry: Registry,
  deps: PipelineDeps,
  chatId: number,
  sdkSessionId: string,
): RunDeps {
  const folder = registry.get(id)?.order.folder ?? "/";
  const isCompany = registry.getDefault()?.id === id;
  const base: RunDeps = {
    resume: sdkSessionId || undefined,
    mcpServers: neoMcpServers(deps, chatId, { dispatch: isCompany, folder }),
  };
  return isCompany ? { ...base, effort: "low" } : base;
}
```

- In the NEW-order path (step 6), attach `send_file` too. Replace the final return of `handleMessage`:

```ts
  const session = registry.add(parsed, now());
  return startSession(parsed, session.id, chatId, deps, now, start, {
    resume: resume || undefined,
    mcpServers: neoMcpServers(deps, chatId, { dispatch: false, folder: parsed.folder }),
  });
```

- [ ] **Step 5: Run checks**

Run: `bunx tsc --noEmit && bun test tests/dispatch.test.ts tests/pipeline.test.ts`
Expected: tsc clean; PASS. (If any file still imports `dispatchMcpServers`, grep and update: `grep -rn dispatchMcpServers src tests`.)

- [ ] **Step 6: Commit**

```bash
git add src/engine/dispatch.ts src/engine/pipeline.ts tests/dispatch.test.ts
git commit -m "feat(neo): send_file tool (path-confined) for every project" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Telegram file transfer (inbound + outbound)

This is I/O glue (matching `telegram.ts`'s "verified at the daemon e2e step" convention) — no unit test; verified by `tsc` + a manual run.

**Files:**
- Modify: `src/frontends/telegram.ts`
- Verify: `bunx tsc --noEmit` + manual.

**Interfaces:**
- Consumes: `saveInbound` (Task 10), `PipelineDeps.sendFile` (Task 11), `registry.findByChat`/`getDefault`.

- [ ] **Step 1: Add imports** to `src/frontends/telegram.ts`:

```ts
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { basename } from "node:path";
import { saveInbound } from "../engine/files";
```

- [ ] **Step 2: Provide `sendFile` to the pipeline deps**

In the `handleMessage(...)` deps object, add:

```ts
      sendFile: (cid, path, caption) =>
        void bot.api.sendDocument(cid, new InputFile(path), caption ? { caption } : {}),
```

- [ ] **Step 3: Add a download helper** (top-level in the file):

```ts
async function downloadTelegramFile(token: string, filePath: string): Promise<Uint8Array> {
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  return new Uint8Array(await r.arrayBuffer());
}
```

- [ ] **Step 4: Handle inbound documents and photos** (add after the `message:text` handler, inside `startTelegram`):

```ts
  async function intakeFile(ctx: any, name: string, captionText: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!isOperator(userId)) return;
    const chatId = ctx.chat.id;
    const target = registry.findByChat(chatId) ?? registry.getDefault();
    if (!target) {
      void bot.api.sendMessage(chatId, "No active project to receive the file.");
      return;
    }
    const file = await ctx.getFile();
    const bytes = await downloadTelegramFile(cfg.telegramToken, file.file_path!);
    const path = saveInbound(target.order.folder, name, bytes);
    await handleMessage(`📎 operator attached \`${name}\` at \`${path}\`\n${captionText}`, chatId, {
      cfg, ledger, registry, meter, usage, trust,
      reply: (cid, text, project) => void sendFormatted(bot, cid, text, project),
      askApproval: (cid, reason) =>
        new Promise<"allow" | "deny">((resolve) => {
          const token = crypto.randomUUID();
          pending.set(token, resolve);
          const kb = new InlineKeyboard().text("Allow", `a:${token}`).text("Deny", `d:${token}`);
          void bot.api.sendMessage(cid, `⚠️ Approve this action?\n${reason}`, { reply_markup: kb });
        }),
      sendFile: (cid, p, caption) => void bot.api.sendDocument(cid, new InputFile(p), caption ? { caption } : {}),
    });
  }

  bot.on("message:document", (ctx) =>
    intakeFile(ctx, ctx.message.document.file_name ?? `file-${ctx.message.document.file_unique_id}`, ctx.message.caption ?? ""),
  );
  bot.on("message:photo", (ctx) => {
    const photo = ctx.message.photo.at(-1)!; // largest size
    return intakeFile(ctx, `photo-${photo.file_unique_id}.jpg`, ctx.message.caption ?? "");
  });
```

> The `intakeFile` reply/askApproval/sendFile block intentionally mirrors the `message:text` handler's deps. If you prefer DRY, extract a `pipelineDeps(bot)` factory and call it from both — optional, not required.

- [ ] **Step 5: Verify**

Run: `bunx tsc --noEmit`
Expected: clean.

Manual (requires `TELEGRAM_TOKEN`): send a PDF to the bot → confirm it lands in `<active-folder>/inbox/`; have a worker call `send_file` → confirm the document arrives in the chat.

- [ ] **Step 6: Commit**

```bash
git add src/frontends/telegram.ts
git commit -m "feat(neo): Telegram file transfer (document/photo in, send_file out)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Web file transfer (inbound + outbound)

**Files:**
- Modify: `src/engine/web-channel.ts` — `file` event, `sendFile` wiring on the pipeline deps, `getFile(token)`
- Modify: `src/frontends/web.ts` — `POST /upload`, `GET /file`, composer 📎 button, file-chip rendering
- Test: `tests/web-channel.test.ts`

**Interfaces:**
- Produces (on `WebChannel`): `getFile(token: string): string | undefined`. New `WebEvent` `{ type:"file"; name:string; url:string; project?:string }`. `PipelineDeps.sendFile` for the web forwards to an internal emitter.

- [ ] **Step 1: Write the failing test** — append to `tests/web-channel.test.ts` (reuses the existing `fakeStart` + `engine` helpers at the top of the file):

```ts
test("sendFile emits a file event and registers a token getFile can resolve", () => {
  const f = fakeStart();
  const ch = createWebChannel({ engine: engine(f.start), chatId: 0 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  const token = ch._testSendFile("/tmp/report.pdf", "done"); // test seam added in Step 3

  const fileEvent = events.find((e) => e.type === "file") as { type: "file"; name: string; url: string };
  expect(fileEvent.name).toBe("report.pdf");
  expect(fileEvent.url).toContain(encodeURIComponent(token));
  expect(ch.getFile(token)).toBe("/tmp/report.pdf");
});
```

> `_testSendFile` is a small public seam (added in Step 3) that exercises the same `deliverFile()` the engine's `send_file` tool reaches via `PipelineDeps.sendFile` — it keeps this a fast unit test instead of standing up a full SDK round-trip. `engine()` already includes `trust` after Task 8.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/web-channel.test.ts -t "sendFile emits"`
Expected: FAIL — `getFile`/`_testSendFile` do not exist.

- [ ] **Step 3: Implement in `src/engine/web-channel.ts`**

Add the import:

```ts
import { basename } from "node:path";
```

Extend `WebEvent`:

```ts
export type WebEvent =
  | { type: "message"; text: string; project?: string }
  | { type: "escalation"; id: string; reason: string }
  | { type: "projects"; text: string; items: SelectableProject[] }
  | { type: "loops"; items: LoopInfo[] }
  | { type: "file"; name: string; url: string; project?: string };
```

Add to the `WebChannel` interface:

```ts
  /** Resolve a token issued by an outbound file event to its on-disk path (for GET /file). */
  getFile(token: string): string | undefined;
  /** Test/seam hook: deliver a file as if a worker called send_file. Returns the token. */
  _testSendFile(path: string, caption?: string): string;
```

Inside `createWebChannel`, add the registry + the pipeline `sendFile`, and the returned methods:

```ts
  const files = new Map<string, string>(); // token -> absolute path

  function deliverFile(path: string, caption?: string): string {
    const token = crypto.randomUUID();
    files.set(token, path);
    emit({ type: "file", name: basename(path), url: `/file?token=${encodeURIComponent(token)}` });
    if (caption) message(caption);
    return token;
  }
```

Add `sendFile` to the `deps: PipelineDeps` object:

```ts
    sendFile: (_chatId, path, caption) => void deliverFile(path, caption),
```

Add to the returned object:

```ts
    getFile: (token) => files.get(token),
    _testSendFile: (path, caption) => deliverFile(path, caption),
```

- [ ] **Step 4: Run channel tests**

Run: `bun test tests/web-channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the web routes (glue, `tsc`-verified)** in `src/frontends/web.ts`

Add the imports:

```ts
import { saveInbound } from "../engine/files";
import { basename } from "node:path";
```

Add `POST /upload` (after the `/msg` route, inside the session-gated section):

```ts
    if (req.method === "POST" && path === "/upload") {
      const form = await req.formData().catch(() => null);
      const f = form?.get("file");
      if (!(f instanceof File)) return Response.json({ ok: false }, { status: 400 });
      const target = deps.engine.registry.findByChat(WEB_CHAT_ID) ?? deps.engine.registry.getDefault();
      if (!target) return Response.json({ ok: false, error: "no active project" }, { status: 409 });
      const bytes = new Uint8Array(await f.arrayBuffer());
      const saved = saveInbound(target.order.folder, f.name || "file", bytes);
      const caption = typeof form?.get("caption") === "string" ? (form.get("caption") as string) : "";
      void channel.send(`📎 operator attached \`${basename(saved)}\` at \`${saved}\`\n${caption}`);
      return Response.json({ ok: true });
    }
```

Add `GET /file` (serves an outbound file by token):

```ts
    if (req.method === "GET" && path === "/file") {
      const token = url.searchParams.get("token") ?? "";
      const abs = channel.getFile(token);
      if (!abs) return new Response("not found", { status: 404 });
      return new Response(Bun.file(abs), {
        headers: { "content-disposition": `attachment; filename="${basename(abs)}"`, "cache-control": "no-store" },
      });
    }
```

- [ ] **Step 6: Add the UI bits** in `consolePage()` (the embedded HTML/JS in `web.ts`)

- Add a 📎 file input near the message composer, e.g.:

```html
<input type="file" id="file" style="display:none" onchange="uploadFile()">
<button class="chip" onclick="document.getElementById('file').click()">📎</button>
```

- Add the upload function (in the page `<script>`):

```js
function uploadFile(){var i=document.getElementById('file');if(!i.files.length)return;var fd=new FormData();fd.append('file',i.files[0]);fetch('/upload',{method:'POST',body:fd});i.value='';}
```

- Render the `file` SSE event as a download chip (in the SSE `onmessage`/event switch alongside `escalation`):

```js
else if(e.type==='file'){var d=document.createElement('div');d.className='row out';d.innerHTML='📎 <a href="'+e.url+'">'+esc(e.name)+'</a>';pushFeed(d,'out',e.project);}
```

> Match the exact place the existing code dispatches on `e.type` (search `e.type==='escalation'` near line 419). Reuse the page's `esc()` and `pushFeed()` helpers (they exist).

- [ ] **Step 7: Verify**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc clean; all tests PASS.

Manual (needs the daemon + a login): drag/select a file in the console → confirm it lands in `<active-folder>/inbox/` and a 📎 line appears; have a worker call `send_file` → confirm a download chip appears and downloads the file.

- [ ] **Step 8: Commit**

```bash
git add src/engine/web-channel.ts src/frontends/web.ts tests/web-channel.test.ts
git commit -m "feat(neo): web console file transfer (upload in, download out)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run `bunx tsc --noEmit` — clean.
- [ ] Run `bun test` — all green (expect the new tests across idle, commands, config, pipeline, trust, ledger, session-runner, files, dispatch, web-channel).
- [ ] Smoke the daemon (if `TELEGRAM_TOKEN` is set): `bun run src/daemon.ts` and confirm the startup log shows `idle -> close normal projects after 24h … (company exempt)`.

## Self-review notes (coverage map)

- Spec Part 1 → Tasks 1, 2.
- Spec Part 2 → Tasks 3, 4.
- Spec Part 3 (store/enforcement/audit/command/threading) → Tasks 5, 6, 7, 8, 9.
- Spec Part 4 (inbound/outbound, both frontends) → Tasks 10, 11, 12, 13.
- Firewall untouched: no task edits `provider-router.ts`. ✔
- Customer work never trusted: trust is keyed by folder and only wired on `source:"neo"` pipeline/dispatch paths; `runCompanyBrief`/ingress keep `askApproval: async () => "deny"` and pass no trust auto-approve. ✔
