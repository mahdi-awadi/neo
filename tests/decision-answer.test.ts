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

test("answerDecision resolves the row and seeds a resume, returning the grounded brief", () => {
  const { registry, ledger, deps } = fixture();
  addSession(registry, "/home/acme", "idle");
  const id = ledger.openDecision({ kind: "decision", project: "acme", folder: "/home/acme", question: "Postgres or Mongo?" });
  const dec = ledger.decisionById(id)!;
  const brief = answerDecision(deps, dec, "Postgres", CHAT);
  // The row is now answered (drops out of the open queue) with the recorded answer.
  expect(ledger.listOpenDecisions()).toHaveLength(0);
  expect(ledger.decisionById(id)).toMatchObject({ status: "answered", answer: "Postgres" });
  // The raising project is focused for the resume, and the delivered brief re-grounds the worker.
  expect(brief).toBe(repliedContextBrief("Postgres or Mongo?", "Postgres"));
  expect(registry.getFocus(CHAT)?.session.order.folder).toBe("/home/acme");
});

test("answerDecision with no folder resolves the row but seeds no resume (returns undefined)", () => {
  const { registry, ledger, deps } = fixture();
  const id = ledger.openDecision({ kind: "decision", question: "risky deploy — allow?" });
  const dec = ledger.decisionById(id)!;
  const brief = answerDecision(deps, dec, "deny", CHAT);
  expect(brief).toBeUndefined();
  expect(ledger.decisionById(id)).toMatchObject({ status: "answered", answer: "deny" });
  expect(registry.getFocus(CHAT)).toBeUndefined(); // nothing to resume — no folder
});
