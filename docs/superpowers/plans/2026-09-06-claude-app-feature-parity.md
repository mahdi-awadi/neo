# Claude App Feature Parity — Design + Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Read `CLAUDE.md` first. **Do not start implementation
> until the operator approves this plan** — it touches the running daemon (restart-gated).

**Goal:** Adopt the best of Claude's 2026 app features (Remote Control, Dispatch, Agent View,
Cowork Cloud, the Desktop Code tab) into Neo, and make Neo's versions *better* where its
governed-company-engine model allows — without rebuilding what Neo already does, and without ever
weakening the compliance firewall or the "no AI in the engine" rule.

**Architecture:** Every new surface is a **deterministic projection** of state Neo already holds
(registry, dashboard snapshot, decisions ledger, scheduler next-due, usage meter, per-session
control handles) plus a **thin live-delta stream** over the existing operator-bus / SSE plumbing.
No new engine mechanics, no AI in the engine, no change to the provider router or governor
semantics. The web console gains a first-class **Agent View**; the SSE stream gains **per-session
scoping**; two small worker-facing gaps (visual diff, PR monitoring) reuse the loop runtime and a
read-only git surface.

**Tech Stack:** Bun + TypeScript · bun:sqlite (ledger) · grammy (Telegram) · `Bun.serve` + SSE (web
console) · `@anthropic-ai/claude-agent-sdk` (workers) · `bun test` + `bunx tsc --noEmit`.

**Spec:** this document (combined design + plan, per the operator's request for a single plan
artifact at this path).

## Global Constraints (copied into every task)

- **No AI in the engine.** Agent View is a pure, deterministic projection of ledger + registry +
  meter + scheduler. AI lives only inside SDK workers.
- **Compliance firewall is untouchable.** Nothing here routes `source:"customer"` to the
  subscription, offers a customer a Claude login, or gives a live-view surface any *control* the
  operator doesn't already have. Read surfaces are admin-gated (TOFU) exactly like today's console.
- **Governor semantics unchanged.** New surfaces *display* governor state (pending escalations,
  budget); they never bypass `canUseTool` or the approval gate.
- **Behavior-preserving defaults.** Every new endpoint/event is additive; with the web console off
  or the new flags unset, the daemon behaves exactly as today.
- **Restart discipline.** This is the running daemon (`neo.service`, systemd `Restart=always`).
  Any new endpoint, SSE event, or config knob needs a daemon restart — **operator-gated, never
  self-initiated** (see memory `never-restart-without-permission`). Each phase flags its restart
  requirement.
- **Machine-local state stays untracked.** New knobs live in `.env`/`config.json`, never tracked
  docs. Runtime data stays under `data/`/`company/`.
- **TDD.** Failing test first; `bun test` + `bunx tsc --noEmit` green before any task is done;
  commit per task; commit to a branch, never `master`.

---

## 1. Capability Inventory — what Neo ALREADY has

For each of Claude's five feature areas, this is the honest state of Neo today, with citations.
**Neo already surpasses two of the five and has ~80% of a third** — the plan does not rebuild these.

### 1.1 Remote Control (Claude: a live window from phone/browser/desktop into a running *local* session)

Claude's Remote Control mirrors an interactive `claude` **CLI process**: run `claude remote-control`,
then drive that terminal session from the Claude app or `claude.ai/code`; files/MCP/config stay
local, only messages + tool results cross an encrypted bridge.

**Neo is already a remote-control architecture — inverted.** Neo never mirrors a terminal; it runs
**headless SDK `query()` workers** governed by the engine, and the operator reaches them from
Telegram *and* a web console. What Neo has:

- **Multi-surface output sync** — `src/engine/operator-bus.ts:28-59`: a sink registry
  (`register`/`mirror`), output-only sinks, origin-exclusion so a line from Telegram fans to the web
  and vice-versa with no feedback loop. This is real multi-device *output* sync (Telegram + web).
- **Web console over SSE** — `src/frontends/web.ts` (`/stream` at `:277-305`), `WebEvent` union in
  `src/engine/web-channel.ts:36-82` (`message`/`echo`/`notice`/`escalation`/`projects`/`loops`/
  `sdk`/`file`). Long-lived stream, 15s keepalive, `idleTimeout:0`, event replay on subscribe.
- **Files/MCP/config stay local by construction** — workers run in-process against `/home/*`
  folders on the operator's server; nothing about the worker leaves the box. This is *stronger* than
  Claude's bridge (there is no remote sandbox at all).

**Honest gap:** the stream is **coarse and not per-session-scoped**. Events are conversation-level
(`message`/`escalation`), tagged only by `project` name; there is no live, per-*session* feed of a
single worker's tool-by-tool activity, cost, and context growth. See §2.1/§2.2.

### 1.2 Dispatch (Claude: start a task from your phone that runs on your machine) — **Neo already does this, and better**

- `mcp__neo__dispatch` — `src/engine/dispatch.ts:802-830` (company-only MCP tool; the customer path
  never receives it → firewall by construction).
- Auto-prepended brief preamble `briefWithProjectDocs` — `dispatch.ts:189-215`: read the project's
  rule/doc files, use `codebase-memory` FIRST, use superpowers, challenge-self before escalating.
- Engine pre-indexes the target folder before the worker starts (`ensureIndexed`,
  `src/engine/codebase-memory.ts`) so the "use codebase-memory" instruction is satisfiable in code.
- Liveness-bounded, not wall-clock — stall monitor + per-dispatch ceiling + graceful wrap-up:
  `dispatch.ts:129-135, 546-585`.
- Result routing by priority — a completion is a `result` → the unmuted Decisions group
  (`dispatch.ts:613-617`); progress stays in the muted DM.
- Reachable from **both** Telegram and web today (web routes through the same `deps.reply`,
  `web-channel.ts:97-127`). "Start from phone → runs on your machine" is fully covered.

**Gap:** essentially none on capability. A minor UX gap: the web/mobile surface has a "New project"
form but no first-class *Dispatch to an existing project* affordance (today it goes through the
always-on company session's natural-language routing). Small; folded into §4 Phase C.

### 1.3 Agent View (Claude: one dashboard, one row per session; signals = id, waiting-on-you, last response, last-interaction time; loops show next run)

Neo has the **data** and two partial renderings:

- **Text list** — `/list` (`src/engine/commands.ts:326-368`) renders per session: pin/focus star,
  status icon, trust lock, name, folder, status, **activity label + age**, **queue depth**,
  **ctx%**, uptime, task. This is *richer than Claude's four signals* — but text-only in Telegram.
- **`sessions` MCP tool** — `src/engine/session-status.ts:34-83`
  (`describeSessionStatus`/`sessionStatuses`/`sessionsReport`) gives the company live awareness.
- **Web dashboard snapshot** — `src/engine/dashboard.ts:14-107`: `DashState { projects:
  DashProject[], sdk, usage, loops, recent, repos }`, each `DashProject { status, active, ageMs,
  activity, queued, ctxPct }`. Served at `/api/state` and rendered as a **sidebar project picker**.

**Honest gaps:** (a) the web project list is a *picker*, not a live grid; it re-renders on events but
individual sessions aren't streamed as deltas; (b) loops live in a **separate tab**, not unified with
sessions, and **next-scheduled-run is not surfaced** per loop; (c) there is no **"waiting on you"**
signal wiring the open **decisions** queue (`ledger` decisions table) to its session; (d) no
per-session governor/budget badges. All the underlying data exists — this is presentation + a
live-delta stream, not new engine mechanics. This is the **highest-leverage gap**.

### 1.4 Cowork Cloud (Claude: sessions run remotely, keep working after you close your laptop, scheduled tasks fire with no device online) — **Neo already does this, and it is better-aligned**

- **Always-on server daemon** — `src/daemon.ts:150-223`: a self-rescheduling heartbeat tick runs
  idle-sweep + stuck-sweep + the loop scheduler, independent of any operator device.
- **Scheduled tasks with no device online** — `src/engine/scheduler.ts:59-78` fires cron/interval
  loops when due + enabled + a free slot + unthrottled; built-in loops in `src/engine/loops.ts`
  (`error-sweep`, `docs-sweep`, `memory-dream`, `secretary`, `mywellbeing-checkin`, …). This is
  *exactly* Cowork Cloud's headline capability, live in Neo for months (the loop runtime).
- **Runs on YOUR server against YOUR files on YOUR subscription** — the deliberate "Agent SDK, not
  Managed Agents" choice (`CLAUDE.md` → "Why these decisions"). Cowork's cloud sandbox *cannot see
  your files*; Neo's model can, and stays subscription-compliant.

**Gap:** none on the "runs without a device / scheduled" axis. Neo is detached-by-default (you never
"attach"; you dispatch and it reports back), so there is not even a detach/reattach UX to build.

### 1.5 Desktop Code tab (Claude: visual diff review, server previews, PR monitoring, device cards)

- **Visual diff review:** none in the operator surface. Workers do the edits; the operator sees text
  progress + result previews (`session-runner.ts:383-486`). No diff pane in the web console.
- **Server previews:** partial — **workers** get a headless Playwright MCP (HISTORY: "Playwright
  browser MCP on every operator project worker"), so a *worker* can drive a browser/preview, but the
  *operator* has no live preview pane.
- **PR monitoring:** none as a feature. The loop runtime *could* host a "babysit PRs" loop, but no
  built-in exists.
- **Device cards / multi-host:** none. Neo is **single-host** (one daemon, one server; the shared
  VPS runs everything). No concept of registering multiple machines and choosing where to start a
  session.

---

## 2. Gap Analysis — the genuine gaps, ranked by leverage (value ÷ effort × fit)

| # | Gap | Value | Effort | Fit to governed model | Verdict |
|---|-----|-------|--------|----------------------|---------|
| 2.1 | **Agent View** — live multi-session grid unifying sessions + loops + decisions + budget | **High** | Medium | Excellent (pure projection) | **Build first** |
| 2.2 | **Live session window** — per-session structured activity/cost/ctx stream | High | Medium | Excellent (reuses SSE + existing hooks) | Build (Phase B/C) |
| 2.3 | **Visual diff review** — read-only `git diff` pane per session in the console | Medium | Small | Good (read-only, no new worker powers) | Build (Phase D) |
| 2.4 | **PR monitoring** — a `babysit-prs` loop (checks → fix → report) | Medium | Small | Excellent (loop runtime already exists) | Build (Phase D) |
| 2.5 | **Multi-host / device cards** — register N machines, start a session on a chosen one | Low–Med | **High** | Weak today (single shared VPS) | **Defer — operator decision** |
| 2.6 | **Richer mobile UX** — responsive Agent View + first-class Dispatch/decisions on mobile web | Low–Med | Small | Good | Fold into 2.1/2.2 |

### 2.1 Agent View (highest leverage)

The one live view Neo lacks. Everything it needs already exists:
- live sessions + real turn-active signal — `registry.ts`, `SessionControl.active()`
  (`session-runner.ts:966,1045`);
- per-session activity/queue/ctx% — `dashboard.ts:54-107`;
- pending decisions per session ("waiting on you") — the `decisions` ledger table
  (`listOpenDecisions`, `decisionByMessage`);
- next scheduled run per loop — `scheduler.ts` (`isDue` + `LoopStateStore.lastRun`) + the trigger
  matcher;
- budget/cost + reserve headroom — the usage meter (`usage.ts` `UsageSnapshot`), per-session cost
  from `RunResult.costUsd`.

The gap is a **single deterministic projection** (`agentView.ts`) + an endpoint + a live-delta
stream + a web grid. **Difficulty: medium.** **Value: high** (it is the "is this thing still alive"
answer for a multi-project engine). **Fit: excellent** — it is a pure read model, no AI, and it is
the natural home for Neo's governance signals (see §3).

### 2.2 Live session window

Today's SSE events are conversation-level and project-tagged, not per-session deltas. A "watch this
worker" window needs the stream to carry **per-session** structured updates (status, activity label,
ctx%, cumulative cost) sourced from the **existing** `onActivity`/`onHeartbeat`/`onCost` hooks in
`session-runner.ts` — the SDK core stays ledger-free/AI-free; the web-channel projects the hooks into
events. **Difficulty: medium** (mostly wiring + a session-scoped web pane). Complements 2.1: an
Agent View row → click → live window.

### 2.3 / 2.4 Visual diff + PR monitoring

- **Visual diff:** every project folder is a git repo; a read-only `git diff`/`git status` view per
  session is a small web surface. No new worker powers; the engine shells a read-only git command in
  the fenced folder. **Small.**
- **PR monitoring:** a natural **loop** — `trigger: interval → goal: gh pr checks green → action:
  fix failing checks → report`. Reuses the loop runtime end-to-end; escalations auto-deny so it never
  auto-merges without the approval gate. **Small, high fit.**

### 2.5 Multi-host / device cards (defer)

Neo is single-host today; the shared VPS runs every project. True multi-host means a host-agent per
machine registering to the daemon, a routing layer choosing where a session runs, and a much larger
governance surface (firewall + budget per host). **High effort, presently low value** for a
single-server deployment. This is a **product-direction decision for the operator** (see Open
Questions). Recommendation: **defer**; do not build now.

---

## 3. "Better than Claude" angles — where Neo's model wins

Claude's Agent View shows four flat signals (id, waiting?, last response, last time). Neo can show
the **full governed lifecycle** because it *owns* the governance data:

1. **Governance-native Agent View.** Per session, surface what Claude cannot: pending **governor
   escalations** and tracked **decisions** (with the actual tappable option, not just a flag — reuse
   `structured-question.ts`), **budget/cost** + interactive-reserve headroom, **compliance route**
   (subscription vs Gemini), **ctx% + context-policy state**, and per-loop **next scheduled run**.
2. **Dispatch with discipline (already true).** Every dispatch carries TDD + codebase-memory +
   firewall + budget metering + a durable decisions queue. Claude's Dispatch has none of this.
3. **Firewall-aware live window.** Watching a customer-tainted worker *shows* it is governed (zero
   tools, no MCP) — the live view makes the compliance boundary visible, not just enforced.
4. **Cowork, but file-aware and compliant.** Neo's no-device scheduled work runs against real
   `/home` folders on the operator's subscription — Cowork's cloud sandbox can't see the files.
5. **Deterministic, auditable read model.** The whole dashboard is a pure projection of
   ledger + registry + meter; it can be replayed/tested and never involves an AI reading state — a
   trust property a cloud dashboard can't offer.

---

## 4. Phased Implementation Plan (TDD, Neo MVP-PLAN style)

**Recommended first phase: Phase A (Agent View snapshot + endpoint + text command).** Highest
leverage: all data already exists, it is a deterministic projection (fits "no AI in engine"), it is
small and shippable on its own, and it unlocks B and C. Phases B–E are sketched at task-list
granularity deliberately (YAGNI) — they are re-detailed via `writing-plans` once A ships and the
operator confirms direction.

### Phase A — Agent View read model + snapshot API + `/agents` (recommended first; **restart-gated: new endpoint + command**)

**File Structure**
- Create: `src/engine/agent-view.ts` — the pure projection (registry + dashboard + decisions +
  scheduler + meter → one snapshot). One responsibility, unit-tested.
- Create: `tests/agent-view.test.ts`.
- Modify: `src/frontends/web.ts` — add `GET /api/agent-view` (admin-gated, cache-busted like
  `/api/state`).
- Modify: `src/engine/commands.ts` — add `/agents` (text mirror of the snapshot).
- Modify: `docs/CONFIG.md`, `docs/HISTORY.md`, `README.md`.

#### Task A1: The Agent View projection module

**Files:**
- Create: `src/engine/agent-view.ts`
- Test: `tests/agent-view.test.ts`

**Interfaces:**
- Consumes: `Registry` (live sessions + `getControl`), `Ledger.listOpenDecisions()`,
  `dashboardSnapshot`-style signals (`ctxPct`, `queued`), the scheduler's due-check
  (`isDue`/`lastRun`) for loops, `UsageMeter` snapshot.
- Produces:

```ts
export interface AgentRow {
  id: string; name: string; folder: string;
  status: "running" | "idle" | "done" | "error";
  active: boolean;               // turn in flight right now (SessionControl.active())
  activity?: { label: string; since: number };
  queued: number;                // follow-ups waiting
  ctxPct?: number;               // 0..100
  costUsd?: number;              // cumulative session cost
  provider?: "subscription" | "codex" | "gemini";
  waitingOnYou: boolean;         // >=1 open decision/escalation for this session
  openDecisions: number;         // count from the decisions ledger
  ageMs: number;
}
export interface LoopRow {
  name: string; enabled: boolean;
  nextRunAt: number | null;      // computed from the trigger + lastRun
  lastRunAt: number | null;
}
export interface AgentViewSnapshot {
  sessions: AgentRow[];
  loops: LoopRow[];
  budget: { spentUsd: number; remainingUsd: number | null; reservePct: number };
  computedAt: number;
}
export function agentViewSnapshot(deps: {
  registry: Registry; ledger: Ledger; usage?: UsageMeter;
  loops: LoopDef[]; enabledLoop: (name: string) => boolean;
  lastRun: (name: string) => number | null; now?: number;
  signals?: (folder: string, sdkSessionId: string, opts?: any) => ContextSignals;
  windowTokensByModel?: Record<string, number>;
}): AgentViewSnapshot;
```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { agentViewSnapshot } from "../src/engine/agent-view";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";

test("a session with an open decision is flagged waitingOnYou", () => {
  const registry = createRegistry();
  const id = registry.add({ /* minimal SessionInfo for /home/acme, name 'acme' */ } as any);
  const ledger = openLedger(":memory:");
  ledger.openDecision({ kind: "decision", project: "acme", folder: "/home/acme", question: "which db?" });
  const snap = agentViewSnapshot({
    registry, ledger, loops: [], enabledLoop: () => false, lastRun: () => null, now: 1_000,
  });
  const row = snap.sessions.find((s) => s.name === "acme")!;
  expect(row.waitingOnYou).toBe(true);
  expect(row.openDecisions).toBe(1);
});

test("a loop's nextRunAt is computed from its trigger", () => {
  const snap = agentViewSnapshot({
    registry: createRegistry(), ledger: openLedger(":memory:"),
    loops: [{ name: "error-sweep", trigger: { kind: "cron", expr: "30 3 * * *" } } as any],
    enabledLoop: () => true, lastRun: () => null, now: Date.parse("2026-09-06T00:00:00Z"),
  });
  expect(snap.loops[0]!.nextRunAt).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/agent-view.test.ts` → FAIL (module not
  found).
- [ ] **Step 3: Implement** — `agentViewSnapshot` iterates `registry.list()`, joins each session to
  its `getControl()?.active()/queued()`, its `ctxPct` via `signals`, its cumulative `costUsd` (from
  the registry/ledger), and counts open decisions matching the session's folder/project via
  `ledger.listOpenDecisions()`; maps loops to `{enabled, nextRunAt, lastRunAt}` using a
  `nextRunAt(trigger, lastRun, now)` helper built on the existing `isDue` matcher (search forward
  from `now` at `CRON_RESOLUTION_MS` granularity for cron, `lastRun + intervalMs` for interval);
  reads the meter for `{spentUsd, remainingUsd, reservePct}`. Pure, no I/O beyond the injected deps.
- [ ] **Step 4: Run** — `bun test tests/agent-view.test.ts` → PASS; `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(agent-view): deterministic multi-session snapshot`.

#### Task A2: `GET /api/agent-view` endpoint

**Files:**
- Modify: `src/frontends/web.ts` (add the route beside `/api/state`)
- Test: `tests/web-agent-view.test.ts` (drive via `fetch` against `createWebApp`, like the existing
  web tests)

**Interfaces:**
- Consumes: `agentViewSnapshot` (A1), the same admin gate (`sessionUser`) used by `/api/state`.
- Produces: `GET /api/agent-view` → `200 application/json` = `AgentViewSnapshot` for an authed admin;
  `401` otherwise; `Cache-Control: no-store` (match `/api/state`).

- [ ] **Step 1: Write the failing test** — an authed request returns JSON with `sessions`, `loops`,
  `budget`, `computedAt`; an unauthed request returns 401. Reuse the existing test's cookie/admin
  fakes.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add the route: gate with `sessionUser(req)`; on success
  `Response.json(agentViewSnapshot({...deps}))` with `no-store`; wire the same deps the daemon passes
  to `dashboardSnapshot`.
- [ ] **Step 4: Run** — `bun test tests/web-agent-view.test.ts` → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(web): /api/agent-view snapshot endpoint`.

#### Task A3: `/agents` text command (Telegram + web parity)

**Files:**
- Modify: `src/engine/commands.ts` (new COMMANDS entry + a `renderAgents(snap)` helper; add to help)
- Test: `tests/commands.test.ts` (add a case)

**Interfaces:**
- Consumes: `agentViewSnapshot` (A1).
- Produces: `/agents` → one compact line per session (`name · status · activity · N queued · ctx% ·
  ⏳ waiting?`) and a loops footer (`error-sweep → next 03:30`), reusing `describeSessionStatus`
  formatting where possible.

- [ ] **Step 1: Write the failing test** — with one live session (open decision) and one enabled
  loop, `renderAgents(snap)` contains the session name, a `waiting` marker, and the loop's next-run.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — `renderAgents` formats the snapshot deterministically; the COMMANDS
  entry calls it. (No AI; pure render, like `/list` and `/decisions`.)
- [ ] **Step 4: Run** — `bun test tests/commands.test.ts` → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(commands): /agents live multi-session view`.

#### Task A4: Docs sync

**Files:** `docs/CONFIG.md` (note the read-only endpoint; no new secrets), `docs/HISTORY.md` (feature
narrative), `README.md` (Agent View), `docs/loops.md` (loop next-run surfaced).

- [ ] **Step 1** — document the `/agents` command + `/api/agent-view` endpoint and the snapshot
  shape.
- [ ] **Step 2: Commit** — `docs: Agent View read model + /agents`.

**End of Phase A:** a deterministic, governance-native multi-session view on Telegram *and* an API the
web grid consumes. **Restart-gated** (new endpoint + command). Ship, get the operator's go-ahead to
restart, verify live before Phase B.

### Phase B — Live Agent View grid + per-session delta stream (**restart-gated: new SSE events**)

Task-list granularity (re-detailed after A ships):
- [ ] **B1** — extend `WebEvent` (`web-channel.ts:36-82`) with a `session_update` delta
  `{ type: "session_update"; id; patch: Partial<AgentRow> }` and an `agent_view` full-snapshot event;
  keep additive/backward-compatible.
- [ ] **B2** — project the existing `session-runner` hooks (`onActivity`/`onHeartbeat`/`onCost`,
  `session-runner.ts:398,415,438,466`) into `session_update` deltas at the web-channel boundary (the
  SDK core stays ledger-free — no new coupling inside `consumeStream`). Throttle/coalesce deltas so
  the stream never becomes a firehose.
- [ ] **B3** — web console renders a live **Agent View grid** (replaces the sidebar picker as the
  primary view; the picker remains as a compact mode), one row per session with governance badges
  from §3; loops shown inline with next-run; responsive layout (covers §2.6 mobile).
- [ ] **B4** — docs + HISTORY.

### Phase C — Live session "window" + first-class Dispatch affordance (**mostly frontend; restart-gated for any endpoint**)

- [ ] **C1** — clicking an Agent View row opens a focused live feed for **one** worker (scope the
  already-streamed, project-tagged lines by session id), with the session's pending decision rendered
  inline via the existing `structured-question.ts` keyboard spec.
- [ ] **C2** — a first-class "Dispatch to project" affordance (pre-fills project + brief; posts to the
  existing dispatch path). Closes the minor §1.2 UX gap.
- [ ] **C3** — docs + HISTORY.

### Phase D — Visual diff pane + PR-monitoring loop

- [ ] **D1** — engine exposes a **read-only** per-session diff: a small `git-view.ts` that shells
  `git -C <fenced folder> diff`/`status` (folder-fenced, read-only, no worker powers), surfaced as
  `GET /api/session/:id/diff` and a diff pane in the console. Restart-gated (endpoint).
- [ ] **D2** — a `BABYSIT_PRS` `LoopDef` in `src/engine/loops.ts` (interval trigger; goal = `gh pr
  checks` green via a verifiable command; action = fix failing checks; escalations auto-deny so it
  **never** auto-merges). Data-driven loop → no restart to author (loop CRUD), but shipping the
  built-in is restart-gated.
- [ ] **D3** — docs (`docs/loops.md`, CONFIG, HISTORY).

### Phase E — Multi-host / device cards (**DEFERRED — operator product decision; do not build without a yes**)

Not planned in detail on purpose. If the operator chooses multi-host, the minimal shape is: a
lightweight host-agent per machine that registers to the daemon and exposes its folders + a
per-host budget/firewall context; the daemon's dispatch/registry gain a `host` dimension. This is a
**major surface** (governance × N hosts) — it gets its own brainstorm → spec → plan cycle, not a
task list here. Evaluate at that point whether to lean on Claude's own device-cards/Remote-Control
primitive for the *transport* while keeping Neo's governor in front (see §5).

---

## 5. Build vs Delegate note (per gap)

| Gap | Decision | Why |
|-----|----------|-----|
| **Agent View** (2.1) | **Build** | It is a projection of Neo's *own* ledger/registry/meter — nothing external can produce it. |
| **Live window** (2.2) | **Build** | Neo governs **SDK `query()` streams**; Claude Remote Control mirrors an interactive **CLI**, so it can't hook Neo's governed workers. Delegating would also bypass the governor + firewall. Neo already owns ~80% of the plumbing (operator-bus + SSE). |
| **Dispatch** (1.2) | **Already built + superior** | No build beyond a small web affordance (Phase C2). |
| **Cowork "no-device scheduled"** (1.4) | **Already built + superior** | Server daemon + loop scheduler; file-aware + subscription-compliant. Delegating to Anthropic's cloud sandbox would break file access *and* the firewall. |
| **Visual diff** (2.3) | **Build small** | A read-only `git diff` pane; do not adopt Claude's desktop diff (different process model, and it would pull the operator out of Neo's governed surface). |
| **PR monitoring** (2.4) | **Build as a loop** | The loop runtime already does trigger→action→goal; a built-in `babysit-prs` is cheap and durable, and auto-deny keeps auto-merge behind the approval gate. |
| **Multi-host** (2.5) | **Defer / operator decision** | High effort; low value on a single VPS. If pursued, consider using Claude's device-cards/Remote-Control primitive as the *transport* between hosts while Neo's governor stays the control plane — but that is a separate spec, not this plan. |

**Guiding principle:** Neo builds the **read/governance surface** (its differentiator) and delegates
nothing that would move a worker off the operator's server or around the firewall. The only place a
Claude-native primitive is even a candidate is multi-host *transport* — deferred.

---

## Open Questions (genuine operator decisions — flagged, not blocking Phase A)

1. **Multi-host direction (2.5/Phase E).** Stay single-host (recommended — matches the shared-VPS
   reality and keeps the governance surface small), or invest in multi-host device cards later? A
   product/architecture call; irreversible-ish once built.
2. **Agent View primary surface.** Recommendation: keep **both** — a compact `/agents` text view on
   Telegram (cheap, mobile-first) *and* the rich web grid. Confirm the web grid should *replace* the
   current sidebar picker as the default view (Phase B3) vs. sit alongside it.
3. **Live-window granularity (2.2/Phase B2).** How much per-session detail to stream — activity +
   status + ctx% + cost is the recommended default (display-only, **no extra worker/subscription
   cost**, since it projects hooks that already fire). Streaming tool *inputs*/reasoning is possible
   but noisier; recommend leaving it off by default behind a flag.

## Self-Review

- **Deliverable coverage:** §1 inventory (all five areas, cited) ✓; §2 gap analysis (ranked, with
  value/effort/fit) ✓; §3 "better than Claude" angles ✓; §4 phased TDD plan with a recommended first
  phase ✓; §5 build-vs-delegate note (per gap) ✓.
- **Honesty about overlap:** Dispatch (1.2) and Cowork-no-device (1.4) are stated as *already built +
  superior* — not rebuilt. Remote Control (1.1) is ~80% present (operator-bus + SSE) — only the
  per-session gap is planned. No task rebuilds an existing capability.
- **Placeholder scan:** Phase A tasks carry real test code, interfaces, and commit messages. Phases
  B–E are intentionally task-list granularity (YAGNI) and explicitly marked for re-detailing via
  `writing-plans` after A — this is a scoping decision, not a placeholder.
- **Type consistency:** `AgentRow`/`LoopRow`/`AgentViewSnapshot`/`agentViewSnapshot` (A1) are used by
  the same names in A2/A3 and referenced by B1's `session_update`/`agent_view` events.
- **Constraint fit:** every phase is additive, admin-gated, AI-free in the engine, firewall-safe, and
  flags its daemon-restart requirement (operator-gated).
