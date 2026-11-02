# Markdown file links in the console — design (ADR-0046)

A small change: one server seam, one route, one browser module. Built on, no approval gate.

## Interface

- `src/engine/md-file.ts`
  - `readMdFilesCfg(raw, workRoot): MdFilesCfg` — `{ roots: string[]; maxBytes: number }`.
  - `resolveMdFile(path, cfg): { ok: true; bytes; name; real } | { ok: false; status; reason; real? }`.
- `GET /md-file?path=<absolute path>` in `src/frontends/web.ts`, behind the admin session.
- `src/frontends/web/md-links.ts`
  - `findMdPaths(text): Array<{ start; end; path }>` (pure).
  - `linkMdPaths(root, label)` (DOM pass, run with the code-block enhancer).

## Acceptance criteria

1. A regular `.md` file (any case of `.md`) inside a readable root downloads: 200, the file bytes,
   `text/markdown; charset=utf-8`, `attachment` with a safe file name, `nosniff`, `no-store`,
   CORP `same-origin`.
2. No session → 401, and nothing is read.
3. Outside every root → 403. A symlink inside a root that points outside → 403.
4. Not `.md` → 403. A symlink named `x.md` that points to a non-`.md` file → 403.
5. `.env*`, a hidden segment (`.git`, `.claude`, `.ssh`), a `..` or `.` segment, a relative path,
   a NUL → refused (400 or 403).
6. A missing file → 404. A directory named `x.md` → 404.
7. Larger than `mdFiles.maxBytes` → 413.
8. Every request with a session records a ledger event `md_file` (asked path, real path, outcome,
   uid, session hash).
9. The browser finds absolute `.md` paths in plain text and in inline code, and not in URLs, not
   with a `..` or hidden segment, not `x.md.bak`. Sentence punctuation after the path is not part
   of it. Arabic letters in a path are allowed.
10. Link title from the catalogue (`files.download`), AR and EN. The link is `dir="ltr"`.

## Edge cases

- A configured root that does not exist is skipped. No valid root → every path is refused.
- A bad `mdFiles` value in config keeps the default (a bad value never opens the fence).
- The route answers 400 when `path` is missing.
