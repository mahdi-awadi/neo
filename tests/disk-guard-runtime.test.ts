// ADR-0068: the daemon's disk-guard step reads the installed kit (its config, lock and last run), the disk
// use through the kit's own `diskUse`, keeps its state in the ledger's meta, and starts the kit's run as a
// detached child with an argv (no shell).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/engine/ledger";
import { createDiskGuardStep, DISK_GUARD_META, startTierA } from "../src/engine/disk-guard-runtime";

function kit(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "neo-dg-"));
  writeFileSync(join(dir, "defaults.json"), JSON.stringify({ mount: "/", dailyHour: 4, keepImagesFrom: [], packageCaches: [], ...over }));
  mkdirSync(join(dir, "state"));
  return dir;
}
const df = (pct: number) => (argv: string[]) =>
  argv[0] === "df" ? { code: 0, out: `      Size       Used\n400000000000 ${Math.round(4e9 * pct)}\n` } : { code: 1, out: "" };

test("under pressure: spawns `bun <kit>/cleanup.ts run`, alerts, and keeps its state in the ledger", () => {
  const dir = kit();
  const ledger = openLedger(":memory:");
  const spawned: string[][] = [];
  const alerts: string[] = [];
  const step = createDiskGuardStep({ kitDir: dir, ledger, alert: (t) => void alerts.push(t), sh: df(92), spawn: (argv) => void spawned.push(argv), now: () => new Date(2026, 9, 30, 10).getTime(), bunBin: "bun" });
  step();
  expect(spawned).toEqual([["bun", join(dir, "cleanup.ts"), "run"]]);
  expect(alerts[0]).toContain("92.0%");
  expect((ledger.getMeta(DISK_GUARD_META)?.value as { lastPressureRun?: number }).lastPressureRun).toBeDefined();
  expect(ledger.listEvents({ kind: "disk_cleanup_started" })).toHaveLength(1);
});

test("a live lock holder in the kit's state means a run is active: nothing is spawned", () => {
  const dir = kit();
  writeFileSync(join(dir, "state", "run.lock"), String(process.pid)); // this process is alive
  const spawned: string[][] = [];
  const step = createDiskGuardStep({ kitDir: dir, ledger: openLedger(":memory:"), alert: () => {}, sh: df(95), spawn: (a) => void spawned.push(a), now: () => Date.now(), bunBin: "bun" });
  step();
  expect(spawned).toEqual([]);
});

test("a stale lock (dead pid) does not block, and the kit's last-run.json reports the finished run", () => {
  const dir = kit();
  writeFileSync(join(dir, "state", "run.lock"), "999999999");
  const ledger = openLedger(":memory:");
  const alerts: string[] = [];
  const t0 = new Date(2026, 9, 30, 10).getTime();
  const spawned: string[][] = [];
  createDiskGuardStep({ kitDir: dir, ledger, alert: (t) => void alerts.push(t), sh: df(92), spawn: (a) => void spawned.push(a), now: () => t0, bunBin: "bun" })();
  expect(spawned).toHaveLength(1);
  writeFileSync(join(dir, "state", "last-run.json"), JSON.stringify({ at: t0 + 60_000, freedBytes: 95e9, afterPct: 73.1 }));
  createDiskGuardStep({ kitDir: dir, ledger, alert: (t) => void alerts.push(t), sh: df(73), spawn: () => {}, now: () => t0 + 120_000, bunBin: "bun" })();
  expect(alerts.at(-1)).toContain("95.0 GB");
  expect(alerts.at(-1)).toContain("73.1%");
});

test("a missing kit never throws, still alerts from the defaults, starts no run, and records its failure once", () => {
  const ledger = openLedger(":memory:");
  const alerts: string[] = [];
  const spawned: string[][] = [];
  const t0 = new Date(2026, 9, 30, 10).getTime();
  let t = t0;
  const step = createDiskGuardStep({ kitDir: "/nonexistent/neo-disk-kit", ledger, alert: (x) => void alerts.push(x), sh: df(92), spawn: (a) => void spawned.push(a), now: () => t, bunBin: "bun" });
  expect(() => step()).not.toThrow();
  t += 60_000;
  step();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("cannot be read");
  expect(spawned).toEqual([]);
  expect(ledger.listEvents({ kind: "disk_guard_failed" })).toHaveLength(1);
});

test("when the ledger cannot save (a full disk), the state stays in memory: no alert every tick", () => {
  const dir = kit();
  const real = openLedger(":memory:");
  const ledger = { getMeta: real.getMeta, recordEvent: real.recordEvent, setMeta: () => { throw new Error("database or disk is full"); } };
  const alerts: string[] = [];
  let t = new Date(2026, 9, 30, 10).getTime();
  const step = createDiskGuardStep({ kitDir: dir, ledger, alert: (x) => void alerts.push(x), sh: df(85), spawn: () => {}, now: () => t, bunBin: "bun" });
  step();
  t += 60_000;
  step();
  t += 60_000;
  step();
  expect(alerts).toHaveLength(1);
});

test("a started run with no result and no live lock after pendingTimeoutMinutes is reported as failed", () => {
  const dir = kit();
  const ledger = openLedger(":memory:");
  const alerts: string[] = [];
  const t0 = new Date(2026, 9, 30, 10).getTime();
  createDiskGuardStep({ kitDir: dir, ledger, alert: (x) => void alerts.push(x), sh: df(92), spawn: () => {}, now: () => t0, bunBin: "bun" })();
  createDiskGuardStep({ kitDir: dir, ledger, alert: (x) => void alerts.push(x), sh: df(92), spawn: () => {}, now: () => t0 + 121 * 60_000, bunBin: "bun" })();
  expect(alerts.some((a) => a.includes("did not finish"))).toBe(true);
  expect(ledger.listEvents({ kind: "disk_cleanup_failed" })).toHaveLength(1);
});

test("startTierA: its own systemd unit (survives a daemon restart); a detached child only when systemd-run is missing", () => {
  const calls: string[][] = [];
  const detached: string[][] = [];
  startTierA(["bun", "/kit/cleanup.ts", "run"], { run: (a) => (calls.push(a), { ok: true }), detached: (a) => void detached.push(a) });
  expect(calls[0]).toEqual(["systemd-run", "--unit=neo-disk-tier-a", "--collect", "--quiet", "--", "bun", "/kit/cleanup.ts", "run"]);
  expect(detached).toEqual([]);
  startTierA(["bun", "/kit/cleanup.ts", "run"], { run: () => ({ ok: false, missing: true }), detached: (a) => void detached.push(a) });
  expect(detached).toEqual([["bun", "/kit/cleanup.ts", "run"]]);
  // A unit that already exists is a run in progress: never a second one beside it.
  expect(() => startTierA(["bun", "/kit/cleanup.ts", "run"], { run: () => ({ ok: false, error: "Unit neo-disk-tier-a.service already exists" }), detached: () => { throw new Error("must not run"); } })).toThrow(/already exists/);
});
