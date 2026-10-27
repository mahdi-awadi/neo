// ADR-0054 B2: every order ends. An order with no outcome and no activity since the previous engine
// boot was cut off by a restart: at boot it gets the outcome `interrupted`, so a question it raised can
// expire (ADR-0053) instead of waiting for an end that never comes.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { DEFAULT_DECISION_SETTLE } from "../src/engine/decision-settle";

const DAY = 86_400_000;
const PREV_BOOT = 100 * DAY;
const order = (id: string, createdAt: number, folder = "/home/eticket-v3") => ({ id, source: "neo" as const, folder, task: "t", chatId: 7, createdAt });

test("endInterruptedOrders closes only orders silent since the previous boot", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order("x", PREV_BOOT - 5 * DAY)); // its last event is before the previous boot
  led.recordEvent("session_start", { orderId: "x", at: PREV_BOOT - 4 * DAY });
  led.recordOrder(order("y", PREV_BOOT - 5 * DAY)); // active in the previous daemon life
  led.recordEvent("session_start", { orderId: "y", at: PREV_BOOT + DAY });
  led.recordOrder(order("z", PREV_BOOT - 5 * DAY)); // already ended
  led.recordOutcome("z", "done", "ok", PREV_BOOT - 3 * DAY);
  led.recordOrder(order("w", PREV_BOOT - DAY)); // no events at all: its creation is its last activity
  expect(led.endInterruptedOrders(PREV_BOOT)).toBe(2);
  expect(led.getOutcome("x")?.status).toBe("interrupted");
  expect(led.getOutcome("w")?.status).toBe("interrupted");
  // Dated at the last known activity, not at the boot.
  expect(led.outcomesForFolder("/home/eticket-v3").find((o) => o.orderId === "x")?.at).toBe(PREV_BOOT - 4 * DAY);
  expect(led.getOutcome("y")).toBeUndefined();
  expect(led.getOutcome("z")?.status).toBe("done");
  // Idempotent: a second boot sweep with the same boundary changes nothing.
  expect(led.endInterruptedOrders(PREV_BOOT)).toBe(0);
});

test("a resumed order is not interrupted", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order("r", PREV_BOOT - 5 * DAY));
  led.recordEvent("session_start", { orderId: "r", at: PREV_BOOT + 10 });
  expect(led.endInterruptedOrders(PREV_BOOT)).toBe(0);
  expect(led.getOutcome("r")).toBeUndefined();
});

test("expiry counts an interrupted order as ended; a keep-pattern question still never expires", () => {
  const led = openLedger(":memory:");
  const t = createTrace({ ledger: led, registry: createRegistry(), settleCfg: () => DEFAULT_DECISION_SETTLE });
  const root = t.inbound({ chatId: 7, text: "Continue on eticket-v3", surface: "telegram" });
  const asked = PREV_BOOT - 20 * DAY;
  led.recordOrder(order("old", asked - DAY), { cause: root });
  const plain = led.openDecision({ kind: "decision", question: "Where should support agents see the AI chat?", folder: "/home/eticket-v3", orderId: "old", cause: root }, asked);
  const prod = led.openDecision({ kind: "decision", question: "Allow one read-only prod check?", folder: "/home/eticket-v3", orderId: "old", cause: root }, asked);
  // Later work in the same folder ended done.
  led.recordOrder(order("later", asked + DAY));
  led.recordOutcome("later", "done", "ok", asked + 2 * DAY);
  t.refreshThread(root.threadId);
  expect(led.decisionById(plain)?.status).toBe("open"); // its order never ended: nothing to go on
  led.endInterruptedOrders(PREV_BOOT);
  t.refreshThread(root.threadId);
  expect(led.decisionById(plain)?.status).toBe("expired");
  expect(led.decisionById(prod)?.status).toBe("open");
});

test("an interrupted order does not turn its thread failed", () => {
  const led = openLedger(":memory:");
  const t = createTrace({ ledger: led, registry: createRegistry() });
  const root = t.inbound({ chatId: 7, text: "fix the wallet", surface: "telegram" });
  led.recordOrder(order("o", PREV_BOOT - 2 * DAY), { cause: root });
  led.recordOutcome("o", "done", "ok", PREV_BOOT - DAY);
  led.recordOrder(order("cut", PREV_BOOT - DAY / 2), { cause: root });
  led.endInterruptedOrders(PREV_BOOT);
  t.refreshThread(root.threadId);
  expect(led.threadById(root.threadId)?.state).toBe("done");
});
