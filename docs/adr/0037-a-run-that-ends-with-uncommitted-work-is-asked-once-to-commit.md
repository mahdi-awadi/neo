# A run that ends with uncommitted work is asked once to commit

**Status:** accepted (2026-10-15) · extends ADR-0007 (settled end), ADR-0008/0027 (todo queue),
ADR-0021/0029 (handoffs) and ADR-0034 (a repository is its git common dir).

On gold, 2026-10-12 … 10-14, nine dispatched runs ended on their `/security-review` step. The
review's output became the worker's final message and the build was left uncommitted. The next
queued todo then started in the same folder, on top of the uncommitted files. The chief of staff
verified and committed each one by hand (`0890f14`, `f55c935`, `50696c9`, `a49719c`, `835f362`, …).
"Commit before you finish" in the brief did not help. The engine already saw the files: it raised a
`dirty` attention item and said "left N uncommitted files" — but only after the run had ended and
the next todo had started.

## Decision

### 1. The check happens at the settled end, inside the same run
A dispatch closes its run when the session is **settled** (ADR-0007). At that moment the engine now
reads `git status` for the folder. If the run's own changes are not empty, it does NOT close the
run. It sends ONE fixed follow-up into the same, still-open session:

> Your run ended with uncommitted changes: <files>. Finish now: run the project's checks that
> apply, then commit your work with a clear message (never `--no-verify`), or, if a change must not
> be committed, say why. Then end.

When the session settles again, the run closes as before. One follow-up per run, never two. This is
the **commit finish**.

It is the same session, the same governor, the same stall limit and the same operator stream. The
todo stays `running`, so the folder stays busy and its next todo cannot start.

### 2. Only the run's own changes count
Before the worker starts, the engine records the folder's dirty paths and a fingerprint of each
(size + mtime, or "gone"). At the end, a path counts only if it is new, or its fingerprint changed.
So an operator's own local edit (for example `/home/neo`'s `.gitignore`) never makes a worker commit
it. Paths that match `commitFinish.ignore` (Bun globs, repo-relative) never count: by default the
handoff notes (`HANDOFF.md`, `**/HANDOFF.md`, `data/handoffs/**`).

### 3. Skipped when it would be wrong
No commit finish when: the turn ended on an API error; the engine is draining; the stall wrap-up or
the spin wrap-up was already sent; a context checkpoint is armed (ADR-0021 owns that end); or the
session waits on the operator (a held plan, an open decision — that run continues later, ADR-0029).

### 4. Other worktrees of the same repository wait too
While a commit finish runs, the repository is held, keyed by its git common dir (ADR-0034). A
queued todo for any worktree of that repository waits ("finishing a commit") and is released when
the commit finish ends. Its own folder is busy anyway.

### 5. The result says what happened
The final result keeps the worker's FIRST end (its summary and its ok). The commit-finish turn only
adds one line:
- `committed by resume: <sha> <subject>` — clean and HEAD moved.
- `cleaned by resume (nothing committed)` — clean, HEAD did not move.
- `still uncommitted after one resume: <files>` — the operator also gets an alert, and the queue's
  existing `dirty` attention item is raised.

A stall during the commit-finish turn does not turn the finished task into a transient end: the
work was done; the result says it is still uncommitted.

### 6. Config
`commitFinish: { enabled: true, ignore: [...] }`. `enabled: false` turns it off. A bad value fails
closed to the default.

## Rejected
- **A stronger brief.** Tried; nine runs ignored it. Brief text is not a guarantee.
- **The engine commits the files itself.** The engine has no AI and cannot judge if the work is green
  or wanted, and it would author commits nobody reviewed.
- **A new todo ("commit what is left") at the head of the queue.** It starts a fresh session that has
  lost the context of what it built, and the run's result would already have gone out as "done".
- **Resume the session after the run closed (a second `query({ resume })`).** It needs the whole run
  set-up a second time. The open run already has every handler; one follow-up is enough.
- **Block the next todo until the folder is clean, with no resume.** It stalls the queue on work
  that nobody is asked to finish.
