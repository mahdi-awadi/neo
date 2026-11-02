# Codex Project Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting Claude or Codex routes all platform-wide operator-owned AI work, including background roles and company-dispatched projects, through the selected SDK.

**Architecture:** Persist a single selected provider and safely drain old-provider sessions at turn boundaries. Expose the existing run-scoped Neo MCP tool set to Codex through an authenticated local transport, without duplicating business logic or weakening routing and governance. Verify the original failure and both direct-open and company-dispatch paths end to end.

**Tech Stack:** Bun, TypeScript, SQLite ledger, `@openai/codex-sdk` 0.145.0, `@modelcontextprotocol/sdk` 1.32.1, existing Claude Agent SDK and web console.

**Spec:** `docs/superpowers/specs/2026-11-01-codex-project-routing-design.md`

## Global Constraints

- Read `CLAUDE.md`, `MVP-PLAN.md`, and the spec; implement test-first. Preserve unrelated working-tree changes.
- Never send customer-direct work to an operator SDK; never weaken read-only, path, approval or tool-scope controls to achieve parity.
- The selected SDK governs every operator-owned AI role and background path in both directions; no silent fallback or per-role provider override. Customer-direct work remains on its separately protected path.
- Existing turns and accepted inputs are not silently interrupted or dropped. SDK session IDs remain provider-specific.
- Keep machine-local state out of tracked files; do not expose credentials in argv, logs, or frontend responses.
- `bunx tsc --noEmit` and `bun test` must pass. Commit logical pieces when the environment permits.

## Review Focus

- Repeated Claude → Codex → Claude selections during a busy turn converge on the latest selection without lost input (Task 3).
- Bridge startup failure, unauthenticated access, and replay after teardown cannot call tools (Tasks 4–5).
- Consult/customer and project sessions never acquire company-only dispatch privileges (Task 5).
- A restart after selection preserves the provider without overriding an explicit deployment setting (Task 2).
- A missing tool, incompatible resume ID, or blocked drain produces a visible actionable status, never false success (Tasks 3, 5–7).

## File Map

- `src/engine/sdk-choice.ts`, `src/engine/ledger.ts`, `src/engine/ledger-migrations.ts`, `src/daemon.ts`: durable selected provider and boot precedence.
- `src/engine/pipeline.ts`, `src/engine/registry.ts`, `src/engine/web-channel.ts`, `src/engine/commands.ts`: safe session transitions and status.
- `src/engine/dispatch.ts`, `src/engine/loops.ts`, new `src/engine/codex-mcp-bridge.ts`, `src/engine/session-runner.ts`, `src/engine/model-resolver.ts`: shared tool definitions, scoped bridge and Codex configuration.
- `src/frontends/web/app.ts`, `src/frontends/web/locales/{en,ar}/console.json`: switch status and failures.
- `tests/sdk-resume.test.ts`, `tests/session-runner.test.ts`, `tests/pipeline.test.ts`, `tests/web-channel.test.ts`, `tests/web.test.ts`, plus new focused bridge/persistence tests.
- `docs/sdk-notes.md`, `docs/CONFIG.md`, `README.md`, new `docs/adr/` decision: actual SDK and operation limits.

### Task 1: Reproduce and prove transport feasibility

**Files:** Modify `docs/sdk-notes.md`; add isolated tests/spike under `tests/` or `spike/` as needed.

**Interfaces:** Input: console direct open, natural-language company dispatch, installed Codex SDK. Output: recorded observed failure and a proven transport/config shape; no production behavior changed.

- [ ] Capture the user's exact symptom when available; inspect the relevant event records without exposing private conversation contents. Test `/open` and company dispatch independently on a disposable project; record provider and outcome.
- [ ] Inspect `neoMcpServers`, its per-run context and the installed MCP and Codex SDK declarations. Write a disposable transport spike that lists and calls a harmless tool through Codex, authenticates initialization and calls, and tears down the listener. Never put secrets in process arguments.
- [ ] Run the spike and record the actual command, result and supported transport in `docs/sdk-notes.md`. If no authenticated transport is possible, stop and record the blocker rather than claiming dispatch works.

### Task 2: Durable provider choice

**Files:** Modify `src/engine/sdk-choice.ts`, `src/engine/ledger.ts`, `src/engine/ledger-migrations.ts`, `src/daemon.ts`, `src/engine/commands.ts`, `src/engine/web-channel.ts`; test `tests/sdk-choice-persistence.test.ts`, `tests/commands.test.ts`, `tests/web-channel.test.ts`.

**Interfaces:** Provide a shared provider-selection service with `get(): WorkerSdkProvider` and `set(raw: string): { ok: boolean; error?: string; sdk: WorkerSdkState; changed: boolean }`; back it with one ledger setting and use it for both UI and command. Keep `WorkerSdkProvider` from `sdk-choice.ts`.

- [ ] Write failing tests: fresh DB uses configured default; UI and `/sdk` share the selection; closing and reopening the ledger restores `codex`; invalid values do not mutate or persist; a write failure reports failure and leaves the in-memory value unchanged. Test explicit environment precedence only if config actually supports it.
- [ ] Run `bun test tests/sdk-choice-persistence.test.ts tests/commands.test.ts tests/web-channel.test.ts`; verify the new cases fail for the intended missing behavior.
- [ ] Add a migration and persistence using existing ledger patterns; initialize the service before wiring launch paths. Do not rewrite `config.json`. Update all SDK switch entry points to call the service.
- [ ] Repeat the focused test command and ensure all pass. Commit this logical piece when possible.

### Task 3: Drain and switch existing sessions

**Files:** Modify `src/engine/pipeline.ts`, `src/engine/registry.ts`, `src/engine/sdk-choice.ts`, `src/engine/commands.ts`, `src/engine/web-channel.ts`; test `tests/pipeline.test.ts`, `tests/sdk-resume.test.ts`, `tests/web-channel.test.ts`.

**Interfaces:** The selection service from Task 2 notifies the registry on a successful change. A session exposes its actual provider and transition status; the existing `SessionRun.close()`, `done`, `active()`, and `queued()` drive the transition.

- [ ] Add failing tests for an idle Claude session, a busy session with queued messages, a message arriving while closing, and rapid Codex/Claude/Codex changes. Assert each accepted input is delivered once, the busy turn finishes, the next fresh run uses the latest provider, and a known foreign thread ID is not resumed. Assert a non-draining control remains visible as pending.
- [ ] Run `bun test tests/pipeline.test.ts tests/sdk-resume.test.ts tests/web-channel.test.ts` and verify the new cases fail.
- [ ] Implement coordinated close at a safe boundary, serialize transition/delivery with the existing reopen guard, and keep provider-specific history intact. Use the existing handoff/memory mechanisms for fresh provider context; do not inject a foreign resume ID.
- [ ] Repeat focused tests; additionally verify a failed switch does not drop pending inputs. Commit when possible.

### Task 4: Run-scoped authenticated MCP bridge

**Files:** Create `src/engine/codex-mcp-bridge.ts`, `tests/codex-mcp-bridge.test.ts`; modify `src/engine/dispatch.ts` and `src/engine/loops.ts` to expose the existing tool definitions without duplicating handlers.

**Interfaces:** `startCodexMcpBridge(toolSet, options): Promise<{ codexConfig: Record<string, unknown>; close(): Promise<void> }>`; `toolSet` is the same run-bound definition set passed to Claude. Choose concrete types matching the installed MCP SDK after Task 1.

- [ ] Write failing tests for list/call of a fake tool, invalid or missing capability on initialize and call, cross-session token rejection, handler errors, cancellation, startup failure, idempotent teardown, and calls after teardown. Assert the listener cannot bind to a public interface and capability values are absent from argv/logs.
- [ ] Run `bun test tests/codex-mcp-bridge.test.ts`; verify failure is due to the missing bridge.
- [ ] Extract tool-set construction from `neoMcpServers` and loop memory without changing existing Claude behavior. Implement the transport proved in Task 1 with per-run capability, run-scoped handlers, and bounded lifecycle; reject startup if security conditions cannot be met.
- [ ] Run `bun test tests/codex-mcp-bridge.test.ts tests/dispatch.test.ts tests/loops.test.ts`; use actual existing test filenames if these suites were renamed. Verify Claude's existing tool tests still pass. Commit when possible.

### Task 5: Attach tools to Codex and enforce scopes

**Files:** Modify `src/engine/session-runner.ts`, `src/engine/model-resolver.ts`, `src/engine/dispatch.ts`; test `tests/session-runner.test.ts`, `tests/codex-mcp-bridge.test.ts`, `tests/dispatch.test.ts`.

**Interfaces:** Both `runOrder` and `startOrder` obtain a Task 4 bridge before creating the Codex client, pass its `codexConfig` via `CodexOptions.config`, and close it on completion, cancellation, or failure. Retain existing `RunDeps` scope and handlers.

- [ ] Add failing tests proving company sessions get `dispatch`, project sessions do not, consult tools are read-only, and ingress cannot acquire operator tools; verify the bridge is closed when client creation, turn, or interruption fails. Test that unsupported external MCP servers produce a visible capability error rather than a false success.
- [ ] Run `bun test tests/session-runner.test.ts tests/codex-mcp-bridge.test.ts tests/dispatch.test.ts`; confirm failure.
- [ ] Connect the bridge to both Codex execution paths. Update compatibility reporting only for capabilities actually supported; preserve read-only sandbox and firewall behavior. Do not enable an external MCP server if its existing escalation policy cannot be enforced on Codex.
- [ ] Repeat focused tests. Run the Task 1 smoke with the real Codex SDK: list/call the harmless tool and exercise company dispatch into a disposable project. Commit when possible.

### Task 6: Audit routing and communicate switch status

**Files:** Modify relevant launch wiring in `src/engine/worker-profile.ts`, `src/engine/dispatch.ts`, `src/engine/loops.ts`, `src/daemon.ts`, `src/engine/dashboard.ts`, `src/frontends/web/app.ts`, `src/frontends/web/locales/en/console.json`, `src/frontends/web/locales/ar/console.json`; test existing profile, loop, pipeline and web suites.

**Interfaces:** Dashboard SDK state contains the selected provider plus counts/details of sessions draining or unable to switch; display actual per-session provider where available. All dynamic launch paths consult the Task 2 selection service at launch.

- [ ] Inventory every AI launch and direct SDK/API call, including company, project, dispatch, loop, consult, handoff, judge, secretary, producers, retries, and configured auxiliary AI roles. Add failing table-driven tests for each operator-owned path after switching Claude → Codex and Codex → Claude, including changes after daemon boot. Assert no own-work role or profile override launches the other SDK; features that cannot use the selected SDK report an actionable error rather than silently falling back. Customer routes remain on their separate firewall-protected provider. Add console tests for selected, draining, failed, and completed states in English and Arabic.
- [ ] Run the affected focused tests and verify failures. Audit startup-captured provider values as well as dispatch code; document any legitimate non-worker path.
- [ ] Route every inventoried operator-owned AI path through the shared selection service at launch; remove boot-time provider snapshots and conflicting own-work overrides. Adapt auxiliary roles to the selected SDK or surface an explicit unsupported state. Display truthful transition and capability failures and retain provider-specific limits. Verify both locale catalogues contain matching keys.
- [ ] Rerun focused tests and commit when possible.

### Task 7: End-to-end verification and release evidence

**Files:** Modify `docs/sdk-notes.md`, `docs/CONFIG.md`, `README.md`; create a numbered ADR under `docs/adr/`.

**Interfaces:** Task 2 selection, Task 3 transition, and Task 5 bridge must be integrated in the real daemon.

- [ ] Write an end-to-end regression that selects Codex in the web API, sends a company project request, observes a Codex company tool call and a Codex project worker, and checks the result; also test direct open and an unavailable bridge. Use injected SDKs for deterministic CI and a real SDK only in the disposable smoke.
- [ ] Run the new test, `bunx tsc --noEmit`, and `bun test`; resolve failures before proceeding.
- [ ] Document actual bridge design, session transition, persistence precedence, limitations and rollback; record the ADR with security tradeoffs and verified SDK behavior.
- [ ] Run the real Codex smoke in a disposable project with no external side effects. Check that `/home/neo` can be selected/opened without modifying it as a smoke side effect. Confirm the original reported UI failure is resolved when its reproduction is known.
- [ ] Commit the validated pieces when possible. Roll out using the existing graceful lifecycle, preserving active work; verify the running boot includes the fix and repeat the UI smoke. If rollout is unavailable or unsafe, report explicitly that the fix is built but not live.
