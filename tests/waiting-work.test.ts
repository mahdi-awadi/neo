// ADR-0054 C1: one waiting-work model. Every waiting item has an owner and a next action; a thread is
// WAITING exactly when it holds one; a decision counts as waiting for its OWN project; and no todo is
// left parked on a decision that already closed.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { createTodoQueue } from "../src/engine/todo-queue";
import { DEFAULT_KEEP_PATTERNS } from "../src/engine/decision-settle";
import { waitingWork } from "../src/engine/waiting-work";

const KEEP = DEFAULT_KEEP_PATTERNS;

function setup() {
  const led = openLedger(":memory:");
  const registry = createRegistry();
  const t = createTrace({ ledger: led, registry });
  return { led, registry, t };
}

test("every WAITING thread has a waiting item, and every item's thread is WAITING", () => {
  const { led, t } = setup();
  const a = t.inbound({ chatId: 7, text: "fix the wallet", surface: "telegram" });
  const b = t.inbound({ chatId: 7, text: "observability spec", surface: "telegram" });
  const c = t.inbound({ chatId: 7, text: "nothing open here", surface: "telegram" });
  led.openDecision({ kind: "decision", question: "Which bank?", folder: "/home/eticket-v3", project: "eticket-v3", cause: a }, 1_000);
  const card = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/p.md — P", folder: "/home/eticket-v3", project: "eticket-v3", cause: b }, 1_000);
  led.upsertPlan({ project: "eticket-v3", folder: "/home/eticket-v3", path: "docs/p.md", title: "P", sha256: "x", stepsTotal: 1, stepsDone: 0, status: "sent", gate: "approval", decisionId: card, threadId: b.threadId } as never);
  // mb1et's shape: its only decision was dismissed.
  const gone = led.openDecision({ kind: "decision", question: "old card", folder: "/home/eticket-v3", cause: c }, 1_000);
  led.dismissDecision(gone);
  for (const x of [a, b, c]) t.refreshThread(x.threadId);
  const items = waitingWork(led, { keepPatterns: KEEP });
  const waitingThreads = [a, b, c].filter((x) => led.threadById(x.threadId)?.state === "waiting").map((x) => x.threadId).sort();
  const itemThreads = [...new Set(items.flatMap((i) => (i.threadId !== undefined && i.kind !== "parked_todo" ? [i.threadId] : [])))].sort();
  expect(itemThreads).toEqual(waitingThreads);
  expect(waitingThreads).toEqual([a.threadId, b.threadId].sort());
  expect(items.find((i) => i.id === card)).toMatchObject({ kind: "plan", owner: "operator", next: "approve" });
});

test("a gold decision on an eticket thread counts as waiting for gold, not for eticket-v3", () => {
  const { led, t } = setup();
  const root = t.inbound({ chatId: 7, text: "check all of these tasks", surface: "telegram" });
  led.touchThread(root.threadId, root.msgId, 1_000, { project: "eticket-v3", folder: "/home/eticket-v3" });
  led.openDecision({ kind: "decision", question: "Send the price bot's token", folder: "/home/gold", project: "gold", cause: root }, 1_000);
  t.refreshThread(root.threadId);
  expect(led.threadById(root.threadId)?.state).toBe("waiting");
  const ids = (project: string) => led.listThreads({ project, state: "waiting" }, { limit: 50 }).rows.map((r) => r.id);
  expect(ids("gold")).toContain(root.threadId);
  expect(ids("eticket-v3")).not.toContain(root.threadId);
  expect(waitingWork(led, { keepPatterns: KEEP })[0]).toMatchObject({ project: "gold", threadId: root.threadId });
});

test("the next action is never empty, and the owner follows the facts", () => {
  const { led, t } = setup();
  const root = t.inbound({ chatId: 7, text: "work", surface: "telegram" });
  const plain = led.openDecision({ kind: "decision", question: "Which bank?", folder: "/home/p", project: "p", cause: root }, 1_000);
  const prod = led.openDecision({ kind: "decision", question: "Run the prod migration?", folder: "/home/p", project: "p", cause: root }, 1_001);
  const judged = led.openDecision({ kind: "decision", question: "Which account?", folder: "/home/p", project: "p", cause: root }, 1_002);
  const escalation = led.openDecision({ kind: "decision", question: "Allow git push?" }, 1_003); // a governor escalation: no order, no folder
  led.setMeta("waitingSweep.judged", { [judged]: { at: 2_000, commitAt: 0, ask: "pick the partner account" } }, 2_000);
  const parked = led.addTodo({ project: "p", folder: "/home/p", brief: "continue", workClass: "interactive", createdBy: "operator", cause: root }, 1_004);
  led.updateTodo(parked.id, { status: "waiting", waitingOn: plain });
  const items = waitingWork(led, { keepPatterns: KEEP });
  for (const i of items) {
    expect(i.next.length).toBeGreaterThan(0);
    if (i.next !== "resumes") expect((i.ask ?? "").trim().length).toBeGreaterThan(0);
  }
  const by = (id: string) => items.find((i) => i.id === id)!;
  expect(by(plain)).toMatchObject({ owner: "sweep", next: "judge" }); // in a repo, not judged yet
  expect(by(prod)).toMatchObject({ owner: "operator", next: "answer", keep: true });
  expect(by(judged)).toMatchObject({ owner: "operator", next: "answer", ask: "pick the partner account" });
  expect(by(escalation)).toMatchObject({ owner: "operator", next: "answer" });
  expect(by(`#${parked.id}`)).toMatchObject({ kind: "parked_todo", owner: "engine", next: "resumes", on: plain.slice(0, 8) });
});

test("releaseOrphans: a todo parked on a closed decision is resumed with the answer, or cancelled with the reason", () => {
  const { led, registry, t } = setup();
  const root = t.inbound({ chatId: 7, text: "work", surface: "telegram" });
  const q = createTodoQueue({ ledger: led, registry, onFailure: () => "continue" });
  const park = (decision: string) => {
    const todo = led.addTodo({ project: "p", folder: "/home/p", brief: "continue", workClass: "interactive", createdBy: "operator", cause: root }, 1_000);
    led.updateTodo(todo.id, { status: "waiting", waitingOn: decision });
    return todo.id;
  };
  // #611's shape: a plan card tapped Done on a build that did not release its parked todo.
  const card = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/superpowers/plans/fix.md — Fix all", folder: "/home/p", cause: root }, 1_000);
  const onCard = park(card);
  led.resolveDecision(card, "Done");
  // A plain question answered, but its parked todo never resumed.
  const ask = led.openDecision({ kind: "decision", question: "Which bank?", folder: "/home/p", cause: root }, 1_000);
  const onAsk = park(ask);
  led.resolveDecision(ask, "the IQD bank");
  // A superseded question.
  const old = led.openDecision({ kind: "decision", question: "Restart?", folder: "/home/p", cause: root }, 1_000);
  const onOld = park(old);
  led.supersedeDecision(old, "asked again as #12345678", 1_500, { moveParkedTo: undefined } as never);
  led.updateTodo(onOld, { status: "waiting", waitingOn: old }); // left parked by an older path
  // Still open: untouched.
  const live = led.openDecision({ kind: "decision", question: "Which colour?", folder: "/home/p", cause: root }, 1_000);
  const onLive = park(live);

  const r = q.releaseOrphans();
  expect(r.resumed).toEqual([onAsk]);
  expect(r.cancelled.sort()).toEqual([onCard, onOld].sort());
  expect(led.todoById(onCard)).toMatchObject({ status: "cancelled", result: expect.stringContaining(`#${card.slice(0, 8)}`) });
  expect(led.todoById(onAsk)?.status).toBe("queued");
  expect(led.todoById(onAsk)?.brief).toContain("the IQD bank");
  expect(led.todoById(onLive)?.status).toBe("waiting");
  // Idempotent.
  expect(q.releaseOrphans()).toEqual({ resumed: [], cancelled: [] });
});
