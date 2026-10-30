// `data/history.db`, the task history's own store (ADR-0066, spec "Data"): every SQL statement of the
// history lives here, parameterized. Sources and their chunks (original text in `chunks`, the normalized
// text and Arabic stems in `chunks_fts`), vectors by text hash and model tag, Qdrant point marks, the
// delete queue, remembered entries, tombstones, boilerplate counts, state and the writer lock. The file is
// mode 0600; its schema runs through the ledger's `migrate()` with its `.bak-v<N>` copy.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "../ledger-migrations";
import { openSqlite } from "../sqlite";
import { arabicStems } from "./arabic-stem";
import { STORE_DEFAULTS, type StoreCfg } from "./defaults";
import { hashText } from "./extract";
import { HISTORY_MIGRATIONS } from "./migrations";
import { normalize } from "./normalize";

export type HistoryKind =
  | "todo" | "order" | "result" | "digest" | "message" | "plan"
  | "note" | "attention" | "decision" | "remembered" | "line";

export interface SourceMeta {
  todo?: number;
  order?: string;
  thread?: number;
  path?: string;
  commits?: string[];
  /** A project note's sender project (the target is the source's project). */
  from?: string;
  /** A plan file that is gone: the last indexed text stays. */
  fileMissing?: boolean;
  /** The text was cut (`planMaxBytes`, `maxPerRef`). */
  cut?: boolean;
}

export interface SourceInput {
  ref: string;
  kind: HistoryKind;
  project?: string;
  at: number;
  title: string;
  /** The hash of the extracted source text: unchanged → no work. */
  hash: string;
  meta: SourceMeta;
}

export interface SourceRow extends SourceInput {
  goneAt?: number;
  indexedAt: number;
}

export interface ChunkInput {
  text: string;
  flags?: number;
}

export interface ChunkRow {
  id: number;
  ref: string;
  seq: number;
  text: string;
  textHash: string;
  flags: number;
}

export interface PutResult {
  /** The ref has a tombstone: nothing was written. */
  tombstoned: boolean;
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
  /** The points of the deleted chunks (also queued in `pending_deletes`). */
  removedPoints: string[];
}

export interface HistoryFilter {
  project?: string;
  /** ms, inclusive */
  since?: number;
  until?: number;
  kinds?: HistoryKind[];
}

export interface WordHit {
  chunkId: number;
  ref: string;
  seq: number;
  /** bm25: lower is better. */
  rank: number;
}

export interface UploadPoint {
  pointId: string;
  chunkId: number;
  vector: Float32Array;
  kind: HistoryKind;
  project?: string;
  at: number;
}

export interface RememberedRow {
  id: number;
  text: string;
  project?: string;
  by: string;
  cause?: string;
  at: number;
}

export type LockResult = { ok: true } | { ok: false; pid: number; at: number };

export interface HistoryStore {
  readonly path: string;
  /** Run `fn` in one write transaction. */
  transaction<T>(fn: () => T): T;
  getSource(ref: string): SourceRow | undefined;
  /** Write a source and its chunks (seq = index). An unchanged `text_hash` keeps the chunk and its points; a
   *  changed one keeps its id (so its point id), replaces its FTS row and needs a new upload; removed seqs
   *  are deleted with their FTS rows and points, and the points are queued for deletion. Clears `gone_at`. */
  putSource(src: SourceInput, chunks: ChunkInput[], now: number): PutResult;
  /** Delete a source everywhere in this file: chunks, FTS rows, points (queued), and the vectors no other
   *  chunk uses. */
  removeSource(ref: string, at: number): { chunks: number; points: string[]; vectors: number };
  /** Mark sources the ledger no longer has (archived). Keeps an earlier mark. Returns the rows marked. */
  markGone(refs: string[], at: number): number;
  chunksOf(ref: string): ChunkRow[];
  chunkById(id: number): ChunkRow | undefined;
  /** Every chunk in id order after `afterId`, at most `limit` (the admin's secret rescan walks them all). */
  scanChunks(afterId: number, limit: number): ChunkRow[];
  /** Every source in ref order after `afterRef`, at most `limit` (the admin's secret rescan checks titles and commits). */
  scanSources(afterRef: string | undefined, limit: number): SourceRow[];
  /** Replace the stored commit list of one source (the rescan drops a commit its kept text does not hold). */
  setCommits(ref: string, commits: string[]): void;
  /** The refs of `kinds` that are not archived, in ref order after `afterRef` (the reconcile's archive walk). */
  listRefs(kinds: string[], afterRef: string | undefined, limit: number): string[];
  /** Refs that start with `prefix` (a decision id prefix), in ref order. */
  refsWithPrefix(prefix: string, limit: number): string[];
  /** Refs whose meta names this todo, order or thread, newest first. */
  refsByMeta(field: "todo" | "order" | "thread", value: string | number, limit: number): string[];
  /** The chunks behind Qdrant point ids (any tag), in the order of `pointIds`; unknown ids are left out. */
  chunksByPointIds(pointIds: string[]): Array<{ pointId: string; chunkId: number; ref: string; textHash: string }>;
  /** Which of `pointIds` this file does not know (Qdrant orphans). */
  unknownPointIds(pointIds: string[]): string[];
  /** FTS5 on `body` and/or `stems` (FTS5 query strings, e.g. from `safeFtsQuery`), best bm25 first, with the
   *  filters applied through the join to `sources`. Neither column → []. */
  searchWords(q: { body?: string; stems?: string }, filter: HistoryFilter, limit: number): WordHit[];
  /** Distinct chunk texts with no vector for `tag`. */
  textsWithoutVector(tag: string, limit: number): Array<{ textHash: string; text: string }>;
  /** How many distinct chunk texts have no vector for `tag` (the embed backlog). */
  countWithoutVector(tag: string): number;
  /** How many points of `tag` wait for their upload (the upload backlog). */
  countToUpload(tag: string): number;
  putVectors(tag: string, rows: Array<{ textHash: string; vec: Float32Array }>): void;
  getVector(textHash: string, tag: string): Float32Array | undefined;
  /** Give a point id (`pointIdOf`) to chunks that have a vector for `tag` and no point yet. Returns how many. */
  addMissingPoints(tag: string, limit: number): number;
  /** Walk the stored points (from a saved position) and give each the id `pointIdOf` derives: a point
   *  stored before ids were derived gets its new id, is sent again, and its old id is queued for deletion. */
  rederivePointIds(limit: number, at: number): { checked: number; changed: number };
  /** Uploaded points of `tag` in chunk order after `afterChunkId`, at most `limit` (the weekly sweep). */
  uploadedPoints(tag: string, afterChunkId: number, limit: number): Array<{ pointId: string; chunkId: number }>;
  /** Forget that these points were uploaded (the weekly sweep found them missing in Qdrant). */
  unmarkPoints(pointIds: string[]): void;
  /** Points of `tag` not yet uploaded whose vector exists, with their payload fields. */
  pointsToUpload(tag: string, limit: number): UploadPoint[];
  markUploaded(pointIds: string[], at: number): void;
  /** Forget which points of `tag` were uploaded (the collection lost them). Returns how many. */
  clearUploadMarks(tag: string): number;
  pointIdsOfTag(tag: string): string[];
  countUploaded(tag: string): number;
  /** Retire a model tag: delete its point rows and vectors here. Returns the point ids for Qdrant. */
  dropTag(tag: string): { points: string[]; vectors: number };
  /** The share of chunks with an uploaded point of `tag` (1 when there are no chunks). */
  coverage(tag: string): { chunks: number; uploaded: number; ratio: number };
  queueDeletes(pointIds: string[], at: number): void;
  /** Queued point ids, oldest first. */
  pendingDeletes(limit: number): string[];
  clearPendingDeletes(pointIds: string[]): void;
  countPendingDeletes(): number;
  /** Save an explicit entry; the same text in the same project gives the existing id. */
  addRemembered(r: { text: string; project?: string; by: string; cause?: string; at: number }): { id: number; duplicate: boolean };
  getRemembered(id: number): RememberedRow | undefined;
  deleteRemembered(id: number): boolean;
  addTombstone(ref: string, reason: string, at: number): void;
  /** Which of `refs` have a tombstone. */
  tombstoned(refs: string[]): Set<string>;
  /** Count each paragraph hash of one source row once. */
  countParagraphs(hashes: string[]): void;
  /** The paragraph hashes seen in at least `minRows` rows. */
  boilerplate(minRows: number): Set<string>;
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  /** Take or refresh the writer lock for `pid`. A lock of another pid whose heartbeat is younger than
   *  `lockStaleMs` is live: the answer names it. */
  takeLock(pid: number, now: number): LockResult;
  lockHolder(): { pid: number; at: number } | undefined;
  /** Free the lock if `pid` holds it. */
  releaseLock(pid: number): void;
  close(): void;
}

export type HistoryStoreErrorCode = "corrupt" | "unreadable";
export type HistoryStoreError = Error & { code: HistoryStoreErrorCode; path: string };

export function isHistoryStoreError(e: unknown): e is HistoryStoreError {
  return e instanceof Error && ((e as Partial<HistoryStoreError>).code === "corrupt" || (e as Partial<HistoryStoreError>).code === "unreadable") && typeof (e as Partial<HistoryStoreError>).path === "string";
}

function storeError(path: string, cause: unknown): HistoryStoreError {
  const why = cause instanceof Error ? cause.message : String(cause);
  const code: HistoryStoreErrorCode = /not a database|malformed|corrupt/i.test(why) ? "corrupt" : "unreadable";
  return Object.assign(new Error(`history store ${path} is ${code}: ${why}`, { cause }), { code, path });
}

const LOCK_KEY = "lock";
/** The `state` key of the point-id walk: the last `points.rowid` checked. */
const REDERIVE_KEY = "points.rederived";

/** The namespace of the task history's point ids (RFC 4122 name-based ids). */
const POINT_NAMESPACE = Buffer.from("6f1c2a4e8b3d4f5aa7c9e0d1b2f3a4c5", "hex");

/** The Qdrant point id of one chunk under one model tag: a UUID v5 (SHA-1, RFC 4122) of the tag, the ref
 *  and the chunk seq, so the same chunk always has the same id (ADR-0066 Decision 4). */
export function pointIdOf(tag: string, ref: string, seq: number): string {
  const h = createHash("sha1").update(POINT_NAMESPACE).update(`${tag}\u0000${ref}\u0000${seq}`).digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** bm25 column weights: `body`, then `stems` (spec "Search"). */
const BM25_WEIGHTS = [1.0, 0.6] as const;

const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(b.slice().buffer);
const inList = (n: number): string => Array.from({ length: n }, () => "?").join(",");

interface SourceDbRow {
  ref: string; kind: HistoryKind; project: string | null; at: number; title: string; hash: string; meta: string;
  gone_at: number | null; indexed_at: number;
}

/** Open (or create) `history.db` at `path`, migrated to the newest version and set to mode 0600. A file that
 *  is not a database, or cannot be read, throws a `HistoryStoreError`. */
export function openHistoryStore(path: string, opts: Partial<StoreCfg> & { busyTimeoutMs?: number } = {}): HistoryStore {
  const lockStaleMs = opts.lockStaleMs ?? STORE_DEFAULTS.lockStaleMs;
  const onDisk = path !== ":memory:" && path !== "";
  let db: Database;
  try {
    if (onDisk) {
      mkdirSync(dirname(path), { recursive: true });
      // Made 0600 before SQLite opens it, so the -wal and -shm files it creates take the same mode.
      if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    db = openSqlite(path, { busyTimeoutMs: opts.busyTimeoutMs });
  } catch (err) {
    throw storeError(path, err);
  }
  try {
    migrate(db, { path, migrations: HISTORY_MIGRATIONS, label: "history" });
  } catch (err) {
    db.close();
    throw storeError(path, err);
  }

  const q = {
    source: db.query(`SELECT * FROM sources WHERE ref = ?`),
    upsertSource: db.query(
      `INSERT INTO sources (ref, kind, project, at, title, hash, meta, gone_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, project = excluded.project, at = excluded.at, title = excluded.title,
         hash = excluded.hash, meta = excluded.meta, gone_at = NULL, indexed_at = excluded.indexed_at`,
    ),
    chunksOf: db.query(`SELECT id, ref, seq, text, text_hash, flags FROM chunks WHERE ref = ? ORDER BY seq`),
    insertChunk: db.query(`INSERT INTO chunks (ref, seq, text, text_hash, flags) VALUES (?, ?, ?, ?, ?)`),
    updateChunk: db.query(`UPDATE chunks SET text = ?, text_hash = ?, flags = ? WHERE id = ?`),
    updateFlags: db.query(`UPDATE chunks SET flags = ? WHERE id = ?`),
    deleteChunk: db.query(`DELETE FROM chunks WHERE id = ?`),
    insertFts: db.query(`INSERT INTO chunks_fts (rowid, body, stems) VALUES (?, ?, ?)`),
    deleteFts: db.query(`DELETE FROM chunks_fts WHERE rowid = ?`),
    pointsOfChunk: db.query(`SELECT point_id FROM points WHERE chunk_id = ?`),
    deletePointsOfChunk: db.query(`DELETE FROM points WHERE chunk_id = ?`),
    unmarkChunk: db.query(`UPDATE points SET uploaded_at = NULL WHERE chunk_id = ?`),
    unmarkRef: db.query(`UPDATE points SET uploaded_at = NULL WHERE chunk_id IN (SELECT id FROM chunks WHERE ref = ?)`),
    unqueueDelete: db.query(`DELETE FROM pending_deletes WHERE point_id = ?`),
    queueDelete: db.query(`INSERT OR IGNORE INTO pending_deletes (point_id, at) VALUES (?, ?)`),
    tombstone: db.query(`SELECT 1 FROM tombstones WHERE ref = ?`),
    getState: db.query(`SELECT value FROM state WHERE key = ?`),
    setState: db.query(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  const ftsRow = (id: number, text: string): void => {
    q.insertFts.run(id, normalize(text), arabicStems(text));
  };

  /** Delete one chunk with its FTS row and points; returns the point ids (queued for Qdrant). */
  const dropChunk = (id: number, at: number): string[] => {
    const pts = (q.pointsOfChunk.all(id) as Array<{ point_id: string }>).map((r) => r.point_id);
    for (const p of pts) q.queueDelete.run(p, at);
    q.deletePointsOfChunk.run(id);
    q.deleteFts.run(id);
    q.deleteChunk.run(id);
    return pts;
  };

  const mapChunk = (r: { id: number; ref: string; seq: number; text: string; text_hash: string; flags: number }): ChunkRow => ({
    id: r.id, ref: r.ref, seq: r.seq, text: r.text, textHash: r.text_hash, flags: r.flags,
  });

  const mapSource = (r: SourceDbRow): SourceRow => ({
    ref: r.ref, kind: r.kind, ...(r.project !== null ? { project: r.project } : {}), at: r.at, title: r.title, hash: r.hash,
    meta: JSON.parse(r.meta) as SourceMeta, ...(r.gone_at !== null ? { goneAt: r.gone_at } : {}), indexedAt: r.indexed_at,
  });

  const lockHolder = (): { pid: number; at: number } | undefined => {
    const v = (q.getState.get(LOCK_KEY) as { value: string } | null)?.value;
    if (!v) return undefined;
    try {
      const l = JSON.parse(v) as { pid?: unknown; at?: unknown };
      return typeof l.pid === "number" && typeof l.at === "number" ? { pid: l.pid, at: l.at } : undefined;
    } catch {
      return undefined; // an unreadable lock row is no lock
    }
  };

  return {
    path,
    transaction: (fn) => db.transaction(fn)(),

    getSource(ref) {
      const r = q.source.get(ref) as SourceDbRow | null;
      return r ? mapSource(r) : undefined;
    },

    scanSources(afterRef, limit) {
      const rows = db.query(`SELECT * FROM sources WHERE (? IS NULL OR ref > ?) ORDER BY ref LIMIT ?`).all(afterRef ?? null, afterRef ?? null, limit);
      return (rows as SourceDbRow[]).map(mapSource);
    },

    setCommits(ref, commits) {
      db.query(`UPDATE sources SET meta = json_set(meta, '$.commits', json(?)) WHERE ref = ?`).run(JSON.stringify(commits), ref);
    },

    putSource(src, chunks, now) {
      const result: PutResult = { tombstoned: false, added: 0, changed: 0, unchanged: 0, deleted: 0, removedPoints: [] };
      db.transaction(() => {
        if (q.tombstone.get(src.ref)) {
          result.tombstoned = true;
          return;
        }
        const before = q.source.get(src.ref) as SourceDbRow | null;
        // The payload carries kind, project and at: when one changes, the kept points are sent again.
        if (before && (before.kind !== src.kind || before.project !== (src.project ?? null) || before.at !== src.at)) q.unmarkRef.run(src.ref);
        q.upsertSource.run(src.ref, src.kind, src.project ?? null, src.at, src.title, src.hash, JSON.stringify(src.meta), now);
        const old = new Map((q.chunksOf.all(src.ref) as Parameters<typeof mapChunk>[0][]).map((r) => [r.seq, mapChunk(r)]));
        chunks.forEach((c, seq) => {
          const textHash = hashText(c.text);
          const flags = c.flags ?? 0;
          const prev = old.get(seq);
          if (!prev) {
            const id = Number(q.insertChunk.run(src.ref, seq, c.text, textHash, flags).lastInsertRowid);
            ftsRow(id, c.text);
            result.added++;
          } else if (prev.textHash === textHash) {
            if (prev.flags !== flags) q.updateFlags.run(flags, prev.id);
            result.unchanged++;
          } else {
            q.updateChunk.run(c.text, textHash, flags, prev.id);
            q.deleteFts.run(prev.id);
            ftsRow(prev.id, c.text);
            q.unmarkChunk.run(prev.id); // same point id, sent again once the new text has a vector
            result.changed++;
          }
        });
        for (const [seq, prev] of old) {
          if (seq < chunks.length) continue;
          result.removedPoints.push(...dropChunk(prev.id, now));
          result.deleted++;
        }
      })();
      return result;
    },

    removeSource(ref, at) {
      return db.transaction(() => {
        const rows = (q.chunksOf.all(ref) as Parameters<typeof mapChunk>[0][]).map(mapChunk);
        const points: string[] = [];
        for (const c of rows) points.push(...dropChunk(c.id, at));
        let vectors = 0;
        const hashes = [...new Set(rows.map((c) => c.textHash))];
        if (hashes.length) {
          vectors = db
            .query(`DELETE FROM vectors WHERE text_hash IN (${inList(hashes.length)}) AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.text_hash = vectors.text_hash)`)
            .run(...hashes).changes;
        }
        db.query(`DELETE FROM sources WHERE ref = ?`).run(ref);
        return { chunks: rows.length, points, vectors };
      })();
    },

    markGone(refs, at) {
      if (!refs.length) return 0;
      return db.transaction(() => {
        const stmt = db.query(`UPDATE sources SET gone_at = ? WHERE ref = ? AND gone_at IS NULL`);
        return refs.reduce((n, ref) => n + stmt.run(at, ref).changes, 0);
      })();
    },

    chunksOf(ref) {
      return (q.chunksOf.all(ref) as Parameters<typeof mapChunk>[0][]).map(mapChunk);
    },

    scanChunks(afterId, limit) {
      const rows = db.query(`SELECT id, ref, seq, text, text_hash, flags FROM chunks WHERE id > ? ORDER BY id LIMIT ?`).all(afterId, limit);
      return (rows as Parameters<typeof mapChunk>[0][]).map(mapChunk);
    },

    chunkById(id) {
      const r = db.query(`SELECT id, ref, seq, text, text_hash, flags FROM chunks WHERE id = ?`).get(id) as Parameters<typeof mapChunk>[0] | null;
      return r ? mapChunk(r) : undefined;
    },

    listRefs(kinds, afterRef, limit) {
      if (!kinds.length) return [];
      return (
        db
          .query(
            `SELECT ref FROM sources WHERE kind IN (SELECT value FROM json_each(?)) AND gone_at IS NULL AND (? IS NULL OR ref > ?)
             ORDER BY ref LIMIT ?`,
          )
          .all(JSON.stringify(kinds), afterRef ?? null, afterRef ?? null, limit) as Array<{ ref: string }>
      ).map((r) => r.ref);
    },

    refsWithPrefix(prefix, limit) {
      if (!prefix) return [];
      // A range on the primary key: every ref that starts with `prefix` sorts between it and prefix + U+FFFF.
      return (db.query(`SELECT ref FROM sources WHERE ref >= ? AND ref < ? ORDER BY ref LIMIT ?`).all(prefix, `${prefix}￿`, limit) as Array<{ ref: string }>).map((r) => r.ref);
    },

    refsByMeta(field, value, limit) {
      const path = { todo: "$.todo", order: "$.order", thread: "$.thread" }[field];
      return (
        db.query(`SELECT ref FROM sources WHERE json_extract(meta, ?) = ? ORDER BY at DESC, ref LIMIT ?`).all(path, value, limit) as Array<{ ref: string }>
      ).map((r) => r.ref);
    },

    chunksByPointIds(pointIds) {
      if (!pointIds.length) return [];
      const rows = db
        .query(
          `SELECT p.point_id AS pointId, c.id AS chunkId, c.ref AS ref, c.text_hash AS textHash
           FROM points p JOIN chunks c ON c.id = p.chunk_id WHERE p.point_id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(pointIds)) as Array<{ pointId: string; chunkId: number; ref: string; textHash: string }>;
      const byId = new Map(rows.map((r) => [r.pointId, r]));
      return pointIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    },

    unknownPointIds(pointIds) {
      if (!pointIds.length) return [];
      const known = new Set(
        (db.query(`SELECT point_id FROM points WHERE point_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(pointIds)) as Array<{ point_id: string }>).map((r) => r.point_id),
      );
      return pointIds.filter((id) => !known.has(id));
    },

    searchWords(match, filter, limit) {
      const parts: string[] = [];
      if (match.body) parts.push(`body : (${match.body})`);
      if (match.stems) parts.push(`stems : (${match.stems})`);
      if (!parts.length) return [];
      const kinds = filter.kinds?.length ? JSON.stringify(filter.kinds) : null;
      return db
        .query(
          `SELECT c.id AS chunkId, c.ref AS ref, c.seq AS seq, bm25(chunks_fts, ?, ?) AS rank
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN sources s ON s.ref = c.ref
           WHERE chunks_fts MATCH ?
             AND (? IS NULL OR s.project = ?)
             AND (? IS NULL OR s.at >= ?)
             AND (? IS NULL OR s.at <= ?)
             AND (? IS NULL OR s.kind IN (SELECT value FROM json_each(?)))
           ORDER BY rank LIMIT ?`,
        )
        .all(
          BM25_WEIGHTS[0], BM25_WEIGHTS[1], parts.join(" OR "),
          filter.project ?? null, filter.project ?? null,
          filter.since ?? null, filter.since ?? null,
          filter.until ?? null, filter.until ?? null,
          kinds, kinds, limit,
        ) as WordHit[];
    },

    textsWithoutVector(tag, limit) {
      return db
        .query(
          `SELECT c.text_hash AS textHash, MIN(c.text) AS text FROM chunks c
           WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.text_hash = c.text_hash AND v.tag = ?)
           GROUP BY c.text_hash ORDER BY MIN(c.id) LIMIT ?`,
        )
        .all(tag, limit) as Array<{ textHash: string; text: string }>;
    },

    countWithoutVector(tag) {
      return (
        db
          .query(`SELECT count(DISTINCT c.text_hash) AS n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.text_hash = c.text_hash AND v.tag = ?)`)
          .get(tag) as { n: number }
      ).n;
    },

    countToUpload(tag) {
      return (db.query(`SELECT count(*) AS n FROM points WHERE tag = ? AND uploaded_at IS NULL`).get(tag) as { n: number }).n;
    },

    putVectors(tag, rows) {
      const stmt = db.query(`INSERT OR REPLACE INTO vectors (text_hash, tag, vec) VALUES (?, ?, ?)`);
      db.transaction(() => {
        for (const r of rows) stmt.run(r.textHash, tag, toBlob(r.vec));
      })();
    },

    getVector(textHash, tag) {
      const r = db.query(`SELECT vec FROM vectors WHERE text_hash = ? AND tag = ?`).get(textHash, tag) as { vec: Uint8Array } | null;
      return r ? fromBlob(r.vec) : undefined;
    },

    addMissingPoints(tag, limit) {
      return db.transaction(() => {
        const ids = db
          .query(
            `SELECT c.id, c.ref, c.seq FROM chunks c JOIN vectors v ON v.text_hash = c.text_hash AND v.tag = ?
             WHERE NOT EXISTS (SELECT 1 FROM points p WHERE p.chunk_id = c.id AND p.tag = ?) ORDER BY c.id LIMIT ?`,
          )
          .all(tag, tag, limit) as Array<{ id: number; ref: string; seq: number }>;
        const ins = db.query(`INSERT INTO points (chunk_id, tag, point_id, uploaded_at) VALUES (?, ?, ?, NULL)`);
        for (const c of ids) {
          const pointId = pointIdOf(tag, c.ref, c.seq);
          // The same id may wait in the delete queue (the seq was dropped before): the new upsert wins.
          q.unqueueDelete.run(pointId);
          ins.run(c.id, tag, pointId);
        }
        return ids.length;
      })();
    },

    rederivePointIds(limit, at) {
      return db.transaction(() => {
        const after = Number((q.getState.get(REDERIVE_KEY) as { value: string } | null)?.value ?? "0");
        const rows = db
          .query(
            `SELECT p.rowid AS rid, p.point_id, p.tag, c.ref, c.seq FROM points p JOIN chunks c ON c.id = p.chunk_id
             WHERE p.rowid > ? ORDER BY p.rowid LIMIT ?`,
          )
          .all(after, limit) as Array<{ rid: number; point_id: string; tag: string; ref: string; seq: number }>;
        const set = db.query(`UPDATE points SET point_id = ?, uploaded_at = NULL WHERE rowid = ?`);
        let changed = 0;
        for (const r of rows) {
          const id = pointIdOf(r.tag, r.ref, r.seq);
          if (id === r.point_id) continue;
          q.queueDelete.run(r.point_id, at);
          q.unqueueDelete.run(id);
          set.run(id, r.rid);
          changed++;
        }
        if (rows.length) q.setState.run(REDERIVE_KEY, String(rows.at(-1)!.rid));
        return { checked: rows.length, changed };
      })();
    },

    uploadedPoints(tag, afterChunkId, limit) {
      return db
        .query(`SELECT point_id AS pointId, chunk_id AS chunkId FROM points WHERE tag = ? AND uploaded_at IS NOT NULL AND chunk_id > ? ORDER BY chunk_id LIMIT ?`)
        .all(tag, afterChunkId, limit) as Array<{ pointId: string; chunkId: number }>;
    },

    unmarkPoints(pointIds) {
      const stmt = db.query(`UPDATE points SET uploaded_at = NULL WHERE point_id = ?`);
      db.transaction(() => {
        for (const id of pointIds) stmt.run(id);
      })();
    },

    pointsToUpload(tag, limit) {
      const rows = db
        .query(
          `SELECT p.point_id, p.chunk_id, v.vec, s.kind, s.project, s.at
           FROM points p JOIN chunks c ON c.id = p.chunk_id JOIN sources s ON s.ref = c.ref
             JOIN vectors v ON v.text_hash = c.text_hash AND v.tag = p.tag
           WHERE p.tag = ? AND p.uploaded_at IS NULL ORDER BY p.chunk_id LIMIT ?`,
        )
        .all(tag, limit) as Array<{ point_id: string; chunk_id: number; vec: Uint8Array; kind: HistoryKind; project: string | null; at: number }>;
      return rows.map((r) => ({
        pointId: r.point_id, chunkId: r.chunk_id, vector: fromBlob(r.vec), kind: r.kind,
        ...(r.project !== null ? { project: r.project } : {}), at: r.at,
      }));
    },

    markUploaded(pointIds, at) {
      const stmt = db.query(`UPDATE points SET uploaded_at = ? WHERE point_id = ?`);
      db.transaction(() => {
        for (const id of pointIds) stmt.run(at, id);
      })();
    },

    clearUploadMarks(tag) {
      return db.query(`UPDATE points SET uploaded_at = NULL WHERE tag = ? AND uploaded_at IS NOT NULL`).run(tag).changes;
    },

    pointIdsOfTag(tag) {
      return (db.query(`SELECT point_id FROM points WHERE tag = ? ORDER BY chunk_id`).all(tag) as Array<{ point_id: string }>).map((r) => r.point_id);
    },

    countUploaded(tag) {
      return (db.query(`SELECT count(*) AS n FROM points WHERE tag = ? AND uploaded_at IS NOT NULL`).get(tag) as { n: number }).n;
    },

    dropTag(tag) {
      return db.transaction(() => {
        const points = (db.query(`SELECT point_id FROM points WHERE tag = ? ORDER BY chunk_id`).all(tag) as Array<{ point_id: string }>).map((r) => r.point_id);
        db.query(`DELETE FROM points WHERE tag = ?`).run(tag);
        const vectors = db.query(`DELETE FROM vectors WHERE tag = ?`).run(tag).changes;
        return { points, vectors };
      })();
    },

    coverage(tag) {
      const chunks = (db.query(`SELECT count(*) AS n FROM chunks`).get() as { n: number }).n;
      const uploaded = (db.query(`SELECT count(*) AS n FROM points WHERE tag = ? AND uploaded_at IS NOT NULL`).get(tag) as { n: number }).n;
      return { chunks, uploaded, ratio: chunks === 0 ? 1 : uploaded / chunks };
    },

    queueDeletes(pointIds, at) {
      db.transaction(() => {
        for (const id of pointIds) q.queueDelete.run(id, at);
      })();
    },

    pendingDeletes(limit) {
      return (db.query(`SELECT point_id FROM pending_deletes ORDER BY at, rowid LIMIT ?`).all(limit) as Array<{ point_id: string }>).map((r) => r.point_id);
    },

    clearPendingDeletes(pointIds) {
      const stmt = db.query(`DELETE FROM pending_deletes WHERE point_id = ?`);
      db.transaction(() => {
        for (const id of pointIds) stmt.run(id);
      })();
    },

    countPendingDeletes() {
      return (db.query(`SELECT count(*) AS n FROM pending_deletes`).get() as { n: number }).n;
    },

    addRemembered(r) {
      const textHash = hashText(r.text.trim());
      return db.transaction(() => {
        const dup = db.query(`SELECT id FROM remembered WHERE text_hash = ? AND project IS ?`).get(textHash, r.project ?? null) as { id: number } | null;
        if (dup) return { id: dup.id, duplicate: true };
        const id = Number(
          db
            .query(`INSERT INTO remembered (text, project, by, cause, at, text_hash) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(r.text, r.project ?? null, r.by, r.cause ?? null, r.at, textHash).lastInsertRowid,
        );
        return { id, duplicate: false };
      })();
    },

    getRemembered(id) {
      const r = db.query(`SELECT id, text, project, by, cause, at FROM remembered WHERE id = ?`).get(id) as
        | { id: number; text: string; project: string | null; by: string; cause: string | null; at: number }
        | null;
      if (!r) return undefined;
      return { id: r.id, text: r.text, ...(r.project !== null ? { project: r.project } : {}), by: r.by, ...(r.cause !== null ? { cause: r.cause } : {}), at: r.at };
    },

    deleteRemembered(id) {
      return db.query(`DELETE FROM remembered WHERE id = ?`).run(id).changes > 0;
    },

    addTombstone(ref, reason, at) {
      db.query(`INSERT INTO tombstones (ref, reason, at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET reason = excluded.reason, at = excluded.at`).run(ref, reason, at);
    },

    tombstoned(refs) {
      if (!refs.length) return new Set();
      const rows = db.query(`SELECT ref FROM tombstones WHERE ref IN (SELECT value FROM json_each(?))`).all(JSON.stringify(refs)) as Array<{ ref: string }>;
      return new Set(rows.map((r) => r.ref));
    },

    countParagraphs(hashes) {
      const stmt = db.query(`INSERT INTO boilerplate (hash, rows) VALUES (?, 1) ON CONFLICT(hash) DO UPDATE SET rows = rows + 1`);
      db.transaction(() => {
        for (const h of new Set(hashes)) stmt.run(h);
      })();
    },

    boilerplate(minRows) {
      return new Set((db.query(`SELECT hash FROM boilerplate WHERE rows >= ?`).all(minRows) as Array<{ hash: string }>).map((r) => r.hash));
    },

    getState(key) {
      return (q.getState.get(key) as { value: string } | null)?.value;
    },

    setState(key, value) {
      q.setState.run(key, value);
    },

    takeLock(pid, now) {
      // IMMEDIATE: two processes never both read "free" and both write.
      return db.transaction((): LockResult => {
        const held = lockHolder();
        if (held && held.pid !== pid && now - held.at < lockStaleMs) return { ok: false, pid: held.pid, at: held.at };
        q.setState.run(LOCK_KEY, JSON.stringify({ pid, at: now }));
        return { ok: true };
      }).immediate();
    },

    lockHolder,

    releaseLock(pid) {
      if (lockHolder()?.pid === pid) db.query(`DELETE FROM state WHERE key = ?`).run(LOCK_KEY);
    },

    close() {
      db.close();
    },
  };
}
