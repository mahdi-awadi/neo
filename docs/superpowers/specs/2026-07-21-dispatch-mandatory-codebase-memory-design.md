# Dispatch: mandatory codebase-memory + engine-guaranteed index

**Date:** 2026-07-21
**Status:** approved (autonomous engine order)
**Module(s):** `src/engine/dispatch.ts`, new `src/engine/codebase-memory.ts`, `src/config.ts`, `src/engine/pipeline.ts` (wiring)

## Problem

Every dispatched brief is auto-prefixed by `briefWithProjectDocs` with a preamble that *suggests*
the worker query the `codebase-memory` MCP "before cold-reading files" — phrased conditionally
("if indexed, else read files"). Two gaps make the suggestion hollow:

1. **The worker often can't act on it.** codebase-memory's `index_repository` / `list_projects`
   are DENIED to subagents by the governor (verified: they work only from the main/company session).
   A dispatched worker landing on an *un-indexed* project cannot self-index — so "use codebase-memory
   first" is impossible for exactly the projects that need it most (a first-ever dispatch).
2. **The wording is soft.** codebase-memory and the superpowers skills read as optional, so workers
   fall back to cold-reading the whole tree (~10× the tokens, and slower — this is what trips the
   5-minute stall monitor on big repos).

## Goal

Make the two behaviours the operator wants *guaranteed*, not hoped for:

- **Preamble:** codebase-memory-first and superpowers are stated as REQUIRED, and the preamble tells
  the worker plainly that the engine has *already indexed this project* so the map is ready.
- **Engine guarantee:** before a worker starts, the engine (main side, where the index tools are
  allowed) ensures the target folder is indexed in codebase-memory — indexing it first if missing —
  so the "must use codebase-memory" instruction is always satisfiable.

Builds on the reply-routing fix just landed on master; touches none of it.

## Design

### 1. Preamble wording (`briefWithProjectDocs`) — MANDATORY

Rewrite the codebase-memory and superpowers paragraphs from conditional to required. Verbatim target:

```
Before starting, read this project's rule and doc .md files so you work by its rules: AGENTS.md,
DESIGN.md, and any other root-level .md files (besides CLAUDE.md, already loaded), plus the docs
relevant to this task (e.g. under docs/). Follow them together with CLAUDE.md.

REQUIRED — use the `codebase-memory` MCP FIRST. The engine has already indexed this project for you,
so the structural map is ready to query. Start every investigation there: get_architecture for the
module layout, then search_code / query_graph to find the code that matters. Read source files
directly ONLY for what the map doesn't cover — never as your default way in.

REQUIRED — use the superpowers skills for the shape of work at hand: brainstorming → writing-plans
for design, systematic-debugging to root-cause any bug, and test-driven-development for
implementation (write the failing test first).

<task>
```

No "if indexed, else read files" phrasing. The map's availability is stated as a fact, made true by (2).

### 2. Engine-side index guarantee (`src/engine/codebase-memory.ts`, new)

The deterministic engine (no AI) talks to the codebase-memory MCP over its own minimal stdio
JSON-RPC client. Two layers, so the *logic* is unit-testable without a live server:

**Low-level client (thin IO adapter, injectable):**
```ts
export interface CmProject { name: string; root_path: string }
export interface CodebaseMemoryClient {
  listProjects(): Promise<CmProject[]>;
  indexRepository(repoPath: string): Promise<void>;
}
export function stdioCodebaseMemoryClient(bin: string, opts?: {
  listTimeoutMs?: number; indexTimeoutMs?: number;
}): CodebaseMemoryClient;
```
`stdioCodebaseMemoryClient` spawns `bin` per call (`Bun.spawn`, as `goal.ts` does), speaks
newline-delimited JSON-RPC 2.0 — `initialize` → `notifications/initialized` → `tools/call` — reads
`result.content[0].text`, then kills the process. Fresh-process-per-call (not a long-lived
connection) because calls are rare (once per folder per process, then cached) and this avoids
crash-recovery/lifecycle bookkeeping in the daemon. Verified against the real binary
(protocol/handshake confirmed). Each op is bounded by a timeout; on timeout the process is killed and
the call rejects. This adapter is NOT unit-tested (it's pure IO); the orchestration below is.

**Orchestration (the tested unit):**
```ts
export interface CodebaseMemoryIndexer {
  ensureIndexed(folder: string, onFirstIndex?: () => void | Promise<void>): Promise<void>;
}
export function makeIndexer(client: CodebaseMemoryClient, opts?: {
  log?: (msg: string) => void;
}): CodebaseMemoryIndexer;
```
`ensureIndexed(folder, onFirstIndex)`:
1. Resolve `folder` to a canonical path (`realpathSync`, falling back to `resolve`).
2. **Cache hit** — if the canonical path is in the process-lifetime `Set` of known-indexed folders,
   return immediately (zero IO — keeps the common path free).
3. `listProjects()`; if any project's resolved `root_path` equals the canonical folder → add to
   cache, return (the cheap common path: one `list_projects` call).
4. **Missing** → fire `onFirstIndex?.()` (lets dispatch emit the operator line), then
   `await client.indexRepository(folder)`; on success → add to cache.
5. **Resilience:** the whole body is wrapped so it NEVER throws. Any failure (bin absent, spawn
   error, MCP error, timeout) → `log` + return; the folder is NOT cached (so a later dispatch
   retries). The worker then simply falls back to file reading.

**Staleness — out of scope, deliberately.** Presence in `list_projects` counts as indexed; we do NOT
re-index a project that's already there. Detecting drift against the working tree needs a full
`detect_changes` re-scan, which contradicts the operator's cheapness mandate ("already-indexed
projects should add negligible latency — a single list/status call") and would re-index 100k-node
repos on every dispatch. Drift is tolerated: the worker still reads changed files directly, and any
nightly index/docs sweep refreshes the graph. Missing-only is the trigger.

### 3. Wiring (`dispatch.ts` + `pipeline.ts`/daemon + `config.ts`)

- `DispatchDeps` gains `codebaseMemory?: CodebaseMemoryIndexer` (absent → step skipped entirely).
- In `dispatchToProject`, inside the existing background block, **immediately before**
  `const run = start(...)`:
  ```ts
  if (deps.codebaseMemory) {
    try {
      await deps.codebaseMemory.ensureIndexed(folder, () =>
        deps.reply(replyChat, `indexing ${name} into codebase-memory…`, name));
    } catch { /* best-effort; never block the dispatch */ }
  }
  ```
  This lives in the background block (not before the function returns), so the company's turn still
  ends immediately — only the sub-worker's start is delayed by a first-time index, and the operator
  sees the "indexing…" line. Already-indexed folders add one cached/`list_projects` call ≈ no delay.
- `config.ts`: add `codebaseMemoryIndexTimeoutMs` (default `CM_INDEX_TIMEOUT_MS_DEFAULT` = 300_000).
- The indexer is constructed **once** at daemon startup from `cfg.codebaseMemoryBin` (when set) so its
  known-indexed cache is process-lifetime, and threaded into the dispatch deps. When
  `codebaseMemoryBin` is empty, no indexer is built → the step is skipped (matching how the worker
  also gets no codebase-memory MCP in that case).

## Testing

Unit-test the orchestration against a mock `CodebaseMemoryClient` (no live server):
- already-in-`listProjects` → no `indexRepository`, no `onFirstIndex`, folder cached.
- missing → `indexRepository(folder)` called once, `onFirstIndex` fired once, folder cached.
- second call for a cached folder → NO client calls at all.
- `listProjects` throws → resolves (no throw), folder not cached (retry next time).
- `indexRepository` throws → resolves (no throw), folder not cached.
- `root_path` matched by canonical path (trailing-slash / symlink-insensitive).

Dispatch integration (inject a stub `codebaseMemory`, existing fake-`start` pattern):
- `ensureIndexed(folder)` is awaited BEFORE `start` is called (ordering log).
- stub `ensureIndexed` throws → dispatch still starts the worker (resilience).
- no `codebaseMemory` in deps → dispatch behaves exactly as today (no regression).

Preamble: assert the rendered brief contains "REQUIRED", "codebase-memory", "already indexed",
"superpowers", and the task text.

`bunx tsc --noEmit` + `bun test` green; commit per logical piece on `master`; no push/deploy.
