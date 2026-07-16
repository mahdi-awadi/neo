import { expect, test } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { describeSessionStatus, humanAge, sessionStatuses, sessionsReport } from "../src/engine/session-status";
import type { Order, SessionInfo } from "../src/types";

const order = (o: Partial<Order> = {}): Order => ({
  id: crypto.randomUUID(),
  source: "neo",
  folder: "/p/acme",
  task: "do a thing",
  chatId: 5,
  createdAt: 0,
  ...o,
});

test("humanAge renders compact durations", () => {
  expect(humanAge(5_000)).toBe("5s");
  expect(humanAge(90_000)).toBe("1m");
  expect(humanAge(3 * 60 * 60 * 1000)).toBe("3h");
  expect(humanAge(2 * 24 * 60 * 60 * 1000)).toBe("2d");
});

test("describeSessionStatus reports what a running session is doing, its age, and queue", () => {
  const s: SessionInfo = {
    id: "1",
    name: "acme",
    sdkSessionId: "sdk",
    order: order(),
    status: "running",
    startedAt: 0,
    lastActivityAt: 0,
    activity: { label: "editing files", since: 0 },
  };
  const line = describeSessionStatus(s, 120_000, { queued: 2 });
  expect(line).toContain("running");
  expect(line).toContain("editing files");
  expect(line).toContain("2m"); // activity has run 2 minutes
  expect(line).toContain("2 queued");
});

test("describeSessionStatus reports idle sessions with last-active age, no queue noise", () => {
  const s: SessionInfo = {
    id: "1",
    name: "acme",
    sdkSessionId: "sdk",
    order: order(),
    status: "idle",
    startedAt: 0,
    lastActivityAt: 60_000,
  };
  const line = describeSessionStatus(s, 360_000, {});
  expect(line).toContain("idle");
  expect(line).toContain("5m"); // last active 5 minutes ago
  expect(line).not.toContain("queued");
});

test("sessionStatuses lists open project sessions and excludes the company/default", () => {
  const reg = createRegistry();
  const company = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 0);
  reg.setDefault(company.id);
  reg.setStatus(company.id, "idle");
  const a = reg.add(order({ folder: "/p/alpha", chatId: 5 }), 1);
  reg.noteActivity(a.id, "running tests", 1);
  reg.add(order({ folder: "/p/beta", chatId: 5 }), 2);

  const views = sessionStatuses(reg, 61_000);
  expect(views.map((v) => v.name).sort()).toEqual(["alpha", "beta"]); // company excluded
  const alpha = views.find((v) => v.name === "alpha")!;
  expect(alpha.folder).toBe("/p/alpha");
  expect(alpha.line).toContain("running tests");
});

test("sessionStatuses reads the live queue depth from the control handle", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/alpha", chatId: 5 }), 1);
  reg.attachControl(a.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 3 });
  const [alpha] = sessionStatuses(reg, 1);
  expect(alpha.line).toContain("3 queued");
});

test("sessionsReport renders a one-line-per-project summary the company can read", () => {
  const reg = createRegistry();
  const company = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 0);
  reg.setDefault(company.id);
  const a = reg.add(order({ folder: "/p/alpha", chatId: 5 }), 1);
  reg.noteActivity(a.id, "running tests", 1);
  const report = sessionsReport(reg, 1);
  expect(report).toContain("alpha");
  expect(report).toContain("running tests");
  expect(report).not.toContain("agent"); // the company itself is excluded
});

test("sessionsReport says so when no projects are open", () => {
  const reg = createRegistry();
  const company = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 0);
  reg.setDefault(company.id);
  expect(sessionsReport(reg, 1).toLowerCase()).toContain("no projects");
});
