// Config `backup` (ADR-0066 Decision 8, spec "The snapshot backup"): which SQLite files get a snapshot
// backup, when, where, and how many are kept. `readBackupCfg(raw)` is pure and keeps each value of the
// right type, falling back to its default key by key, so one bad value never turns the job off. The default
// list holds `history.db` only: the ledger joins it only by the operator's decision (ADR-0066, "Separate
// operator decision: the ledger backup").
import { basename } from "node:path";
import { isValidCron } from "../trigger";

export interface BackupDb {
  /** The SQLite file (relative paths resolve against the daemon's folder). Its name without `.db` names
   *  the snapshots, so two entries may not share a file name. */
  path: string;
  /** When its snapshot runs (5-field cron, host time, like loops). */
  cron: string;
}

export interface BackupCfg {
  /** The backup folder: absolute, made with mode 0700. */
  dir: string;
  databases: BackupDb[];
  /** Rotation: the newest `keepRecent`, then the newest of each day for `keepDaily` days, then the newest of
   *  each ISO week for `keepWeekly` weeks. */
  keepRecent: number;
  keepDaily: number;
  keepWeekly: number;
  /** Gzip the snapshot. */
  compress: boolean;
  /** The weekly restore drill. */
  drillCron: string;
  /** A snapshot does not start with less free space than this in the backup folder (GiB). */
  minFreeGb: number;
  /** A snapshot or drill child that runs longer is ended. */
  timeoutMs: number;
}

export const BACKUP_DEFAULTS: Readonly<BackupCfg> = {
  dir: "/var/backups/neo",
  databases: [{ path: "data/history.db", cron: "41 3 * * *" }],
  keepRecent: 8,
  keepDaily: 7,
  keepWeekly: 4,
  compress: true,
  drillCron: "23 5 * * 0",
  minFreeGb: 20,
  timeoutMs: 900_000,
};

/** The snapshot name of a database file: its base name without `.db` (`data/history.db` → `history`). */
export function backupName(path: string): string {
  return basename(path).replace(/\.db$/, "");
}

/** A name that is safe in a file name and in the naming rule. */
const NAME = /^[a-z0-9][a-z0-9_]*$/;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const int = (v: unknown, d: number, min = 1): number => (typeof v === "number" && Number.isInteger(v) && v >= min ? v : d);
const cron = (v: unknown, d: string): string => (typeof v === "string" && isValidCron(v.trim()) ? v.trim() : d);

function readDatabases(raw: unknown, d: readonly BackupDb[]): BackupDb[] {
  if (!Array.isArray(raw)) return d.map((x) => ({ ...x }));
  const out: BackupDb[] = [];
  const names = new Set<string>();
  for (const item of raw) {
    const r = obj(item);
    const path = typeof r.path === "string" ? r.path.trim() : "";
    const c = typeof r.cron === "string" ? r.cron.trim() : "";
    if (!path.endsWith(".db") || !isValidCron(c)) continue;
    const name = backupName(path);
    if (!NAME.test(name) || names.has(name)) continue;
    names.add(name);
    out.push({ path, cron: c });
  }
  return out;
}

export function readBackupCfg(raw: unknown): BackupCfg {
  const r = obj(raw);
  const d = BACKUP_DEFAULTS;
  const dir = typeof r.dir === "string" && r.dir.trim().startsWith("/") ? r.dir.trim().replace(/\/+$/, "") || d.dir : d.dir;
  return {
    dir,
    databases: readDatabases(r.databases, d.databases),
    keepRecent: int(r.keepRecent, d.keepRecent),
    keepDaily: int(r.keepDaily, d.keepDaily, 0),
    keepWeekly: int(r.keepWeekly, d.keepWeekly, 0),
    compress: typeof r.compress === "boolean" ? r.compress : d.compress,
    drillCron: cron(r.drillCron, d.drillCron),
    minFreeGb: typeof r.minFreeGb === "number" && Number.isFinite(r.minFreeGb) && r.minFreeGb >= 0 ? r.minFreeGb : d.minFreeGb,
    timeoutMs: int(r.timeoutMs, d.timeoutMs),
  };
}
