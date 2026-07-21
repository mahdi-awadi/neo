import { test, expect } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMessageRoutes } from "../src/engine/message-routes";
import { routeReply, repliedContextBrief, UNRESOLVED_REPLY_MESSAGE } from "../src/engine/reply-routing";
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

test("a non-reply message is delivered unchanged and sets no focus (company routing preserved)", () => {
  const { registry, deps } = fixture();
  const res = routeReply(deps, { chatId: CHAT, text: "just a normal message" });
  expect(res).toEqual({ deliver: "just a normal message" });
  expect(registry.getFocus(CHAT)).toBeUndefined();
});

test("a reply we can't attribute asks the operator to name it — it does NOT hit the company", () => {
  const { registry, deps } = fixture();
  const res = routeReply(deps, { chatId: CHAT, replyToMessageId: 500, replyToText: "hi", text: "do it" });
  expect(res).toEqual({ clarify: UNRESOLVED_REPLY_MESSAGE });
  expect(registry.getFocus(CHAT)).toBeUndefined(); // no silent focus/misroute
});

test("a reply to a LIVE project's message focuses it once, delivered unchanged (no re-grounding)", () => {
  const { registry, routes, deps } = fixture();
  const s = addSession(registry, "/home/acme", "running");
  routes.remember(CHAT, 10, { sessionId: s.id, folder: "/home/acme", project: "acme" });
  const res = routeReply(deps, { chatId: CHAT, replyToMessageId: 10, replyToText: "building X", text: "yes ship it" });
  expect(res).toEqual({ deliver: "yes ship it" });
  const focus = registry.getFocus(CHAT);
  expect(focus?.session.id).toBe(s.id);
  expect(focus?.mode).toBe("once");
});

test("a reply to an IDLE (resumable) project focuses it and prepends the replied-to original", () => {
  const { registry, routes, deps } = fixture();
  const s = addSession(registry, "/home/acme", "idle");
  routes.remember(CHAT, 11, { sessionId: s.id, folder: "/home/acme", project: "acme" });
  const res = routeReply(deps, { chatId: CHAT, replyToMessageId: 11, replyToText: "I proposed plan A", text: "go with it" });
  expect(res).toEqual({ deliver: repliedContextBrief("I proposed plan A", "go with it") });
  expect(registry.getFocus(CHAT)?.session.id).toBe(s.id);
});

test("a reply to an idle-CLOSED project (gone from the registry) resumes it: registers a focused, seeded entry", () => {
  const { registry, ledger, routes, deps } = fixture();
  // Simulate a project that was idle-closed: a recorded resume id in the ledger, nothing in the registry.
  const o: Order = { id: "old-order", source: "neo", folder: "/home/acme", task: "t", chatId: CHAT, createdAt: 0 };
  ledger.recordOrder(o);
  ledger.recordSession("old-order", "sdk-resume-xyz");
  routes.remember(CHAT, 12, { sessionId: "gone", folder: "/home/acme", project: "acme" });

  const res = routeReply(deps, { chatId: CHAT, replyToMessageId: 12, replyToText: "sent the draft", text: "tweak it" });

  expect(res).toEqual({ deliver: repliedContextBrief("sent the draft", "tweak it") });
  const focused = registry.getFocus(CHAT)?.session;
  expect(focused).toBeTruthy();
  expect(focused!.order.folder).toBe("/home/acme");
  expect(focused!.status).toBe("idle"); // the pipeline's resume branch will pick it up
  expect(focused!.sdkSessionId).toBe("sdk-resume-xyz"); // seeded so the SDK conversation resumes
});

test("a resume with no replied-to text delivers unchanged (nothing to prepend)", () => {
  const { registry, routes, deps } = fixture();
  const s = addSession(registry, "/home/acme", "idle");
  routes.remember(CHAT, 13, { sessionId: s.id, folder: "/home/acme", project: "acme" });
  const res = routeReply(deps, { chatId: CHAT, replyToMessageId: 13, text: "continue" });
  expect(res).toEqual({ deliver: "continue" });
});

test("repliedContextBrief frames the original + the operator's reply", () => {
  expect(repliedContextBrief("A", "B")).toBe("You previously sent: «A». The operator is replying to that: B");
});
