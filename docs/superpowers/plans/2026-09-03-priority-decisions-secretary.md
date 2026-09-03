# Priority tags · Decisions queue · Secretary loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking. Read `CLAUDE.md` first.

**Goal:** Tag every outbound operator message with a deterministic priority, route
DECISION/ALERT to a notified "Decisions" channel and PROGRESS/DONE to the muted firehose,
persist a pending-decisions queue in the ledger, and add a secretary loop that digests and
reminds — so nothing blocking is ever lost.

**Architecture:** A pure priority module maps intent → surface (no AI). Existing outbound
choke points (`reply`, `askApproval`, dispatch outcome lines, a new `ask_operator` worker
tool) carry the tag. The Telegram frontend routes by surface. A new `decisions` ledger
table makes the queue durable; answering reuses the existing reply-routing resume path. A
secretary `LoopDef` (same shape as the memory-dream loop) digests the open queue on the
latest model.

**Tech Stack:** Bun + TypeScript · bun:sqlite (ledger) · grammy (Telegram) ·
`@anthropic-ai/claude-agent-sdk` (worker/loop) · `bun test` + `bunx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-03-priority-decisions-secretary-design.md`

## Global Constraints

- **No AI in the engine.** The engine only tags (a deterministic map), routes (a pure
  function), stores (the ledger), and renders queue data. AI lives only inside the
  secretary loop worker (own work, on the subscription).
- **Firewall.** The `ask_operator` tool attaches only through `neoMcpServers` on operator
  paths. The customer/ingress path must never pass its deps, so customer-tainted work can
  never raise a decision.
- **Behavior-preserving defaults.** Un-tagged lines default to `progress` (firehose). With
  `decisionsChatId` unset, DECISION/ALERT still post to the admin DM (today's behavior) but
  are tagged, persisted, and reminded.
- **Machine-local state stays untracked.** `decisionsChatId` and secretary knobs live in
  `.env`/`config.json`, never tracked docs. The queue lives in `data/ledger.db`.
- **TDD.** Write the failing test first. `bun test` + `bunx tsc --noEmit` must be green
  before any task is done. Commit per task.
- **Commit target `dev`-style discipline:** this repo commits completed, green work; never
  to a protected branch without being asked.

---

## File Structure

New:
- `src/engine/priority.ts` — `Priority` type, `surfaceFor`, `priorityBadge` (pure).
- `tests/priority.test.ts`, `tests/decisions.test.ts`, `tests/secretary-loop.test.ts`,
  `tests/decision-answer.test.ts`.

Modified:
- `src/engine/operator-bus.ts` — `priority?` on the `reply` `BusLine`.
- `src/engine/ledger.ts` — `decisions` table + methods.
- `src/engine/dispatch.ts` — reply signature + outcome tags + `ask_operator` tool.
- `src/frontends/telegram.ts` — surface routing, escalation recording, answer resolution.
- `src/engine/loops.ts` — secretary `LoopDef`, `resolveSecretaryLoop`,
  `secretaryGateOutcome`, prompt interpolation.
- `src/engine/commands.ts` — `/decisions` command.
- `src/daemon.ts` — secretary loop wiring + alert priorities.
- `src/config.ts` — `decisionsChatId`, `secretaryCron`, `secretaryStaleHours`,
  `decisionsKeep`, `workers.secretary`.
- `docs/CONFIG.md`, `docs/HISTORY.md`, `README.md`, `docs/loops.md`.

---

## Phase 1 — Priority model + two-surface routing (MVP core)

### Task 1: The priority module

**Files:**
- Create: `src/engine/priority.ts`
- Test: `tests/priority.test.ts`

**Interfaces:**
- Produces: `type Priority = "decision" | "alert" | "progress" | "done"`;
  `surfaceFor(p: Priority): "decisions" | "firehose"`;
  `priorityBadge(p: Priority): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { surfaceFor, priorityBadge } from "../src/engine/priority";

test("decision and alert route to the decisions surface", () => {
  expect(surfaceFor("decision")).toBe("decisions");
  expect(surfaceFor("alert")).toBe("decisions");
});

test("progress and done route to the firehose", () => {
  expect(surfaceFor("progress")).toBe("firehose");
  expect(surfaceFor("done")).toBe("firehose");
});

test("badge is a short non-empty marker per priority", () => {
  for (const p of ["decision", "alert", "progress", "done"] as const) {
    expect(priorityBadge(p).length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/priority.test.ts`
  → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// Deterministic message-priority model. Pure, AI-free: it only maps a sender's INTENT to
// a surface + a display badge. DECISION/ALERT need the operator's attention (the notified
// "Decisions" channel); PROGRESS/DONE are the muted firehose.
export type Priority = "decision" | "alert" | "progress" | "done";

export function surfaceFor(p: Priority): "decisions" | "firehose" {
  return p === "decision" || p === "alert" ? "decisions" : "firehose";
}

export function priorityBadge(p: Priority): string {
  switch (p) {
    case "decision": return "🔷 DECISION";
    case "alert": return "⛔ ALERT";
    case "done": return "✅ DONE";
    default: return "";
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/priority.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(priority): add deterministic message-priority model`.

### Task 2: Carry priority on the operator-bus line

**Files:**
- Modify: `src/engine/operator-bus.ts:14`
- Test: `tests/operator-bus.test.ts` (add a case)

**Interfaces:**
- Consumes: `Priority` (Task 1).
- Produces: `BusLine` `reply` variant gains `priority?: Priority`.

- [ ] **Step 1: Write the failing test** (add to `tests/operator-bus.test.ts`)

```ts
test("a reply line carries its priority to other sinks", () => {
  const bus = createOperatorBus();
  const seen: any[] = [];
  bus.register({ id: "web", deliver: (l) => seen.push(l) });
  bus.mirror("telegram", { kind: "reply", text: "need a call", priority: "decision" });
  expect(seen[0].priority).toBe("decision");
});
```

- [ ] **Step 2: Run to verify it fails** (type error / missing field).
- [ ] **Step 3: Implement** — add `priority?: Priority` to the `reply` variant and import
  the type:

```ts
import type { Priority } from "./priority";
export type BusLine =
  | { kind: "reply"; text: string; project?: string; priority?: Priority }
  | { kind: "echo"; text: string }
  | { kind: "notice"; text: string };
```

- [ ] **Step 4: Run** — `bun test tests/operator-bus.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(operator-bus): carry priority on reply lines`.

### Task 3: `decisionsChatId` config knob

**Files:**
- Modify: `src/config.ts` (NeoConfig + DEFAULTS + loader)
- Test: `tests/config.test.ts` (add a case)

**Interfaces:**
- Produces: `NeoConfig.decisionsChatId?: number` (env `DECISIONS_CHAT_ID`, then file, else
  undefined).

- [ ] **Step 1: Write the failing test**

```ts
test("decisionsChatId comes from env over file", () => {
  process.env.DECISIONS_CHAT_ID = "-100999";
  const cfg = loadConfig();
  expect(cfg.decisionsChatId).toBe(-100999);
  delete process.env.DECISIONS_CHAT_ID;
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add `decisionsChatId?: number` to `NeoConfig`; in the loader
  add `decisionsChatId: process.env.DECISIONS_CHAT_ID ? Number(process.env.DECISIONS_CHAT_ID) : fileCfg.decisionsChatId`.
- [ ] **Step 4: Run** — `bun test tests/config.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(config): add decisionsChatId knob`.

### Task 4: Route by surface in the Telegram frontend

**Files:**
- Modify: `src/frontends/telegram.ts:42` (`makeTelegramSink`), `:153` (`send`), `:190`
  (pipeline `reply`)
- Test: `tests/telegram-sink.test.ts` (add cases)

**Interfaces:**
- Consumes: `surfaceFor` (Task 1), `cfg.decisionsChatId` (Task 3).
- Produces: `send(chatId, text, project?, priority?)`; the sink and pipeline `reply`
  forward `priority`; a decisions-surface line targets `decisionsChatId` when set.

- [ ] **Step 1: Write the failing test** — assert `makeTelegramSink` sends a `decision`
  line to the configured decisions chat id and a `progress` line to the admin DM. Use the
  existing test's fake `reply`/`plain` capture, extended with the decisions target.

```ts
test("a decision line goes to the decisions chat; progress to the DM", () => {
  const calls: any[] = [];
  const sink = makeTelegramSink({
    adminId: () => 111,
    decisionsChatId: () => 222,
    reply: (cid, text, project, priority) => calls.push({ cid, priority }),
    plain: () => {},
  });
  sink.deliver({ kind: "reply", text: "which design?", priority: "decision" });
  sink.deliver({ kind: "reply", text: "working…", priority: "progress" });
  expect(calls[0].cid).toBe(222);
  expect(calls[1].cid).toBe(111);
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**
  - `makeTelegramSink` deps gain `decisionsChatId: () => number | undefined` and a
    `priority` arg on `reply`; a `reply` line chooses the chat via
    `surfaceFor(line.priority ?? "progress") === "decisions" ? (decisionsChatId() ?? adminId()) : adminId()`.
  - `send(chatId, text, project?, priority?)` threads `priority` (see Task 6 for the
    message-id capture; here just accept + pass it to `sendFormatted`, no visual change).
  - The pipeline `reply` (`telegram.ts:190`) gains `priority?` and forwards it to both
    `send` and `bus.mirror`.
- [ ] **Step 4: Run** — `bun test tests/telegram-sink.test.ts` → PASS; `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(telegram): route messages to firehose vs decisions by priority`.

### Task 5: Tag the existing DECISION/ALERT/DONE sources

**Files:**
- Modify: `src/engine/dispatch.ts:56` (`DispatchDeps.reply` type), `:305,:300,:320`
  (dispatching/queued → progress, explicit), `:469` (apiFailureNotice → alert), `:563`
  (`✅`→done, `⛔`→alert); `src/engine/pipeline.ts` (`PipelineDeps.reply` type + the
  api-failure line); `src/daemon.ts:145,:186` (watchdog + loop-failure alerts).
- Test: `tests/dispatch.test.ts` (assert the outcome line's priority via a capturing reply)

**Interfaces:**
- Consumes: `Priority`.
- Produces: `reply` signatures across pipeline/dispatch/loop become
  `(chatId, text, project?, priority?)` with `progress` default.

- [ ] **Step 1: Write the failing test** — a dispatch whose run returns `ok:false`
  replies its final line with `priority:"alert"`; `ok:true` with `priority:"done"`.

```ts
test("dispatch tags its final line: done on success, alert on failure", async () => {
  const lines: any[] = [];
  const deps = makeDispatchDeps({ reply: (c, t, p, pr) => lines.push({ t, pr }) });
  // run returns ok:false → expect the ⛔ line tagged alert
  // (use the existing dispatch test harness with an injected run)
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — widen the `reply` type everywhere to accept the 4th arg
  (default `progress`), then at `dispatch.ts:563`:

```ts
const ok = result.ok;
const line = ok ? `✅ ${name} finished: ${result.summary || "done"}` : `⛔ ${name}: ${result.summary || "failed"}`;
await deps.reply(replyChat, line, name, ok ? "done" : "alert");
```

  and tag `apiFailureNotice` calls `"alert"`, and the daemon watchdog/loop-failure
  `fetch` alerts route through a priority-aware path (a small `alertOperator` helper that
  posts to `decisionsChatId ?? adminId`).
- [ ] **Step 4: Run** — `bun test` (dispatch + daemon-touching suites) → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(dispatch): tag outcome + alert lines with priority`.

---

## Phase 2 — Pending-decisions queue + raising decisions

### Task 6: The `decisions` ledger table + methods

**Files:**
- Modify: `src/engine/ledger.ts:112` (schema), interface + method bodies; add
  `decisionsKeep` to `openLedger` opts (default `DECISIONS_KEEP = 5_000`).
- Modify: `src/config.ts` (add `decisionsKeep`, default 5000)
- Test: `tests/decisions.test.ts`

**Interfaces:**
- Produces on `Ledger`:

```ts
interface NewDecision {
  kind: "decision" | "alert"; project?: string; folder?: string;
  orderId?: string; sessionId?: string; chatId?: number; question: string;
}
interface DecisionRow extends NewDecision {
  id: string; status: "open" | "answered" | "dismissed"; createdAt: number;
  answeredAt?: number; answer?: string; decisionChatId?: number;
  decisionMessageId?: number; lastRemindedAt?: number; reminderCount: number;
}
openDecision(rec: NewDecision, at?: number): string;
setDecisionMessage(id: string, chatId: number, messageId: number): void;
listOpenDecisions(): DecisionRow[];              // oldest-first
decisionByMessage(chatId: number, messageId: number): DecisionRow | undefined;
resolveDecision(id: string, answer: string, at?: number): void;
dismissDecision(id: string): void;
noteDecisionsReminded(ids: string[], at?: number): void;
```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { openLedger } from "../src/engine/ledger";

test("open → list → resolve a decision", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", project: "acme", folder: "/home/acme", question: "which db?" });
  expect(l.listOpenDecisions().map((d) => d.id)).toContain(id);
  l.resolveDecision(id, "postgres");
  expect(l.listOpenDecisions()).toHaveLength(0);
});

test("decisionByMessage finds a posted decision", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", question: "?" });
  l.setDecisionMessage(id, 222, 900);
  expect(l.decisionByMessage(222, 900)?.id).toBe(id);
});

test("noteDecisionsReminded stamps the reminder fields", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", question: "?" });
  l.noteDecisionsReminded([id], 1234);
  expect(l.listOpenDecisions()[0]!.reminderCount).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add the `CREATE TABLE decisions …` + indexes (copy the shape
  and amortised-prune idiom from the `events` table at `ledger.ts:195,330`), then the seven
  methods with parameterised queries (mirror the existing method style). Prune
  `answered`/`dismissed` rows past `decisionsKeep` in an amortised batch.
- [ ] **Step 4: Run** — `bun test tests/decisions.test.ts` → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(ledger): persistent pending-decisions queue`.

### Task 7: The `ask_operator` worker tool

**Files:**
- Modify: `src/engine/dispatch.ts:613` (`neoMcpServers`) — add the tool unconditionally for
  operator paths (like `send_file`); add a `postDecision` dependency to `DispatchDeps`.
- Test: `tests/dispatch.test.ts` (add a case)

**Interfaces:**
- Consumes: `ledger.openDecision`/`setDecisionMessage` (Task 6), a `postDecision(rec,
  question) → Promise<{chatId,messageId}|undefined>` closure that the frontend supplies
  (posts to the Decisions channel and returns the message id).
- Produces: an `ask_operator(question, options?)` MCP tool that enqueues a DECISION,
  posts it, and returns a "check-point and stop" note to the worker.

- [ ] **Step 1: Write the failing test** — calling the tool opens a decision row and posts
  a decision-priority line; the tool's return text tells the worker to stop and await the
  operator. Assert via a fake `postDecision` + in-memory ledger.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**

```ts
tool(
  "ask_operator",
  "Ask the operator a question that BLOCKS this work (a decision or approval you need to " +
  "proceed). It goes to the operator's high-priority Decisions channel and is tracked until " +
  "they answer. Check-point your work and STOP after calling this — the operator's answer " +
  "will resume this session as a follow-up.",
  { question: z.string(), options: z.array(z.string()).optional() },
  async (args) => {
    const id = deps.ledger.openDecision({
      kind: "decision", project: opts.projectName, folder: opts.folder,
      orderId: opts.orderId, chatId: replyChat, question: args.question,
    });
    const posted = await deps.postDecision?.(
      { id, project: opts.projectName },
      args.options?.length ? `${args.question}\n\nOptions: ${args.options.join(" · ")}` : args.question,
    );
    if (posted) deps.ledger.setDecisionMessage(id, posted.chatId, posted.messageId);
    return { content: [{ type: "text" as const, text:
      `Raised with the operator (decision #${id.slice(0, 8)}). Check-point your work and stop; ` +
      `their answer will resume this session.` }] };
  },
)
```

  (`opts` here gains `projectName`/`orderId`; thread them from `dispatchToProject` and the
  pipeline's own-project path where `neoMcpServers` is built.)
- [ ] **Step 4: Run** — `bun test tests/dispatch.test.ts` → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(dispatch): ask_operator worker tool raises tracked decisions`.

### Task 8: Record governor escalations as decisions

**Files:**
- Modify: `src/frontends/telegram.ts:194` (`askApproval`), `:466` (button resolve)
- Test: `tests/approval-resilience.test.ts` or a new `tests/escalation-decision.test.ts`

**Interfaces:**
- Consumes: `ledger.openDecision`/`resolveDecision`.
- Produces: `askApproval` opens a decision (kind `decision`) and posts it to the Decisions
  channel; the Allow/Deny press resolves it.

- [ ] **Step 1: Write the failing test** — invoking `askApproval` opens exactly one open
  decision; resolving the pending token closes it. (Test the pure wiring by extracting the
  open/resolve calls into a small helper the frontend calls, so the test needs no Bot.)
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — in `askApproval`, `openDecision({kind:"decision",
  question: reason, …})`, post the `⚠️ Approve…` message to the decisions surface, store the
  message id; in the callback resolver, `resolveDecision(id, kind==="a"?"allow":"deny")`.
- [ ] **Step 4: Run** — suite → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(telegram): track governor escalations in the decisions queue`.

### Task 9: `/decisions` command

**Files:**
- Modify: `src/engine/commands.ts:87` (COMMANDS), `:480` (help)
- Test: `tests/commands.test.ts` (add a case)

**Interfaces:**
- Consumes: `ledger.listOpenDecisions`.
- Produces: a `/decisions` command that renders the open queue.

- [ ] **Step 1: Write the failing test** — with two open decisions, `/decisions` returns
  text listing both with project + age.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add the COMMANDS entry calling a `renderDecisions(ledger,
  now)` helper (project · age · reminders · question). Dismiss buttons are optional here;
  answering is by reply (Phase 3).
- [ ] **Step 4: Run** — `bun test tests/commands.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(commands): /decisions lists the open queue`.

---

## Phase 3 — Answering resolves + unblocks

### Task 10: Resolve a decision by replying to it

**Files:**
- Modify: `src/frontends/telegram.ts:319` (reply handler — check decisions BEFORE
  `routeReply`); reuse `repliedContextBrief` from `reply-routing.ts`.
- Test: `tests/decision-answer.test.ts`

**Interfaces:**
- Consumes: `ledger.decisionByMessage`/`resolveDecision`, `routeReply`'s resume-seed path
  (extract a shared `deliverIntoFolder(deps, folder, chatId, text)` helper in
  `reply-routing.ts` so the decision-answer path and `routeReply` share the exact
  session-seeding code).
- Produces: an operator reply to a decision message marks it answered and delivers the
  answer into the raising project's session.

- [ ] **Step 1: Write the failing test** — given an open decision with a stored
  `(chatId, messageId)` and a folder, a reply to that message calls `resolveDecision` and
  routes the answer into that folder's session (assert via fakes).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — in the text handler, before `routeReply`:

```ts
const dec = ctx.message.reply_to_message
  ? ledger.decisionByMessage(chatId, ctx.message.reply_to_message.message_id)
  : undefined;
if (dec && dec.status === "open") {
  ledger.resolveDecision(dec.id, ctx.message.text);
  const brief = dec.folder
    ? repliedContextBrief(dec.question, ctx.message.text)
    : ctx.message.text;
  if (dec.folder) deliverIntoFolder({ registry, ledger, worker: cfg.providers.ownWork }, dec.folder, chatId, brief, pipelineDeps());
  void bot.api.sendMessage(chatId, `✅ answered — resuming ${dec.project ?? "the project"}.`);
  return;
}
```

- [ ] **Step 4: Run** — `bun test tests/decision-answer.test.ts` → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(telegram): answering a decision resolves it and resumes the project`.

---

## Phase 4 — Secretary / reminder loop

### Task 11: The secretary `LoopDef` + resolve/gate helpers

**Files:**
- Modify: `src/engine/loops.ts` (add `SECRETARY` to `LOOPS:201`; `secretary?: boolean` on
  `LoopDef:33`; `resolveSecretaryLoop` mirroring `resolveDreamLoop:306`;
  `secretaryGateOutcome` mirroring `dreamGateOutcome:322`; interpolate `{{OPEN_DECISIONS}}`
  in `startScheduledLoop:460`).
- Modify: `src/config.ts` (`secretaryCron`, `secretaryStaleHours`, `WorkerPathName +=
  "secretary"`, `workers.secretary: {}`).
- Test: `tests/secretary-loop.test.ts`

**Interfaces:**
- Consumes: `ledger.listOpenDecisions`, `noteDecisionsReminded`.
- Produces: `resolveSecretaryLoop(loop, cfg, ledger): LoopDef` (rewrites folder to
  `companyFolder` and interpolates the rendered queue into the prompt);
  `secretaryGateOutcome(loop, ledger): LoopOutcome | undefined` (returns a 0-iteration
  completed outcome when the queue is empty → silent, no worker run).

- [ ] **Step 1: Write the failing test**

```ts
test("secretary gate is silent when the queue is empty", () => {
  const l = openLedger(":memory:");
  expect(secretaryGateOutcome(SECRETARY, l)?.iterations).toBe(0);
});

test("resolve interpolates open decisions into the prompt and stamps reminders", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", project: "acme", question: "which db?" });
  const def = resolveSecretaryLoop(SECRETARY, cfg, l);
  expect(def.prompt).toContain("which db?");
  expect(l.listOpenDecisions()[0]!.reminderCount).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — the `SECRETARY` def (fire-once shape: `goal {command:["sh",
  "-c","false"]}`, `maxIterations:1`, `trigger {kind:"cron", expr: cfg.secretaryCron}`,
  `folder:"company"` sentinel, `secretary:true`, `enabledByDefault:false`), a prompt with a
  `{{OPEN_DECISIONS}}` placeholder telling the worker to write ONE warm, grouped,
  stalest-first digest as its text reply and to escalate items past
  `secretaryStaleHours`; `resolveSecretaryLoop` renders the queue rows to a compact list,
  interpolates them, and calls `noteDecisionsReminded`; `secretaryGateOutcome` returns the
  empty-queue no-op outcome.
- [ ] **Step 4: Run** — `bun test tests/secretary-loop.test.ts` → PASS; `tsc`.
- [ ] **Step 5: Commit** — `feat(loops): secretary digest loop over the decisions queue`.

### Task 12: Wire the secretary loop into the daemon

**Files:**
- Modify: `src/daemon.ts:165` (`resolveDreamLoop` map → also `resolveSecretaryLoop`),
  `:176` (`start` — the secretary/digest reply routes to the Decisions channel),
  `:114` (`loopReply`).
- Test: covered by `tests/secretary-loop.test.ts` + a daemon smoke assertion if practical
  (daemon is verified e2e, not unit — keep the logic in `loops.ts`, tested there).

**Interfaces:**
- Consumes: `resolveSecretaryLoop`, `secretaryGateOutcome`, `cfg.decisionsChatId`.
- Produces: the scheduler fires the secretary loop; its digest posts to the Decisions
  channel.

- [ ] **Step 1: Write the failing test** — assert `startScheduledLoop` on a `secretary`
  loop emits its digest via a `decision`-priority reply (extend the loop test with a
  capturing reply that records the priority).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — in the daemon tick's loop map, apply `resolveSecretaryLoop`
  alongside `resolveDreamLoop`; in `startScheduledLoop`, when `loop.secretary`, tag the
  `onMessage` reply `"decision"` so `loopReply`/the sink routes it to the Decisions
  channel; short-circuit on `secretaryGateOutcome`.
- [ ] **Step 4: Run** — `bun test` (loops) → PASS; `bunx tsc --noEmit`; `bun run
  src/daemon.ts` banner starts.
- [ ] **Step 5: Commit** — `feat(daemon): run the secretary loop, digest to the Decisions channel`.

### Task 13: Docs sync

**Files:**
- Modify: `docs/CONFIG.md` (the new knobs), `docs/HISTORY.md` (the feature narrative),
  `README.md` (two-surface behavior + the Decisions channel), `docs/loops.md` (the
  secretary loop).

- [ ] **Step 1** — document `decisionsChatId`, `secretaryCron`, `secretaryStaleHours`,
  `decisionsKeep`, `workers.secretary` with env→file→default precedence in `docs/CONFIG.md`.
- [ ] **Step 2** — add the feature paragraph to `docs/HISTORY.md` and a short section to
  `README.md`; note the secretary loop in `docs/loops.md`.
- [ ] **Step 3: Commit** — `docs: sync CONFIG/HISTORY/README/loops to the priority+decisions feature`.

---

## Self-Review

**Spec coverage:**
- §5.1 priority model → Task 1. §5.2 tag sources → Tasks 5, 7, 8, 12. §5.3 two-surface
  routing → Tasks 2, 3, 4. §5.4 queue table → Task 6. §5.5 raising (ask_operator +
  escalation + alerts) → Tasks 7, 8, 5. §5.6 answer resolves → Task 10. §5.7 secretary
  loop → Tasks 11, 12. §5.8 `/decisions` → Task 9. Docs → Task 13. All spec sections map
  to a task.
- Deferred items (web board, ALERT auto-ack, auto-close, forum/second-bot variants) are
  intentionally out of scope — noted in the spec, not planned here.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Code blocks are
concrete; the `ask_operator`/answer/secretary snippets show the real calls.

**Type consistency:** `Priority` (Task 1) is used identically in Tasks 2, 4, 5, 12.
`reply(chatId, text, project?, priority?)` is the one signature threaded through
pipeline/dispatch/loop. `DecisionRow`/`NewDecision`/`openDecision`/`resolveDecision`/
`decisionByMessage`/`noteDecisionsReminded` (Task 6) are used with the same names in Tasks
7–12. `resolveSecretaryLoop`/`secretaryGateOutcome` (Task 11) are used by the same names in
Task 12.

## Notes for the executor

- Keep the pure logic in engine modules (`priority.ts`, `loops.ts`, `ledger.ts`,
  `commands.ts`) where it is unit-tested; the Telegram frontend stays thin I/O wiring
  verified e2e, matching the repo's convention.
- The four Open Questions in the spec (channel mechanism, cadence/default, worker vs
  deterministic digest, escalation mirroring) should be resolved by the operator before
  Phase 4 (and before finalising Phase 1's `decisionsChatId` UX). They do not block Phases
  1–3.
```
