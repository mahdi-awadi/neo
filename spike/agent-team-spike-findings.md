# SPIKE: agent-team (Agent + SendMessage) under Neo's governor

Throwaway spike. Question: can Neo dispatch a **team of named subagents** that talk to
each other (SendMessage) and write files, under the existing governor + path-fence, and
what (if anything) must change to wire it in?

Scope: static read of `governor.ts` + `session-runner.ts`, plus a live SDK `query()` run
with two named agents. No production edits, no restart, no commit.

---

## STEP 1 — STATIC VERDICTS (governor.ts + session-runner.ts)

The governor decision path: `decide(tool, input, {folder})` in
`src/engine/governor.ts:48`, reached via `buildCanUseTool()` in
`src/engine/session-runner.ts:170` (wired as the SDK `canUseTool` at
`session-runner.ts:211`).

Order of checks in `decide()`:
1. `AskUserQuestion` → **DENY** (governor.ts:52-56)
2. `SAFE_TOOLS.has(tool)` → **ALLOW** (governor.ts:58)
3. `tool.startsWith("mcp__neo__")` → **ALLOW** (governor.ts:61)
4. `FENCED_TOOLS.has(tool)` (Write/Edit/NotebookEdit) → ALLOW if path inside `folder`, else **ESCALATE** (governor.ts:63-70)
5. `Bash` → ESCALATE if `RISKY_BASH` matches, else ALLOW (governor.ts:72-76)
6. **default → ESCALATE** "unrecognized tool" (governor.ts:79)

### Verdict per tool

| Tool | Governor verdict | Where | Note |
|------|------------------|-------|------|
| **`Agent`** (a.k.a. `Task`) | **ALLOW** | `SAFE_TOOLS` set — governor.ts:29-30; allowed at governor.ts:58 | Comment governor.ts:19-20: "safe because subagent tool calls re-enter canUseTool and are governed individually." |
| **`SendMessage`** | **ESCALATE** | falls through to default, governor.ts:79 | Not in SAFE_TOOLS, not `mcp__neo__`, not fenced, not Bash → "unrecognized tool: SendMessage". |
| **`Workflow`** | **ESCALATE** | falls through to default, governor.ts:79 | Same as SendMessage — unrecognized → escalate. |

**What ESCALATE means at runtime** (`buildCanUseTool`, session-runner.ts:181-189):
an escalate verdict → if `handlers.autoApprove?.()` is true, auto-allow
(session-runner.ts:182-185); otherwise `await handlers.onEscalation(...)` — the operator
is asked (session-runner.ts:186-188). On **autonomous paths** (loops / customer briefs)
escalations auto-deny (governor.ts:4-5). So for an autonomous dispatch, an un-approved
`SendMessage`/`Workflow` would be **denied**, breaking inter-agent messaging — UNLESS the
SDK never routes those tools through `canUseTool` (see live evidence below).

### Path-fence on writes made INSIDE a spawned subagent

- The fence lives in the SAME `canUseTool` closure, which captures the **top-level
  session's** `order.folder` (session-runner.ts:170 param `folder`, passed at
  session-runner.ts:211). There is only one closure; subagents do not get their own.
- `FENCED_TOOLS` = Write/Edit/NotebookEdit (governor.ts:34); `insideFolder()` resolves the
  target against `folder` and fails closed (governor.ts:37-46).
- The design intent (governor.ts:19-20) is that **subagent tool calls re-enter this same
  `canUseTool`**, so a subagent Write is fenced to the parent session's folder exactly like
  a top-level Write. **Verified live** — see Step 2 (a subagent's out-of-fence write to
  `/tmp` was DENIED with `deny(fence)`; both in-fence writes were ALLOWED).

---

## STEP 2 — LIVE TEST (evidence)

Two live SDK `query()` runs were executed (both completed; artifacts under `spike/`).
Both mirror Neo's real options — `settingSources ["user","project"]`, `systemPrompt`
preset `claude_code`, `permissionMode "default"`, `skills "all"`, and the **real**
`decide()` as `canUseTool`. Each passed `agents: { backend, frontend }` with tools
`[Read, Write, Bash, Agent, SendMessage]`, cwd = a fresh scratch dir under `spike/`.

- **run 1** (`agent-team-spike.ts` → `scratch/`, `run-summary.json`, `governor-log.jsonl`, `run-transcript.jsonl`)
- **run 2** (`agent-team-spike2.ts` → `scratch2/`, `governor-log2.jsonl`, `run-transcript2.jsonl`): adds a project-local `.claude/settings.json` = `{teammateMode:"in-process"}` to try to enable inter-agent messaging.

This resumed session did NOT burn a third live run — the two prior runs are complete and
mutually consistent, and re-running would only reproduce the same result while draining the
subscription (Neo's budget-guard rule).

### What WORKS

1. **Subagents spawn (Agent tool).** The lead launched named `backend` + `frontend`
   subagents. Evidence: 3 `Agent` tool_use blocks (run 1), subagent messages carry a
   non-null `parent_tool_use_id`. `subagentSpawned: true`.
   - NOTE: the `Agent` tool **never hit `canUseTool`** — `governor-log.jsonl` contains only
     `Write`×4 and `Bash`×9; `governorVerdicts.Agent = []`. The SDK orchestrates subagent
     spawning internally; the governor is not consulted. (Its static verdict is ALLOW anyway,
     so this is moot and in the safe direction.)

2. **Path-fence holds INSIDE spawned subagents.** ✅ The decisive result.
   - run 1: all 4 subagent `Write`s re-entered `canUseTool` and were ALLOWED as in-fence
     (`/home/neo/spike/scratch/...`); the out-of-fence `/tmp/neo-spike-escape.txt` was NOT
     created (`escapeExists: false`, `fenceHeld: true`).
   - run 2: a subagent's out-of-folder write was **DENIED live** — `governor-log2.jsonl`:
     `{"tool":"Write","action":"deny(fence)","reason":"file write outside the project folder: /tmp/neo-spike2-escape.txt (folder: /home/neo/spike/scratch2)"}`.
   - Conclusion: subagent Write/Edit calls DO re-enter the parent's single `canUseTool`
     closure and ARE fenced to the parent session's folder, exactly as governor.ts:19-20 claims.

### What DOES NOT work

3. **`SendMessage` inter-agent messaging is NOT available in the headless SDK.** ✗
   - The backend subagent called `SendMessage`; the SDK tool_result (run 1,
     `tool_use_id=toolu_01F1qVZspaf9DMbmLUaf2kHC`) was an **error**:
     `<tool_use_error>Error: No such tool available: SendMessage. SendMessage exists but is
     not enabled in this context. Use one of the available tools instead.</tool_use_error>`
   - `SendMessage` **never reached `canUseTool`** (no `SendMessage` entry in either governor
     log) — the SDK rejects it as unregistered *before* any permission check. So the
     governor's static ESCALATE verdict for SendMessage is **moot in practice**: the tool
     never gets to the governor.
   - run 2's `teammateMode:"in-process"` project setting did **not** enable it — same error,
     and the frontend reported it "received NO message from backend" (6× `SEND_MESSAGE_UNAVAILABLE`).
   - The prior `run-summary.json` field `sendMessageFromSubagent: 1` counts the *attempt*, not
     a delivery — the attempt errored. Corrected here.
   - The teams still finished the task, but via **workarounds**, not messaging: run 1 the lead
     `TaskStop`'d the parked frontend and re-spawned it with the notification **relayed in the
     prompt**; run 2 used a **file-polling** fallback.

4. **`Workflow`** — not exercised live (no `Workflow` tool_use occurred). Static verdict:
   ESCALATE (default). Given `SendMessage` (a sibling orchestration tool) is "not enabled in
   this context," `Workflow` is very likely also not surfaced to the plain SDK `query()` path,
   but this is **untested** — do not assume.

---

## STEP 3 — VERDICT

| Capability | Result | Basis |
|-----------|--------|-------|
| Spawn named subagent team (Agent) | ✅ WORKS | 3 Agent spawns, parent_tool_use_id set |
| Path-fence inside subagents | ✅ HOLDS | in-fence allows + live `deny(fence)` on /tmp |
| Inter-agent `SendMessage` | ✗ NOT ENABLED | SDK tool_result "not enabled in this context", both runs; teammateMode didn't help |
| `Workflow` under governor | — untested live | static: ESCALATE |

### Governor static verdicts (recap)
- `Agent` → **ALLOW** (SAFE_TOOLS, governor.ts:29-30/58) — but SDK never consults canUseTool for it.
- `SendMessage` → **ESCALATE** (default, governor.ts:79) — **moot**; SDK rejects it before canUseTool.
- `Workflow` → **ESCALATE** (default, governor.ts:79) — untested live.
- Fence on subagent writes → **applies** (single canUseTool closure captures parent folder; verified live).

### GO / NO-GO

- **GO** for a **lead-orchestrated subagent team** (one worker spawns named subagents that do
  work and return results to the lead; the lead relays/sequences). The path-fence protects
  every subagent write. No governor change required.
- **NO-GO** for **peer-to-peer `SendMessage` messaging between agents** on the current Agent
  SDK — the tool is "not enabled in this context" in headless `query()`, and the
  `teammateMode:"in-process"` setting did not enable it. Coordinate via lead relay or a
  shared-file handoff instead.

### Minimal wiring (if adopting the lead-orchestrated team)

1. **session-runner.ts** — thread an `agents` map into SDK options:
   - Add to `RunDeps`: `agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>`.
   - Add to `runConfig()` (near session-runner.ts:331): `if (deps.agents) c.agents = deps.agents;`
   - `sdkOptions` already spreads `runConfig(deps)` (`...extra`), so nothing else changes.
2. **governor.ts** — **no change needed.** `Agent`/`Task` are already in `SAFE_TOOLS`; subagent
   Write/Edit already fence correctly through the same `canUseTool`.
3. **Do NOT** add `SendMessage`/`Workflow` to the allowlist as a way to get messaging — the SDK
   doesn't surface those tools, so an allowlist entry would be dead. Build coordination as
   lead-relay or file-handoff. If a future SDK build enables teammate messaging, revisit and
   (only then) add `SendMessage` to `SAFE_TOOLS`.
