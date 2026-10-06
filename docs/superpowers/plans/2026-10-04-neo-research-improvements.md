# Neo research improvements: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Read `CLAUDE.md` first.

**Status:** PLAN ONLY. Waiting for operator approval. No engine code is changed by this document.

**Goal:** Turn the 2026-10-04 research into phased, TDD engine work. Neo then works unattended for
longer, wakes the model only when there is work, proves "done", asks the operator less often, and
learns from corrections. Every phase extends an existing module.

**Architecture:** All phases are deterministic engine changes: scheduler, triggers, governor,
dispatch, ledger, frontends. AI stays inside workers. The engine only gates, runs commands, counts,
routes and records. Each phase lands behind config with today's behaviour as the default, so an
un-configured daemon behaves exactly as now.

**Tech Stack:** Bun + TypeScript, `bun:sqlite` ledger, grammy, `@anthropic-ai/claude-agent-sdk`
0.3.289 (pinned), `@openai/codex-sdk` 0.145.0 (pinned).

**Spec:** the research in `docs/research/2026-10-04-neo-research/` and the idea→code map
`docs/research/2026-10-04-neo-research-idea-map.md`. The map has the status of every idea and the
reason for each kept, merged, deferred or dropped verdict. This plan covers only the kept ideas.

## Global Constraints

- No AI in the engine. A gate, a check, a detector or a counter is code. Judgement runs in a worker.
- Customer firewall unchanged: `source:"customer"` never reaches the subscription. Customer text
  never reaches a worker that has tools (`TAINTED_DISALLOWED_TOOLS`, no MCP).
- Governor stays default-escalate (ADR-0006 hook first). Trust never lifts a fence escalation
  (ADR-0011). A new rule can make the governor stricter. It can make it looser only through an
  operator tap or command, never through worker text.
- Autonomy widens only by an operator action. Nothing promotes itself.
- No hardcoding: every number or token added is a `config.json` knob with env → file → default
  precedence (`src/config.ts`), documented in `docs/CONFIG.md`. The default keeps today's behaviour.
- Restart-gated: every phase changes daemon code. Report "needs a restart" and wait. Never restart
  without the operator.
- Branch per phase off `master` (`feat/research-p<N>-<slug>`), never commit to `master` directly.
- `bunx tsc --noEmit` + `bun test` green before a task is done. One commit per task. Commit trailer:
  the model that actually wrote the commit.
- Each phase starts with its DESIGN step: `CONTEXT.md` terms + an ADR for each real decision,
  rejected alternatives included. The terms each phase needs are listed under it.
- Docs in the same commit as the behaviour: `docs/CONFIG.md`, `docs/HISTORY.md`, `README.md` where
  it lists commands, `docs/loops.md` for loop changes.
- Operator-facing text added to the web console follows the engineering baseline (i18n catalogues,
  AR + EN). Telegram lines follow the existing `format.ts` / `priority.ts` styling path.

## Review Focus

1. **A gate or script command that hangs or prints megabytes.** The tick must not stall. Expect a
   timeout (`loopGateTimeoutMs`) and a capped stdout (`loopGateMaxOutputChars`). The pinning tests
   are in Task 1.1.
2. **Two channels answer the same approval at once.** Exactly one verdict wins. The other channel
   shows "already answered on X". It must never double-resolve or throw. Pinned in Task 0.1.
3. **A typed "yes" while two approvals are open in the same chat.** This is ambiguous, so the
   engine re-prompts and resolves neither. Pinned in Task 0.2.
4. **An `at` loop whose time passed while the daemon was down.** It fires once at the next tick,
   then disables itself. It must never fire twice and never be silently skipped. Pinned in Task 1.4.
5. **A worker that writes the silence token inside a real report.** Only a reply whose whole
   trimmed text is the token is silent. Any other text is delivered. Pinned in Task 1.3.

---

## Phase order and why

| Phase | What | Size | Why this position |
|---|---|---|---|
| **P0** | Close the open channel gaps: any-channel approvals, typed yes/no, `/now` steer, Codex governor spike | S–M | Every later phase assumes the operator can answer from anywhere. These are the July HIGH issues still open. |
| **P1** | Zero-token loops: script gate, script-only loops, silence token, quiet-loop alert, `at` trigger, honest loop budget, permission denials | S each | Cheapest gain in unattended work. P2 and P5 build on the gate. |
| **P2** | Morning brief / heartbeat with a silence contract, plus `/memory` | S–M | Extends the secretary loop and uses P1's gate and silence token. |
| **P3** | Verified done: checks on every dispatch, judge deficiencies, evidence on the result | M | The largest quality gain: a dispatch is "done" only when its checks pass. |
| **P4** | Approval that scales: rules table, `/never`, scoped grants, offers, outbound content scan, `/audit` | M | Removes approval noise without loosening the governor. |
| **P5** | Event triggers: `/fire`, loops proposed from chat, CI/PR reactions | M | Uses P1's gate and P3's checks. |
| **P6** | Parallel work: opt-in worktree slots per project, `dispatch_many` | M | Needs P3, so parallel results are verified. Amends ADR-0008. Operator decision. |
| **P7** | Learning: correction events, dream-loop proposals, staged skill proposals | M | Needs memory turned on and P4's rules. |
| **P8** | Company layer: goals on the todo board, departments, evening plan / weekly review | L | Needs P2, P3 and P6. Gets its own spec before any code. |

**Plan depth:** P0 and P1 are written out in full TDD steps, because they are built first. P2–P8
list the tasks, files, interfaces and the tests each must pin. Before each later phase is built, it
gets its own expansion into full steps (`docs/superpowers/plans/<date>-research-p<N>.md`), written
against the code as it is then. Writing P5–P8 down to the line now would describe code that P0–P4
will change.

## Operator decisions this plan needs (asked through `ask_operator` at the phase that needs them)

1. **P2/P7:** turn memory on for the company (`"memory": { "scopes": ["company"] }`). Without it,
   P2 works but P7 has nothing to learn into.
2. **P6:** allow more than one todo at a time per project (worktree slots). ADR-0008 says one at a
   time, which the operator asked for. Default stays `1`.
3. **P1 (optional task 1.7):** give loop workers `ask_operator`. ADR-0004 rejected this for now
   because it re-prices every built-in loop.
4. **P0 Task 0.4:** only if the spike shows that Codex cannot be governed headless. Then the
   standard fail-closed default (`read-only` sandbox, `approvalPolicy:"never"`) applies, and the
   operator decides whether to opt a folder into `workspace-write`.

---

## P0 — Close the open channel gaps

**DESIGN step:** `CONTEXT.md` gains **Open approval** (an escalation waiting for a verdict, owned by
the engine, answerable from any operator channel; the first verdict wins) and **Steer** (an operator
message that interrupts the current turn and is resent at once with the interrupted brief). New ADR
`0012-an-approval-is-engine-owned-and-answerable-from-any-channel.md`. Rejected alternatives: keep
per-frontend maps and mirror them (two sources of truth); the full `OperatorHub` refactor now (no
third channel needs it yet).

### Task 0.1: Engine-owned approval board

**Files:**
- Create: `src/engine/approvals.ts`
- Test: `tests/approvals.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Verdict = "allow" | "deny";
  export interface OpenApproval { id: string; chatId: number; reason: string; decisionId: string; openedAt: number }
  export interface ApprovalBoard {
    /** Opens an approval. The promise resolves once, with the first verdict from any channel. */
    open(a: Omit<OpenApproval, "id" | "openedAt">): { id: string; verdict: Promise<Verdict> };
    /** First call wins → true. Unknown or already-resolved id → false. Never throws. */
    resolve(id: string, verdict: Verdict, by: string): boolean;
    /** Open approvals raised in this chat, oldest first. */
    openIn(chatId: number): OpenApproval[];
    /** Called once per resolved approval, so every surface can update its card. */
    onResolved(fn: (a: OpenApproval, verdict: Verdict, by: string) => void): () => void;
  }
  export function createApprovalBoard(now?: () => number): ApprovalBoard;
  /** Maps typed text to a verdict: yes/y/allow/approve/ok/نعم/موافق → allow; no/n/deny/reject/لا/رفض → deny. Otherwise undefined. */
  export function parseTypedVerdict(text: string): Verdict | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/approvals.test.ts
import { describe, expect, test } from "bun:test";
import { createApprovalBoard, parseTypedVerdict } from "../src/engine/approvals";

describe("approval board", () => {
  test("first verdict wins; a second is refused", async () => {
    const b = createApprovalBoard(() => 1);
    const { id, verdict } = b.open({ chatId: 7, reason: "git push", decisionId: "d1" });
    expect(b.resolve(id, "allow", "web")).toBe(true);
    expect(b.resolve(id, "deny", "telegram")).toBe(false);
    expect(await verdict).toBe("allow");
    expect(b.openIn(7)).toEqual([]);
  });

  test("onResolved fires once with the winning channel", () => {
    const b = createApprovalBoard(() => 1);
    const seen: string[] = [];
    b.onResolved((_a, v, by) => seen.push(`${v}@${by}`));
    const { id } = b.open({ chatId: 7, reason: "r", decisionId: "d" });
    b.resolve(id, "deny", "telegram");
    b.resolve(id, "allow", "web");
    expect(seen).toEqual(["deny@telegram"]);
  });

  test("unknown id is false, never a throw", () => {
    expect(createApprovalBoard().resolve("nope", "allow", "web")).toBe(false);
  });

  test("a throwing listener does not block the verdict", async () => {
    const b = createApprovalBoard();
    b.onResolved(() => { throw new Error("dead surface"); });
    const { id, verdict } = b.open({ chatId: 1, reason: "r", decisionId: "d" });
    expect(b.resolve(id, "allow", "web")).toBe(true);
    expect(await verdict).toBe("allow");
  });

  test("openIn lists oldest first, per chat", () => {
    let t = 0;
    const b = createApprovalBoard(() => ++t);
    b.open({ chatId: 1, reason: "a", decisionId: "1" });
    b.open({ chatId: 2, reason: "x", decisionId: "2" });
    b.open({ chatId: 1, reason: "b", decisionId: "3" });
    expect(b.openIn(1).map((a) => a.reason)).toEqual(["a", "b"]);
  });
});

describe("parseTypedVerdict", () => {
  test.each([["yes", "allow"], ["Allow", "allow"], [" ok ", "allow"], ["نعم", "allow"],
             ["no", "deny"], ["Deny", "deny"], ["لا", "deny"]])("%s → %s", (t, v) => {
    expect(parseTypedVerdict(t)).toBe(v as "allow" | "deny");
  });
  test("anything else is not a verdict", () => {
    expect(parseTypedVerdict("yes but first run the tests")).toBeUndefined();
    expect(parseTypedVerdict("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `bun test tests/approvals.test.ts`. Expected: FAIL,
  module `../src/engine/approvals` not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/engine/approvals.ts
// The ONE owner of open approvals (ADR-0012). A governor escalation opens one here; any operator
// channel resolves it; the first verdict wins and every surface is told. Pure, no I/O.
export type Verdict = "allow" | "deny";
export interface OpenApproval { id: string; chatId: number; reason: string; decisionId: string; openedAt: number }
export interface ApprovalBoard {
  open(a: Omit<OpenApproval, "id" | "openedAt">): { id: string; verdict: Promise<Verdict> };
  resolve(id: string, verdict: Verdict, by: string): boolean;
  openIn(chatId: number): OpenApproval[];
  onResolved(fn: (a: OpenApproval, verdict: Verdict, by: string) => void): () => void;
}

const ALLOW = new Set(["yes", "y", "allow", "approve", "ok", "نعم", "موافق"]);
const DENY = new Set(["no", "n", "deny", "reject", "لا", "رفض"]);

export function parseTypedVerdict(text: string): Verdict | undefined {
  const t = text.trim().toLowerCase();
  if (ALLOW.has(t)) return "allow";
  if (DENY.has(t)) return "deny";
  return undefined;
}

export function createApprovalBoard(now: () => number = Date.now): ApprovalBoard {
  const open = new Map<string, { a: OpenApproval; settle: (v: Verdict) => void }>();
  const listeners = new Set<(a: OpenApproval, v: Verdict, by: string) => void>();
  return {
    open(input) {
      const a: OpenApproval = { ...input, id: crypto.randomUUID(), openedAt: now() };
      let settle!: (v: Verdict) => void;
      const verdict = new Promise<Verdict>((r) => (settle = r));
      open.set(a.id, { a, settle });
      return { id: a.id, verdict };
    },
    resolve(id, verdict, by) {
      const entry = open.get(id);
      if (!entry) return false;
      open.delete(id);
      entry.settle(verdict);
      for (const fn of listeners) {
        try { fn(entry.a, verdict, by); } catch { /* a dead surface never blocks the verdict */ }
      }
      return true;
    },
    openIn(chatId) {
      return [...open.values()].map((e) => e.a).filter((a) => a.chatId === chatId).sort((x, y) => x.openedAt - y.openedAt);
    },
    onResolved(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

The verb lists are part of the protocol, not tunable values, like `RISKY_BASH`. Record that in
ADR-0012 so that a reviewer does not read them as hardcoding.

- [ ] **Step 4: Run to verify it passes.** `bun test tests/approvals.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/engine/approvals.ts tests/approvals.test.ts docs/adr/0012-*.md CONTEXT.md && git commit -m "feat(approvals): engine-owned approval board, first verdict wins"`

### Task 0.2: Telegram and web resolve through the board; a typed yes/no answers

**Files:**
- Modify: `src/frontends/telegram.ts:239` (`pending` map), `:443-467` (`askApproval`), `:530-560`
  (text handler), `:818-830` (callback handler)
- Modify: `src/engine/web-channel.ts:131-138` (`askApproval`) and its `POST /approve` resolver
- Modify: `src/daemon.ts` (create one board, pass it to both frontends, the same way it shares `bus`)
- Test: `tests/telegram-commands.test.ts` (existing grammy `client.fetch` fixture), `tests/web-channel.test.ts`

**Interfaces:**
- Consumes: `ApprovalBoard`, `parseTypedVerdict` (Task 0.1).
- Produces: `createTelegramBot(..., approvals: ApprovalBoard)` and `createWebChannel({ ..., approvals })`.

- [ ] **Step 1: Write the failing tests.** Add to `tests/telegram-commands.test.ts`, using the file's existing bot + fake-fetch helpers:
  - `"a typed 'yes' resolves the one open approval in that chat"`: open an approval via
    `deps.askApproval(chat, "git push")`, send text `yes` from the admin, expect the promise to resolve
    `"allow"` and the pipeline's `handleMessage` NOT to be called.
  - `"with two open approvals a typed 'yes' resolves neither and re-prompts"`: expect both still in
    `board.openIn(chat)` and one outgoing message that contains `reply to the approval message`.
  - `"a web verdict edits the Telegram card"`: resolve via `board.resolve(id, "deny", "web")`. Expect an
    `editMessageText` call whose text contains `Denied on web`.
  - `"Allow/Deny buttons are coloured"`: expect the `sendMessage` payload `reply_markup` to carry
    `style: "success"` on Allow and `style: "danger"` on Deny.
  Add to `tests/web-channel.test.ts`: `"POST /approve after Telegram answered returns false"`.
- [ ] **Step 2: Run.** `bun test tests/telegram-commands.test.ts tests/web-channel.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - `askApproval` on both surfaces: `const { id, verdict } = approvals.open({ chatId, reason, decisionId })`.
    Post the card, keep `id → messageId` in a local map (only for editing), `return verdict`.
  - Telegram callback: `approvals.resolve(token, verdict, "telegram")`. When false, answer
    `"Already answered"`.
  - `approvals.onResolved` on Telegram: `resolveEscalationDecision(ledger, a.decisionId, v)` (moved here
    from the callback, so it runs once for any channel) and edit the card to
    `${v === "allow" ? "Allowed" : "Denied"} on ${by}`, with the buttons removed. On web: emit
    `{ type: "resolved", id, verdict, by }` on the SSE stream.
  - Text handler: put this first, before the inbox-edit branch.
    `const v = parseTypedVerdict(text); const open = approvals.openIn(chatId);`
    One open approval and a verdict → resolve it, `say("✓ ${v}")`, return. Two or more → say
    `"N approvals are open — reply to the approval message, or tap its button."` and return. Otherwise fall through.
  - A quote-reply to an approval card with a verdict word resolves that card, even when several are open.
  - Buttons: `InlineKeyboard` `.text()` takes no style. Build the keyboard as a raw
    `reply_markup: { inline_keyboard: [[{ text: "Allow", callback_data: "a:"+id, style: "success" }, { text: "Deny", callback_data: "d:"+id, style: "danger" }]] }`
    (Bot API 9.4 `style`. Older clients ignore it).
- [ ] **Step 4: Run** the two files, then `bunx tsc --noEmit && bun test`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(approvals): answer an approval from any channel or by typing yes/no`. The same
  commit updates `docs/HISTORY.md` and the investigation file (mark Issue 4 fixed, with the commit).

### Task 0.3: `/now <message>`: steer a running turn

**Files:**
- Modify: `src/engine/pipeline.ts` (the follow-up branch around `:196-220`)
- Modify: `src/engine/commands.ts` (help text only, because `/now` must reach the pipeline, not the sync command table)
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `SessionControl.interrupt(): Promise<void>`, `followUp(text)`, `active?()` (`src/types.ts:59-69`),
  and the re-send used by the API-retry follow-up (`apiRetryFollowUp` in `pipeline.ts`).

- [ ] **Step 1: Failing tests** in `tests/pipeline.test.ts`, with the file's fake `SessionControl`:
  - `"/now on an in-turn session interrupts, then sends the steer text with a note"`: expect `interrupt`
    to be called once, then `followUp` with text that starts `[operator steer — your previous turn was interrupted]`
    and contains the message.
  - `"/now on a between-turns session is a plain follow-up (no interrupt)"`.
  - `"/now with no live session says so and starts nothing"`.
- [ ] **Step 2: Run.** `bun test tests/pipeline.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `handleMessage`, before the normal follow-up path: when the text starts with
  `/now `, resolve the target the same way a follow-up does (focus → default). When `control.active?.()` is
  true, `await control.interrupt()`, then `control.followUp(steerText)`. Record an `operator_steer` event.
  The interrupt drops in-flight tool work. The help line says so: `/now <msg> — interrupt the current turn and send this now (in-flight work is dropped)`.
  If `interrupt()` closes the input channel (check `closed?()`), resume with the same seed the API-retry
  path uses. Write a test for that path first.
- [ ] **Step 4: Run.** `bunx tsc --noEmit && bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipeline): /now steers a running turn`. Update the investigation (Issue 1) and HISTORY.

### Task 0.4: Codex governor spike, then a fail-closed mapping

**Files:**
- Create (throwaway, not committed): `spike/codex-approval.ts`
- Modify: `src/engine/session-runner.ts:600-614` (`codexThreadOptions`), `src/config.ts`
- Test: `tests/session-runner-config.test.ts`
- Docs: `docs/sdk-notes.md` (the finding), ADR `0013-codex-runs-fail-closed-without-a-governor.md`

- [ ] **Step 1: Spike** (read-only scratch folder under `/tmp`): run one Codex thread with today's options
  (`workspace-write`, `on-request`) and a brief that asks for `git push --dry-run` and a write outside the folder.
  Record what happens: auto-approved, refused, or hung. Record whether the SDK exposes an approval callback.
  Write the result in `docs/sdk-notes.md`.
- [ ] **Step 2: Failing tests** in `tests/session-runner-config.test.ts`:
  - `"codex defaults to read-only sandbox and approvalPolicy never"` (when the spike shows no approval hook).
  - `"a folder in cfg.codex.writableFolders gets workspace-write, network off"`.
  - `"a customer-sourced order can never get workspace-write"`.
- [ ] **Step 3: Implement** the defaults behind new config `codex: { writableFolders: string[] }` (default `[]`).
  If the spike shows a usable approval hook, wire it to `decide()` instead and change the tests to match. Either way,
  ADR-0013 records the finding and the rejected alternative.
- [ ] **Step 4: Run.** `bunx tsc --noEmit && bun test`. **Step 5: Commit** `fix(codex): runs fail closed without a governor`. Update `docs/CONFIG.md`.

---

## P1 — Zero-token loops

**DESIGN step:** `CONTEXT.md` gains **Gate** (a command the engine runs before a loop fire. No
output or a non-zero exit means the fire is skipped and no worker runs. Its output goes into the
brief), **Script loop** (a loop whose action is a command, not a worker), **Silence token** and
**Quiet loop**. ADR `0014-a-loop-wakes-a-worker-only-when-its-gate-says-so.md`. Rejected: an
AI pre-check (AI in the engine); a gate inside the worker prompt (still costs a run).

### Task 1.1: `LoopDef.gate`, and the built-in gates move onto the same path

**Files:**
- Create: `src/engine/loop-gate.ts`
- Modify: `src/engine/goal.ts:17-52` (extract the spawn into `runCommand`, and `commandGoal` uses it)
- Modify: `src/engine/loops.ts` (`LoopDef` gains `gate?`; `startLoop` `:521` and `startScheduledLoop` `:583` call `preFire`)
- Modify: `src/daemon.ts:236-246` (the secretary branch goes through `preFire` too)
- Modify: `src/engine/loop-validate.ts` (validate `gate`), `src/config.ts` (`loopGateTimeoutMs` default 60000, `loopGateMaxOutputChars` default 4000)
- Test: `tests/loop-gate.test.ts`, `tests/goal.test.ts`, `tests/loop-validate.test.ts`, `tests/secretary-loop.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // goal.ts
  export interface CommandRun { exit: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }
  export function runCommand(opts: { command: string[]; cwd: string; timeoutMs?: number; maxOutputChars?: number }): Promise<CommandRun>;
  // loop-gate.ts
  export type GateResult = { fire: true; context?: string } | { fire: false; detail: string };
  export function runGate(gate: { command: string[]; timeoutMs?: number }, cwd: string, cfg: Pick<NeoConfig, "loopGateTimeoutMs" | "loopGateMaxOutputChars">): Promise<GateResult>;
  /** One pre-fire path: the built-in gates (dream, secretary), then the script gate. Returns the loop to run (prompt + gate context) or a 0-iteration outcome. */
  export function preFire(loop: LoopDef, deps: { cfg?: NeoConfig; ledger?: Pick<Ledger, "listOpenDecisions" | "recordEvent"> }): Promise<{ run: LoopDef } | { skip: LoopOutcome }>;
  ```

- [ ] **Step 1: Failing tests** (`tests/loop-gate.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { runGate } from "../src/engine/loop-gate";
const cfg = { loopGateTimeoutMs: 2000, loopGateMaxOutputChars: 50 };

describe("runGate", () => {
  test("exit 0 with output fires and carries the output", async () => {
    expect(await runGate({ command: ["sh", "-c", "echo 2 new issues"] }, "/tmp", cfg)).toEqual({ fire: true, context: "2 new issues" });
  });
  test("exit 0 with empty output skips", async () => {
    const r = await runGate({ command: ["true"] }, "/tmp", cfg);
    expect(r.fire).toBe(false);
  });
  test("non-zero exit skips with the exit code in detail", async () => {
    const r = await runGate({ command: ["sh", "-c", "exit 3"] }, "/tmp", cfg);
    expect(r).toEqual({ fire: false, detail: expect.stringContaining("exit 3") });
  });
  test("a hanging gate times out and skips", async () => {
    const r = await runGate({ command: ["sleep", "10"], timeoutMs: 100 }, "/tmp", cfg);
    expect(r).toEqual({ fire: false, detail: expect.stringContaining("timed out") });
  });
  test("huge output is capped", async () => {
    const r = await runGate({ command: ["sh", "-c", "yes x | head -c 100000"] }, "/tmp", cfg);
    expect(r.fire && r.context!.length).toBeLessThanOrEqual(50 + 20); // cap + truncation marker
  });
  test("a missing binary skips, never throws", async () => {
    const r = await runGate({ command: ["/no/such/bin"] }, "/tmp", cfg);
    expect(r.fire).toBe(false);
  });
});
```

  Also: `tests/goal.test.ts` keeps every existing `commandGoal` case green, because the refactor must not change it.
  `tests/secretary-loop.test.ts` adds `"preFire skips the secretary on an empty queue (same outcome as before)"`.
  `tests/loop-validate.test.ts` adds `"gate.command must be a non-empty string array"`.
- [ ] **Step 2: Run.** `bun test tests/loop-gate.test.ts tests/goal.test.ts tests/secretary-loop.test.ts tests/loop-validate.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - `runCommand`: move the body of `commandGoal` (`goal.ts:17-52`) into it and add `maxOutputChars` truncation
    (`…[truncated]`). `commandGoal` becomes `runCommand` + the existing `detail` formatting.
  - `runGate`: `exit===0 && stdout.trim()` → `{ fire: true, context }`, else `{ fire: false, detail }`.
  - `preFire`: `dreamGateOutcome` → `secretaryGateOutcome` → `runGate`. On fire, append
    `\n\n## Gate output (what changed)\n${context}` to `prompt`. On skip, `recordEvent("loop_gated", { loop, detail })`.
    The scheduler has already written `lastRun`, so a gated fire still counts as run, and a gate that always
    skips never spins.
  - `startLoop`, `startScheduledLoop` and the daemon secretary branch call `preFire` instead of their
    hand-written gate checks. That deletes the duplicate gate code.
- [ ] **Step 4: Run.** `bunx tsc --noEmit && bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(loops): a script gate decides whether a loop wakes a worker`. Docs: `docs/loops.md` (gate section + example
  `gh issue list --search "is:open updated:>=$(date -d '-1 hour' +%FT%T)" --json number --jq '.[].number'`), `docs/CONFIG.md`.

### Task 1.2: Script-only loops

**Files:** Modify `src/engine/loops.ts` (`LoopDef.action?: { kind: "script"; command: string[]; timeoutMs?: number }`),
`src/engine/loop-validate.ts`. Test: `tests/loops.test.ts`.

**Interfaces:** Consumes `runCommand` (Task 1.1). Produces `runScriptLoop(loop, deps): Promise<LoopOutcome>`.

- [ ] **Step 1: Failing tests:** `"script loop: non-empty stdout is delivered word for word, no worker run"`. Assert that
  `deps.run` (the worker fake) is never called and that `reply` got the exact stdout.
  `"script loop: empty stdout is silent"`. `"script loop: non-zero exit sends one alert line with exit + last stderr line"`.
  `"validation: a script loop needs no goal; goal defaults to {kind:'command', command:['true']}"`.
- [ ] **Step 2: Run** `bun test tests/loops.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** a branch at the top of `startScheduledLoop` / `startLoop`, after `preFire`. It returns
  `{ met: exit===0, iterations: 1, reason: "stopped", lastDetail, spentUsd: 0 }`. The alert uses the `alert` priority.
- [ ] **Step 4: Run all.** **Step 5: Commit** `feat(loops): script-only loops (no worker, no budget)`. Update `docs/loops.md`.

### Task 1.3: Silence token, archived quiet output, quiet-loop alert

**Files:** Modify `src/engine/loops.ts` (`startScheduledLoop` `onMessage`), `src/config.ts` (`loopSilentToken` default
`"NEO_SILENT"`, `loopQuietAlertAfter` default `0` = off), `src/engine/ledger.ts` (`loop_state` gains `quiet_runs`, migration-guarded),
`src/daemon.ts` (`onError` alerts go through `faults` signature dedupe). Tests: `tests/loops.test.ts`, `tests/loop-state.test.ts`, `tests/scheduler.test.ts`.

- [ ] **Step 1: Failing tests:**
  - `"a reply that is exactly the silence token is not delivered but is recorded as loop_silent"`.
  - `"a report that mentions the token inside other text is delivered"` (Review Focus 5).
  - `"after loopQuietAlertAfter fires with no output and goal not met, one alert is sent, then the counter resets"`.
  - `"the same loop failing twice inside the dedupe window alerts once"` (through `faults`).
- [ ] **Step 2: Run.** **Step 3: Implement.** Compare `text.trim() === cfg.loopSilentToken`. Archive the event with
  `recordEvent("loop_silent", { loop })`, never the body (event-log policy). Every built-in loop prompt that today
  says "say nothing when there is nothing to report" also names the token.
- [ ] **Step 4: Run all.** **Step 5: Commit** `feat(loops): silence token + quiet-loop alert + deduped failure alerts`.

### Task 1.4: `at` trigger (one-shot)

**Files:** Modify `src/engine/trigger.ts` (`| { kind: "at"; atMs: number }`), `src/engine/scheduler.ts`
(after an `at` fire: `store.setEnabled(name, false)`), `src/engine/heartbeat.ts` (an `at` loop contributes `CRON_RESOLUTION_MS`),
`src/engine/loop-validate.ts` (ISO time string → `atMs`, must be in the future at create time). Tests:
`tests/trigger.test.ts`, `tests/scheduler.test.ts`, `tests/heartbeat.test.ts`, `tests/loop-validate.test.ts`.

- [ ] **Step 1: Failing tests:**

```ts
test("at: due once when now >= atMs and never run", () => {
  expect(isDue({ kind: "at", atMs: 1000 }, undefined, 999)).toBe(false);
  expect(isDue({ kind: "at", atMs: 1000 }, undefined, 1000)).toBe(true);
  expect(isDue({ kind: "at", atMs: 1000 }, 1000, 5000)).toBe(false);
});
test("at: a time missed while the daemon was down fires at the next tick, then disables", () => {
  // tickScheduler with lastRun undefined, now = atMs + 3h → start called once, setEnabled(name,false)
});
```

- [ ] **Step 2–4:** Run, implement, run all. **Step 5: Commit** `feat(trigger): one-shot "at" trigger`. Update `docs/loops.md`.

### Task 1.5: Honest loop budget: judge cost counts, judge timeout works, daily fire cap

**Files:** Modify `src/engine/goal.ts` (`GoalCheck` returns `{ met, detail, costUsd? }`; `judgeGoal` returns the judge run's
`costUsd` and honours `timeoutMs` by interrupting the run), `src/engine/loop-runner.ts:54` (`spentUsd += goal.costUsd ?? 0`),
`src/engine/project-loop.ts:16` (comment matches the code), `src/engine/scheduler.ts` (optional `bounds.maxFiresPerDay`; at the cap,
skip and send one "paused at cap" notice per day). Tests: `tests/goal.test.ts`, `tests/loop-runner.test.ts`, `tests/scheduler.test.ts`.

- [ ] **Step 1: Failing tests:** `"runLoop adds the judge's cost to spentUsd"`; `"over-budget triggers on worker+judge spend"`;
  `"judgeGoal with timeoutMs stops a slow judge and reports not-met"`; `"maxFiresPerDay: the 3rd fire of a cap-2 loop is skipped with one notice"`.
- [ ] **Step 2–4.** **Step 5: Commit** `fix(loops): the loop budget counts judge runs; judge timeout works; daily fire cap`.
  Update the memory note `loop-budget-and-ask-operator-gaps` (gap 2 closed).

### Task 1.6: Permission denials reach the loop digest

**Files:** Modify `src/engine/session-runner.ts` (`RunResult.permissionDenials?: { tool: string }[]` read from the SDK
`result.permission_denials`, which exists in 0.3.289 `sdk.d.ts`), `src/engine/loops.ts` (a scheduled fire with denials sends one
line: `#proj loop X: 3 actions were denied (Bash ×2, WebFetch)`). Tests: `tests/session-runner.test.ts`, `tests/loops.test.ts`.

- [ ] **Steps 1–5** as above. Commit `feat(loops): report denied actions instead of losing them`.

### Task 1.7 (operator decision 3, optional): `ask_operator` for loop workers

Only if the operator says yes. Attach `neoMcpServers` (the `ask_operator` tool only, no `dispatch`) in `loopRunExtras`. A loop's
decision posts with the loop name as project. This amends ADR-0004. Tests in `tests/loops.test.ts`:
`"a loop worker's ask_operator raises a tracked decision"`; `"a loop worker gets no dispatch or scheduling tool"` (spec 2026-07-23 item 10b).

---

## P2 — Morning brief / heartbeat with a silence contract, plus `/memory`

**DESIGN:** terms **Brief** and **Brief snapshot**. ADR `0015-the-brief-is-the-secretary-with-a-wider-snapshot.md`.
Rejected: a second digest loop beside the secretary (a second implementation).

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 2.1 Brief snapshot | Create `src/engine/brief-snapshot.ts` (pure). It reuses `listOpenDecisions`, `sessionStatuses` (`session-status.ts`), todo queue state, loop `lastRun` + last outcome events, `Meter` spend, undelivered dispatcher-inbox rows | `briefSnapshot(deps, now): { text: string; hash: string }` | Same inputs → same hash; a changed decision → new hash; no secrets or bodies in the text |
| 2.2 Secretary → brief | Modify `loops.ts` `resolveSecretaryLoop`: the `{{OPEN_DECISIONS}}` placeholder grows a `{{BRIEF}}` sibling; `secretaryGateOutcome` → a `preFire` gate "snapshot hash unchanged since the last brief" (ledger `loop_state.last_hash`). Worker profile `workers.secretary`, run with `READONLY_DENY` | config `briefCron` (default unset = secretary behaviour unchanged) | Unchanged snapshot → no worker run; worker reply = silence token → nothing sent; the brief goes to the Decisions chat; a read-only run cannot Write/Bash |
| 2.3 `/memory` | Modify `commands.ts`: `/memory [scope]` shows the capped files; `/memory forget <text>` → `applyMemoryOp(remove)` through the existing scan and backups (`memory.ts`); admin only | — | Forget removes exactly one matching entry; an ambiguous match lists the candidates and changes nothing; memory off → says how to turn it on |

## P3 — Verified done on every dispatch

**DESIGN:** terms **Check**, **Evidence**, **Deficiency**. ADR `0016-a-dispatch-is-green-only-when-its-checks-pass.md`.
Rejected: trust the worker's "done"; a full workflow YAML (YAGNI).

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 3.1 Project-declared checks | Create `src/engine/checks.ts`: read `<folder>/.neo/checks.json` (`{ "checks": [["bun","test"],["bunx","tsc","--noEmit"]] }`); the `dispatch` tool gains an optional `checks: string[][]` that overrides it | `resolveChecks(folder, override?) : string[][]` | Missing file → `[]` (today's behaviour); bad JSON → `[]` + a `checks_invalid` event, never a throw |
| 3.2 Check → resume → report | Modify `dispatch.ts` at the settled end (ADR-0007): run checks with `runCommand`; on failure resume the same session with the failing output, up to `dispatchCheckRetries` (config, default 2) | `DispatchEvidence { checks: {cmd, exit}[]; diffStat: string; costUsd: number; green: boolean }` on the dispatch result + `dispatch_end` event | All pass → green; fail then pass on retry → green with 2 runs recorded; still failing after N → not green, reported as failed, todo `failed` (todo failure policy applies); a stall during a retry is still a stall abort |
| 3.3 Evidence in the result line | Modify `dispatch-report.ts`: the result line carries `✓ 2/2 checks · +120 −30 in 6 files · $1.84`, or `✗ bun test exit 1` | — | Green requires checks to have run; "no checks declared" is shown, never shown as green |
| 3.4 Judge deficiencies | Modify `goal.ts` `judgePrompt`: ask for `DEFICIENCY: …` lines; `judgeGoal` returns `deficiencies: string[]`; `loop-runner.ts` passes them into the next iteration's prompt | `GoalCheck` result gains `deficiencies?` | Parsed in order; capped count (config); absent → today's behaviour |

## P4 — Approval that scales

**DESIGN:** terms **Rule** (allow/ask/block · tool · glob · project), **Grant** (a rule with a scope:
once / task / until / always), **Offer**. ADR `0017-block-and-ask-rules-beat-trust.md` (it amends ADR-0011: trust approves an
escalation, a block rule refuses it first). Rejected: an AI approval classifier; auto-promotion.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 4.1 Rules table | Ledger `policy_rules(id, folder, tool, pattern, effect, scope, expires_at, created_by, created_at)`; create `src/engine/policy.ts` (pure matcher, glob on the Bash command / file path / `mcp__server__*`) | `matchRule(rules, tool, input, folder, now): Rule \| undefined` | Order: block > ask > allow; an expired grant is ignored; the fence is never lifted by an allow rule |
| 4.2 Governor consults rules | Modify `governor.ts` `decide()` + `buildGovernorHook` (ADR-0006, one shared `decide`) | `GovernorCtx` gains `rules` | A block rule denies in a trusted folder; an ask rule escalates in a trusted folder; customer path unchanged (zero tools) |
| 4.3 `/never`, `/rules` | `commands.ts`: `/never <tool> <glob>` (block, project-scoped), `/rules`, `/rules rm <id>` | — | Only the admin can create rules; worker text cannot reach this path |
| 4.4 Scoped grant buttons | Approval card gets `Once · This task · 1h · Always · Deny`; Task 0.2's board carries the scope; non-Once writes a grant row | `resolve(id, verdict, by, scope?)` | "This task" ends with the todo/session; "1h" expires; "Always" shows in `/rules` |
| 4.5 Offers | After `grantOfferAfter` (config, default 0 = off) approvals of the same `(folder, tool, pattern)` with no deny, the next card adds "Always allow this?" | — | Never applied without a tap; one deny resets the count |
| 4.6 Outbound content scan | Create `src/engine/outbound-scan.ts` (regex: phone, IBAN, card numbers with Luhn, any `.env` value, operator personal fields from config). Used by inbox Send and by rules with effect `ask` on outbound MCP tools | `scanOutbound(text, ctx): Finding[]` | A hit forces an explicit confirm showing the findings; an `.env` value never appears in the finding text itself |
| 4.7 `/audit` | Create `src/engine/audit.ts`: `.env` mode 600, web bind address, admin claimed, `.gitignore` covers `data/` + `company/`, count of trusted folders, loops whose prompt asks for write tools, Codex sandbox mode (P0.4) | `runAudit(deps): AuditCheck[]` (id, ok, detail, fix?) | Every check has a stable id; `--fix` only for mechanical items (chmod) |

## P5 — Event triggers and reactions

**DESIGN:** terms **Fire request**, **Proposed loop**, **PR link**. ADR `0018-external-fires-are-tainted-unless-the-loop-says-operator-only.md`.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 5.1 `POST /fire/:loop` | `frontends/web.ts` route; per-loop HMAC secret in `.env` (`NEO_FIRE_SECRET_<LOOP>`); body `{ text? }`; text goes into the prompt under `## Fire payload (untrusted)`; a loop with `fire.tainted` runs with `TAINTED_DISALLOWED_TOOLS` and no MCP | `LoopDef.fire?: { tainted: boolean }` | Bad signature → 401, nothing runs; loop without `fire` → 404; tainted run has zero tools; rate-limited by `fireMinIntervalMs` |
| 5.2 Loops proposed from chat | Company MCP tool `propose_loop` → `validateLoopInput` → a decision with the loop summary and **Create / Cancel**; Create calls the existing `createLoop` | — | An invalid proposal is rejected at the tool boundary; a proposed loop can never ask for more tools than the default loop profile (spec 2026-07-23 item 10a); a scheduled run has no `propose_loop` (10b) |
| 5.3 PR links | Ledger `pr_links(repo, pr, folder, sdk_session_id, created_at)`; after a dispatch settles, the engine runs `gh pr list --head <branch> --json number,url` in the folder | — | No `gh` or no PR → no row, no error |
| 5.4 PR reactions loop | Built-in loop `pr-reactions` (disabled by default): a P1 gate runs `gh pr checks` / new review comments for linked PRs; on a failure it resumes the linked session with the log via `deliverIntoFolder`; after `prReactionEscalateAfter` rounds it raises a decision | — | A green PR never wakes a worker; the resume goes to the linked session; escalation after N |

## P6 — Parallel work (operator decision 2)

**DESIGN:** term **Slot**. ADR `0019-a-project-may-run-n-todos-in-separate-worktrees.md` (amends ADR-0008).

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 6.1 Worktree manager | Create `src/engine/worktrees.ts`, reusing the worktree steps in `update-sdk.ts` (extract them, never copy): `git worktree add <folder>/.neo-wt/<todo> -b neo/todo-<id>`, cleanup when merged or on `/todo clean` | `acquire(folder, todoId): { cwd, branch }`, `release(...)` | Non-git folder → slots stay 1; a dirty main checkout never blocks; `.neo-wt/` is git-ignored |
| 6.2 Slots in the todo queue | `todo-queue.ts`: new config map `parallelSlots: { [folder: string]: number }` (absent folder = 1); release starts up to N; each runs with `cwd` = its worktree (the governor fence follows `cwd`); `PORT` from a free-port allocator in `workerEnv` | — | Default 1 = ADR-0008 behaviour exactly; two todos never share a worktree; a reload fails running todos with their stop point as today |
| 6.3 `dispatch_many` | Company MCP tool: N self-contained briefs → N todos + one synthesis todo released when all N end; each result's `DispatchEvidence` (P3) goes into the synthesis brief | — | One failed child still releases synthesis with the failure listed; children never see each other's context |

## P7 — Learning from corrections (needs operator decision 1)

**DESIGN:** terms **Correction**, **Proposal**. ADR `0020-the-agent-proposes-the-operator-approves-every-learned-change.md`.

| Task | Files | Interfaces | Tests that must pin it |
|---|---|---|---|
| 7.1 Correction events | `escalation.ts` (deny), `commands.ts` (`/kill`), `pipeline.ts` (a follow-up within `correctionWindowMs` after a result in the same project) → `recordEvent("correction", { kind, order_id, project })` | — | Pointers only, never bodies; window 0 = off |
| 7.2 Dream loop reads corrections | `loops.ts` `MEMORY_DREAM` prompt gains the last N correction pointers + transcript excerpt ids; the dream writes proposals to `memory/PROPOSALS.md`; each becomes a decision (Apply / Reject); Apply runs `applyMemoryOp` under the dream caps | — | Zero corrections → no change to today's dream run; Reject is recorded; caps still hold |
| 7.3 Staged skill proposals | Worker may write `<folder>/.neo/skill-proposals/<name>/SKILL.md` (inside the fence); the engine checks size (`skillProposalMaxBytes`) and frontmatter, then raises a decision with the diff; Approve copies it into `<folder>/.claude/skills/<name>/` on a branch and commits | — | Oversize or malformed → rejected with a reason; live skill dirs are never written by the worker; Approve commits on a branch, not `master` |

## P8 — Company layer (own spec first)

This phase is large and changes the product model. Before any code it gets its own design spec
(`docs/superpowers/specs/<date>-company-board-design.md`) and an operator review. Scope for that spec:

- **Goals on the board:** a `goals` table (metric, target, review date). `project_todos` gains
  `goal_id`, `acceptance` (a P3 check list or a judge criterion) and a `review` state. It extends
  ADR-0008's todo queue and never adds a second work table.
- **Departments as config:** `departments.<name> = { folders, profile, memoryScope, budgetUsdPerDay, cadence }`.
  This is a view over `workers` profiles, `memory.scopes`, the todo queue and loops. Nothing new in kind.
- **Rhythm:** an evening plan (the company proposes tomorrow's todos as a decision with tap-to-approve)
  and a weekly review, both on P2's brief machinery.
- **Not in scope:** an AI "CEO" that approves, and automatic autonomy levels (dropped, see the map §4).
  Finance stays MVP Phase 4.

---

## Self-review

- **Coverage:** every **Keep** row in the idea map points to a task: P0 (issues 1, 4, 5, Codex,
  colours), P1 (A1–A3, B4, H1, F7), P2 (heartbeat/brief, memory controls, F4), P3 (C1–C3, G1
  checks), P4 (F1–F3, F5, F6, `/audit`), P5 (B1, C4, chat-created loops), P6 (D1, D2), P7
  (E1–E3), P8 (board, departments, rhythm).
- **Names checked across tasks:** `ApprovalBoard.resolve(id, verdict, by)` is extended with `scope?` in 4.4.
  `runCommand` (1.1) is used by 1.2, 3.2 and the gates. `preFire` (1.1) is used by 2.2 and 5.4. `DispatchEvidence`
  (3.2) is used by 3.3 and 6.3. `READONLY_DENY` and `TAINTED_DISALLOWED_TOOLS` are existing exports.
- **Defaults:** every new knob defaults to today's behaviour (`briefCron` unset, `loopQuietAlertAfter` 0,
  `grantOfferAfter` 0, `parallelSlots` 1, `correctionWindowMs` 0, missing `.neo/checks.json` → no checks).
  The one deliberate exception is P0.4's Codex default, which becomes fail-closed.
