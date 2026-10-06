import { expect, test } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { describeSession, humanAge, sessionStatuses, sessionsReport } from "../src/engine/session-status";
import type { Order } from "../src/types";

const order = (o: Partial<Order> = {}): Order => ({
  id: crypto.randomUUID(),
  source: "neo",
  folder: "/p/acme",
  task: "do a thing",
  chatId: 5,
  createdAt: 0,
  ...o,
});

const busyControl = () => ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => true });
const idleControl = () => ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false });

test("humanAge renders compact durations", () => {
  expect(humanAge(5_000)).toBe("5s");
  expect(humanAge(90_000)).toBe("1m");
  expect(humanAge(3 * 60 * 60 * 1000)).toBe("3h");
  expect(humanAge(2 * 24 * 60 * 60 * 1000)).toBe("2d");
});

test("describeSession reports a working session's activity, both clocks and its queue", () => {
  const reg = createRegistry();
  const s = reg.add(order(), 0);
  reg.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 2, active: () => true });
  reg.noteActivity(s.id, "editing files", 100_000);

  const line = describeSession(reg, s, 120_000);
  expect(line).toContain("working");
  expect(line).toContain("editing files");
  expect(line).toContain("last activity 20s ago");
  expect(line).toContain("2 queued");
});

// The incident: adminli was described as "running · waiting for 10h" while healthy, and the
// company read that as wedged. A session with nothing in flight is IDLE, at any age.
test("describeSession calls a session with nothing in flight idle, not running or wedged", () => {
  const reg = createRegistry();
  const s = reg.add(order(), 0);
  reg.attachControl(s.id, idleControl());
  reg.noteActivity(s.id, "waiting", 0);

  const line = describeSession(reg, s, 10 * 60 * 60 * 1000);
  expect(line).toContain("idle");
  expect(line).toContain("nothing in flight");
  expect(line).not.toContain("running");
  expect(line).not.toContain("wedged");
});

test("describeSession calls an in-turn session with no activity wedged, and says on what", () => {
  const reg = createRegistry();
  const s = reg.add(order(), 0);
  reg.attachControl(s.id, busyControl());
  reg.noteActivity(s.id, "Bash: cp -i a b", 0);

  const line = describeSession(reg, s, 12 * 60 * 1000);
  expect(line).toContain("wedged");
  expect(line).toContain("no activity for 12m");
  expect(line).toContain("Bash: cp -i a b");
  expect(line).toContain("stdin wait");
});

test("describeSession reports a session waiting on the operator as awaiting-operator", () => {
  const reg = createRegistry();
  const s = reg.add(order(), 0);
  reg.attachControl(s.id, busyControl());
  reg.noteBlocked(s.id, { kind: "approval", label: "Write outside project", since: 0 });

  const line = describeSession(reg, s, 30 * 60 * 1000);
  expect(line).toContain("awaiting-operator");
  expect(line).toContain("Write outside project");
  expect(line).not.toContain("wedged");
});

test("describeSession reports an ended session as idle with its last-activity age", () => {
  const reg = createRegistry();
  const s = reg.add(order(), 0);
  reg.setStatus(s.id, "idle");
  reg.noteHeartbeat(s.id, 60_000);

  const line = describeSession(reg, s, 360_000);
  expect(line).toContain("idle");
  expect(line).toContain("last activity 5m ago");
  expect(line).not.toContain("queued");
});

test("sessionStatuses lists open project sessions with their derived state, excluding the company", () => {
  const reg = createRegistry();
  const company = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 0);
  reg.setDefault(company.id);
  reg.setStatus(company.id, "idle");
  const a = reg.add(order({ folder: "/p/alpha", chatId: 5 }), 1);
  reg.attachControl(a.id, busyControl());
  reg.noteActivity(a.id, "running tests", 1);
  reg.add(order({ folder: "/p/beta", chatId: 5 }), 2);

  const views = sessionStatuses(reg, 61_000);
  expect(views.map((v) => v.name).sort()).toEqual(["alpha", "beta"]); // company excluded
  const alpha = views.find((v) => v.name === "alpha")!;
  expect(alpha.folder).toBe("/p/alpha");
  expect(alpha.state).toBe("working");
  expect(alpha.line).toContain("running tests");
});

test("sessionStatuses reads the live queue depth from the control handle", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/alpha", chatId: 5 }), 1);
  reg.attachControl(a.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 3, active: () => true });
  const [alpha] = sessionStatuses(reg, 1);
  expect(alpha.line).toContain("3 queued");
});

test("sessionsReport renders a one-line-per-project summary the company can read", () => {
  const reg = createRegistry();
  const company = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 0);
  reg.setDefault(company.id);
  const a = reg.add(order({ folder: "/p/alpha", chatId: 5 }), 1);
  reg.attachControl(a.id, busyControl());
  reg.noteActivity(a.id, "running tests", 1);
  const report = sessionsReport(reg, 1);
  expect(report).toContain("alpha");
  expect(report).toContain("running tests");
  expect(report).not.toContain("agent"); // the company itself is excluded
});

test("sessionsReport explains its own vocabulary so the reader can't misread idle as wedged", () => {
  const reg = createRegistry();
  const company = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 0);
  reg.setDefault(company.id);
  const a = reg.add(order({ folder: "/p/alpha", chatId: 5 }), 1);
  reg.attachControl(a.id, idleControl());
  const report = sessionsReport(reg, 1);
  expect(report).toContain("idle = healthy");
  expect(report).toContain("wedged");
});

test("sessionsReport says so when no projects are open", () => {
  const reg = createRegistry();
  const company = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 0);
  reg.setDefault(company.id);
  expect(sessionsReport(reg, 1).toLowerCase()).toContain("no projects");
});
