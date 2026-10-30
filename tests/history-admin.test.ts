// ADR-0066 plan task 18: the history admin commands (tools/history/admin.ts) that the verify step runs.
// `copy-ledger` copies read-only through `VACUUM INTO` and refuses `data/` and an existing file; `backfill`
// needs a `--db` outside `data/` and, with `--verify`, uses the verify tag and refuses a collection that
// holds another tag's points; `verify-clean` deletes by the verify-tag filter and then requires a count of
// 0; `rescan-secrets` forgets each stored entry whose chunk the secret finder matches now; `forget` and
// `status` go through the seam. Every command goes through the engine code (no raw SQL, no curl with the
// key). Temp folders, the fake TEI and the fake Qdrant only.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/engine/ledger";
import { modelTag } from "../src/engine/history/embedder";
import { openHistoryStore } from "../src/engine/history/store";
import { runAdmin, verifyTag, type AdminCtx } from "../tools/history/admin";
import { bench, operatorThread, remotePoints, todo, type Bench } from "./fixtures/history-harness";

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

interface Rig {
  b: Bench;
  neo: string;
  data: string;
  scratch: string;
  ledgerPath: string;
  out: string[];
  ctx: AdminCtx;
  run(...argv: string[]): Promise<number>;
  tag: string;
}

/** A Neo folder with `data/ledger.db` (two operator todos), a scratch folder outside it, and the fakes. */
function rig(): Rig {
  const b = bench();
  const neo = mkdtempSync(join(tmpdir(), "neo-admin-"));
  const data = join(neo, "data");
  const scratch = join(neo, "tmp");
  mkdirSync(data);
  mkdirSync(scratch);
  const ledgerPath = join(data, "ledger.db");
  const led = openLedger(ledgerPath);
  const t = operatorThread(led);
  led.addTodo(todo({ brief: "Bus seats are not freed after a cancelled booking; fix the capacity release.", cause: { msgId: t, threadId: t } }));
  led.addTodo(todo({ brief: "Add the Qeshm hotels from CityNet to the destination list.", cause: { msgId: t, threadId: t } }));
  const out: string[] = [];
  const ctx: AdminCtx = {
    neoDir: neo, protectedDirs: [data], cfg: { ...b.cfg, dbPath: "data/history.db" }, env: b.env, workRoot: b.workRoot,
    out: (l) => void out.push(l), now: () => Date.UTC(2026, 9, 30, 12), pid: 4242,
  };
  cleanup.push(() => {
    b.stop();
    rmSync(neo, { recursive: true, force: true });
  });
  return { b, neo, data, scratch, ledgerPath, out, ctx, run: (...argv) => runAdmin(argv, ctx), tag: modelTag(b.cfg.embedder.model, b.cfg.embedder.dims, b.cfg.embedder.revision) };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const countRows = (path: string, table: string): number => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

test("copy-ledger copies the ledger read-only to a new file outside data/", async () => {
  const r = rig();
  const before = sha(r.ledgerPath);
  const to = join(r.scratch, "ledger-copy.db");
  expect(await r.run("copy-ledger", "--to", to)).toBe(0);
  expect(countRows(to, "project_todos")).toBe(2);
  expect(sha(r.ledgerPath)).toBe(before);
  expect(r.out.join("\n")).toContain(to);
  // The copy is the engine's read-only VACUUM INTO (backup/run.ts vacuumCopy), never a second implementation.
  const run = readFileSync(join(import.meta.dir, "..", "src/engine/backup/run.ts"), "utf8");
  expect(run).toMatch(/new Database\(source, \{ readonly: true \}\);\s*try \{\s*src\.prepare\("VACUUM INTO \?"\)/);
  expect(readFileSync(join(import.meta.dir, "..", "tools/history/admin.ts"), "utf8")).toContain("vacuumCopy(");
});

test("copy-ledger refuses a target inside data/ (also through a symlink) and a file that exists", async () => {
  const r = rig();
  expect(await r.run("copy-ledger", "--to", join(r.data, "copy.db"))).toBe(1);
  expect(existsSync(join(r.data, "copy.db"))).toBe(false);
  symlinkSync(r.data, join(r.neo, "link"));
  expect(await r.run("copy-ledger", "--to", join(r.neo, "link", "copy.db"))).toBe(1);
  expect(existsSync(join(r.data, "copy.db"))).toBe(false);
  const there = join(r.scratch, "there.db");
  writeFileSync(there, "keep me");
  expect(await r.run("copy-ledger", "--to", there)).toBe(1);
  expect(readFileSync(there, "utf8")).toBe("keep me");
  expect(await r.run("copy-ledger")).toBe(1); // --to is required
  expect(r.out.join("\n")).toMatch(/inside .*data/);
});

test("backfill needs a --db outside data/ and a --ledger that is not the live one", async () => {
  const r = rig();
  const copy = join(r.scratch, "ledger-copy.db");
  await r.run("copy-ledger", "--to", copy);
  expect(await r.run("backfill", "--ledger", copy)).toBe(1);
  expect(await r.run("backfill", "--ledger", copy, "--db", join(r.data, "history-verify.db"))).toBe(1);
  expect(existsSync(join(r.data, "history-verify.db"))).toBe(false);
  expect(await r.run("backfill", "--ledger", r.ledgerPath, "--db", join(r.scratch, "h.db"))).toBe(1);
  expect(existsSync(join(r.scratch, "h.db"))).toBe(false);
});

test("backfill --verify indexes a ledger copy under the verify tag only", async () => {
  const r = rig();
  const copy = join(r.scratch, "ledger-copy.db");
  await r.run("copy-ledger", "--to", copy);
  const db = join(r.scratch, "history-verify.db");
  expect(await r.run("backfill", "--ledger", copy, "--db", db, "--verify")).toBe(0);
  const vt = verifyTag(r.tag);
  expect(vt).toBe(`${r.tag}~verify`);
  const points = [...r.b.qdrant.collections.get("neo_history")!.points.values()];
  expect(points.length).toBeGreaterThan(0);
  expect(points.every((p) => p.payload.m === vt)).toBe(true);
  const store = openHistoryStore(db);
  expect(store.coverage(vt).ratio).toBe(1);
  store.close();
  const text = r.out.join("\n");
  expect(text).toMatch(/chunks \d+/);
  expect(text).toContain(vt);
  expect(text).not.toContain("MARKER"); // no key in the output
});

test("backfill --verify refuses to start when the collection holds another tag's points", async () => {
  const r = rig();
  const copy = join(r.scratch, "ledger-copy.db");
  await r.run("copy-ledger", "--to", copy);
  r.b.qdrant.collections.get("neo_history")!.points.set("00000000-0000-4000-8000-000000000001", { id: "00000000-0000-4000-8000-000000000001", vector: [1, 0, 0, 0], payload: { m: r.tag, kind: "todo", at: 1 } });
  const db = join(r.scratch, "history-verify.db");
  expect(await r.run("backfill", "--ledger", copy, "--db", db, "--verify")).toBe(1);
  expect(r.out.join("\n")).toContain("1 point(s) of another tag");
  expect(existsSync(db)).toBe(false);
  expect(r.b.embedCalls()).toBe(0);
});

test("backfill without --verify keeps vectors local: nothing goes to the shared index", async () => {
  const r = rig();
  const copy = join(r.scratch, "ledger-copy.db");
  await r.run("copy-ledger", "--to", copy);
  const db = join(r.scratch, "h.db");
  expect(await r.run("backfill", "--ledger", copy, "--db", db)).toBe(0);
  expect(r.b.qdrant.requests.length).toBe(0);
  const store = openHistoryStore(db);
  expect(store.listRefs(["todo"], undefined, 10).length).toBe(2);
  store.close();
});

test("verify-clean deletes by the verify-tag filter, keeps other tags, then requires a count of 0", async () => {
  const r = rig();
  const col = r.b.qdrant.collections.get("neo_history")!;
  const vt = verifyTag(r.tag);
  col.points.set("00000000-0000-4000-8000-00000000000a", { id: "00000000-0000-4000-8000-00000000000a", vector: [1, 0, 0, 0], payload: { m: vt, kind: "todo", at: 1 } });
  col.points.set("00000000-0000-4000-8000-00000000000b", { id: "00000000-0000-4000-8000-00000000000b", vector: [1, 0, 0, 0], payload: { m: "other", kind: "todo", at: 1 } });
  expect(await r.run("verify-clean")).toBe(0);
  expect(remotePoints(r.b.qdrant, vt)).toEqual([]);
  expect(remotePoints(r.b.qdrant, "other").length).toBe(1);
  const del = r.b.qdrant.requests.find((q) => q.path.includes("/points/delete"));
  expect(del?.body).toEqual({ filter: { must: [{ key: "m", match: { value: vt } }] } });
  expect(r.out.join("\n")).toContain(`${vt}: 0 points`);
  // A count that is not 0 after the delete fails.
  r.b.qdrant.fail.set("POST delete", 500);
  col.points.set("00000000-0000-4000-8000-00000000000c", { id: "00000000-0000-4000-8000-00000000000c", vector: [1, 0, 0, 0], payload: { m: vt, kind: "todo", at: 1 } });
  expect(await r.run("verify-clean")).toBe(1);
});

test("rescan-secrets forgets each entry whose stored chunk the secret finder matches now; --dry-run only lists", async () => {
  const r = rig();
  const db = join(r.scratch, "h.db");
  const store = openHistoryStore(db);
  const token = `ghp_${"a".repeat(36)}`;
  store.putSource({ ref: "todo:1", kind: "todo", project: "eticket", at: 1, title: "deploy", hash: "h1", meta: { commits: [] } }, [{ text: `Deploy with the token ${token} for now, then rotate it.` }], 1);
  store.putSource({ ref: "todo:2", kind: "todo", project: "eticket", at: 2, title: "seats", hash: "h2", meta: { commits: [] } }, [{ text: "Bus seats are not freed after a cancelled booking." }], 2);
  store.close();
  expect(await r.run("rescan-secrets", "--db", db, "--dry-run")).toBe(0);
  let s = openHistoryStore(db);
  expect(s.getSource("todo:1")).toBeDefined();
  s.close();
  expect(await r.run("rescan-secrets", "--db", db)).toBe(0);
  s = openHistoryStore(db);
  expect(s.getSource("todo:1")).toBeUndefined();
  expect(s.tombstoned(["todo:1"]).has("todo:1")).toBe(true);
  expect(s.getSource("todo:2")).toBeDefined();
  s.close();
  const text = r.out.join("\n");
  expect(text).toContain("todo:1 github_token");
  expect(text).not.toContain(token);
});

test("forget removes one entry with a reason; no reason is refused", async () => {
  const r = rig();
  const db = join(r.scratch, "h.db");
  const store = openHistoryStore(db);
  store.putSource({ ref: "todo:2", kind: "todo", at: 2, title: "seats", hash: "h2", meta: { commits: [] } }, [{ text: "Bus seats are not freed after a cancelled booking." }], 2);
  store.close();
  expect(await r.run("forget", "todo:2", "--db", db)).toBe(1);
  expect(await r.run("forget", "todo:2", "--db", db, "--reason", "wrong project")).toBe(0);
  const s = openHistoryStore(db);
  expect(s.getSource("todo:2")).toBeUndefined();
  s.close();
  expect(r.out.join("\n")).toContain("forgot todo:2");
});

test("status names each service state, the tag coverage and the verify-tag count, never a key", async () => {
  const r = rig();
  const db = join(r.scratch, "h.db");
  openHistoryStore(db).close();
  expect(await r.run("status", "--db", db)).toBe(0);
  const text = r.out.join("\n");
  expect(text).toContain("embedder: up");
  expect(text).toContain("vectors: up");
  expect(text).toContain(`active ${r.tag}`);
  expect(text).toContain(`${verifyTag(r.tag)}: 0 points`);
  expect(text).not.toContain("MARKER");
  // A missing store is refused, not made.
  expect(await r.run("status", "--db", join(r.scratch, "none.db"))).toBe(1);
  expect(existsSync(join(r.scratch, "none.db"))).toBe(false);
  // The embedder off: the step is named.
  r.ctx.env = { ...r.b.env, HISTORY_EMBEDDER_KEY: "" };
  expect(await r.run("status", "--db", db)).toBe(0);
  expect(r.out.join("\n")).toContain("bun tools/history/install.ts");
});

test("an unknown command prints the usage", async () => {
  const r = rig();
  expect(await r.run("nope")).toBe(2);
  expect(r.out.join("\n")).toContain("copy-ledger");
});

test("every command goes through the engine: no raw SQL, no curl, the config through loadConfig", () => {
  for (const f of ["tools/history/admin.ts", "tools/history/eval.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
    expect(src, f).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE FROM|VACUUM|PRAGMA)\b/);
    expect(src, f).not.toMatch(/new Database\(|bun:sqlite|\.query\(|curl/);
  }
  // The config and the keys come only through the engine's loader.
  expect(readFileSync(join(import.meta.dir, "..", "tools/history/admin.ts"), "utf8")).toContain("loadConfig(");
  expect(readFileSync(join(import.meta.dir, "..", "tools/history/eval.ts"), "utf8")).toContain("realContext(");
});
