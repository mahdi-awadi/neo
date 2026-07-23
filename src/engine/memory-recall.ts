// FTS5-backed recall index over the daily log — cited search (every hit carries file + day).
// One bun:sqlite database per memory folder at `<folder>/memory/index.sqlite`, following the
// same bun:sqlite idioms as ledger.ts (Database, db.query(...).run/.all/.get).
//
// File-path convention (citations): indexFile/indexLine take an ABSOLUTE path, but `file` is
// STORED relative to the memory folder (e.g. "log/2026-07-01.md") — so a citation stays valid
// across machines/checkouts and doesn't leak the host filesystem layout back to a worker.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { memoryDir } from "./memory";

export interface MemoryHit {
  content: string;
  file: string;
  day: string;
}

export interface MemoryIndex {
  /** bm25-ranked search, newest-day tiebreak. Every result carries file + day (the citation).
   * FTS syntax errors (malformed operator queries) fail open to []. */
  search(query: string, limit: number): MemoryHit[];
  /** (Re-)indexes a file's non-empty lines as rows tagged with `day`. `path` is absolute.
   * Deletes any existing rows for that file first, so re-indexing never duplicates. */
  indexFile(path: string, day: string): void;
  /** Indexes a single already-scanned line (used by appendDailyLog's incremental update) without
   * touching other rows for that file — callers are responsible for not double-inserting.
   * `path` is absolute, same convention as indexFile. */
  indexLine(path: string, day: string, line: string): void;
}

// Module-level cache of open Database handles, keyed by the memory folder's canonical (realpath)
// path — repeated openMemoryIndex(folder) calls for the same folder must reuse one handle rather
// than leaking a new sqlite connection per call.
const indexCache = new Map<string, MemoryIndex>();

function canonical(folder: string): string {
  try {
    return realpathSync(resolve(folder));
  } catch {
    return resolve(folder);
  }
}

/** Converts an absolute path into the citation form stored in `file`: relative to the memory
 * folder (e.g. "log/2026-07-01.md"). Callers of indexFile/indexLine always pass absolute paths. */
function toCitationPath(folder: string, absolutePath: string): string {
  return relative(memoryDir(folder), absolutePath);
}

/** Wraps a free-text query so FTS5 operator characters (AND/OR/NEAR/quotes/parens/-) can never
 * produce a syntax error: each whitespace-separated token is quoted individually (doubling any
 * embedded quote, SQLite's own escape for a literal `"` inside a quoted string) and the quoted
 * tokens are joined with spaces, which FTS5 treats as an implicit AND over literal-string matches.
 * An empty/whitespace-only query becomes an empty quoted string, matching nothing. */
function safeFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/** Opens (or reuses) the FTS5 recall index for a memory folder, creating `index.sqlite` and its
 * `mem` virtual table if needed. Handles are cached per canonical folder path (module-level Map)
 * so repeated opens never leak a new sqlite connection. */
export function openMemoryIndex(folder: string): MemoryIndex {
  const key = canonical(folder);
  const cached = indexCache.get(key);
  if (cached) return cached;

  const dir = memoryDir(folder);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "index.sqlite"));
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(content, file, day)`);

  const index: MemoryIndex = {
    search(query, limit) {
      try {
        return db
          .query(
            `SELECT content, file, day FROM mem
             WHERE mem MATCH ?
             ORDER BY bm25(mem), day DESC
             LIMIT ?`,
          )
          .all(safeFtsQuery(query), limit) as MemoryHit[];
      } catch {
        // Fail open: a query FTS5 can't parse (or any other sqlite error) returns no hits rather
        // than throwing into the caller (a worker's free-text recall query is untrusted input).
        return [];
      }
    },
    indexFile(path, day) {
      const file = toCitationPath(folder, path);
      db.query(`DELETE FROM mem WHERE file = ?`).run(file);
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch {
        return; // nothing to index
      }
      const insert = db.query(`INSERT INTO mem (content, file, day) VALUES (?, ?, ?)`);
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        insert.run(line, file, day);
      }
    },
    indexLine(path, day, line) {
      const file = toCitationPath(folder, path);
      db.query(`INSERT INTO mem (content, file, day) VALUES (?, ?, ?)`).run(line, file, day);
    },
  };

  indexCache.set(key, index);
  return index;
}
