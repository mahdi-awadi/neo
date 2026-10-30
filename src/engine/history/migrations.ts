// The `history.db` schema (ADR-0066, spec "Data"). Numbered like the ledger's and run by the same
// `migrate()` (with its `.bak-v<N>` copy): a change is a new entry here, never an edit to an old one.
import type { Database } from "bun:sqlite";
import type { Migration } from "../ledger-migrations";

function base(db: Database): void {
  // One row per indexed source (a todo, an order, a result, a plan, …). `meta` is JSON: todo, order,
  // thread, path, commits, fileMissing, cut. `gone_at`: the ledger no longer has the row (archived).
  db.run(
    `CREATE TABLE sources (
       ref TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT, at INTEGER NOT NULL,
       title TEXT NOT NULL, hash TEXT NOT NULL, meta TEXT NOT NULL,
       gone_at INTEGER, indexed_at INTEGER NOT NULL
     )`,
  );
  // The original chunk text (display only); its normalized copy and Arabic stems live in chunks_fts.
  db.run(
    `CREATE TABLE chunks (
       id INTEGER PRIMARY KEY, ref TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL,
       text_hash TEXT NOT NULL, flags INTEGER NOT NULL DEFAULT 0, UNIQUE (ref, seq)
     )`,
  );
  // rowid = chunks.id. Contentless with delete support: the text is stored once, in chunks.
  db.run(
    `CREATE VIRTUAL TABLE chunks_fts USING fts5(body, stems, content='', contentless_delete=1,
       tokenize='porter unicode61 remove_diacritics 2')`,
  );
  // float32, one per text and model tag: the same text under two refs is embedded once.
  db.run(
    `CREATE TABLE vectors (
       text_hash TEXT NOT NULL, tag TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (text_hash, tag)
     ) WITHOUT ROWID`,
  );
  // One Qdrant point per chunk and tag; `uploaded_at` NULL = still to send.
  db.run(
    `CREATE TABLE points (
       chunk_id INTEGER NOT NULL, tag TEXT NOT NULL, point_id TEXT NOT NULL UNIQUE,
       uploaded_at INTEGER, PRIMARY KEY (chunk_id, tag)
     )`,
  );
  db.run(`CREATE TABLE pending_deletes (point_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
  db.run(
    `CREATE TABLE remembered (
       id INTEGER PRIMARY KEY, text TEXT NOT NULL, project TEXT, by TEXT NOT NULL,
       cause TEXT, at INTEGER NOT NULL, text_hash TEXT NOT NULL
     )`,
  );
  db.run(`CREATE TABLE tombstones (ref TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE boilerplate (hash TEXT PRIMARY KEY, rows INTEGER NOT NULL)`);
  // The feed cursor, the reconcile position, the active tag, the writer lock.
  db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`CREATE INDEX sources_kind_at ON sources (kind, at)`);
  db.run(`CREATE INDEX sources_project_at ON sources (project, at)`);
  db.run(`CREATE INDEX chunks_text_hash ON chunks (text_hash)`);
  db.run(`CREATE INDEX points_tag_uploaded ON points (tag, uploaded_at)`);
  // The duplicate check of `remember` (not in the spec's list; it keeps that check off a table scan).
  db.run(`CREATE INDEX remembered_hash ON remembered (text_hash, project)`);
}

function boilerplateRecount(db: Database): void {
  // The paragraph counts of a reconcile in progress; they replace `boilerplate` when the count ends, so a
  // recount (weekly, or a first count restarted) never adds to the old counts and never shows half of them.
  db.run(`CREATE TABLE boilerplate_next (hash TEXT PRIMARY KEY, rows INTEGER NOT NULL)`);
}

export const HISTORY_MIGRATIONS: Migration[] = [
  { version: 1, name: "task history", up: base },
  { version: 2, name: "boilerplate recount", up: boilerplateRecount },
];
