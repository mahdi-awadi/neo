import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createFaultReporter, installSafetyNet, type FaultCfg } from "../src/engine/fault";

const CFG: FaultCfg = { dedupeMs: 15 * 60_000, maxAlertsPerHour: 3, companyHandoff: true, maxHandoffsPerHour: 3 };

function rig(cfg: Partial<FaultCfg> = {}, over: Partial<Record<"record" | "alert" | "toCompany", (...a: any[]) => void>> = {}) {
  let t = 1_000_000;
  const logs: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const alerts: string[] = [];
  const company: string[] = [];
  const r = createFaultReporter(
    {
      log: (l) => void logs.push(l),
      record: over.record ?? ((d) => void records.push(d)),
      alert: over.alert ?? ((x) => void alerts.push(x)),
      toCompany: over.toCompany ?? ((x) => void company.push(x)),
    },
    { ...CFG, ...cfg },
    () => t,
  );
  return { r, logs, records, alerts, company, advance: (ms: number) => void (t += ms) };
}

test("a fault is logged with component, project, order id and stack; recorded; alerted; queued for the company", () => {
  const x = rig();
  x.r.report("telegram.send", new Error("429: Too Many Requests"), { project: "waselni", orderId: "o-1" });
  expect(x.logs[0]).toContain("[fault] telegram.send");
  expect(x.logs[0]).toContain("project=waselni");
  expect(x.logs[0]).toContain("order=o-1");
  expect(x.logs[0]).toContain("429: Too Many Requests");
  expect(x.logs[0]).toContain("fault.test.ts"); // the stack
  expect(x.records[0]).toMatchObject({ component: "telegram.send", message: "429: Too Many Requests", project: "waselni", orderId: "o-1" });
  expect(x.alerts[0]).toContain("telegram.send");
  expect(x.company[0]).toContain("Investigate");
  expect(x.company[0]).toContain("429: Too Many Requests");
});

test("the same signature inside the dedupe window is logged and recorded but not re-sent; after it, re-sent with a count", () => {
  const x = rig();
  for (let i = 0; i < 5; i++) x.r.report("heartbeat.sweepIdle", new Error("database is locked"));
  expect(x.logs).toHaveLength(5);
  expect(x.records).toHaveLength(5);
  expect(x.alerts).toHaveLength(1);
  expect(x.company).toHaveLength(1);
  x.advance(CFG.dedupeMs + 1);
  x.r.report("heartbeat.sweepIdle", new Error("database is locked"));
  expect(x.alerts).toHaveLength(2);
  expect(x.alerts[1]).toContain("4 more");
});

test("distinct faults past the hourly alert cap are logged and recorded, not alerted", () => {
  const x = rig();
  for (const m of "abcdef") x.r.report("c", new Error(`distinct ${m}`));
  expect(x.records).toHaveLength(6);
  expect(x.alerts).toHaveLength(3);
  x.advance(60 * 60_000 + 1);
  x.r.report("c", new Error("later"));
  expect(x.alerts).toHaveLength(4);
});

test("report never throws, even when every sink throws; the company handoff can be switched off", () => {
  const boom = () => {
    throw new Error("sink down");
  };
  const x = rig({}, { record: boom, alert: boom, toCompany: boom });
  expect(() => x.r.report("c", "a string, not an Error")).not.toThrow();
  expect(x.logs.some((l) => l.includes("a string, not an Error"))).toBe(true);
  const off = rig({ companyHandoff: false });
  off.r.report("c", new Error("e"));
  expect(off.company).toHaveLength(0);
  expect(off.alerts).toHaveLength(1);
});

test("guard returns the value, or reports a throw and returns undefined", () => {
  const x = rig();
  expect(x.r.guard("a", () => 7)).toBe(7);
  expect(
    x.r.guard("heartbeat.tickScheduler", () => {
      throw new Error("tick broke");
    }),
  ).toBeUndefined();
  expect(x.records[0]).toMatchObject({ component: "heartbeat.tickScheduler", message: "tick broke" });
});

test("contain reports a rejected promise and a function that throws before returning one", async () => {
  const x = rig();
  x.r.contain("dispatch.continuation", Promise.reject(new Error("late reject")), { orderId: "o-2" });
  x.r.contain("web.send", () => {
    throw new Error("sync throw");
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(x.records.map((r) => r.message)).toEqual(["sync throw", "late reject"]);
  expect(x.records[1]).toMatchObject({ orderId: "o-2" });
});

test("the safety net reports uncaught exceptions and unhandled rejections and keeps running", () => {
  const x = rig();
  const proc = new EventEmitter();
  installSafetyNet(proc, x.r);
  proc.emit("unhandledRejection", new Error("nobody awaited me"), Promise.resolve());
  proc.emit("uncaughtException", new Error("thrown in a timer"));
  expect(x.records.map((r) => r.component)).toEqual(["process.unhandledRejection", "process.uncaughtException"]);
});

// Review fix: a flood ban made every failed send a "new" fault (retry_after differs each time), and
// each one woke the company, whose reply failed again — a loop. Two bounds break it.
test("faults whose messages differ only in numbers share one signature (retry_after, ids, counts)", () => {
  const x = rig();
  x.r.report("telegram.send", new Error("429: Too Many Requests: retry after 3412"));
  x.r.report("telegram.send", new Error("429: Too Many Requests: retry after 3398"));
  x.r.report("telegram.send", new Error("429: Too Many Requests: retry after 17"));
  expect(x.records).toHaveLength(3);
  expect(x.alerts).toHaveLength(1);
  expect(x.company).toHaveLength(1);
});

test("company handoffs are capped per rolling hour, separately from alerts; past the cap they are logged only", () => {
  const x = rig({ maxAlertsPerHour: 100, maxHandoffsPerHour: 2 });
  for (const m of ["a", "b", "c", "d"]) x.r.report("web.route", new Error(`distinct fault ${m}`));
  expect(x.alerts).toHaveLength(4);
  expect(x.company).toHaveLength(2);
  expect(x.logs.some((l) => l.includes("handoff cap"))).toBe(true);
  x.advance(60 * 60_000 + 1);
  x.r.report("web.route", new Error("distinct fault e"));
  expect(x.company).toHaveLength(3);
});
