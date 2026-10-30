// The snapshot backup in the running engine (ADR-0066 Decision 8, spec "The snapshot backup"): the heartbeat
// step `backup`. Each database in `backup.databases` is a snapshot job on its own cron; the restore drill is
// one more job on `backup.drillCron`. A job is due once for each cron slot since the last tick (a late tick
// still runs a missed slot, once). One child runs at a time: a job that comes due meanwhile waits in the
// queue and starts when the child before it ends. The child is `bun run.ts` / `bun drill.ts` with every path
// its own argv entry (never a shell), ended after `backup.timeoutMs`. The daemon awaits it without blocking:
// the step returns the promise of the queue it started, and the heartbeat's fault boundary holds it.
//
// Results: `backup_done` / `backup_drill` events on success (counts only), `backup_failed` on a failure
// (the code, never the detail text), one operator alert for each failure streak of a job, and `state()`,
// which the attention producer reads for the `backup_failed` item until the job succeeds again.
import { readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { cronDueBetween } from "../trigger";
import { backupName, type BackupCfg } from "./cfg";
import { drillArgs } from "./drill";
import { snapshotArgs } from "./run";

export interface BackupJob {
  /** `snapshot:<name>` or `drill`. */
  id: string;
  kind: "snapshot" | "drill";
  /** The database name (snapshot jobs). */
  name?: string;
  /** What the job covers, as configured: the database path, or the backup folder (the drill). */
  path: string;
  cron: string;
  /** The child's full argv: the bun binary, the script, then the flags. */
  argv: string[];
}

export interface ChildRun {
  /** Exit code; null when the child was ended by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Spawner = (argv: string[], timeoutMs: number) => Promise<ChildRun>;

export interface BackupFailure {
  job: string;
  kind: "snapshot" | "drill";
  name?: string;
  /** The job's database path, or the backup folder (the drill). */
  path: string;
  /** When the streak started, and the newest failure. */
  since: number;
  at: number;
  /** A code (`low_space`, `integrity_failed`, `timeout`, …) and the child's one-line detail. */
  code: string;
  reason: string;
  streak: number;
}

/** What the attention producer reads (`backup_failed` while `failing` is not empty). */
export interface BackupState {
  failing: BackupFailure[];
  /** The job whose child runs now. */
  running?: string;
  /** The newest success of each job. */
  lastOk: Record<string, number>;
}

export interface BackupScheduleDeps {
  cfg: BackupCfg;
  /** Relative database paths resolve against this folder (the daemon's, like `history.dbPath`). */
  baseDir: string;
  /** The bun binary (process.execPath in the daemon). */
  bun: string;
  /** ledger.recordEvent */
  events: (kind: string, data: Record<string, unknown>) => void;
  /** The operator alert (the Decisions channel, else the DM). */
  alert: (text: string) => void;
  now?: () => number;
  /** Tests inject the child. */
  spawn?: Spawner;
}

export interface BackupSchedule {
  readonly jobs: BackupJob[];
  /** Heartbeat step `backup`: queue the jobs whose slot came, and start the queue unless a child runs.
   *  Returns the promise of the queue it started (it never rejects), or undefined. */
  tick(): Promise<void> | undefined;
  state(): BackupState;
}

const SCRIPTS = { snapshot: join(import.meta.dir, "run.ts"), drill: join(import.meta.dir, "drill.ts") } as const;

/** The jobs of a config: one snapshot job per database, then the drill over all of them (none without a
 *  database). */
export function backupJobs(cfg: BackupCfg, baseDir: string, bun: string): BackupJob[] {
  const keep = { keepRecent: cfg.keepRecent, keepDaily: cfg.keepDaily, keepWeekly: cfg.keepWeekly };
  const snaps: BackupJob[] = cfg.databases.map((db) => {
    const name = backupName(db.path);
    const source = isAbsolute(db.path) ? db.path : resolve(baseDir, db.path);
    return {
      id: `snapshot:${name}`, kind: "snapshot", name, path: db.path, cron: db.cron,
      argv: [bun, SCRIPTS.snapshot, ...snapshotArgs({ source, dir: cfg.dir, name, compress: cfg.compress, minFreeGb: cfg.minFreeGb, keep })],
    };
  });
  if (!snaps.length) return [];
  const drill: BackupJob = { id: "drill", kind: "drill", path: cfg.dir, cron: cfg.drillCron, argv: [bun, SCRIPTS.drill, ...drillArgs({ dir: cfg.dir, names: snaps.map((j) => j.name!) })] };
  return [...snaps, drill];
}

/** Run a child with an argv (no shell), collect its output, and end it after `timeoutMs`. */
export const spawnChild: Spawner = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code: timedOut ? null : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/** The temp files a killed child of `job` may have left in `files` (one child runs at a time, so none is in
 *  use): a snapshot's `.<name>-….tmp` (and its journal) and `<name>-<stamp>.manifest.json.tmp`, or the
 *  drill's `.drill-…`. Snapshots, manifests and other jobs' files never match. */
export function staleTemps(files: string[], job: Pick<BackupJob, "kind" | "name">): string[] {
  if (job.kind === "drill") return files.filter((f) => f.startsWith(".drill-") && /\.tmp(?:-journal)?$/.test(f));
  const name = job.name ?? "";
  return files.filter((f) =>
    (f.startsWith(`.${name}-`) && /\.tmp(?:-journal)?$/.test(f)) || (f.startsWith(`${name}-`) && f.endsWith(".manifest.json.tmp")));
}

/** `backup_failed <code> <detail>` → code and detail; anything else is `child_failed`. */
function failureOf(run: ChildRun, timeoutMs: number): { code: string; reason: string } {
  if (run.timedOut) return { code: "timeout", reason: `ended after ${timeoutMs} ms` };
  const line = run.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const m = /^backup_failed (\S+) ?(.*)$/.exec(line);
  return m ? { code: m[1]!, reason: m[2]! } : { code: "child_failed", reason: line.slice(0, 300) || `exit ${run.code}` };
}

function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.trim().split("\n").at(-1);
  try {
    const v = line ? (JSON.parse(line) as unknown) : undefined;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function createBackupSchedule(deps: BackupScheduleDeps): BackupSchedule {
  const { cfg, events } = deps;
  const now = deps.now ?? Date.now;
  const spawn = deps.spawn ?? spawnChild;
  const jobs = backupJobs(cfg, deps.baseDir, deps.bun);
  let checked = now();
  const queue: BackupJob[] = [];
  let running: string | undefined;
  const failing = new Map<string, BackupFailure>();
  const lastOk: Record<string, number> = {};

  const succeed = (job: BackupJob, out: Record<string, unknown>): void => {
    if (job.kind === "snapshot") {
      const m = (out.manifest ?? {}) as { bytes?: number; rawBytes?: number; ms?: number; counts?: Record<string, number> };
      const counts = Object.values(m.counts ?? {});
      events("backup_done", {
        job: job.id, name: job.name, bytes: m.bytes ?? 0, rawBytes: m.rawBytes ?? 0, ms: m.ms ?? 0,
        tables: counts.length, rows: counts.reduce((a, b) => a + b, 0), deleted: Array.isArray(out.deleted) ? out.deleted.length : 0,
      });
    } else {
      events("backup_drill", { ok: true, checked: Array.isArray(out.checked) ? out.checked.length : 0 });
    }
    failing.delete(job.id);
    lastOk[job.id] = now();
  };

  const failed = (job: BackupJob, code: string, reason: string): void => {
    const at = now();
    const was = failing.get(job.id);
    const f: BackupFailure = { job: job.id, kind: job.kind, ...(job.name ? { name: job.name } : {}), path: job.path, since: was?.since ?? at, at, code, reason, streak: (was?.streak ?? 0) + 1 };
    failing.set(job.id, f);
    if (job.kind === "drill") events("backup_drill", { ok: false, code });
    events("backup_failed", { job: job.id, kind: job.kind, ...(job.name ? { name: job.name } : {}), code, streak: f.streak });
    if (!was) {
      const what = job.kind === "drill" ? "The weekly restore drill" : `The ${job.name} snapshot backup`;
      deps.alert(`⚠️ ${what} failed (${code}): ${reason}. Folder ${cfg.dir}. See docs/backup.md. No more alerts until it works again.`);
    }
  };

  const clearStale = (job: BackupJob): void => {
    let files: string[];
    try {
      files = readdirSync(cfg.dir);
    } catch {
      return; // no folder yet: the child makes it
    }
    for (const f of staleTemps(files, job)) rmSync(join(cfg.dir, f), { force: true });
  };

  const runOne = async (job: BackupJob): Promise<void> => {
    clearStale(job);
    let run: ChildRun;
    try {
      run = await spawn(job.argv, cfg.timeoutMs);
    } catch (e) {
      return failed(job, "spawn_failed", e instanceof Error ? e.message : String(e));
    }
    if (run.code === 0 && !run.timedOut) {
      const out = lastJsonLine(run.stdout);
      return out ? succeed(job, out) : failed(job, "bad_output", "the child printed no result");
    }
    const f = failureOf(run, cfg.timeoutMs);
    failed(job, f.code, f.reason);
  };

  const drain = async (): Promise<void> => {
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        running = job.id;
        try {
          await runOne(job);
        } catch (e) {
          // An event or alert sink that throws must not stop the queue.
          console.error(`[backup] ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      running = undefined;
    }
  };

  return {
    jobs,
    tick() {
      const at = now();
      for (const job of jobs) {
        if (cronDueBetween(job.cron, checked, at) && running !== job.id && !queue.includes(job)) queue.push(job);
      }
      checked = at;
      if (running !== undefined || !queue.length) return undefined;
      return drain();
    },
    state: () => ({ failing: [...failing.values()], ...(running !== undefined ? { running } : {}), lastOk: { ...lastOk } }),
  };
}
