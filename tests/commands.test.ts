import { test, expect } from "bun:test";
import { handleCommand } from "../src/engine/commands";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: "neo",
    folder: over.folder ?? "/proj/app",
    task: "t",
    chatId: over.chatId ?? 1,
    createdAt: 1,
  };
}
const meter = () => createMeter({ windowBudgetUsd: 10, reservePct: 0.2 });

test("/status lists live sessions and the budget headroom", () => {
  const registry = createRegistry();
  const m = meter();
  m.note({ costUsd: 2 });
  registry.add(order({ folder: "/proj/app" }), 1);

  const out = handleCommand("/status", { registry, meter: m })!;

  expect(out).toContain("app"); // session name
  expect(out).toContain("running");
  expect(out.toLowerCase()).toContain("budget");
});

test("/status reports when there are no live sessions", () => {
  const out = handleCommand("/status", { registry: createRegistry(), meter: meter() })!;
  expect(out.toLowerCase()).toContain("no live sessions");
});

test("/kill interrupts a named session and drops it from the registry", () => {
  const registry = createRegistry();
  const o = order({ folder: "/proj/app" });
  registry.add(o, 1);
  let interrupted = false;
  registry.attachControl(o.id, { followUp: () => {}, interrupt: async () => void (interrupted = true) });

  const out = handleCommand("/kill app", { registry, meter: meter() })!;

  expect(out).toContain("Killed");
  expect(interrupted).toBe(true);
  expect(registry.findByName("app")).toBeUndefined();
});

test("/kill an unknown name returns a friendly error", () => {
  const out = handleCommand("/kill ghost", { registry: createRegistry(), meter: meter() })!;
  expect(out).toContain("not found");
});

test("/kill with no name returns usage", () => {
  const out = handleCommand("/kill", { registry: createRegistry(), meter: meter() })!;
  expect(out.toLowerCase()).toContain("usage");
});

test("handleCommand returns null for a non-command message", () => {
  const out = handleCommand("/open /x do it", { registry: createRegistry(), meter: meter() });
  expect(out).toBeNull();
});
