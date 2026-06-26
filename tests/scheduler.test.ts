import { test, expect } from "bun:test";
import { tickScheduler, type SchedulableLoop, type LoopStateStore } from "../src/engine/scheduler";

function memStore(init: Record<string, { lastRun?: number; enabled?: boolean }> = {}): LoopStateStore {
  const s = new Map(Object.entries(init));
  return {
    getLastRun: (n) => s.get(n)?.lastRun,
    setLastRun: (n, at) => void s.set(n, { ...s.get(n), lastRun: at }),
    isEnabled: (n) => s.get(n)?.enabled,
    setEnabled: (n, on) => void s.set(n, { ...s.get(n), enabled: on }),
  };
}
const loop = (over: Partial<SchedulableLoop> = {}): SchedulableLoop => ({
  name: "l",
  folder: "/p",
  trigger: { kind: "interval", everyMs: 1000 },
  enabledByDefault: true,
  ...over,
});

test("fires a due, enabled, free, unthrottled loop and records lastRun before starting", () => {
  const started: string[] = [];
  const store = memStore();
  tickScheduler({ loops: [loop()], store, isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual(["l"]);
  expect(store.getLastRun("l")).toBe(10_000);
});

test("skips when the folder is busy", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore(), isFolderBusy: () => true, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("skips when throttled", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore(), isFolderBusy: () => false, throttled: () => true, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("explicit disabled overrides enabledByDefault", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore({ l: { enabled: false } }), isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("skips manual loops entirely", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop({ trigger: { kind: "manual" } })], store: memStore(), isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});
