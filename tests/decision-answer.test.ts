import { test, expect } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMessageRoutes } from "../src/engine/message-routes";
import { deliverIntoFolder, answerDecision, repliedContextBrief } from "../src/engine/reply-routing";
import type { Order } from "../src/types";

const CHAT = 42;

function fixture() {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const routes = createMessageRoutes({ ledger });
  return { registry, ledger, routes, deps: { registry, ledger, routes, now: () => 1000 } };
}

function addSession(registry: ReturnType<typeof createRegistry>, folder: string, status: "running" | "idle") {
  const order: Order = { id: crypto.randomUUID(), source: "neo", folder, task: "t", chatId: CHAT, createdAt: 0 };
  const s = registry.add(order, 0);
  registry.setStatus(s.id, status);
  return s;
}

test("deliverIntoFolder focuses a LIVE session once (no re-seeding)", () => {
  const { registry, deps } = fixture();
  const s = addSession(registry, "/home/acme", "running");
  const out = deliverIntoFolder(deps, "/home/acme", CHAT, "your answer");
  expect(out).toBe("your answer");
  const focus = registry.getFocus(CHAT);
  expect(focus?.session.id).toBe(s.id);
  expect(focus?.mode).toBe("once");
});

test("deliverIntoFolder rebuilds an idle-CLOSED session (seeded, focused, resumable)", () => {
  const { registry, ledger, deps } = fixture();
  // A project that was idle-closed: a recorded resume id in the ledger, nothing in the registry.
  const o: Order = { id: "old-order", source: "neo", folder: "/home/acme", task: "t", chatId: CHAT, createdAt: 0 };
  ledger.recordOrder(o);
  ledger.recordSession("old-order", "sdk-resume-xyz");
  deliverIntoFolder(deps, "/home/acme", CHAT, "the answer");
  const focused = registry.getFocus(CHAT)?.session;
  expect(focused).toBeTruthy();
  expect(focused!.order.folder).toBe("/home/acme");
  expect(focused!.status).toBe("idle"); // the pipeline's resume branch will pick it up
  expect(focused!.sdkSessionId).toBe("sdk-resume-xyz"); // seeded so the SDK conversation resumes
});

test("answerDecision resolves the row and seeds a resume, returning the grounded brief + home chat", () => {
  const { registry, ledger, deps } = fixture();
  addSession(registry, "/home/acme", "idle");
  const id = ledger.openDecision({ kind: "decision", project: "acme", folder: "/home/acme", question: "Postgres or Mongo?" });
  const dec = ledger.decisionById(id)!;
  const resumed = answerDecision(deps, dec, "Postgres", CHAT);
  // The row is now answered (drops out of the open queue) with the recorded answer.
  expect(ledger.listOpenDecisions()).toHaveLength(0);
  expect(ledger.decisionById(id)).toMatchObject({ status: "answered", answer: "Postgres" });
  // The raising project is focused for the resume, and the delivered brief re-grounds the worker.
  expect(resumed?.brief).toBe(repliedContextBrief("Postgres or Mongo?", "Postgres"));
  expect(resumed?.homeChat).toBe(CHAT); // this decision has no stored chat → falls back to the answer chat
  expect(registry.getFocus(CHAT)?.session.order.folder).toBe("/home/acme");
});

test("answering a decision posted to the GROUP resumes homed to the ORIGINAL raising chat (the DM), not the group", () => {
  // The reported bug: a decision is posted to the unmuted group and answered there, so the resume was
  // homed to the group and flooded it with the project's progress. The resume must go back to the DM.
  const { registry, ledger, deps } = fixture();
  const DM = 42; // the raising session's home chat (the muted operator DM)
  const GROUP = -1004429044948; // the unmuted Decisions group the decision was posted + answered in
  const o: Order = { id: "raise-order", source: "neo", folder: "/home/acme", task: "t", chatId: DM, createdAt: 0 };
  ledger.recordOrder(o);
  ledger.recordSession("raise-order", "sdk-xyz");
  // Raised with chatId = the DM (raiseOperatorDecision stores the raising chat), posted to the group.
  const id = ledger.openDecision({ kind: "decision", project: "acme", folder: "/home/acme", chatId: DM, question: "Postgres or Mongo?" });
  const dec = ledger.decisionById(id)!;
  // The operator answers IN THE GROUP (a tapped button or a plain reply both arrive here).
  const resumed = answerDecision(deps, dec, "Postgres", GROUP);
  expect(resumed?.homeChat).toBe(DM); // homed to the DM, NOT the group where it was answered
  const focused = registry.getFocus(DM)?.session;
  expect(focused?.order.folder).toBe("/home/acme");
  expect(focused?.order.chatId).toBe(DM); // the resumed Order streams to the DM firehose
  expect(registry.getFocus(GROUP)).toBeUndefined(); // never homed to the group
});

test("answerDecision falls back to the answer chat when the decision has no stored raising chat", () => {
  // A decision posted straight to the DM (no group configured) and answered there still resumes there.
  const { registry, ledger, deps } = fixture();
  addSession(registry, "/home/acme", "idle");
  const id = ledger.openDecision({ kind: "decision", project: "acme", folder: "/home/acme", question: "?" });
  const dec = ledger.decisionById(id)!;
  const resumed = answerDecision(deps, dec, "yes", CHAT);
  expect(resumed?.homeChat).toBe(CHAT);
  expect(registry.getFocus(CHAT)?.session.order.folder).toBe("/home/acme");
});

test("answerDecision with no folder resolves the row but seeds no resume (returns undefined)", () => {
  const { registry, ledger, deps } = fixture();
  const id = ledger.openDecision({ kind: "decision", question: "risky deploy — allow?" });
  const dec = ledger.decisionById(id)!;
  const resumed = answerDecision(deps, dec, "deny", CHAT);
  expect(resumed).toBeUndefined();
  expect(ledger.decisionById(id)).toMatchObject({ status: "answered", answer: "deny" });
  expect(registry.getFocus(CHAT)).toBeUndefined(); // nothing to resume — no folder
});
