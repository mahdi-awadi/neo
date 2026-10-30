// ADR-0066: `data/history.db`, the task history's own store — its schema (through the shared `migrate()`),
// file mode 0600, sources and chunks with their FTS rows, vectors and point marks, the delete queue,
// remembered entries, tombstones, boilerplate counts, the archive mark, coverage, state and the writer lock.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { isHistoryStoreError, openHistoryStore, type SourceInput } from "../src/engine/history/store";
import { hashText } from "../src/engine/history/extract";
import { safeFtsQuery } from "../src/engine/memory-recall";
import { normalize } from "../src/engine/history/normalize";
import { arabicStems } from "../src/engine/history/arabic-stem";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "neo-hist-store-")), "history.db");
const src = (over: Partial<SourceInput> = {}): SourceInput => ({
  ref: "todo:1", kind: "todo", project: "eticket", at: 1_000, title: "Seats", hash: "h1", meta: { todo: 1, commits: [] }, ...over,
});
const words = (q: string) => safeFtsQuery(normalize(q), { mode: "any" });
const vec = (...xs: number[]) => Float32Array.from(xs);

test("a new file has the spec schema at version 1, FTS5 contentless-delete with porter, and mode 0600", () => {
  const path = dbPath();
  const s = openHistoryStore(path);
  s.putSource(src(), [{ text: "the bus seats are not released" }], 1);
  s.close();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
  const db = new Database(path, { readonly: true });
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
  const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ["sources", "chunks", "chunks_fts", "vectors", "points", "pending_deletes", "remembered", "tombstones", "boilerplate", "state"]) {
    expect(names).toContain(t);
  }
  const fts = (db.query("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get() as { sql: string }).sql;
  expect(fts).toContain("contentless_delete=1");
  expect(fts).toContain("content=''");
  expect(fts).toContain("porter unicode61 remove_diacritics 2");
  const idx = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string }>).map((r) => r.name);
  expect(idx.length).toBeGreaterThanOrEqual(4);
  db.close();
});

test("an existing file with a looser mode is set to 0600", () => {
  const path = dbPath();
  writeFileSync(path, "", { mode: 0o644 });
  openHistoryStore(path).close();
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a reopen keeps the cursor, the state and the lock", () => {
  const path = dbPath();
  const a = openHistoryStore(path);
  a.setState("feed.cursor", "4711");
  expect(a.takeLock(111, 1_000)).toEqual({ ok: true });
  a.close();
  const b = openHistoryStore(path);
  expect(b.getState("feed.cursor")).toBe("4711");
  expect(b.getState("missing")).toBeUndefined();
  expect(b.lockHolder()).toEqual({ pid: 111, at: 1_000 });
  b.close();
});

test("a live lock is seen by a second opener; a stale one or the same pid is taken; release frees it", () => {
  const path = dbPath();
  const a = openHistoryStore(path, { lockStaleMs: 60_000 });
  const b = openHistoryStore(path, { lockStaleMs: 60_000 });
  expect(a.takeLock(111, 1_000)).toEqual({ ok: true });
  expect(b.takeLock(222, 30_000)).toEqual({ ok: false, pid: 111, at: 1_000 });
  expect(a.takeLock(111, 40_000)).toEqual({ ok: true }); // heartbeat
  expect(b.takeLock(222, 90_000)).toEqual({ ok: false, pid: 111, at: 40_000 });
  expect(b.takeLock(222, 100_001)).toEqual({ ok: true }); // stale: taken over
  b.releaseLock(111); // not the holder: no change
  expect(a.lockHolder()).toEqual({ pid: 222, at: 100_001 });
  b.releaseLock(222);
  expect(a.lockHolder()).toBeUndefined();
  a.close();
  b.close();
});

test("a corrupt file gives a typed error", () => {
  const path = dbPath();
  writeFileSync(path, "this is not a sqlite database at all, just text ".repeat(200));
  let err: unknown;
  try {
    openHistoryStore(path);
  } catch (e) {
    err = e;
  }
  expect(isHistoryStoreError(err)).toBe(true);
  expect((err as { code: string }).code).toBe("corrupt");
  expect(isHistoryStoreError(new Error("x"))).toBe(false);
});

test("putSource: unchanged chunks keep their id, a changed chunk replaces its FTS row, removed seqs give back their points", () => {
  const s = openHistoryStore(dbPath());
  const r1 = s.putSource(src(), [{ text: "alpha seats released" }, { text: "bravo webhook arrived" }, { text: "charlie refund issued" }], 10);
  expect(r1).toMatchObject({ added: 3, changed: 0, unchanged: 0, deleted: 0, removedPoints: [] });
  const before = s.chunksOf("todo:1");
  expect(before.map((c) => c.seq)).toEqual([0, 1, 2]);
  expect(before[0]!.textHash).toBe(hashText("alpha seats released"));

  // Give every chunk an uploaded point for tag T.
  s.putVectors("T", before.map((c) => ({ textHash: c.textHash, vec: vec(1, 0) })));
  expect(s.addMissingPoints("T", 10)).toBe(3);
  const pts = s.pointsToUpload("T", 10);
  s.markUploaded(pts.map((p) => p.pointId), 11);
  const pointOf = (chunkId: number) => pts.find((p) => p.chunkId === chunkId)!.pointId;

  const r2 = s.putSource(src({ hash: "h2", title: "Seats v2" }), [{ text: "alpha seats released" }, { text: "bravo webhook changed" }], 20);
  expect(r2).toMatchObject({ added: 0, changed: 1, unchanged: 1, deleted: 1 });
  expect(r2.removedPoints).toEqual([pointOf(before[2]!.id)]);
  expect(s.pendingDeletes(10)).toEqual([pointOf(before[2]!.id)]);
  const after = s.chunksOf("todo:1");
  expect(after.map((c) => c.id)).toEqual([before[0]!.id, before[1]!.id]); // ids kept
  expect(after[1]!.text).toBe("bravo webhook changed");
  expect(s.getSource("todo:1")).toMatchObject({ title: "Seats v2", hash: "h2", indexedAt: 20 });

  // The changed chunk's FTS row is replaced; the removed chunk's row is gone.
  const hit = (q: string) => s.searchWords({ body: words(q) }, {}, 10).map((h) => h.chunkId);
  expect(hit("changed")).toEqual([before[1]!.id]);
  expect(hit("arrived")).toEqual([]);
  expect(hit("refund")).toEqual([]);
  // The changed chunk's point waits for a new vector; the unchanged one stays uploaded.
  expect(s.countUploaded("T")).toBe(1);
  s.putVectors("T", [{ textHash: after[1]!.textHash, vec: vec(0, 1) }]);
  expect(s.pointsToUpload("T", 10).map((p) => p.pointId)).toEqual([pointOf(before[1]!.id)]); // the same point id
  s.close();
});

test("putSource refuses a tombstoned ref, and clears the archive mark of a ref that came back", () => {
  const s = openHistoryStore(dbPath());
  s.putSource(src(), [{ text: "first text here" }], 1);
  expect(s.markGone(["todo:1", "todo:404"], 5)).toBe(1);
  expect(s.getSource("todo:1")!.goneAt).toBe(5);
  expect(s.markGone(["todo:1"], 9)).toBe(0); // the first mark stays
  s.putSource(src({ hash: "h2" }), [{ text: "first text here" }], 10);
  expect(s.getSource("todo:1")!.goneAt).toBeUndefined();

  s.addTombstone("todo:2", "operator forgot it", 11);
  expect(s.tombstoned(["todo:1", "todo:2"])).toEqual(new Set(["todo:2"]));
  expect(s.putSource(src({ ref: "todo:2" }), [{ text: "never again please" }], 12)).toMatchObject({ tombstoned: true, added: 0 });
  expect(s.getSource("todo:2")).toBeUndefined();
  s.close();
});

test("removeSource deletes the chunks, FTS rows, the vectors no other chunk uses, and queues the points", () => {
  const s = openHistoryStore(dbPath());
  s.putSource(src(), [{ text: "shared text body" }, { text: "only in one" }], 1);
  s.putSource(src({ ref: "order:a", kind: "order" }), [{ text: "shared text body" }], 1);
  const hashes = s.chunksOf("todo:1").map((c) => c.textHash);
  s.putVectors("T", hashes.map((h) => ({ textHash: h, vec: vec(1) })));
  s.addMissingPoints("T", 10);
  const r = s.removeSource("todo:1", 7);
  expect(r.chunks).toBe(2);
  expect(r.points.length).toBe(2);
  expect(r.vectors).toBe(1); // "shared text body" is still used by order:a
  expect(s.getVector(hashes[0]!, "T")).toBeDefined();
  expect(s.getVector(hashes[1]!, "T")).toBeUndefined();
  expect(s.getSource("todo:1")).toBeUndefined();
  expect(s.searchWords({ body: words("one") }, {}, 10)).toEqual([]);
  expect(new Set(s.pendingDeletes(10))).toEqual(new Set(r.points));
  expect(s.removeSource("todo:404", 8)).toEqual({ chunks: 0, points: [], vectors: 0 });
  s.close();
});

test("FTS search on body and stems in bm25 order, with the filters through the join to sources", () => {
  const s = openHistoryStore(dbPath());
  s.putSource(src({ ref: "todo:1", project: "eticket", at: 100, kind: "todo" }), [{ text: "seats seats seats are not released after cancel" }], 1);
  s.putSource(src({ ref: "result:o1", project: "eticket", at: 200, kind: "result" }), [{ text: "one mention of seats in a much longer result text about other things" }], 1);
  s.putSource(src({ ref: "todo:2", project: "waselni", at: 300, kind: "todo" }), [{ text: "والمقاعدُ لا تتحرر بعد الإلغاء" }], 1);
  s.putSource(src({ ref: "plan:3", project: "waselni", at: 400, kind: "plan" }), [{ text: "booking 123 confirmed by the agent" }], 1);
  const refs = (q: { body?: string; stems?: string }, f = {}) => s.searchWords(q, f, 10).map((h) => h.ref);

  expect(refs({ body: words("seats") })).toEqual(["todo:1", "result:o1"]); // bm25: denser first
  expect(refs({ body: words("seats") }, { project: "eticket", kinds: ["result"] })).toEqual(["result:o1"]);
  expect(refs({ body: words("seats") }, { since: 150 })).toEqual(["result:o1"]);
  expect(refs({ body: words("seats") }, { until: 150 })).toEqual(["todo:1"]);
  expect(refs({ body: words("seats") }, { project: "waselni" })).toEqual([]);
  // Porter: "release" finds "released".
  expect(refs({ body: words("release") })).toEqual(["todo:1"]);
  // Arabic: the stem column finds the word with its prefix and harakat; digits are normalized.
  expect(refs({ stems: safeFtsQuery(arabicStems("مقاعد"), { mode: "any" }) })).toEqual(["todo:2"]);
  expect(refs({ body: words("١٢٣") })).toEqual(["plan:3"]);
  // Both columns in one query.
  expect(new Set(refs({ body: words("booking"), stems: safeFtsQuery(arabicStems("المقاعد"), { mode: "any" }) }))).toEqual(new Set(["plan:3", "todo:2"]));
  expect(s.searchWords({}, {}, 10)).toEqual([]);
  const top = s.searchWords({ body: words("seats") }, {}, 1);
  expect(top).toHaveLength(1);
  expect(top[0]).toMatchObject({ ref: "todo:1", seq: 0 });
  expect(typeof top[0]!.rank).toBe("number");
  s.close();
});

test("vectors by text hash and tag; point marks: to upload, mark, clear for a tag, the ids of a tag", () => {
  const s = openHistoryStore(dbPath());
  s.putSource(src({ ref: "todo:1", project: "eticket", at: 100 }), [{ text: "chunk one text" }, { text: "chunk two text" }], 1);
  const [c1, c2] = s.chunksOf("todo:1");
  expect(s.textsWithoutVector("A", 10)).toEqual([{ textHash: c1!.textHash, text: "chunk one text" }, { textHash: c2!.textHash, text: "chunk two text" }]);
  s.putVectors("A", [{ textHash: c1!.textHash, vec: vec(0.5, -1.25, 3) }]);
  expect(Array.from(s.getVector(c1!.textHash, "A")!)).toEqual([0.5, -1.25, 3]);
  expect(s.getVector(c1!.textHash, "B")).toBeUndefined();
  expect(s.textsWithoutVector("A", 10).map((t) => t.textHash)).toEqual([c2!.textHash]);
  expect(s.textsWithoutVector("B", 1)).toHaveLength(1); // the limit

  expect(s.addMissingPoints("A", 10)).toBe(1); // only the chunk with a vector
  expect(s.addMissingPoints("A", 10)).toBe(0);
  const up = s.pointsToUpload("A", 10);
  expect(up).toHaveLength(1);
  expect(up[0]).toMatchObject({ chunkId: c1!.id, kind: "todo", project: "eticket", at: 100 });
  expect(up[0]!.pointId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Array.from(up[0]!.vector)).toEqual([0.5, -1.25, 3]);

  s.markUploaded([up[0]!.pointId], 50);
  expect(s.pointsToUpload("A", 10)).toEqual([]);
  expect(s.countUploaded("A")).toBe(1);
  expect(s.pointIdsOfTag("A")).toEqual([up[0]!.pointId]);
  expect(s.coverage("A")).toEqual({ chunks: 2, uploaded: 1, ratio: 0.5 });
  expect(s.coverage("B")).toEqual({ chunks: 2, uploaded: 0, ratio: 0 });

  expect(s.clearUploadMarks("A")).toBe(1);
  expect(s.countUploaded("A")).toBe(0);
  expect(s.pointsToUpload("A", 10).map((p) => p.pointId)).toEqual([up[0]!.pointId]); // same id, sent again

  // Retiring a tag drops its points and vectors.
  s.putVectors("B", [{ textHash: c2!.textHash, vec: vec(1) }]);
  expect(s.dropTag("A")).toEqual({ points: [up[0]!.pointId], vectors: 1 });
  expect(s.pointIdsOfTag("A")).toEqual([]);
  expect(s.getVector(c2!.textHash, "B")).toBeDefined();
  s.close();
});

test("an empty store has full coverage", () => {
  const s = openHistoryStore(dbPath());
  expect(s.coverage("A")).toEqual({ chunks: 0, uploaded: 0, ratio: 1 });
  s.close();
});

test("the pending_deletes queue: oldest first, idempotent, cleared by id", () => {
  const s = openHistoryStore(dbPath());
  s.queueDeletes(["p2", "p1"], 5);
  s.queueDeletes(["p1"], 9); // already queued
  s.queueDeletes(["p0"], 1);
  expect(s.pendingDeletes(10)).toEqual(["p0", "p2", "p1"]);
  expect(s.pendingDeletes(1)).toEqual(["p0"]);
  expect(s.countPendingDeletes()).toBe(3);
  s.clearPendingDeletes(["p0", "p2"]);
  expect(s.pendingDeletes(10)).toEqual(["p1"]);
  s.close();
});

test("remembered entries: the duplicate check is on project and text hash", () => {
  const s = openHistoryStore(dbPath());
  const a = s.addRemembered({ text: "Seats free on cancel via the webhook", project: "eticket", by: "operator", at: 1 });
  expect(a).toEqual({ id: a.id, duplicate: false });
  expect(s.addRemembered({ text: "Seats free on cancel via the webhook", project: "eticket", by: "worker", at: 2 })).toEqual({ id: a.id, duplicate: true });
  expect(s.addRemembered({ text: "Seats free on cancel via the webhook", project: "waselni", by: "worker", at: 3 }).duplicate).toBe(false);
  const none = s.addRemembered({ text: "Seats free on cancel via the webhook", by: "company", cause: "m4f2", at: 4 });
  expect(none.duplicate).toBe(false);
  expect(s.addRemembered({ text: "Seats free on cancel via the webhook", by: "company", at: 5 })).toEqual({ id: none.id, duplicate: true });
  expect(s.getRemembered(none.id)).toEqual({ id: none.id, text: "Seats free on cancel via the webhook", by: "company", cause: "m4f2", at: 4 });
  expect(s.deleteRemembered(none.id)).toBe(true);
  expect(s.getRemembered(none.id)).toBeUndefined();
  expect(s.deleteRemembered(none.id)).toBe(false);
  s.close();
});

test("boilerplate counts add up per hash; the set is the hashes at or above the limit", () => {
  const s = openHistoryStore(dbPath());
  for (let i = 0; i < 3; i++) s.countParagraphs(["a", "b"]);
  s.countParagraphs(["a"]);
  expect(s.boilerplate(4)).toEqual(new Set(["a"]));
  expect(s.boilerplate(3)).toEqual(new Set(["a", "b"]));
  s.countParagraphs([]);
  s.close();
});

test("transaction rolls back on a throw", () => {
  const s = openHistoryStore(dbPath());
  expect(() =>
    s.transaction(() => {
      s.setState("k", "v");
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(s.getState("k")).toBeUndefined();
  s.close();
});
