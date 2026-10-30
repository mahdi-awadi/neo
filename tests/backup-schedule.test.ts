// ADR-0066 Decision 8, spec "The snapshot backup", AC21 (plan task 16): the heartbeat step that runs the
// snapshot and drill children. It runs a job once for each cron slot, one child at a time, ends a child
// that passes `timeoutMs`, and on a failure records `backup_failed`, sends one alert for each failure
// streak and keeps the state the attention producer reads; a success clears it. Temp folders only.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_DEFAULTS, type BackupCfg } from "../src/engine/backup/cfg";
import { backupJobs, createBackupSchedule, spawnChild, type ChildRun } from "../src/engine/backup/schedule";

const MIN = 60_000;
/** 2026-10-30 03:40 local time: the default snapshot cron (41 3 * * *) is due one minute later. */
const T = new Date(2026, 9, 30, 3, 40, 0).getTime();

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const cfg = (over: Partial<BackupCfg> = {}): BackupCfg => ({ ...BACKUP_DEFAULTS, dir: "/tmp/neo-backup-test-unused", ...over });

function harness(runs: Array<ChildRun | (() => Promise<ChildRun>)>, c: BackupCfg = cfg(), start = T) {
  let now = start;
  const calls: string[][] = [];
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const alerts: string[] = [];
  const s = createBackupSchedule({
    cfg: c,
    baseDir: "/home/neo",
    bun: "/usr/local/bin/bun",
    now: () => now,
    events: (kind, data) => events.push({ kind, data }),
    alert: (t) => alerts.push(t),
    spawn: async (argv) => {
      calls.push(argv);
      const r = runs.shift() ?? { code: 0, stdout: "{}", stderr: "", timedOut: false };
      return typeof r === "function" ? r() : r;
    },
  });
  return { s, calls, events, alerts, at: (t: number) => (now = t) };
}

const ok = (name = "history"): ChildRun => ({ code: 0, stdout: JSON.stringify({ ok: true, file: `${name}-20261030T034100Z.db.gz`, manifest: { name, bytes: 10, rawBytes: 40, ms: 5, counts: { a: 3, b: 4 } }, deleted: ["x", "y"] }) + "\n", stderr: "", timedOut: false });
const fail = (code = "low_space"): ChildRun => ({ code: 1, stdout: "", stderr: `backup_failed ${code} 3.0 GiB free, need 20 GiB\n`, timedOut: false });

describe("jobs", () => {
  test("one snapshot job per database and one drill; the child gets each path as its own argv entry, no shell", () => {
    const jobs = backupJobs(cfg({ databases: [{ path: "data/history.db", cron: "41 3 * * *" }, { path: "/srv/a b;rm -rf x/admin.db", cron: "0 4 * * *" }] }), "/home/neo", "/usr/local/bin/bun");
    expect(jobs.map((j) => j.id)).toEqual(["snapshot:history", "snapshot:admin", "drill"]);
    const [h, a, d] = jobs;
    expect(h!.argv[0]).toBe("/usr/local/bin/bun");
    expect(h!.argv[1]).toMatch(/src\/engine\/backup\/run\.ts$/);
    expect(h!.argv).toContain("/home/neo/data/history.db");
    expect(a!.argv).toContain("/srv/a b;rm -rf x/admin.db");
    expect(a!.argv.some((x) => x === "sh" || x === "-c" || x === "bash")).toBe(false);
    expect(d!.argv[1]).toMatch(/src\/engine\/backup\/drill\.ts$/);
    expect(d!.argv).toEqual(expect.arrayContaining(["--names", "history,admin"]));
    expect(d!.cron).toBe(BACKUP_DEFAULTS.drillCron);
    expect(backupJobs(cfg({ databases: [] }), "/home/neo", "bun")).toEqual([]);
  });
});

describe("the schedule", () => {
  test("runs once for each cron slot, not again in the same slot, and again at the next", async () => {
    const h = harness([ok(), ok()]);
    expect(h.s.tick()).toBeUndefined(); // 03:40: nothing due
    h.at(T + MIN);
    await h.s.tick();
    expect(h.calls.length).toBe(1);
    h.at(T + MIN + 20_000);
    expect(h.s.tick()).toBeUndefined(); // same minute
    h.at(T + 2 * MIN);
    expect(h.s.tick()).toBeUndefined();
    h.at(T + MIN + 86_400_000);
    await h.s.tick();
    expect(h.calls.length).toBe(2);
    expect(h.events.filter((e) => e.kind === "backup_done").map((e) => e.data)).toEqual([
      { job: "snapshot:history", name: "history", bytes: 10, rawBytes: 40, ms: 5, tables: 2, rows: 7, deleted: 2 },
      { job: "snapshot:history", name: "history", bytes: 10, rawBytes: 40, ms: 5, tables: 2, rows: 7, deleted: 2 },
    ]);
  });

  test("a late tick still runs a missed slot once", async () => {
    const h = harness([ok()]);
    h.at(T + 30 * MIN);
    await h.s.tick();
    expect(h.calls.length).toBe(1);
  });

  test("one child at a time: a slot that comes due while a child runs waits, then runs", async () => {
    let release: (r: ChildRun) => void = () => {};
    const slow = () => new Promise<ChildRun>((r) => (release = r));
    const two = cfg({ databases: [{ path: "data/history.db", cron: "41 3 * * *" }, { path: "data/admin.db", cron: "42 3 * * *" }] });
    const h = harness([slow, ok("admin")], two);
    h.at(T + MIN);
    const first = h.s.tick();
    expect(first).toBeInstanceOf(Promise);
    expect(h.s.state().running).toBe("snapshot:history");
    h.at(T + 2 * MIN);
    expect(h.s.tick()).toBeUndefined(); // queued, not started
    expect(h.calls.length).toBe(1);
    release(ok());
    await first;
    expect(h.calls.length).toBe(2);
    expect(h.calls[1]).toContain("/home/neo/data/admin.db");
    expect(h.s.state().running).toBeUndefined();
  });

  test("a failure gives the event, one alert for the streak and the state; a success clears it", async () => {
    const h = harness([fail(), { code: null, stdout: "", stderr: "", timedOut: true }, ok()]);
    for (let day = 0; day < 3; day++) {
      h.at(T + MIN + day * 86_400_000);
      await h.s.tick();
      if (day === 1) {
        const st = h.s.state();
        expect(st.failing).toEqual([{ job: "snapshot:history", kind: "snapshot", name: "history", path: "data/history.db", since: T + MIN, at: T + MIN + 86_400_000, code: "timeout", reason: `ended after ${BACKUP_DEFAULTS.timeoutMs} ms`, streak: 2 }]);
      }
    }
    const failed = h.events.filter((e) => e.kind === "backup_failed").map((e) => e.data);
    expect(failed).toEqual([
      { job: "snapshot:history", kind: "snapshot", name: "history", code: "low_space", streak: 1 },
      { job: "snapshot:history", kind: "snapshot", name: "history", code: "timeout", streak: 2 },
    ]);
    // Events carry codes, never the detail text.
    expect(JSON.stringify(h.events)).not.toContain("GiB");
    expect(h.alerts.length).toBe(1);
    expect(h.alerts[0]).toContain("history");
    expect(h.alerts[0]).toContain("low_space");
    expect(h.alerts[0]).toContain("docs/backup.md");
    expect(h.s.state().failing).toEqual([]);
    expect(h.s.state().lastOk["snapshot:history"]).toBe(T + MIN + 2 * 86_400_000);
  });

  test("a new streak after a success alerts again", async () => {
    const h = harness([fail(), ok(), fail("copy_failed")]);
    for (let day = 0; day < 3; day++) {
      h.at(T + MIN + day * 86_400_000);
      await h.s.tick();
    }
    expect(h.alerts.length).toBe(2);
  });

  test("the drill runs at its own slot and records backup_drill; a failed drill is a failure too", async () => {
    // Sunday 2026-11-01 05:22 local: the default drill cron (23 5 * * 0) is due one minute later.
    const sunday = new Date(2026, 10, 1, 5, 22, 0).getTime();
    const h = harness([{ code: 1, stdout: "", stderr: "backup_failed count_mismatch history history-x.db.gz\n", timedOut: false }], cfg(), sunday);
    expect(h.s.tick()).toBeUndefined();
    h.at(sunday + MIN);
    await h.s.tick();
    expect(h.calls[0]![1]).toMatch(/drill\.ts$/);
    expect(h.events.map((e) => e.kind)).toEqual(["backup_drill", "backup_failed"]);
    expect(h.events[0]!.data).toEqual({ ok: false, code: "count_mismatch" });
    expect(h.s.state().failing[0]).toMatchObject({ job: "drill", kind: "drill", code: "count_mismatch" });
    expect(h.alerts.length).toBe(1);
  });

  test("a spawn that throws is a failure, never a throw out of the step", async () => {
    let now = T;
    const alerts: string[] = [];
    const s = createBackupSchedule({ cfg: cfg(), baseDir: "/home/neo", bun: "bun", now: () => now, events: () => {}, alert: (t) => alerts.push(t), spawn: async () => { throw new Error("ENOENT"); } });
    now = T + MIN;
    await s.tick();
    expect(s.state().failing[0]).toMatchObject({ code: "spawn_failed" });
    expect(alerts.length).toBe(1);
  });
});

describe("spawnChild", () => {
  test("a child past its timeout is ended and reported as timed out", async () => {
    const started = Date.now();
    const r = await spawnChild(["bun", "-e", "await Bun.sleep(20000)"], 300);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a real snapshot through the schedule: a path with a space and a semicolon stays one argument", async () => {
    root = mkdtempSync(join(tmpdir(), "neo-backup-sched-"));
    const dataDir = join(root, "a b;echo pwned");
    mkdirSync(dataDir);
    const db = new Database(join(dataDir, "hist.db"));
    db.exec("CREATE TABLE a(x); INSERT INTO a VALUES (1), (2);");
    db.close();
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    let now = T;
    const s = createBackupSchedule({
      cfg: cfg({ dir: join(root, "backups"), minFreeGb: 0, databases: [{ path: "a b;echo pwned/hist.db", cron: "41 3 * * *" }] }),
      baseDir: root,
      bun: process.execPath,
      now: () => now,
      events: (kind, data) => events.push({ kind, data }),
      alert: () => {},
    });
    now = T + MIN;
    await s.tick();
    expect(events.map((e) => e.kind)).toEqual(["backup_done"]);
    expect(events[0]!.data).toMatchObject({ name: "hist", rows: 2 });
    expect(readdirSync(join(root, "backups")).some((f) => /^hist-\d{8}T\d{6}Z\.db\.gz$/.test(f))).toBe(true);
    expect(existsSync(join(root, "pwned"))).toBe(false);
  });
});
