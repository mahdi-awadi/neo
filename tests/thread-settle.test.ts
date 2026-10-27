// ADR-0038: a thread waits only on a live question — settle stale decisions, close a thread, and
// count approvals only on running sessions.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";

function setup(opts: { settle?: boolean } = {}) {
  const led = openLedger(":memory:");
  const reg = createRegistry();
  const t = createTrace({ ledger: led, registry: reg, ...(opts.settle === false ? { settleDecisions: false } : {}) });
  const root = t.inbound({ chatId: 7, text: "build the wallet", surface: "telegram" });
  return { led, reg, t, root };
}
const PAST = 1_000; // decisions and messages before the outcome (recordOutcome stamps Date.now())

test("ADR-0054: a chat line and later finished work never close a question (no chat guess)", () => {
  const { led, t, root } = setup();
  const d = led.openDecision({ kind: "decision", question: "Start the three follow-up defects?", cause: root, folder: "/f" }, PAST);
  t.refreshThread(root.threadId);
  expect(led.threadById(root.threadId)?.state).toBe("waiting");
  // The operator writes something else in the thread (d83217cb: "Explain why we should cut off")…
  const said = led.insertMessage({ chatId: 7, role: "user", content: "Explain why we should cut off", at: PAST + 10, surface: "telegram", kind: "text", threadId: root.threadId });
  // …and other work in the same folder finishes.
  led.recordOrder({ id: "o2", source: "neo", folder: "/f", task: "go", chatId: 7, createdAt: PAST + 20 }, { cause: { msgId: said, threadId: root.threadId } });
  led.recordOutcome("o2", "done", "ok");
  t.refreshThread(root.threadId);
  expect(led.decisionById(d)?.status).toBe("open");
  expect(led.threadById(root.threadId)?.state).toBe("waiting");
});

test("AC1: asked again — the older open decision is superseded by the newer one", () => {
  const { led, t, root } = setup();
  const a = led.openDecision({ kind: "decision", question: "Restart dev?", cause: root }, PAST);
  const b = led.openDecision({ kind: "decision", question: "restart  dev?", cause: root }, PAST + 1);
  t.refreshThread(root.threadId);
  expect(led.decisionById(a)).toMatchObject({ status: "superseded", answer: `asked again as #${b.slice(0, 8)}` });
  expect(led.decisionById(b)?.status).toBe("open");
  expect(led.threadById(root.threadId)?.state).toBe("waiting"); // b still needs the operator
});

test("AC3: a plan's review decision closes when the plan is executing; an awaiting plan's stays", () => {
  const { led, t, root } = setup();
  const d1 = led.openDecision({ kind: "decision", question: "Plan ready for review: a.md", cause: root }, PAST);
  const d2 = led.openDecision({ kind: "decision", question: "Plan ready for review: b.md", cause: root }, PAST);
  const p = { project: "gold", folder: "/home/gold", title: "t", sha256: "x", stepsTotal: 3, stepsDone: 0, threadId: root.threadId, createdAt: PAST, updatedAt: PAST };
  led.upsertPlan({ ...p, path: "docs/a.md", status: "executing", decisionId: d1 } as never);
  led.upsertPlan({ ...p, path: "docs/b.md", status: "sent", decisionId: d2 } as never);
  t.refreshThread(root.threadId);
  expect(led.decisionById(d1)).toMatchObject({ status: "superseded", answer: "plan executing" });
  expect(led.decisionById(d2)?.status).toBe("open");
});

test("AC4: a decision a waiting todo is parked on is never superseded", () => {
  const { led, t, root } = setup();
  const d = led.openDecision({ kind: "decision", question: "Which bank?", cause: root }, PAST);
  const todo = led.addTodo({ project: "p", folder: "/f", brief: "continue", workClass: "interactive", createdBy: "operator", cause: root }, PAST);
  led.updateTodo(todo.id, { status: "waiting", waitingOn: d });
  const said = led.insertMessage({ chatId: 7, role: "user", content: "x", at: PAST + 10, surface: "telegram", kind: "text", threadId: root.threadId });
  led.recordOrder({ id: "o2", source: "neo", folder: "/f", task: "go", chatId: 7, createdAt: PAST + 20 }, { cause: { msgId: said, threadId: root.threadId } });
  led.recordOutcome("o2", "done", "ok");
  t.refreshThread(root.threadId);
  expect(led.decisionById(d)?.status).toBe("open");
});

test("AC5: decisionSettle off — refreshThread leaves stale decisions open", () => {
  const { led, t, root } = setup({ settle: false });
  const a = led.openDecision({ kind: "decision", question: "Restart dev?", cause: root }, PAST);
  led.openDecision({ kind: "decision", question: "Restart dev?", cause: root }, PAST + 1);
  t.refreshThread(root.threadId);
  expect(led.decisionById(a)?.status).toBe("open");
});

test("AC6: close — the thread is done, its open decisions dismissed with a reason, parked todos cancelled; a new message reopens it", () => {
  const { led, t, root } = setup();
  const d = led.openDecision({ kind: "decision", question: "Which bank?", cause: root }, PAST);
  const parked = led.addTodo({ project: "p", folder: "/f", brief: "continue", workClass: "interactive", createdBy: "operator", cause: root }, PAST);
  led.updateTodo(parked.id, { status: "waiting", waitingOn: d });
  const running = led.addTodo({ project: "p", folder: "/f", brief: "other", workClass: "interactive", createdBy: "operator", cause: root }, PAST);
  led.updateTodo(running.id, { status: "running" });
  t.refreshThread(root.threadId);
  expect(led.threadById(root.threadId)?.state).toBe("waiting");

  const r = led.closeThread(root.threadId, "thread closed by the operator", PAST + 50);
  expect(r).toEqual({ closed: true, decisions: 1, todosCancelled: [parked.id], stillActive: [running.id] });
  t.refreshThread(root.threadId);
  expect(led.threadById(root.threadId)).toMatchObject({ state: "done", closedByOperator: true });
  expect(led.decisionById(d)).toMatchObject({ status: "dismissed", answer: "thread closed by the operator" });
  expect(led.todoById(parked.id)?.status).toBe("cancelled");
  expect(led.todoById(running.id)?.status).toBe("running");
  expect(led.closeThread(root.threadId, "again", PAST + 60)).toMatchObject({ closed: false }); // already closed

  // A new operator message in the thread reopens it.
  t.inbound({ chatId: 7, text: "one more thing", surface: "web", threadId: root.threadId });
  expect(led.threadById(root.threadId)?.closedByOperator).toBe(false);
});

test("closeThread on an unknown thread says so", () => {
  const { led } = setup();
  expect(led.closeThread(424242, "x", 1)).toEqual({ closed: false, missing: true, decisions: 0, todosCancelled: [], stillActive: [] });
});

test("AC9: a session that leaves running loses its approval block; refreshThread counts approvals on running sessions only", () => {
  const { reg } = setup();
  const s = reg.add({ id: "o1", source: "neo", folder: "/f", task: "x", chatId: 7, createdAt: 0 }, 0);
  reg.setStatus(s.id, "running");
  reg.noteBlocked(s.id, { kind: "approval", label: "write outside", since: 0 });
  reg.setStatus(s.id, "idle");
  expect(reg.get(s.id)?.blockedOn).toBeUndefined();
  // A decision block is the worker waiting on the operator after it stopped: it stays on an idle session.
  reg.setStatus(s.id, "running");
  reg.noteBlocked(s.id, { kind: "decision", label: "which bank?", since: 0 });
  reg.setStatus(s.id, "idle");
  expect(reg.get(s.id)?.blockedOn?.kind).toBe("decision");
});

// --- the operator's Close: one engine action, two surfaces --------------------------------------

test("AC8: /close <ref> closes the thread and says what it closed; any message ref of the thread works", async () => {
  const { handleCommand } = await import("../src/engine/commands");
  const { openTrustStore } = await import("../src/engine/trust");
  const { led, reg, t, root } = setup();
  led.openDecision({ kind: "decision", question: "Which bank?", cause: root }, PAST);
  const later = t.outbound({ chatId: 7, text: "a later line", cause: root });
  t.refreshThread(root.threadId);
  const deps = { registry: reg, ledger: led, trust: openTrustStore(":memory:"), trace: t, cfg: { providers: { ownWork: "subscription" as const, customerWork: "gemini" as const } } };
  const out = handleCommand(`/close ${t.ref(later)}`, 7, deps)!.text;
  expect(out).toBe(`✓ closed thread ${t.ref(root.threadId)} — 1 open decision dismissed`);
  expect(led.threadById(root.threadId)).toMatchObject({ state: "done", closedByOperator: true });
  expect(handleCommand(`/close ${t.ref(root.threadId)}`, 7, deps)!.text).toBe(`thread ${t.ref(root.threadId)} is already closed`);
  expect(handleCommand("/close", 7, deps)!.text).toBe("Usage: /close <thread ref> — or reply /close to a Neo message.");
  expect(handleCommand("/close mzzzzzz", 7, deps)!.text).toBe("No message mzzzzzz — check the ref");
});

test("review: a tapped answer to Q1 (its line is the answer text) and an approval verdict are not chat — Q2 stays open", () => {
  const { led, t, root } = setup();
  const T = led.messageById(root.msgId)!.at + 1_000; // after the thread's root line
  const q1 = led.openDecision({ kind: "decision", question: "Q1: karat?", cause: root, folder: "/f" }, T);
  const q2 = led.openDecision({ kind: "decision", question: "Q2: sizes?", cause: root, folder: "/f" }, T + 1);
  led.resolveDecision(q1, "21K", T + 10);
  led.insertMessage({ chatId: 7, role: "user", content: "21K", at: T + 10, surface: "telegram", kind: "text", threadId: root.threadId });
  t.outbound({ chatId: 7, text: "allow", cause: root, role: "user", kind: "approval", at: T + 15 });
  const run = led.addTodo({ project: "p", folder: "/f", brief: "resume", workClass: "interactive", createdBy: "operator", cause: root }, T + 20);
  led.updateTodo(run.id, { status: "done", endedAt: T + 30 });
  t.refreshThread(root.threadId);
  expect(led.decisionById(q2)?.status).toBe("open");
  expect(led.threadById(root.threadId)?.state).toBe("waiting");
});

test("review: a new decision in a closed thread reopens it, so the question is never hidden", () => {
  const { led, t, root } = setup();
  led.closeThread(root.threadId, "x", PAST);
  t.refreshThread(root.threadId);
  expect(led.threadById(root.threadId)?.state).toBe("done");
  led.openDecision({ kind: "decision", question: "New question?", cause: root, folder: "/f" }, PAST + 5);
  t.refreshThread(root.threadId);
  expect(led.threadById(root.threadId)).toMatchObject({ closedByOperator: false, state: "waiting" });
});

test("ADR-0054 B3: a todo naming the plan, ended done after the card, settles it in the engine; a delivery that never ran does not", () => {
  const { led, t, root } = setup();
  const q = "Plan waiting for your approval: docs/superpowers/plans/fix.md — Fix all";
  const card = led.openDecision({ kind: "decision", question: q, cause: root, folder: "/f" }, PAST);
  const plan = led.upsertPlan({ project: "p", folder: "/f", path: "docs/superpowers/plans/fix.md", title: "Fix all", sha256: "x", stepsTotal: 2, stepsDone: 0, status: "sent", gate: "approval", decisionId: card, threadId: root.threadId } as never);
  // A delivery marked done at once (started == ended, ADR-0052) never ran: no evidence.
  const fake = led.addTodo({ project: "p", folder: "/f", brief: "build docs/superpowers/plans/fix.md", workClass: "interactive", createdBy: "operator", cause: root }, PAST + 1);
  led.updateTodo(fake.id, { status: "done", startedAt: PAST + 5, endedAt: PAST + 5 });
  t.refreshThread(root.threadId);
  expect(led.decisionById(card)?.status).toBe("open");
  // A todo that really ran and names the plan built it.
  const real = led.addTodo({ project: "p", folder: "/f", brief: "Operator APPROVED. Execute docs/superpowers/plans/fix.md", workClass: "interactive", createdBy: "operator", cause: root }, PAST + 2);
  led.updateTodo(real.id, { status: "done", startedAt: PAST + 10, endedAt: PAST + 500 });
  t.refreshThread(root.threadId);
  expect(led.decisionById(card)).toMatchObject({ status: "superseded", answer: `plan built by todo #${real.id} (it names the plan and ended done)` });
  expect(led.planById(plan.id)?.status).toBe("done");
  expect(led.threadById(root.threadId)?.state).not.toBe("waiting");
});
