import { expect, test } from "bun:test";
import { openLedger, DECISIONS_PRUNE_INTERVAL } from "../src/engine/ledger";

test("open → list → resolve a decision (open drops out of listOpenDecisions)", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", project: "acme", folder: "/home/acme", question: "which db?" });
  expect(typeof id).toBe("string");
  expect(l.listOpenDecisions().map((d) => d.id)).toContain(id);
  l.resolveDecision(id, "postgres", 500);
  expect(l.listOpenDecisions()).toHaveLength(0);
  const row = l.decisionById(id)!;
  expect(row.status).toBe("answered");
  expect(row.answer).toBe("postgres");
  expect(row.answeredAt).toBe(500);
});

test("listOpenDecisions returns oldest-first", () => {
  const l = openLedger(":memory:");
  const a = l.openDecision({ kind: "decision", question: "first" }, 100);
  const b = l.openDecision({ kind: "alert", question: "second" }, 200);
  const open = l.listOpenDecisions();
  expect(open.map((d) => d.id)).toEqual([a, b]);
  expect(open[0]!.createdAt).toBe(100);
});

test("options round-trip through the row (tappable answers survive persistence)", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", question: "ship it?", options: ["Yes", "No", "Wait"] });
  expect(l.decisionById(id)!.options).toEqual(["Yes", "No", "Wait"]);
  expect(l.listOpenDecisions()[0]!.options).toEqual(["Yes", "No", "Wait"]);
});

test("setDecisionMessage + decisionByMessage find a posted decision", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", question: "?" });
  l.setDecisionMessage(id, 222, 900);
  expect(l.decisionByMessage(222, 900)?.id).toBe(id);
  expect(l.decisionByMessage(222, 901)).toBeUndefined(); // wrong message id
  const row = l.decisionById(id)!;
  expect(row.decisionChatId).toBe(222);
  expect(row.decisionMessageId).toBe(900);
});

test("noteDecisionsReminded stamps the reminder fields", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "decision", question: "?" });
  l.noteDecisionsReminded([id], 1234);
  const row = l.listOpenDecisions()[0]!;
  expect(row.reminderCount).toBe(1);
  expect(row.lastRemindedAt).toBe(1234);
  l.noteDecisionsReminded([id], 5678);
  expect(l.decisionById(id)!.reminderCount).toBe(2);
});

test("dismissDecision closes an alert without an answer", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({ kind: "alert", question: "dispatch failed" });
  l.dismissDecision(id);
  expect(l.listOpenDecisions()).toHaveLength(0);
  expect(l.decisionById(id)!.status).toBe("dismissed");
});

test("full field carry: folder/orderId/sessionId/chatId persist for the resume path", () => {
  const l = openLedger(":memory:");
  const id = l.openDecision({
    kind: "decision",
    project: "eticket-v3",
    folder: "/home/eticket-v3",
    orderId: "ord-1",
    sessionId: "sdk-9",
    chatId: -2,
    question: "which fare?",
  });
  const row = l.decisionById(id)!;
  expect(row).toMatchObject({
    project: "eticket-v3",
    folder: "/home/eticket-v3",
    orderId: "ord-1",
    sessionId: "sdk-9",
    chatId: -2,
    kind: "decision",
  });
});

test("answered/dismissed rows are pruned past decisionsKeep; open rows are always kept", () => {
  const l = openLedger(":memory:", { decisionsKeep: 3 });
  const openId = l.openDecision({ kind: "decision", question: "keep me open" });
  // The prune is amortised (fires every DECISIONS_PRUNE_INTERVAL closes) — cross the interval so it runs.
  const closed: string[] = [];
  for (let i = 0; i < DECISIONS_PRUNE_INTERVAL; i++) {
    const id = l.openDecision({ kind: "alert", question: `a${i}` }, 1000 + i);
    l.resolveDecision(id, "ok", 2000 + i);
    closed.push(id);
  }
  // The open decision is never pruned.
  expect(l.decisionById(openId)?.status).toBe("open");
  expect(l.listOpenDecisions().map((d) => d.id)).toEqual([openId]);
  // At most `decisionsKeep` closed rows remain (oldest dropped).
  const survivingClosed = closed.filter((id) => l.decisionById(id) !== undefined);
  expect(survivingClosed.length).toBeLessThanOrEqual(3);
  // The most recent closed rows survive; the oldest were dropped.
  expect(l.decisionById(closed.at(-1)!)).toBeDefined();
  expect(l.decisionById(closed[0]!)).toBeUndefined();
});
