import { test, expect } from "bun:test";
import { handleCommand } from "../src/engine/commands";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: "neo",
    folder: over.folder ?? "/proj/app",
    task: over.task ?? "do the thing",
    chatId: over.chatId ?? 1,
    createdAt: 1,
  };
}
function deps(over: { registry?: ReturnType<typeof createRegistry>; ledger?: ReturnType<typeof openLedger> } = {}) {
  return {
    registry: over.registry ?? createRegistry(),
    ledger: over.ledger ?? openLedger(":memory:"),
    now: () => 100000,
  };
}

test("/help lists the available commands including /open", () => {
  const out = handleCommand("/help", 1, deps())!;
  expect(out).toContain("/open");
  expect(out).toContain("/list");
  expect(out).toContain("/kill");
});

test("/list shows open projects with name, folder, status, and task", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/proj/app", task: "add tests to math" }), 1000);
  const out = handleCommand("/list", 1, deps({ registry }))!;
  expect(out).toContain("app");
  expect(out).toContain("/proj/app");
  expect(out).toContain("add tests");
});

test("/list reports none when there are no open projects", () => {
  expect(handleCommand("/list", 1, deps())!.toLowerCase()).toContain("no open projects");
});

test("/status is an alias of /list", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/x" }), 1);
  const d = deps({ registry });
  expect(handleCommand("/status", 1, d)).toBe(handleCommand("/list", 1, d));
});

test("there is NO budget/dollar readout anymore", () => {
  const registry = createRegistry();
  registry.add(order(), 1);
  const out = handleCommand("/list", 1, deps({ registry }))!;
  expect(out).not.toContain("$");
  expect(out.toLowerCase()).not.toContain("budget");
});

test("/kill interrupts a named session and drops it", () => {
  const registry = createRegistry();
  const o = order({ folder: "/p/app" });
  registry.add(o, 1);
  let interrupted = false;
  registry.attachControl(o.id, { followUp: () => {}, interrupt: async () => void (interrupted = true) });
  const out = handleCommand("/kill app", 1, deps({ registry }))!;
  expect(out).toContain("Killed");
  expect(interrupted).toBe(true);
  expect(registry.findByName("app")).toBeUndefined();
});

test("/kill an unknown name returns a friendly error; no name returns usage", () => {
  expect(handleCommand("/kill ghost", 1, deps())!).toContain("not found");
  expect(handleCommand("/kill", 1, deps())!.toLowerCase()).toContain("usage");
});

test("returns null for /open and unknown input so the pipeline handles them", () => {
  expect(handleCommand("/open /x do it", 1, deps())).toBeNull();
  expect(handleCommand("just chatting", 1, deps())).toBeNull();
});
