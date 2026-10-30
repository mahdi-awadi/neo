// ADR-0066 Decision 8, spec "The snapshot backup", AC21 (plan task 16): the snapshot child (`run.ts`) and
// the restore drill (`drill.ts`). Temp folders only: these tests never write /var/backups.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrill } from "../src/engine/backup/drill";
import { manifestName, snapshotName } from "../src/engine/backup/rotate";
import { takeSnapshot, type Manifest } from "../src/engine/backup/run";

const RUN = join(import.meta.dir, "..", "src", "engine", "backup", "run.ts");
const KEEP = { keepRecent: 8, keepDaily: 7, keepWeekly: 4 };
const T0 = Date.UTC(2026, 9, 30, 3, 41, 0);

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/** A WAL database with two tables, an FTS table and a user_version. */
function makeDb(rows = 200): { path: string; dir: string; db: Database } {
  root = mkdtempSync(join(tmpdir(), "neo-backup-"));
  const path = join(root, "data", "t.db");
  Bun.spawnSync(["mkdir", "-p", join(root, "data")]);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=3; CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE b(id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE f USING fts5(body);");
  const ins = db.prepare("INSERT INTO a(v) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < rows; i++) ins.run(`row ${i} ${"x".repeat(200)}`);
  })();
  db.prepare("INSERT INTO b(id) VALUES (?)").run(1);
  db.prepare("INSERT INTO f(body) VALUES (?)").run("hello");
  return { path, dir: join(root, "backups"), db };
}

const opts = (source: string, dir: string, extra: Partial<Parameters<typeof takeSnapshot>[0]> = {}) => ({ source, dir, name: "t", compress: true, minFreeGb: 0, keep: KEEP, ...extra });
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const counts = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return { a: (db.query("SELECT count(*) AS n FROM a").get() as { n: number }).n, ok: (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check };
  } finally {
    db.close();
  }
};

describe("run.ts (the child)", () => {
  test("a snapshot of a WAL database while a writer writes passes integrity_check, opens to the same counts, and has its manifest", async () => {
    const { path, dir, db } = makeDb();
    const ins = db.prepare("INSERT INTO a(v) VALUES (?)");
    let written = 0;
    const writer = setInterval(() => {
      ins.run(`live ${written++}`);
    }, 2);
    const child = Bun.spawn(["bun", RUN, "--source", path, "--dir", dir, "--name", "t", "--compress", "1", "--min-free-gb", "0", "--keep", "8,7,4"], { stdout: "pipe", stderr: "pipe" });
    const code = await child.exited;
    clearInterval(writer);
    const out = await new Response(child.stdout).text();
    expect(code).toBe(0);
    expect(written).toBeGreaterThan(0);
    const result = JSON.parse(out.trim()) as { ok: true; file: string; manifest: Manifest };
    const file = join(dir, result.file);
    expect(result.file).toMatch(/^t-\d{8}T\d{6}Z\.db\.gz$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const m = result.manifest;
    const onDisk = JSON.parse(readFileSync(join(dir, result.file.replace(/\.db\.gz$/, ".manifest.json")), "utf8")) as Manifest;
    expect(onDisk).toEqual(m);
    expect(statSync(join(dir, result.file.replace(/\.db\.gz$/, ".manifest.json"))).mode & 0o777).toBe(0o600);
    expect(m).toMatchObject({ version: 1, name: "t", file: result.file, source: path, compressed: true, userVersion: 3, integrity: "ok" });
    expect(m.sha256).toBe(sha(file));
    expect(m.bytes).toBe(statSync(file).size);
    expect(m.rawBytes).toBeGreaterThan(m.bytes);
    expect(m.ms).toBeGreaterThanOrEqual(0);
    expect(m.counts.a).toBeGreaterThanOrEqual(200);
    expect(m.counts.b).toBe(1);
    expect(m.counts.f).toBeUndefined(); // a virtual table is counted through its own shadow tables
    // The gzip opens to the same counts.
    const raw = join(root, "restored.db");
    writeFileSync(raw, Bun.gunzipSync(readFileSync(file)));
    expect(counts(raw)).toEqual({ a: m.counts.a!, ok: "ok" });
    // Only the snapshot and its manifest are left (no temp file).
    expect(readdirSync(dir).sort()).toEqual([result.file, result.file.replace(/\.db\.gz$/, ".manifest.json")].sort());
    db.close();
  });

  test("a failure exits 1 with a one-line reason", async () => {
    root = mkdtempSync(join(tmpdir(), "neo-backup-"));
    const child = Bun.spawn(["bun", RUN, "--source", join(root, "missing.db"), "--dir", join(root, "b"), "--name", "t", "--compress", "1", "--min-free-gb", "0", "--keep", "8,7,4"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    const err = (await new Response(child.stderr).text()).trim();
    expect(err.split("\n").length).toBe(1);
    expect(err).toMatch(/^backup_failed source_missing/);
  });

  test("bad arguments exit 1", async () => {
    const child = Bun.spawn(["bun", RUN, "--source", "x.db"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect((await new Response(child.stderr).text()).trim()).toMatch(/^backup_failed bad_args/);
  });
});

describe("takeSnapshot", () => {
  test("low free space (injected) fails before any copy", async () => {
    const { path, dir, db } = makeDb(5);
    const r = await takeSnapshot(opts(path, dir, { minFreeGb: 20 }), { freeBytes: () => 19 * 1024 ** 3 });
    expect(r).toMatchObject({ ok: false, code: "low_space" });
    expect(readdirSync(dir)).toEqual([]);
    db.close();
  });

  test("a corrupt copy (injected) fails with a reason and leaves no file", async () => {
    const { path, dir, db } = makeDb(5);
    const r = await takeSnapshot(opts(path, dir), { integrity: () => "*** in database main ***\nPage 3 is never used" });
    expect(r).toMatchObject({ ok: false, code: "integrity_failed" });
    expect(r.ok ? "" : r.reason).toContain("Page 3");
    expect(readdirSync(dir)).toEqual([]);
    db.close();
  });

  test("the folder: a new one is made 0700; a dedicated one is set to 0700; one that holds other files is refused and left as it is", async () => {
    const { path, dir, db } = makeDb(5);
    expect((await takeSnapshot(opts(path, dir))).ok).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    expect((await takeSnapshot(opts(path, dir), { now: () => T0 + 60_000 })).ok).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const shared = join(root, "shared");
    Bun.spawnSync(["mkdir", "-p", shared]);
    chmodSync(shared, 0o755);
    writeFileSync(join(shared, "notes.txt"), "someone else's file");
    const r = await takeSnapshot(opts(path, shared));
    expect(r).toMatchObject({ ok: false, code: "dir_not_dedicated" });
    expect(statSync(shared).mode & 0o777).toBe(0o755);
    expect(readdirSync(shared)).toEqual(["notes.txt"]);
    db.close();
  });

  test("an uncompressed snapshot when compress is off", async () => {
    const { path, dir, db } = makeDb(5);
    const r = await takeSnapshot(opts(path, dir, { compress: false }), { now: () => T0 });
    expect(r).toMatchObject({ ok: true, file: snapshotName("t", T0, false) });
    expect(counts(join(dir, snapshotName("t", T0, false))).ok).toBe("ok");
    db.close();
  });

  test("rotation after a success deletes only old snapshots of this database and their manifests", async () => {
    const { path, dir, db } = makeDb(5);
    Bun.spawnSync(["mkdir", "-p", dir]);
    chmodSync(dir, 0o700);
    const old = [T0 - 2 * 86_400_000, T0 - 86_400_000];
    for (const at of old) {
      writeFileSync(join(dir, snapshotName("t", at, true)), "old");
      writeFileSync(join(dir, manifestName("t", at)), "{}");
    }
    writeFileSync(join(dir, ".other-1.db.tmp"), "another database's child");
    writeFileSync(join(dir, snapshotName("other", T0 - 9 * 86_400_000, true)), "other db");
    const r = await takeSnapshot(opts(path, dir, { keep: { keepRecent: 2, keepDaily: 0, keepWeekly: 0 } }), { now: () => T0 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.deleted.sort()).toEqual([snapshotName("t", old[0]!, true), manifestName("t", old[0]!)].sort());
    expect(existsSync(join(dir, ".other-1.db.tmp"))).toBe(true);
    expect(existsSync(join(dir, snapshotName("other", T0 - 9 * 86_400_000, true)))).toBe(true);
    expect(existsSync(join(dir, snapshotName("t", old[1]!, true)))).toBe(true);
    db.close();
  });
});

describe("drill.ts", () => {
  test("restores the newest snapshot, checks it and compares the counts with the manifest", async () => {
    const { path, dir, db } = makeDb(20);
    await takeSnapshot(opts(path, dir), { now: () => T0 - 3_600_000 });
    db.prepare("INSERT INTO a(v) VALUES (?)").run("newer");
    const newest = await takeSnapshot(opts(path, dir), { now: () => T0 });
    const r = await runDrill({ dir, names: ["t"] });
    expect(r).toEqual({ ok: true, checked: [{ name: "t", file: snapshotName("t", T0, true), counts: newest.ok ? newest.manifest.counts : {} }] });
    expect(readdirSync(dir).filter((f) => !f.startsWith("t-"))).toEqual([]); // the temp file is gone
    db.close();
  });

  test("a count mismatch, a changed file or a missing snapshot fails", async () => {
    const { path, dir, db } = makeDb(20);
    await takeSnapshot(opts(path, dir), { now: () => T0 });
    const mf = join(dir, manifestName("t", T0));
    const m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
    writeFileSync(mf, JSON.stringify({ ...m, counts: { ...m.counts, a: m.counts.a! + 1 } }));
    expect(await runDrill({ dir, names: ["t"] })).toMatchObject({ ok: false, code: "count_mismatch" });
    writeFileSync(mf, JSON.stringify(m));
    const snap = join(dir, snapshotName("t", T0, true));
    const bytes = readFileSync(snap);
    bytes[bytes.length - 20] ^= 0xff;
    writeFileSync(snap, bytes);
    expect(await runDrill({ dir, names: ["t"] })).toMatchObject({ ok: false, code: "checksum_mismatch" });
    expect(await runDrill({ dir, names: ["nothing"] })).toMatchObject({ ok: false, code: "no_snapshot" });
    expect(readdirSync(dir).filter((f) => !f.startsWith("t-"))).toEqual([]);
    db.close();
  });
});
