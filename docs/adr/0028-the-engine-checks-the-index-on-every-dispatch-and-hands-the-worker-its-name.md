# The engine checks the index on every dispatch and hands the worker its name

**Status:** accepted (2026-10-09) · amends the 2026-07-21 dispatch-mandatory-codebase-memory design.

Workers kept reporting that codebase-memory had no index for their project. On eticket-v3 (todo
#132) only `home-eticket-v3-ui-agency-ui` was listed, so the worker indexed the repo itself. The
operator saw the same on every project.

## Root cause (evidence, 2026-10-09)

1. **The binary loses index DBs.** codebase-memory-mcp 0.8.1 writes a whole new DB file when any
   file changed: on a scratch repo, one changed file gave the DB a new inode. The process also
   crashes. `coredumpctl` shows 11 SIGABRT dumps of the binary since 2026-10-05, all inside
   `neo.service`, two of them with 75 MB and 111 MB heaps. Index files the engine had logged as
   indexed (`/home/prod-ops`, `/home/neo/agent/desks/research`) no longer exist in
   `~/.cache/codebase-memory-mcp/`. `home-eticket-v3` was listed on 2026-10-08 and missing on
   2026-10-09 until the worker rebuilt it at 10:11.
2. **The engine checked once per daemon lifetime.** `makeIndexer` cached "indexed" for each folder
   on its first check and never looked again. A DB lost after that stayed lost for every later
   dispatch until a restart. The same cache meant the engine never refreshed a stale index:
   `/var/log/neo.log` shows only "indexing / indexed" pairs, never a refresh.
3. **The preamble did not name the project.** It told the worker to `list_projects` and match
   `root_path` itself. When the DB was missing, the worker saw no match and indexed the repo
   itself, or fell back to reading files.

## Decision

- **Check on every dispatch.** `ensureIndexed` calls `list_projects` each time (0.2–0.5 s). There is
  no "already indexed" cache. Concurrent dispatches to one folder share one run.
- **Index a missing folder. Refresh a stale one.** "Stale" means the folder's git HEAD differs from
  the HEAD the engine last indexed it at. That HEAD is stored in the ledger's `meta` table
  (`cbm:<folder>`), so a restart does not re-index everything. A folder with no record is refreshed
  once. The binary's own file hashes make an unchanged repo cheap (0.04 s on /home/neo). A folder
  that is not a git repo has no freshness signal and is indexed only when missing.
- **Hand the worker the exact name.** `ensureIndexed` returns `{ project }`, read back from
  `list_projects` after indexing, never derived by the engine. Dispatch prepends one line,
  `codebaseMemoryLine`, to the brief: "indexed this project as `<name>` (fresh at its HEAD) … Do NOT
  call `list_projects`, `index_status` or `index_repository`". If no index could be made, the line
  says to read files and not to try to index.
- **Worktrees use the main project's index.** A worker that makes a worktree is told to use the same
  index for structure and to read the files it changed directly. A dispatch whose folder is itself a
  worktree is indexed under the name the binary gives that path.

## Considered options

- **Keep the cache and invalidate it on a timer.** Rejected. A lost DB is still invisible until the
  timer fires, and the check it saves costs well under a second.
- **Re-index on every dispatch.** Rejected. On eticket-v3 a rebuild takes about 36 s and writes a new
  326 MB file. Doing that per dispatch also gives the crash more chances to lose the DB.
- **Freshness on uncommitted changes too.** Rejected. The worker's own uncommitted work changes
  constantly, so every dispatch would rebuild. The index maps committed code; the worker reads its
  own changes directly.
- **Derive the name from the path (`/home/x` → `home-x`).** Rejected. That is the binary's private
  rule. Reading the name back from `list_projects` cannot drift from it.
- **Index each worktree under its own name.** Rejected as the default. Each one would add a
  100–300 MB DB (`home-mirshad-.claude-worktrees-devqa` is 97 MB). Worktree folders are temporary
  (CLAUDE.md), and their DBs outlive them.
- **Upgrade codebase-memory-mcp to 0.11.0** to stop the crashes. Not decided here: the updater holds
  it because its release notes flag a breaking change. That is the operator's call (`/updates apply
  codebase-memory-mcp`). This ADR makes the engine correct whichever version runs.

## Consequences

- The first dispatch to a project after its HEAD moved waits for the refresh. On eticket-v3 that is
  about 36 s, before the stall clock starts.
- The preamble shrank by about 700 characters; the name line is about 520.
- Restart-gated: the running daemon keeps the old once-per-lifetime cache until it restarts.
