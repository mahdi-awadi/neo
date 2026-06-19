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

test("/use makes a project active and /list marks it with a star", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  const d = deps({ registry });
  expect(handleCommand("/use alpha", 1, d)!.toLowerCase()).toContain("now on alpha");
  const list = handleCommand("/list", 1, d)!;
  const alphaLine = list.split("\n").find((l) => l.includes("alpha"))!;
  const betaLine = list.split("\n").find((l) => l.includes("beta"))!;
  expect(alphaLine).toContain("★");
  expect(betaLine).not.toContain("★");
});

test("/use an unknown project is a friendly error", () => {
  expect(handleCommand("/use ghost", 1, deps())!).toContain("not found");
});

test("/recent shows recent orders with their outcomes", () => {
  const ledger = openLedger(":memory:");
  ledger.recordOrder(order({ id: "a", folder: "/p/alpha", task: "add tests", createdAt: 1 }));
  ledger.recordOutcome("a", "done", "added 3 tests");
  ledger.recordOrder(order({ id: "b", folder: "/p/beta", task: "fix bug", createdAt: 2 }));
  const out = handleCommand("/recent", 1, deps({ ledger }))!;
  expect(out).toContain("alpha");
  expect(out).toContain("add tests");
  expect(out).toContain("done");
  expect(out).toContain("beta"); // newest, still pending
});

test("/recent with no orders reports none", () => {
  expect(handleCommand("/recent", 1, deps())!.toLowerCase()).toContain("no orders");
});

test("returns null for /open and unknown input so the pipeline handles them", () => {
  expect(handleCommand("/open /x do it", 1, deps())).toBeNull();
  expect(handleCommand("just chatting", 1, deps())).toBeNull();
});
