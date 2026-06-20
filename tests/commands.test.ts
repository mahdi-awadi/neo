import { test, expect } from "bun:test";
import { handleCommand, selectProject, killProject } from "../src/engine/commands";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { openTrustStore } from "../src/engine/trust";
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
function deps(
  over: {
    registry?: ReturnType<typeof createRegistry>;
    ledger?: ReturnType<typeof openLedger>;
    usage?: any;
  } = {},
) {
  return {
    registry: over.registry ?? createRegistry(),
    ledger: over.ledger ?? openLedger(":memory:"),
    usage: over.usage as any,
    trust: openTrustStore(":memory:"),
    now: () => 100000,
  };
}

function fakeUsage(over: { hourly?: number; daily?: number; weekly?: number; rateLimits?: any[] } = {}) {
  const w = (consumedTokens: number) => ({ consumedTokens, consumedInput: 0, consumedOutput: 0, capTokens: null, remaining: null });
  return {
    snapshot: () => ({
      perWindow: { hourly: w(over.hourly ?? 41_800_000), daily: w(over.daily ?? 1_100_000_000), weekly: w(over.weekly ?? 5_000_000_000) },
      contextOccupancy: 477_000,
      weeklyResetAt: Date.parse("2026-06-22T10:00:00.000Z"),
      rateLimits: over.rateLimits ?? [],
      turnCount: 100,
      computedAt: 0,
    }),
  };
}

test("/help lists the available commands including /open", () => {
  const out = handleCommand("/help", 1, deps())!.text;
  expect(out).toContain("/open");
  expect(out).toContain("/list");
  expect(out).toContain("/kill");
});

test("/list shows open projects with name, folder, status, and task", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/proj/app", task: "add tests to math" }), 1000);
  const out = handleCommand("/list", 1, deps({ registry }))!.text;
  expect(out).toContain("app");
  expect(out).toContain("/proj/app");
  expect(out).toContain("add tests");
});

test("/list reports none when there are no open projects", () => {
  expect(handleCommand("/list", 1, deps())!.text.toLowerCase()).toContain("no open projects");
});

test("/status is an alias of /list", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/x" }), 1);
  const d = deps({ registry });
  expect(handleCommand("/status", 1, d)!.text).toBe(handleCommand("/list", 1, d)!.text);
});

test("there is NO budget/dollar readout anymore", () => {
  const registry = createRegistry();
  registry.add(order(), 1);
  const out = handleCommand("/list", 1, deps({ registry }))!.text;
  expect(out).not.toContain("$");
  expect(out.toLowerCase()).not.toContain("budget");
});

test("/kill interrupts a named session and drops it", () => {
  const registry = createRegistry();
  const o = order({ folder: "/p/app" });
  registry.add(o, 1);
  let interrupted = false;
  registry.attachControl(o.id, { followUp: () => {}, interrupt: async () => void (interrupted = true) });
  const out = handleCommand("/kill app", 1, deps({ registry }))!.text;
  expect(out).toContain("Killed");
  expect(interrupted).toBe(true);
  expect(registry.findByName("app")).toBeUndefined();
});

test("/kill an unknown name returns a friendly error; no name returns usage", () => {
  expect(handleCommand("/kill ghost", 1, deps())!.text).toContain("not found");
  expect(handleCommand("/kill", 1, deps())!.text.toLowerCase()).toContain("usage");
});

test("/use makes a project active and /list marks it with a star", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  const d = deps({ registry });
  expect(handleCommand("/use alpha", 1, d)!.text.toLowerCase()).toContain("now on alpha");
  const list = handleCommand("/list", 1, d)!.text;
  const alphaLine = list.split("\n").find((l) => l.includes("alpha"))!;
  const betaLine = list.split("\n").find((l) => l.includes("beta"))!;
  expect(alphaLine).toContain("★");
  expect(betaLine).not.toContain("★");
});

test("/use an unknown project is a friendly error", () => {
  expect(handleCommand("/use ghost", 1, deps())!.text).toContain("not found");
});

test("/recent shows recent orders with their outcomes", () => {
  const ledger = openLedger(":memory:");
  ledger.recordOrder(order({ id: "a", folder: "/p/alpha", task: "add tests", createdAt: 1 }));
  ledger.recordOutcome("a", "done", "added 3 tests");
  ledger.recordOrder(order({ id: "b", folder: "/p/beta", task: "fix bug", createdAt: 2 }));
  const out = handleCommand("/recent", 1, deps({ ledger }))!.text;
  expect(out).toContain("alpha");
  expect(out).toContain("add tests");
  expect(out).toContain("done");
  expect(out).toContain("beta"); // newest, still pending
});

test("/recent with no orders reports none", () => {
  expect(handleCommand("/recent", 1, deps())!.text.toLowerCase()).toContain("no orders");
});

test("/usage renders hourly/daily/weekly token usage + weekly reset, no dollars", () => {
  const out = handleCommand("/usage", 1, deps({ usage: fakeUsage() }))!.text;
  expect(out).toContain("41.8M");
  expect(out).toContain("1.1B");
  expect(out).toContain("5.0B");
  expect(out.toLowerCase()).toContain("weekly");
  expect(out).toContain("resets");
  expect(out).not.toContain("$"); // measured tokens, not a dollar budget
});

test("/usage degrades gracefully when no meter is wired", () => {
  expect(handleCommand("/usage", 1, deps())!.text.toLowerCase()).toContain("unavailable");
});

test("/usage shows per-window limit status and % left when the SDK provides it", () => {
  const usage = fakeUsage({
    rateLimits: [
      { status: "allowed", rateLimitType: "five_hour", resetsAt: 1781923200 },
      { status: "allowed_warning", rateLimitType: "seven_day", resetsAt: 1782000000, utilization: 0.88 },
    ],
  });
  const out = handleCommand("/usage", 1, deps({ usage }))!.text;
  expect(out).toContain("5-hour");
  expect(out.toLowerCase()).toContain("within limit"); // five_hour, no utilization sent
  expect(out).toContain("7-day");
  expect(out).toContain("88% used"); // seven_day utilization 0.88
  expect(out).toContain("12% left");
});

test("/list returns selectable projects with the active one flagged", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  const b = registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  registry.setActive(1, b.id);
  const res = handleCommand("/list", 1, deps({ registry }))!;
  expect(res.select?.map((s) => s.label)).toEqual(["alpha", "beta"]);
  const beta = res.select?.find((s) => s.label === "beta");
  expect(beta?.active).toBe(true);
  expect(beta?.id).toBe(b.id);
  expect(beta?.folder).toBe("/p/beta");
  expect(beta?.status).toBe("running");
});

test("killProject interrupts + removes the session and returns the refreshed list", () => {
  const registry = createRegistry();
  const a = registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  let interrupted = false;
  registry.attachControl(a.id, { followUp: () => {}, interrupt: async () => void (interrupted = true) });
  const res = killProject(a.id, 1, deps({ registry }));
  expect(interrupted).toBe(true);
  expect(registry.get(a.id)).toBeUndefined();
  expect(res.select?.map((s) => s.label)).toEqual(["beta"]);
});

test("selectProject sets the active project and returns the refreshed list", () => {
  const registry = createRegistry();
  const a = registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  const res = selectProject(a.id, 1, deps({ registry }));
  expect(registry.findByChat(1)?.id).toBe(a.id);
  expect(res.select?.find((s) => s.label === "alpha")?.active).toBe(true);
});

test("returns null for /open and unknown input so the pipeline handles them", () => {
  expect(handleCommand("/open /x do it", 1, deps())).toBeNull();
  expect(handleCommand("just chatting", 1, deps())).toBeNull();
});

test("killProject refuses to kill the default company project", () => {
  const registry = createRegistry();
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(o, 0);
  registry.setDefault(o.id);
  const d = deps({ registry });

  const result = killProject("company", 1, d);

  expect(result.text).toContain("always-on");
  expect(registry.get("company")).toBeDefined(); // not removed
});

test("/trust on trusts the company when it is the fallback target, then /trust off untrusts", () => {
  const registry = createRegistry();
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(o, 0);
  registry.setDefault(o.id); // free-text falls back to the company
  const trust = openTrustStore(":memory:");
  const d = { registry, ledger: openLedger(":memory:"), trust, now: () => 1 };

  expect(handleCommand("/trust on", 5, d)!.text).toContain("🔓");
  expect(trust.isTrusted("/home/neo/agent")).toBe(true);
  expect(handleCommand("/trust", 5, d)!.text).toContain("trusted");
  expect(handleCommand("/trust off", 5, d)!.text).toContain("🔒");
  expect(trust.isTrusted("/home/neo/agent")).toBe(false);
});

test("/trust on then /trust toggles and reports trust when a project is explicitly selected", () => {
  const registry = createRegistry();
  const company = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(company, 0);
  registry.setDefault(company.id);
  const proj = order({ id: "proj1", folder: "/home/neo/myproject", chatId: 5 });
  registry.add(proj, 0);
  registry.setActive(5, proj.id); // chatId 5 has explicitly selected proj1
  const trust = openTrustStore(":memory:");
  const d = { registry, ledger: openLedger(":memory:"), trust, now: () => 1 };

  expect(handleCommand("/trust on", 5, d)!.text).toContain("🔓");
  expect(trust.isTrusted("/home/neo/myproject")).toBe(true);
  expect(handleCommand("/trust", 5, d)!.text).toContain("trusted");
  expect(handleCommand("/trust off", 5, d)!.text).toContain("🔒");
  expect(trust.isTrusted("/home/neo/myproject")).toBe(false);
});
