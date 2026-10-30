// Snapshot names and rotation (ADR-0066 Decision 8): pure, no I/O. A snapshot is
// `<name>-<UTC yyyymmddThhmmssZ>.db[.gz]` with its manifest `<name>-<stamp>.manifest.json`. Rotation keeps
// the newest `keepRecent`, then the newest snapshot of each UTC day for `keepDaily` more days, then the
// newest of each ISO week for `keepWeekly` more weeks (a day or week that already has a kept snapshot does
// not count again). It returns only files that match the naming rule of the given database: a temp file,
// another database's snapshot or any other file is never in the list.

/** `20261030T091500Z`: a UTC time that sorts and fits in a file name. */
export function fileStamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** The time of a `fileStamp`, or undefined when it is not one. */
export function parseStamp(stamp: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return undefined;
  const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return fileStamp(at) === stamp ? at : undefined;
}

export function snapshotName(name: string, at: number, compressed: boolean): string {
  return `${name}-${fileStamp(at)}.db${compressed ? ".gz" : ""}`;
}

export function manifestName(name: string, at: number): string {
  return `${name}-${fileStamp(at)}.manifest.json`;
}

const SNAPSHOT = /^([a-z0-9][a-z0-9_]*)-(\d{8}T\d{6}Z)\.db(\.gz)?$/;
const MANIFEST = /^([a-z0-9][a-z0-9_]*)-(\d{8}T\d{6}Z)\.manifest\.json$/;

/** A file the backup itself writes in its folder: a snapshot, a manifest, or a temp file of the child or the
 *  drill (a dot name ending in `.tmp`, a SQLite journal of one, or a manifest's `.tmp`). */
export function isBackupFile(file: string): boolean {
  return SNAPSHOT.test(file) || MANIFEST.test(file) || /^\..+\.tmp(?:-journal)?$/.test(file) || MANIFEST.test(file.replace(/\.tmp$/, ""));
}

export function parseSnapshotName(file: string): { name: string; at: number; compressed: boolean } | undefined {
  const m = SNAPSHOT.exec(file);
  const at = m ? parseStamp(m[2]!) : undefined;
  return m && at !== undefined ? { name: m[1]!, at, compressed: m[3] !== undefined } : undefined;
}

function parseManifestName(file: string): { name: string; at: number } | undefined {
  const m = MANIFEST.exec(file);
  const at = m ? parseStamp(m[2]!) : undefined;
  return m && at !== undefined ? { name: m[1]!, at } : undefined;
}

export interface Keep {
  keepRecent: number;
  keepDaily: number;
  keepWeekly: number;
}

/** The UTC day of a time: `2026-10-30`. */
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The ISO week of a time (UTC): `2026-W44`. */
function weekOf(at: number): string {
  const d = new Date(at);
  const day = d.getUTCDay() || 7;
  // The Thursday of this week decides the ISO year.
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The snapshot times rotation keeps, newest first. */
export function keptTimes(ats: number[], keep: Keep): Set<number> {
  const sorted = [...new Set(ats)].sort((a, b) => b - a);
  const kept = new Set(sorted.slice(0, keep.keepRecent));
  const rest = sorted.slice(keep.keepRecent);
  const bucket = (key: (at: number) => string, count: number) => {
    const seen = new Set([...kept].map(key));
    let added = 0;
    for (const at of rest) {
      if (added >= count) break;
      if (kept.has(at) || seen.has(key(at))) continue;
      seen.add(key(at));
      kept.add(at);
      added++;
    }
  };
  bucket(dayOf, keep.keepDaily);
  bucket(weekOf, keep.keepWeekly);
  return kept;
}

/** The files of database `name` in `files` (base names) that rotation deletes: each snapshot that is not
 *  kept, and its manifest. A manifest whose snapshot is gone goes too. */
export function rotationDeletes(files: string[], name: string, keep: Keep): string[] {
  const snaps = files.flatMap((f) => {
    const p = parseSnapshotName(f);
    return p && p.name === name ? [{ f, at: p.at }] : [];
  });
  const kept = keptTimes(snaps.map((s) => s.at), keep);
  const out = snaps.filter((s) => !kept.has(s.at)).map((s) => s.f);
  for (const f of files) {
    const m = parseManifestName(f);
    if (m && m.name === name && !kept.has(m.at)) out.push(f);
  }
  return out;
}
