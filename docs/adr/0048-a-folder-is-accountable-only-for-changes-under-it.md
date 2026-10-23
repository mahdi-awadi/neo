# A folder is accountable only for the changes under it

**Status:** accepted (2026-10-23; built on `dev`, restart-gated). Amends ADR-0021 (uncommitted work
read from git) and the todo `dirty` check (spec §8.6). Affects ADR-0037 (commit finish).

The ops and research desks raised high attention items #248 and #173: "1 uncommitted file after
todo #547/#548 · files: HANDOFF.md". Neither desk had changed anything.

## Root cause

A desk lives at `/home/neo/agent/desks/<desk>`. That folder is inside the `/home/neo` repo, under the
gitignored `/agent/`. `git status --porcelain` lists the **whole** repo's changes, with paths from the
repo root. `uncommittedFrom` (`src/engine/git-read.ts`) removed only the folder's own note
(`agent/desks/ops/HANDOFF.md`). It kept every other path, so the root `HANDOFF.md` that sat
uncommitted in `/home/neo` was charged to each desk. The same rule feeds the context checkpoint, the
handoff gate, the commit finish, the git producer and the project view.

## Decision

1. **Only paths under the folder count.** `uncommittedFrom(porcelain, prefix)` keeps a path only if
   it starts with the folder's `--show-prefix`. The repo root has prefix `""`, so a root project is
   unchanged.
2. **An ignored folder is not under version control.** `uncommittedIn` returns `undefined` when
   `git check-ignore -q .` says the folder is ignored. Every caller already reads `undefined` as "not
   a git repo": no `dirty` item, no checkpoint, no commit finish, empty `gitFacts`.

## Rejected

- **Scope only the todo `dirty` check.** That makes two rules for "uncommitted work". The other
  callers have the same bug. For example, a commit finish on a desk would ask the desk worker to commit
  `/home/neo`'s changes, which is another project's work.
- **Run `git status -- .`** (a pathspec). It gives the same answer for the sync reader, but the git
  producer and the project view parse status output they already hold. Filtering in the one parser
  fixes every caller.
- **Skip desks by path (`/agent/desks/`).** That hardcodes a layout. The ignore rule is the real fact.

## Consequences

- A project that is a sub-folder of a larger repo no longer sees, or is asked to commit, changes made
  elsewhere in that repo.
- #248 and #173 are resolved in the live ledger. They would not be raised again once the daemon runs
  `dev`.
