// ADR-0053: a decision lands on the thread of its work, and closes when its question is gone.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { DEFAULT_DECISION_SETTLE } from "../src/engine/decision-settle";

const DAY = 86_400_000;
const T0 = 1_000;

function setup(now = () => T0) {
  const led = openLedger(":memory:");
  const reg = createRegistry();
  const t = createTrace({ ledger: led, registry: reg, now, settleCfg: () => DEFAULT_DECISION_SETTLE });
  const root = t.inbound({ chatId: 7, text: "build the wallet", surface: "telegram" });
  return { led, reg, t, root };
}

test("B1: closing a thread's last open decision by ANY path re-derives the thread — it leaves waiting", () => {
  for (const close of ["dismiss", "resolve", "supersede", "expire"] as const) {
    const { led, t, root } = setup();
    const d = led.openDecision({ kind: "decision", question: "Which bank?", cause: root }, T0);
    t.refreshThread(root.threadId);
    expect(led.threadById(root.threadId)?.state).toBe("waiting");
    if (close === "dismiss") led.dismissDecision(d);
    if (close === "resolve") led.resolveDecision(d, "IQD bank");
    if (close === "supersede") led.supersedeDecision(d, "asked again as #x");
    if (close === "expire") led.expireDecision(d, "expired: its work ended");
    expect(led.threadById(root.threadId)?.state).not.toBe("waiting");
  }
});

test("expireDecision: status `expired` with the reason; only an open decision; listeners hear its thread", () => {
  const { led, root } = setup();
  const heard: Array<number | undefined> = [];
  led.onDecisionClosed((e) => heard.push(e.threadId));
  const d = led.openDecision({ kind: "decision", question: "Q?", cause: root }, T0);
  led.expireDecision(d, "expired: its work ended", T0 + 5);
  expect(led.decisionById(d)).toMatchObject({ status: "expired", answer: "expired: its work ended", answeredAt: T0 + 5 });
  led.expireDecision(d, "again"); // closed already: no change, no second notice
  expect(led.decisionById(d)?.answer).toBe("expired: its work ended");
  expect(heard).toEqual([root.threadId]);
});

test("supersedeDecision with moveParkedTo: the parked todo now waits on the newer card, it is not cancelled", () => {
  const { led, root } = setup();
  const old = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/a.md — A", cause: root }, T0);
  const now = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/a.md — A", cause: root }, T0 + 1);
  const todo = led.addTodo({ project: "p", folder: "/f", brief: "continue", workClass: "interactive", createdBy: "operator", cause: root }, T0);
  led.updateTodo(todo.id, { status: "waiting", waitingOn: old });
  const r = led.supersedeDecision(old, "replaced by plan card v2", T0 + 2, { moveParkedTo: now });
  expect(r.todosCancelled).toEqual([]);
  expect(led.todoById(todo.id)).toMatchObject({ status: "waiting", waitingOn: now });
});

test("settle facts: an older plan card, a plan building as a todo, and an ended order with later done work", () => {
  const { led, t, root } = setup();
  const plan = { project: "gold", folder: "/home/gold", title: "A", sha256: "x", stepsTotal: 0, stepsDone: 0, threadId: root.threadId, createdAt: T0, updatedAt: T0 };
  const v1 = led.openDecision({ kind: "decision", question: "Plan ready for review: docs/a.md — A", folder: "/home/gold", cause: root }, T0);
  const v2 = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/a.md — A", folder: "/home/gold", cause: root }, T0 + 1);
  led.upsertPlan({ ...plan, path: "docs/a.md", status: "sent", decisionId: v2, version: 2 } as never);
  const b = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/b.md — B", folder: "/home/gold", cause: root }, T0);
  led.upsertPlan({ ...plan, path: "docs/b.md", status: "executing", decisionId: b, todoId: 9 } as never);
  led.recordOrder({ id: "o1", source: "neo", folder: "/home/gold", task: "t", chatId: 7, createdAt: T0 }, { cause: root });
  const q = led.openDecision({ kind: "decision", question: "Colour?", options: ["red", "blue"], folder: "/home/gold", orderId: "o1", cause: root }, T0);
  led.recordOutcome("o1", "done", "ok", T0 + 10);
  led.recordOrder({ id: "o2", source: "neo", folder: "/home/gold", task: "t2", chatId: 7, createdAt: T0 + 20 });
  led.recordOutcome("o2", "done", "ok", T0 + 30);
  const f = led.decisionSettleFacts(root.threadId);
  expect(f.replaced).toEqual({ [v1]: { version: 2, currentId: v2 } });
  expect(f.planBuilding).toEqual([b]);
  expect(f.ended?.[q]).toEqual({ endedAt: T0 + 10, laterDoneAt: T0 + 30 });
  expect(f.open.find((d) => d.id === q)).toMatchObject({ orderId: "o1", text: "Colour? | red | blue" });
  void t;
});

test("C4 through the trace: an old question whose work moved on expires; the thread stops waiting", () => {
  let clock = T0;
  const { led, t, root } = setup(() => clock);
  led.recordOrder({ id: "o1", source: "neo", folder: "/home/gold", task: "t", chatId: 7, createdAt: T0 }, { cause: root });
  const q = led.openDecision({ kind: "decision", question: "Which colour for the header?", folder: "/home/gold", orderId: "o1", cause: root }, T0);
  led.recordOutcome("o1", "done", "ok", T0 + 10);
  led.recordOrder({ id: "o2", source: "neo", folder: "/home/gold", task: "t2", chatId: 7, createdAt: T0 + 20 });
  led.recordOutcome("o2", "done", "ok", T0 + 30);
  t.refreshThread(root.threadId);
  expect(led.decisionById(q)?.status).toBe("open"); // too young
  clock = T0 + 8 * DAY;
  t.refreshThread(root.threadId);
  expect(led.decisionById(q)).toMatchObject({ status: "expired", answer: "expired: its work ended and later work in gold finished" });
  expect(led.threadById(root.threadId)?.state).not.toBe("waiting");
});
