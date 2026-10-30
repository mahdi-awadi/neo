// ADR-0066 Decision 8, spec "The snapshot backup" (plan task 16): the backup config reader and the pure
// naming and rotation rules. Rotation keeps the newest `keepRecent`, then the newest of each UTC day for
// `keepDaily` days, then the newest of each ISO week for `keepWeekly` weeks, and touches only files that
// match the naming rule of the database it rotates.
import { describe, expect, test } from "bun:test";
import { BACKUP_DEFAULTS, readBackupCfg } from "../src/engine/backup/cfg";
import { fileStamp, manifestName, parseSnapshotName, parseStamp, rotationDeletes, snapshotName } from "../src/engine/backup/rotate";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 30, 3, 41, 0); // Fri 2026-10-30 03:41:00Z

describe("readBackupCfg", () => {
  test("defaults: history.db only (never the ledger), /var/backups/neo, 8/7/4, gzip, a weekly drill", () => {
    expect(readBackupCfg(undefined)).toEqual(BACKUP_DEFAULTS);
    expect(BACKUP_DEFAULTS.databases).toEqual([{ path: "data/history.db", cron: "41 3 * * *" }]);
    expect(BACKUP_DEFAULTS.databases.some((d) => d.path.includes("ledger"))).toBe(false);
    expect(BACKUP_DEFAULTS).toMatchObject({ dir: "/var/backups/neo", keepRecent: 8, keepDaily: 7, keepWeekly: 4, compress: true, minFreeGb: 20, timeoutMs: 900_000 });
  });

  test("good values are kept; each bad one keeps its default", () => {
    const c = readBackupCfg({ dir: "/srv/b", keepRecent: 3, compress: false, drillCron: "0 6 * * 1", databases: [{ path: "data/history.db", cron: "0 */6 * * *" }, { path: "data/admin.db", cron: "5 4 * * *" }] });
    expect(c).toMatchObject({ dir: "/srv/b", keepRecent: 3, compress: false, drillCron: "0 6 * * 1" });
    expect(c.databases.map((d) => d.path)).toEqual(["data/history.db", "data/admin.db"]);
    const bad = readBackupCfg({ dir: "relative/dir", keepRecent: 0, keepDaily: -1, keepWeekly: 1.5, compress: "yes", drillCron: "nope", minFreeGb: -2, timeoutMs: "fast" });
    expect(bad).toEqual(BACKUP_DEFAULTS);
  });

  test("a database entry with a bad cron, a path that is not a .db file, or a duplicate name is dropped", () => {
    const c = readBackupCfg({ databases: [{ path: "data/x.db", cron: "bad" }, { path: "data/notes.txt", cron: "1 1 * * *" }, { path: "data/a.db", cron: "1 1 * * *" }, { path: "other/a.db", cron: "2 2 * * *" }, "data/b.db"] });
    expect(c.databases).toEqual([{ path: "data/a.db", cron: "1 1 * * *" }]);
    expect(readBackupCfg({ databases: [] }).databases).toEqual([]);
    expect(readBackupCfg({ databases: "all" }).databases).toEqual(BACKUP_DEFAULTS.databases);
  });
});

describe("names", () => {
  test("UTC names format and parse", () => {
    expect(fileStamp(T0)).toBe("20261030T034100Z");
    expect(parseStamp("20261030T034100Z")).toBe(T0);
    expect(parseStamp("20261330T034100Z")).toBeUndefined();
    expect(snapshotName("history", T0, true)).toBe("history-20261030T034100Z.db.gz");
    expect(snapshotName("history", T0, false)).toBe("history-20261030T034100Z.db");
    expect(manifestName("history", T0)).toBe("history-20261030T034100Z.manifest.json");
    expect(parseSnapshotName("history-20261030T034100Z.db.gz")).toEqual({ name: "history", at: T0, compressed: true });
    expect(parseSnapshotName("history-20261030T034100Z.db")).toEqual({ name: "history", at: T0, compressed: false });
    for (const f of ["history.db", "history-20261030T034100Z.db.gz.tmp", ".history-20261030T034100Z.db.gz", "history-2026-10-30.db.gz", "notes.txt", "history-20261030T034100Z.manifest.json"]) {
      expect(parseSnapshotName(f)).toBeUndefined();
    }
  });
});

describe("rotationDeletes", () => {
  const keep = { keepRecent: 8, keepDaily: 7, keepWeekly: 4 };
  const files = (ats: number[]) => ats.flatMap((at) => [snapshotName("history", at, true), manifestName("history", at)]);

  test("fewer snapshots than keepRecent: nothing goes", () => {
    expect(rotationDeletes(files([T0, T0 - HOUR, T0 - DAY]), "history", keep)).toEqual([]);
  });

  test("keeps the newest 8, then one each day for 7 days, then one each week for 4 weeks", () => {
    // Four snapshots a day (every 6 hours) for 60 days, newest first.
    const ats = Array.from({ length: 240 }, (_, i) => T0 - i * 6 * HOUR);
    const all = files(ats);
    const gone = new Set(rotationDeletes(all, "history", keep));
    const kept = ats.filter((at) => !gone.has(snapshotName("history", at, true)));
    // The newest 8 (two days' worth).
    expect(kept.slice(0, 8)).toEqual(ats.slice(0, 8));
    // Then one a day: the newest of each of the next 7 days that have no kept snapshot yet.
    const daily = kept.slice(8, 15);
    expect(daily.length).toBe(7);
    expect(new Set(daily.map((at) => new Date(at).toISOString().slice(0, 10))).size).toBe(7);
    // Then one a week, 4 weeks; nothing older.
    expect(kept.length).toBe(8 + 7 + 4);
    // A manifest goes with its snapshot, and only then.
    for (const at of ats) {
      expect(gone.has(manifestName("history", at))).toBe(gone.has(snapshotName("history", at, true)));
    }
  });

  test("never touches other files, other databases, temp files or an orphan manifest's neighbours", () => {
    const ats = Array.from({ length: 40 }, (_, i) => T0 - i * DAY * 3);
    const other = ["ledger-20200101T000000Z.db.gz", "notes.txt", ".history-20200101T000000Z.db.gz.tmp", "history.db", "README"];
    const gone = rotationDeletes([...files(ats), ...other], "history", keep);
    expect(gone.length).toBeGreaterThan(0);
    for (const f of other) expect(gone).not.toContain(f);
    for (const f of gone) expect(f.startsWith("history-")).toBe(true);
  });
});
