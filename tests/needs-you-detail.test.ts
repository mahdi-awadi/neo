// ADR-0071: a pin's Open lands on the item itself, with everything needed to act on it. One engine seam
// (needs-you-detail.ts) shapes a decision, a plan card or an attention item; needsYou links a
// `decision_stale` reminder to the open decision it is about.
import { test, expect } from "bun:test";
import { openLedger, type AttentionDraft } from "../src/engine/ledger";
import { DEFAULT_KEEP_PATTERNS } from "../src/engine/decision-settle";
import { needsYou } from "../src/engine/needs-you";
import { itemDetail } from "../src/engine/needs-you-detail";

const KEEP = DEFAULT_KEEP_PATTERNS;
const stale = (decisionId: string, question: string): AttentionDraft => ({
  project: "neo",
  folder: "/home/neo",
  source: "engine",
  kind: "decision_stale",
  key: decisionId,
  title: `decision open 24h: ${question}`,
  severity: "high",
  facts: { decision: decisionId.slice(0, 8), question, since: 1 },
});

test("a decision_stale reminder is linked to its open decision; a plan pin says Review, never one-tap approve", () => {
  const led = openLedger(":memory:");
  const dec = led.openDecision({ kind: "decision", question: "Should I write a plan to cut the memory?", folder: "/home/neo", project: "neo" }, 1);
  led.setPin(`dec:${dec}`, "unpinned", 2); // the operator hid the decision itself (the live case)
  const att = led.insertAttention(stale(dec, "Should I write a plan to cut the memory?"), 3);
  const card = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/p.md — P", folder: "/home/p", project: "p" }, 4);
  led.upsertPlan({ project: "p", folder: "/home/p", path: "docs/p.md", title: "P", sha256: "x", stepsTotal: 1, stepsDone: 0, status: "sent", gate: "approval", decisionId: card } as never);
  const got = needsYou({ ledger: led, keepPatterns: KEEP }, 10);
  expect(got.find((i) => i.ref === `att:${att}`)).toMatchObject({ kind: "attention", action: "answer", decisionId: dec });
  expect(got.find((i) => i.ref === `dec:${card}`)).toMatchObject({ kind: "plan", action: "review", decisionId: card });
  // Once the decision is answered, the reminder is moot and leaves the list.
  led.resolveDecision(dec, "no");
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 10).find((i) => i.ref === `att:${att}`)).toBeUndefined();
});

test("itemDetail: a decision with its full question, options, spec and thread; answerable while open", () => {
  const led = openLedger(":memory:");
  const dec = led.openDecision({ kind: "decision", question: "Which bank?", options: ["Qi", "Zain"], folder: "/home/q", project: "q", cause: { msgId: 7, threadId: 40 } } as never, 1);
  const d = itemDetail({ ledger: led }, `dec:${dec}`, 10);
  expect(d).toMatchObject({ type: "decision", decision: { id: dec, kind: "decision", question: "Which bank?", options: ["Qi", "Zain"], project: "q", threadId: 40, answerable: true } });
  led.resolveDecision(dec, "Qi");
  expect(itemDetail({ ledger: led }, `dec:${dec}`, 10)).toMatchObject({ type: "decision", decision: { status: "answered", answerable: false, answer: "Qi" } });
});

test("itemDetail: a plan card names the plan, its state, its actions and the absolute file to read", () => {
  const led = openLedger(":memory:");
  const card = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/p.md — P", folder: "/home/p", project: "p" }, 1);
  const plan = led.upsertPlan({ project: "p", folder: "/home/p", path: "docs/p.md", title: "P", sha256: "x", stepsTotal: 3, stepsDone: 0, status: "sent", gate: "approval", decisionId: card } as never);
  const d = itemDetail({ ledger: led }, `dec:${card}`, 10);
  expect(d).toMatchObject({ type: "plan", decisionId: card, plan: { id: plan.id, version: plan.version, title: "P", project: "p", file: "/home/p/docs/p.md" } });
  expect((d as { plan: { actions: string[] } }).plan.actions).toContain("approve");
  expect((d as { plan: { actions: string[] } }).plan.actions).toContain("drop");
});

test("itemDetail: an attention item, explained, with its own actions; a decision_stale one carries the decision to answer", () => {
  const led = openLedger(":memory:");
  const dec = led.openDecision({ kind: "decision", question: "Should I write a plan?", folder: "/home/neo", project: "neo" }, 1);
  const att = led.insertAttention(stale(dec, "Should I write a plan?"), 2);
  const d = itemDetail({ ledger: led }, `att:${att}`, 10) as Record<string, any>;
  expect(d).toMatchObject({ type: "attention", attention: { id: att, kind: "decision_stale", badge: "decision_stale", plain: "Should I write a plan?" } });
  expect(d.attention.actions).toContain("dismiss");
  expect(d.linked).toMatchObject({ type: "decision", decision: { id: dec, answerable: true } });
  led.resolveDecision(dec, "yes");
  expect((itemDetail({ ledger: led }, `att:${att}`, 10) as Record<string, any>).linked).toBeUndefined();
});

test("itemDetail: a bad, unknown or todo ref is undefined (the console has the todo sheet)", () => {
  const led = openLedger(":memory:");
  for (const ref of ["", "x", "att:0", "att:999", "dec:nope", "dec:../../etc", "todo:1", "att:1;drop"]) expect(itemDetail({ ledger: led }, ref, 10)).toBeUndefined();
});

// Design review (2026-10-30): one shared rule for what a typed answer may close — the `decision` tool and the
// console both use it. An approval (no order) or an alert is closed by its own card; a plan card by its plan.
test("textAnswerRefusal: approvals, alerts and plan cards are never closed by typed text", async () => {
  const { textAnswerRefusal } = await import("../src/engine/decision-settle");
  const led = openLedger(":memory:");
  const work = led.openDecision({ kind: "decision", question: "Which bank?", folder: "/home/q", project: "q", orderId: "o1" }, 1);
  const approval = led.openDecision({ kind: "decision", question: "risky shell command: git push" }, 1);
  const alert = led.openDecision({ kind: "alert", question: "Disk 95% full", orderId: "o2" }, 1);
  const card = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/p.md — P", folder: "/home/p", project: "p", orderId: "o3" }, 1);
  led.upsertPlan({ project: "p", folder: "/home/p", path: "docs/p.md", title: "P", sha256: "x", stepsTotal: 1, stepsDone: 0, status: "sent", gate: "approval", decisionId: card } as never);
  const r = (id: string) => textAnswerRefusal(led.decisionById(id)!, led);
  expect(r(work)).toBeUndefined();
  expect(r(approval)).toBe("approval");
  expect(r(alert)).toBe("alert");
  expect(r(card)).toBe("plan");
});

test("needsYou: a stale reminder is not listed beside its own decision, and goes once the decision is answered", () => {
  const led = openLedger(":memory:");
  const dec = led.openDecision({ kind: "decision", question: "Q?", folder: "/home/neo", project: "neo", orderId: "o" }, 1);
  const att = led.insertAttention(stale(dec, "Q?"), 2);
  const refs = () => needsYou({ ledger: led, keepPatterns: KEEP }, 10).map((i) => i.ref);
  expect(refs()).toEqual([`dec:${dec}`]); // the decision row is the one to act on
  led.setPin(`dec:${dec}`, "unpinned", 3);
  expect(refs()).toEqual([`att:${att}`]); // hidden: the reminder stands in, linked to it
  led.resolveDecision(dec, "yes");
  expect(refs()).toEqual([]); // answered: the reminder is moot
});
