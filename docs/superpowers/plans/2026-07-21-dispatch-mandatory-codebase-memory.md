# Mandatory codebase-memory + engine-guaranteed index — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dispatch preamble require codebase-memory + superpowers, and have the engine index the target folder before a worker starts (subagents can't self-index — the governor denies them the index tools).

**Architecture:** A new engine module `codebase-memory.ts` speaks newline-delimited JSON-RPC to the codebase-memory MCP binary (thin, untested IO adapter) under a tested `makeIndexer` orchestration with a process-lifetime known-indexed cache. Dispatch calls `ensureIndexed(folder)` (best-effort) just before starting the worker. The preamble is rewritten to state codebase-memory-first + superpowers as REQUIRED.

**Tech Stack:** Bun + TypeScript; `Bun.spawn` (as in `goal.ts`); `bun test`; `bunx tsc --noEmit`.

## Global Constraints

- Engine stays AI-free — this is a deterministic MCP client, no model calls.
- Best-effort: indexing failures NEVER block a dispatch (fail open, log, proceed).
- Keep the common path cheap: an already-indexed folder costs at most one `list_projects` call, then a cached no-op.
- TDD: failing test first. `bunx tsc --noEmit` + `bun test` green before each commit. Commit per task.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Do NOT push or deploy. Work on `master`.

---

### Task 1: Config knob `codebaseMemoryIndexTimeoutMs`

**Files:**
- Modify: `src/config.ts` (interface `NeoConfig`, `DEFAULTS`, return object)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `NeoConfig.codebaseMemoryIndexTimeoutMs: number` (default 300_000).

- [ ] **Step 1: Failing tests** — append to `tests/config.test.ts`:

```ts
test("codebaseMemoryIndexTimeoutMs defaults to 5m", () => {
  expect(loadConfig(dir()).codebaseMemoryIndexTimeoutMs).toBe(5 * 60 * 1000);
});

test("config.json overrides codebaseMemoryIndexTimeoutMs", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ codebaseMemoryIndexTimeoutMs: 1000 }));
  expect(loadConfig(d).codebaseMemoryIndexTimeoutMs).toBe(1000);
});
```

- [ ] **Step 2: Run — expect FAIL** `bun test tests/config.test.ts` → property is `undefined`.

- [ ] **Step 3: Implement.** In `src/config.ts` add to the `NeoConfig` interface (near `codebaseMemoryBin`):

```ts
  /** Bounded wait (ms) for an engine-side codebase-memory index_repository before a dispatch
   *  proceeds anyway (best-effort). Default 5 min. */
  codebaseMemoryIndexTimeoutMs: number;
```

Add to `DEFAULTS` (near the dispatch timeouts):

```ts
  codebaseMemoryIndexTimeoutMs: 5 * 60 * 1000,
```

Add to the returned object (near `codebaseMemoryBin`):

```ts
    codebaseMemoryIndexTimeoutMs: fileCfg.codebaseMemoryIndexTimeoutMs ?? DEFAULTS.codebaseMemoryIndexTimeoutMs,
```

- [ ] **Step 4: Run — expect PASS** `bun test tests/config.test.ts` and `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "config: add codebaseMemoryIndexTimeoutMs (bounded engine-side index wait)"
```

---

### Task 2: `codebase-memory.ts` — client + indexer

**Files:**
- Create: `src/engine/codebase-memory.ts`
- Test: `tests/codebase-memory.test.ts`

**Interfaces:**
- Consumes: `NeoConfig` (Task 1).
- Produces:
  - `interface CmProject { name: string; root_path: string }`
  - `interface CodebaseMemoryClient { listProjects(): Promise<CmProject[]>; indexRepository(repoPath: string): Promise<void> }`
  - `interface CodebaseMemoryIndexer { ensureIndexed(folder: string, onFirstIndex?: () => void | Promise<void>): Promise<void> }`
  - `function makeIndexer(client: CodebaseMemoryClient, opts?: { log?: (m: string) => void }): CodebaseMemoryIndexer`
  - `function stdioCodebaseMemoryClient(bin: string, opts?: { listTimeoutMs?: number; indexTimeoutMs?: number }): CodebaseMemoryClient`
  - `function sharedCodebaseMemoryIndexer(cfg: NeoConfig): CodebaseMemoryIndexer | undefined`

- [ ] **Step 1: Failing tests** — create `tests/codebase-memory.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeIndexer, type CodebaseMemoryClient, type CmProject } from "../src/engine/codebase-memory";

function mockClient(projects: CmProject[], opts: { failList?: boolean; failIndex?: boolean } = {}) {
  const calls = { list: 0, index: [] as string[] };
  const client: CodebaseMemoryClient = {
    async listProjects() {
      calls.list++;
      if (opts.failList) throw new Error("list boom");
      return projects;
    },
    async indexRepository(p) {
      calls.index.push(p);
      if (opts.failIndex) throw new Error("index boom");
    },
  };
  return { client, calls };
}

test("already-indexed folder: no index, no onFirstIndex, list once, then cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([{ name: "p", root_path: dir }]);
  const ix = makeIndexer(client);
  let fired = 0;
  await ix.ensureIndexed(dir, () => void fired++);
  await ix.ensureIndexed(dir, () => void fired++); // second call must be a cached no-op
  expect(calls.index.length).toBe(0);
  expect(fired).toBe(0);
  expect(calls.list).toBe(1); // cache hit on the second call → no extra list_projects
});

test("missing folder: indexRepository once + onFirstIndex once + cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([{ name: "other", root_path: "/somewhere/else" }]);
  const ix = makeIndexer(client);
  let fired = 0;
  await ix.ensureIndexed(dir, () => void fired++);
  await ix.ensureIndexed(dir, () => void fired++); // cached now
  expect(calls.index).toEqual([dir]);
  expect(fired).toBe(1);
  expect(calls.list).toBe(1);
});

test("listProjects failure: resolves (no throw), not cached (retries next time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([], { failList: true });
  const ix = makeIndexer(client);
  await ix.ensureIndexed(dir); // must not throw
  await ix.ensureIndexed(dir);
  expect(calls.list).toBe(2); // not cached → tried again
  expect(calls.index.length).toBe(0);
});

test("indexRepository failure: resolves (no throw), not cached (retries next time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([], { failIndex: true });
  const ix = makeIndexer(client);
  await ix.ensureIndexed(dir); // must not throw
  await ix.ensureIndexed(dir);
  expect(calls.index).toEqual([dir, dir]); // retried
});

test("matching is trailing-slash insensitive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([{ name: "p", root_path: dir + "/" }]);
  const ix = makeIndexer(client);
  await ix.ensureIndexed(dir);
  expect(calls.index.length).toBe(0); // dir and dir+"/" canonicalise equal
});
```

- [ ] **Step 2: Run — expect FAIL** `bun test tests/codebase-memory.test.ts` → module not found.

- [ ] **Step 3: Implement** — create `src/engine/codebase-memory.ts`:

```ts
// The engine's own tiny client for the codebase-memory MCP server + the "ensure indexed" guard
// dispatch runs before a worker starts. The engine has no AI, but it CAN speak MCP: the governor
// denies subagents index_repository/list_projects, so a dispatched worker can never self-index —
// the main/engine side must guarantee the index. Two layers: a thin stdio JSON-RPC adapter (real
// IO, not unit-tested) and makeIndexer (the tested orchestration + a process-lifetime "already
// indexed" cache). Spec: docs/superpowers/specs/2026-07-21-dispatch-mandatory-codebase-memory-design.md
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { NeoConfig } from "../config";

/** A project as codebase-memory's list_projects reports it (only the fields we match on). */
export interface CmProject {
  name: string;
  root_path: string;
}

/** The low-level calls the indexer needs — injectable so the orchestration is testable without a
 *  live MCP server. */
export interface CodebaseMemoryClient {
  listProjects(): Promise<CmProject[]>;
  indexRepository(repoPath: string): Promise<void>;
}

/** What dispatch depends on: ensure `folder` is indexed before the worker runs. */
export interface CodebaseMemoryIndexer {
  /** Resolves once `folder` is known-indexed (indexing it first if missing). Best-effort: NEVER
   *  throws — on any failure it logs and resolves, so a dispatch is never blocked by indexing.
   *  `onFirstIndex` fires only when THIS call triggers a fresh index (dispatch uses it for the
   *  operator "indexing…" line). */
  ensureIndexed(folder: string, onFirstIndex?: () => void | Promise<void>): Promise<void>;
}

/** Newline-delimited JSON-RPC 2.0 op timeouts. */
export const CM_LIST_TIMEOUT_MS_DEFAULT = 15_000;
export const CM_INDEX_TIMEOUT_MS_DEFAULT = 300_000;

/** Canonicalise a folder path for comparison/caching (symlink- and trailing-slash-insensitive). */
function canonical(folder: string): string {
  try {
    return realpathSync(resolve(folder));
  } catch {
    return resolve(folder);
  }
}

/** The tested core: check the folder against codebase-memory and index it if missing, with a
 *  process-lifetime cache of known-indexed folders so the common path is a no-op. */
export function makeIndexer(
  client: CodebaseMemoryClient,
  opts: { log?: (msg: string) => void } = {},
): CodebaseMemoryIndexer {
  const log = opts.log ?? (() => {});
  const known = new Set<string>();
  return {
    async ensureIndexed(folder, onFirstIndex) {
      const path = canonical(folder);
      if (known.has(path)) return; // cheap common path: already confirmed this process
      try {
        const projects = await client.listProjects();
        if (projects.some((p) => canonical(p.root_path) === path)) {
          known.add(path);
          return;
        }
        // Missing → index it (the whole point: the worker can't do this itself).
        if (onFirstIndex) await onFirstIndex();
        log(`codebase-memory: indexing ${path}`);
        await client.indexRepository(path);
        known.add(path);
        log(`codebase-memory: indexed ${path}`);
      } catch (e) {
        // Best-effort: indexing must never block a dispatch. Leave `path` uncached so a later
        // dispatch retries; the worker meanwhile falls back to reading files.
        const msg = e instanceof Error ? e.message : String(e);
        log(`codebase-memory: ensureIndexed(${path}) failed — proceeding without index: ${msg}`);
      }
    },
  };
}

/** One MCP tools/call over a freshly-spawned stdio server: initialize → initialized → call →
 *  parse result.content[0].text → kill. Rejects on JSON-RPC error, tool isError, bad JSON, or
 *  timeout. */
async function callTool(
  bin: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  const proc = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const send = (obj: unknown) => {
    proc.stdin.write(JSON.stringify(obj) + "\n");
    proc.stdin.flush();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waitFor = async (id: number): Promise<any> => {
    for (;;) {
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === id) return msg;
          } catch {
            /* skip non-JSON log lines the server may print */
          }
        }
        nl = buf.indexOf("\n");
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(timedOut ? `timed out after ${timeoutMs}ms` : "stream closed before response");
      buf += dec.decode(value, { stream: true });
    }
  };
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "neo-engine", version: "1.0.0" } },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    const res = await waitFor(2);
    if (res.error) throw new Error(res.error?.message ?? "mcp error");
    if (res.result?.isError) throw new Error(res.result?.content?.[0]?.text ?? "tool error");
    return res.result?.content?.[0]?.text ?? "";
  } finally {
    clearTimeout(timer);
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Real stdio MCP client for the codebase-memory binary. Thin IO adapter (not unit-tested; the
 *  orchestration in makeIndexer is). */
export function stdioCodebaseMemoryClient(
  bin: string,
  opts: { listTimeoutMs?: number; indexTimeoutMs?: number } = {},
): CodebaseMemoryClient {
  const listTimeoutMs = opts.listTimeoutMs ?? CM_LIST_TIMEOUT_MS_DEFAULT;
  const indexTimeoutMs = opts.indexTimeoutMs ?? CM_INDEX_TIMEOUT_MS_DEFAULT;
  return {
    async listProjects() {
      const text = await callTool(bin, "list_projects", {}, listTimeoutMs);
      const parsed = JSON.parse(text) as { projects?: CmProject[] };
      return parsed.projects ?? [];
    },
    async indexRepository(repoPath) {
      await callTool(bin, "index_repository", { repo_path: repoPath }, indexTimeoutMs);
    },
  };
}

/** Process-lifetime indexer for the configured binary, memoised by bin so its known-indexed cache
 *  is shared across every dispatch. Returns undefined when no binary is configured → dispatch skips
 *  the step (matching the worker, which also gets no codebase-memory MCP in that case). */
const sharedByBin = new Map<string, CodebaseMemoryIndexer>();
export function sharedCodebaseMemoryIndexer(cfg: NeoConfig): CodebaseMemoryIndexer | undefined {
  const bin = cfg.codebaseMemoryBin;
  if (!bin) return undefined;
  let ix = sharedByBin.get(bin);
  if (!ix) {
    ix = makeIndexer(stdioCodebaseMemoryClient(bin, { indexTimeoutMs: cfg.codebaseMemoryIndexTimeoutMs }), {
      log: (m) => console.log(`  ${m}`),
    });
    sharedByBin.set(bin, ix);
  }
  return ix;
}
```

- [ ] **Step 4: Run — expect PASS** `bun test tests/codebase-memory.test.ts` and `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/engine/codebase-memory.ts tests/codebase-memory.test.ts
git commit -m "feat(codebase-memory): engine-side MCP client + ensure-indexed guard"
```

---

### Task 3: Preamble rewrite (MANDATORY)

**Files:**
- Modify: `src/engine/dispatch.ts` (`briefWithProjectDocs`, ~line 106, + its doc comment ~line 100)
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- Produces: unchanged signature `briefWithProjectDocs(task: string): string`.

- [ ] **Step 1: Failing test** — add to `tests/dispatch.test.ts`:

```ts
test("briefWithProjectDocs requires codebase-memory + superpowers and states the engine indexed it", () => {
  const brief = briefWithProjectDocs("do the thing");
  expect(brief).toContain("REQUIRED");
  expect(brief).toContain("codebase-memory");
  expect(brief.toLowerCase()).toContain("already indexed");
  expect(brief).toContain("superpowers");
  expect(brief).toContain("do the thing");
});
```

- [ ] **Step 2: Run — expect FAIL** `bun test tests/dispatch.test.ts -t "requires codebase-memory"` (old text has no "REQUIRED"/"already indexed").

- [ ] **Step 3: Implement.** Replace the `briefWithProjectDocs` body in `src/engine/dispatch.ts` with:

```ts
export function briefWithProjectDocs(task: string): string {
  return (
    "Before starting, read this project's rule and doc .md files so you work by its rules: " +
    "AGENTS.md, DESIGN.md, and any other root-level .md files (besides CLAUDE.md, already loaded), " +
    "plus the docs relevant to this task (e.g. under docs/). Follow them together with CLAUDE.md.\n\n" +
    "REQUIRED — use the `codebase-memory` MCP FIRST. The engine has already indexed this project for " +
    "you, so the structural map is ready to query. Start every investigation there: get_architecture " +
    "for the module layout, then search_code / query_graph to find the code that matters. Read source " +
    "files directly ONLY for what the map doesn't cover — never as your default way in.\n\n" +
    "REQUIRED — use the superpowers skills for the shape of work at hand: brainstorming → " +
    "writing-plans for design, systematic-debugging to root-cause any bug, and test-driven-development " +
    "for implementation (write the failing test first).\n\n" +
    task
  );
}
```

Also update the doc comment above it (~lines 100-105) so it reads: codebase-memory is REQUIRED and the engine guarantees the index (see `ensureIndexed`), rather than "if indexed".

- [ ] **Step 4: Run — expect PASS** `bun test tests/dispatch.test.ts` and `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/engine/dispatch.ts tests/dispatch.test.ts
git commit -m "feat(dispatch): make codebase-memory + superpowers MANDATORY in the preamble"
```

---

### Task 4: Auto-index before the worker starts

**Files:**
- Modify: `src/engine/dispatch.ts` (import type; `DispatchDeps`; the background block before `start`)
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- Consumes: `CodebaseMemoryIndexer` (Task 2).
- Produces: `DispatchDeps.codebaseMemory?: CodebaseMemoryIndexer`.

- [ ] **Step 1: Failing tests** — add to `tests/dispatch.test.ts`:

```ts
test("dispatch indexes the folder (and emits the operator line) BEFORE starting the worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const events: string[] = [];
  const codebaseMemory = {
    ensureIndexed: async (folder: string, onFirstIndex?: () => void | Promise<void>) => {
      events.push("index:" + folder);
      if (onFirstIndex) await onFirstIndex();
    },
  };
  const fakeStart = () => {
    events.push("start");
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  const replies: string[] = [];
  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, codebaseMemory, reply: (_c, t) => void replies.push(t) },
    1,
    { start: fakeStart as never, now: () => 0, root },
  );
  await new Promise((r) => setTimeout(r, 0)); // let the background continuation run
  expect(events).toEqual(["index:" + join(root, "eticket-v3"), "start"]);
  expect(replies.some((t) => t.includes("indexing") && t.includes("codebase-memory"))).toBe(true);
});

test("dispatch still starts the worker when ensureIndexed throws (best-effort)", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let started = false;
  const codebaseMemory = { ensureIndexed: async () => { throw new Error("cm down"); } };
  const fakeStart = () => {
    started = true;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "task", { ...d, codebaseMemory }, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(started).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL** `bun test tests/dispatch.test.ts -t "indexes the folder"` (no such deps field / call yet).

- [ ] **Step 3: Implement.** In `src/engine/dispatch.ts`:

Add the import (top, near the other engine imports):
```ts
import type { CodebaseMemoryIndexer } from "./codebase-memory";
```

Add to the `DispatchDeps` interface:
```ts
  /** Ensure the target folder is indexed in codebase-memory BEFORE the worker starts (engine side;
   *  the governor denies subagents the index tools, so the worker can't self-index). Best-effort —
   *  a failure here never blocks the dispatch. Absent → the step is skipped. */
  codebaseMemory?: CodebaseMemoryIndexer;
```

In `dispatchToProject`, inside the `void (async () => { … })()` block, place this **after** the context-policy `try/catch` block ends and **before** `const startedAt = now();` (so a first-time index doesn't eat the dispatch ceiling):
```ts
    // Guarantee the structural map the brief now REQUIRES: the worker can't self-index (the governor
    // denies subagents the codebase-memory index tools), so the engine does it here before the worker
    // starts. Best-effort — a failure never blocks the dispatch; the worker falls back to file reads.
    if (deps.codebaseMemory) {
      try {
        await deps.codebaseMemory.ensureIndexed(folder, () =>
          deps.reply(replyChat, `indexing ${name} into codebase-memory…`, name),
        );
      } catch {
        // ensureIndexed is itself best-effort; this guard belts-and-braces the dispatch path.
      }
    }
```

- [ ] **Step 4: Run — expect PASS** `bun test tests/dispatch.test.ts` and `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/engine/dispatch.ts tests/dispatch.test.ts
git commit -m "feat(dispatch): index the target folder before the worker starts"
```

---

### Task 5: Wire the shared indexer into production

**Files:**
- Modify: `src/engine/pipeline.ts` (`PipelineDeps` gains `codebaseMemory?`)
- Modify: `src/frontends/telegram.ts` (`pipelineDeps()` factory)
- Modify: `src/engine/web-channel.ts` (`deps` object)

**Interfaces:**
- Consumes: `sharedCodebaseMemoryIndexer(cfg)` (Task 2), `CodebaseMemoryIndexer` (Task 2). `PipelineDeps.codebaseMemory` is spread into the `dispatch` tool's `DispatchDeps` at the existing `neoMcpServers({ ...deps, … })` call sites — no change needed there.

- [ ] **Step 1: Implement (wiring — verified by the full suite + tsc, no new unit test).**

`src/engine/pipeline.ts` — import the type and add the field to `PipelineDeps`:
```ts
import type { CodebaseMemoryIndexer } from "./codebase-memory";
```
```ts
  /** Engine-side codebase-memory index guarantee, spread into the company `dispatch` tool's deps so
   *  a dispatched folder is indexed before its worker starts. */
  codebaseMemory?: CodebaseMemoryIndexer;
```

`src/frontends/telegram.ts` — import and set it in the `pipelineDeps()` factory (near `meter,`/`trust,`):
```ts
import { sharedCodebaseMemoryIndexer } from "../engine/codebase-memory";
```
```ts
    codebaseMemory: sharedCodebaseMemoryIndexer(cfg),
```

`src/engine/web-channel.ts` — import and set it in the `deps: PipelineDeps` object (near `trust: opts.engine.trust,`):
```ts
import { sharedCodebaseMemoryIndexer } from "./codebase-memory";
```
```ts
      codebaseMemory: sharedCodebaseMemoryIndexer(opts.engine.cfg),
```

- [ ] **Step 2: Run the full suite + typecheck.** `bunx tsc --noEmit` and `bun test` → all green.

- [ ] **Step 3: Commit**

```bash
git add src/engine/pipeline.ts src/frontends/telegram.ts src/engine/web-channel.ts
git commit -m "feat(dispatch): wire the shared codebase-memory indexer into telegram + web"
```

---

### Task 6: Docs sync

**Files:**
- Modify: `docs/CONFIG.md` (document `codebaseMemoryIndexTimeoutMs`)
- Modify: `CLAUDE.md` (one line under the dispatch-preamble status note)

- [ ] **Step 1:** Add a `codebaseMemoryIndexTimeoutMs` row/line to `docs/CONFIG.md` matching the format of the other dispatch timeouts. Add one sentence to the CLAUDE.md dispatch-preamble paragraph noting codebase-memory is now REQUIRED and the engine indexes the folder before dispatch.
- [ ] **Step 2:** `bunx tsc --noEmit` + `bun test` (still green — docs only).
- [ ] **Step 3: Commit**

```bash
git add docs/CONFIG.md CLAUDE.md
git commit -m "docs: sync CONFIG + CLAUDE for mandatory codebase-memory index"
```

---

## Self-Review

- **Spec coverage:** §1 preamble → Task 3; §2 client/indexer/cache/resilience/staleness → Task 2; §3 wiring (deps field, call-before-start, config, once-at-startup) → Tasks 1, 4, 5; docs → Task 6. All covered.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `CodebaseMemoryIndexer.ensureIndexed(folder, onFirstIndex?)` used identically in Tasks 2/4/5; `makeIndexer`/`stdioCodebaseMemoryClient`/`sharedCodebaseMemoryIndexer` signatures match across tasks; `codebaseMemoryIndexTimeoutMs` field name consistent in Tasks 1/2.
