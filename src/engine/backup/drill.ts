// The weekly restore drill (ADR-0066 Decision 8): for each database name, take its newest snapshot, check
// the file against its manifest (SHA-256), restore it to a temp file in the backup folder (gunzip when
// compressed), run `PRAGMA integrity_check`, compare the row counts with the manifest, and delete the temp
// file. Run as a child: `bun src/engine/backup/drill.ts --dir <folder> --names <a,b>` (argv entries, no
// shell). Exit 0 with one JSON line on stdout; on a failure, exit 1 with one line `backup_failed <code>
// <detail>` on stderr.
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { manifestName, parseSnapshotName } from "./rotate";
import { countsOf, failLine, flagsOf, integrityOf, sha256Of, type Manifest } from "./run";

export interface DrillOpts {
  dir: string;
  names: string[];
}

export type DrillResult =
  | { ok: true; checked: Array<{ name: string; file: string; counts: Record<string, number> }> }
  | { ok: false; code: string; reason: string; name?: string };

class DrillError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
  }
}

/** The newest snapshot of `name` in `dir`, or undefined. */
export function newestSnapshot(dir: string, name: string): { file: string; at: number; compressed: boolean } | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { file: string; at: number; compressed: boolean } | undefined;
  for (const f of readdirSync(dir)) {
    const p = parseSnapshotName(f);
    if (p && p.name === name && (!best || p.at > best.at)) best = { file: f, at: p.at, compressed: p.compressed };
  }
  return best;
}

const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

async function drillOne(dir: string, name: string): Promise<{ name: string; file: string; counts: Record<string, number> }> {
  const snap = newestSnapshot(dir, name);
  if (!snap) throw new DrillError("no_snapshot", name);
  const mpath = join(dir, manifestName(name, snap.at));
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(mpath, "utf8")) as Manifest;
  } catch {
    throw new DrillError("manifest_unreadable", manifestName(name, snap.at));
  }
  const path = join(dir, snap.file);
  if ((await sha256Of(path)) !== manifest.sha256) throw new DrillError("checksum_mismatch", snap.file);
  const tmp = join(dir, `.drill-${name}-${process.pid}.db.tmp`);
  try {
    if (snap.compressed) {
      try {
        await pipeline(createReadStream(path), createGunzip(), createWriteStream(tmp, { mode: 0o600 }));
      } catch (e) {
        throw new DrillError("restore_failed", e instanceof Error ? e.message : String(e));
      }
    }
    const restored = snap.compressed ? tmp : path;
    const integrity = integrityOf(restored);
    if (integrity !== "ok") throw new DrillError("integrity_failed", integrity.split("\n").slice(0, 3).join(" | "));
    const { counts } = countsOf(restored);
    if (!sameCounts(counts, manifest.counts)) throw new DrillError("count_mismatch", snap.file);
    return { name, file: snap.file, counts };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function runDrill(opts: DrillOpts): Promise<DrillResult> {
  const checked: Array<{ name: string; file: string; counts: Record<string, number> }> = [];
  for (const name of opts.names) {
    try {
      checked.push(await drillOne(opts.dir, name));
    } catch (e) {
      if (e instanceof DrillError) return { ok: false, code: e.code, reason: e.message, name };
      return { ok: false, code: "error", reason: e instanceof Error ? e.message : String(e), name };
    }
  }
  return { ok: true, checked };
}

/** The child's argv (after `bun drill.ts`): every value its own entry. */
export function drillArgs(o: DrillOpts): string[] {
  return ["--dir", o.dir, "--names", o.names.join(",")];
}

export function parseDrillArgs(argv: string[]): DrillOpts | undefined {
  const f = flagsOf(argv);
  const dir = f?.get("--dir");
  const names = (f?.get("--names") ?? "").split(",").filter(Boolean);
  if (!f || f.size !== 2 || !dir?.startsWith("/") || !names.length || !names.every((n) => /^[a-z0-9][a-z0-9_]*$/.test(n))) return undefined;
  return { dir, names };
}

if (import.meta.main) {
  const o = parseDrillArgs(process.argv.slice(2));
  if (!o) {
    console.error(failLine("bad_args", "usage: drill.ts --dir <abs folder> --names <a,b>"));
    process.exit(1);
  }
  const r = await runDrill(o);
  if (!r.ok) {
    console.error(failLine(r.code, `${r.name ?? ""} ${r.reason}`));
    process.exit(1);
  }
  console.log(JSON.stringify(r));
}
