// The snapshot child (ADR-0066 Decision 8, spec "The snapshot backup"): one online snapshot of one SQLite
// file, run as `bun src/engine/backup/run.ts --source <db> --dir <folder> --name <name> --compress 1|0
// --min-free-gb <n> --keep <recent>,<daily>,<weekly>` (paths are argv entries; no shell), so the daemon's
// event loop never waits on the copy. Steps:
//   1. make the folder (0700) and check its free space
//   2. `VACUUM INTO` a temp file from a read-only connection (a consistent copy while writers write)
//   3. `PRAGMA integrity_check` on the copy; read its row counts and `user_version`
//   4. gzip it (when `--compress 1`), fsync, rename to `<name>-<UTC stamp>.db[.gz]` (0600)
//   5. write the manifest `<name>-<stamp>.manifest.json` (SHA-256, sizes, counts, duration; 0600)
//   6. rotate this database's snapshots (rotate.ts; other files are never touched)
// Exit 0 with one JSON line on stdout; on a failure, exit 1 with one line `backup_failed <code> <detail>`
// on stderr, and no temp file left behind.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { manifestName, rotationDeletes, snapshotName, type Keep } from "./rotate";

export interface SnapshotOpts {
  source: string;
  dir: string;
  name: string;
  compress: boolean;
  minFreeGb: number;
  keep: Keep;
}

export interface SnapshotDeps {
  now?: () => number;
  /** Free bytes in the folder (tests inject a low value). */
  freeBytes?: (dir: string) => number;
  /** `PRAGMA integrity_check` of a file, joined (tests inject a corrupt answer). */
  integrity?: (path: string) => string;
}

export interface Manifest {
  version: 1;
  name: string;
  file: string;
  source: string;
  /** When the snapshot started (ms, and ISO). */
  at: number;
  createdAt: string;
  compressed: boolean;
  sha256: string;
  /** Size of the snapshot file, and of the database copy before compression. */
  bytes: number;
  rawBytes: number;
  /** Rows of each ordinary table (virtual tables are counted through their shadow tables). */
  counts: Record<string, number>;
  userVersion: number;
  integrity: "ok";
  ms: number;
}

/** A consistent copy of a SQLite file while writers write: a read-only connection, then `VACUUM INTO` the
 *  target (which must not exist). The target ends with mode 0600. Throws what SQLite throws. Also used by
 *  `tools/history/admin.ts copy-ledger`. */
export function vacuumCopy(source: string, target: string): void {
  const src = new Database(source, { readonly: true });
  try {
    src.prepare("VACUUM INTO ?").run(target);
  } finally {
    src.close();
  }
  chmodSync(target, 0o600);
}

export type SnapshotResult =
  | { ok: true; file: string; manifest: Manifest; deleted: string[] }
  | { ok: false; code: string; reason: string };

const GIB = 1024 ** 3;

export class BackupError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
  }
}

const freeBytesOf = (dir: string): number => {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

/** `PRAGMA integrity_check` of a file, read-only; the answer lines joined. */
export function integrityOf(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check).join("\n");
  } finally {
    db.close();
  }
}

/** The row count of each ordinary table, and `user_version`. Table names come from `sqlite_master` and are
 *  quoted as identifiers (an identifier cannot be a bound parameter). */
export function countsOf(path: string): { counts: Record<string, number>; userVersion: number } {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      counts[name] = (db.query(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n;
    }
    const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    return { counts, userVersion };
  } finally {
    db.close();
  }
}

/** SHA-256 of a file, streamed. */
export async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** fsync a file (by path). */
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** fsync a folder so a rename in it is durable; best effort (not every filesystem allows it). */
function syncDir(dir: string): void {
  try {
    syncFile(dir);
  } catch {
    // the file itself is synced; the rename is durable at the next journal commit
  }
}

/** Write a small file through a 0600 temp file, fsync and rename. */
function writeDurable(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  syncFile(tmp);
  renameSync(tmp, path);
}

/** Make the backup folder with mode 0700 (also when it already exists). */
export function ensureBackupDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export async function takeSnapshot(opts: SnapshotOpts, deps: SnapshotDeps = {}): Promise<SnapshotResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const t0 = performance.now();
  const file = snapshotName(opts.name, started, opts.compress);
  const final = join(opts.dir, file);
  // Temp names start with a dot: they never match the naming rule, so rotation never sees them.
  const rawTmp = join(opts.dir, `.${opts.name}-${process.pid}.db.tmp`);
  const gzTmp = join(opts.dir, `.${file}.tmp`);
  const cleanup = () => {
    for (const f of [rawTmp, gzTmp, `${rawTmp}-journal`]) rmSync(f, { force: true });
  };
  try {
    if (!existsSync(opts.source)) throw new BackupError("source_missing", opts.source);
    ensureBackupDir(opts.dir);
    const free = (deps.freeBytes ?? freeBytesOf)(opts.dir);
    if (free < opts.minFreeGb * GIB) throw new BackupError("low_space", `${(free / GIB).toFixed(1)} GiB free, need ${opts.minFreeGb} GiB`);

    try {
      vacuumCopy(opts.source, rawTmp);
    } catch (e) {
      throw new BackupError("copy_failed", e instanceof Error ? e.message : String(e));
    }

    const integrity = (deps.integrity ?? integrityOf)(rawTmp);
    if (integrity !== "ok") throw new BackupError("integrity_failed", integrity.split("\n").slice(0, 3).join(" | "));
    const { counts, userVersion } = countsOf(rawTmp);
    const rawBytes = statSync(rawTmp).size;

    if (opts.compress) {
      try {
        await pipeline(createReadStream(rawTmp), createGzip(), createWriteStream(gzTmp, { mode: 0o600 }));
      } catch (e) {
        throw new BackupError("compress_failed", e instanceof Error ? e.message : String(e));
      }
      chmodSync(gzTmp, 0o600);
      syncFile(gzTmp);
      renameSync(gzTmp, final);
      rmSync(rawTmp, { force: true });
    } else {
      syncFile(rawTmp);
      renameSync(rawTmp, final);
    }
    syncDir(opts.dir);

    const manifest: Manifest = {
      version: 1,
      name: opts.name,
      file,
      source: opts.source,
      at: started,
      createdAt: new Date(started).toISOString(),
      compressed: opts.compress,
      sha256: await sha256Of(final),
      bytes: statSync(final).size,
      rawBytes,
      counts,
      userVersion,
      integrity: "ok",
      ms: Math.round(performance.now() - t0),
    };
    writeDurable(join(opts.dir, manifestName(opts.name, started)), JSON.stringify(manifest, null, 2) + "\n");

    const deleted = rotationDeletes(readdirSync(opts.dir), opts.name, opts.keep);
    for (const f of deleted) rmSync(join(opts.dir, f), { force: true });
    return { ok: true, file, manifest, deleted };
  } catch (e) {
    cleanup();
    if (e instanceof BackupError) return { ok: false, code: e.code, reason: e.message };
    return { ok: false, code: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The child's argv (after `bun run.ts`): every value its own entry, never a shell string. */
export function snapshotArgs(o: SnapshotOpts): string[] {
  return [
    "--source", o.source, "--dir", o.dir, "--name", o.name, "--compress", o.compress ? "1" : "0",
    "--min-free-gb", String(o.minFreeGb), "--keep", `${o.keep.keepRecent},${o.keep.keepDaily},${o.keep.keepWeekly}`,
  ];
}

/** Flags `--key value` of an argv, or undefined when one is missing a value or repeats. */
export function flagsOf(argv: string[]): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!k.startsWith("--") || v === undefined || out.has(k)) return undefined;
    out.set(k, v);
  }
  return out;
}

export function parseSnapshotArgs(argv: string[]): SnapshotOpts | undefined {
  const f = flagsOf(argv);
  if (!f) return undefined;
  const source = f.get("--source");
  const dir = f.get("--dir");
  const name = f.get("--name");
  const compress = f.get("--compress");
  const minFree = Number(f.get("--min-free-gb"));
  const keep = (f.get("--keep") ?? "").split(",").map(Number);
  if (!source || !dir?.startsWith("/") || !name || !/^[a-z0-9][a-z0-9_]*$/.test(name)) return undefined;
  if (compress !== "0" && compress !== "1") return undefined;
  if (!Number.isFinite(minFree) || minFree < 0) return undefined;
  if (keep.length !== 3 || !keep.every((n) => Number.isInteger(n) && n >= 0) || keep[0]! < 1) return undefined;
  return { source, dir, name, compress: compress === "1", minFreeGb: minFree, keep: { keepRecent: keep[0]!, keepDaily: keep[1]!, keepWeekly: keep[2]! } };
}

/** One line on stderr: the code and a detail with no line breaks. */
export function failLine(code: string, reason: string): string {
  return `backup_failed ${code} ${reason.replace(/\s+/g, " ").trim()}`.slice(0, 500);
}

if (import.meta.main) {
  const o = parseSnapshotArgs(process.argv.slice(2));
  if (!o) {
    console.error(failLine("bad_args", "usage: run.ts --source <db> --dir <abs folder> --name <name> --compress 1|0 --min-free-gb <n> --keep <r>,<d>,<w>"));
    process.exit(1);
  }
  const r = await takeSnapshot(o);
  if (!r.ok) {
    console.error(failLine(r.code, r.reason));
    process.exit(1);
  }
  console.log(JSON.stringify(r));
}
