# Scratch and own memory are write roots of the fence

**Status:** accepted (2026-10-04)

The path fence escalated every Write/Edit outside the session folder. Two classes of these were
routine and the operator approved them every time: scratch files under `/tmp/`, and a session's
own Claude Code auto-memory (`~/.claude/projects/<encoded folder>/memory/`). The operator ordered
them auto-allowed.

## Decision

1. **Extend the one fence.** `decide` in `src/engine/governor.ts` allows a fenced write when the
   target is inside the folder (as before) or inside a **write root**. No second fence.
2. **Roots come from config.** `governor.writeRoots` (default `["/tmp", "{ownMemory}"]`). An entry
   is an absolute directory, or the token `{ownMemory}`, which the engine expands per session to
   that session's own memory dir. The encoding is Claude Code's: each non-alphanumeric character of
   the folder path becomes `-`. The config dir comes from `CLAUDE_CONFIG_DIR`, else `~/.claude`.
3. **Match on real paths.** The target is resolved (`..` removed), then its nearest existing
   ancestor goes through `realpath`. It must be strictly inside the root's real path. A root whose
   real path differs from its resolved path (a symlink anywhere in it) is ignored, because a
   worker could otherwise point a symlinked root at `/etc`. Fail closed.
4. **Own work only.** `profileDeps` gives the roots to every launch path except `ingress`
   (customer-driven work). `sdkOptions` also drops them when the order source is `customer`.
   Tainted briefs keep zero tools. Block rules and trust are unchanged: a write outside the folder
   and outside every root is still a fence escalation.

## Considered options

- **A hardcoded allow list of the four paths the operator approved.** Rejected: it does not
  generalise, and it would hardcode host paths.
- **Two keys (`scratchRoots` + `ownMemory: boolean`).** Rejected: one list is simpler to read and
  to turn off (`[]`); the token makes the per-session part explicit.
- **Also realpath the in-folder check.** Not done here. It would change which writes inside
  existing projects escalate (for example through `node_modules` workspace links). It is a separate
  decision.

## Consequences

- `/tmp` is shared on the host. A symlink planted in `/tmp` is caught at decision time, but the
  check and the write are not atomic (time-of-check to time-of-use). This is accepted for
  scratch files; Bash can already write to `/tmp` without asking.
- Restart-gated: the running daemon keeps the old fence until it restarts.
