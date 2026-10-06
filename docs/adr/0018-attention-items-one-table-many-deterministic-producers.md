# Attention items: one table, many deterministic producers

**Status:** proposed (2026-10-06)

The operator wants one "needs attention" list per project — GitHub state (unpushed work, PRs, failed
CI, stale branches, drift, issues, security alerts), leftover worktrees, stuck approvals, spinning
dispatches, unexecuted plans, restart-gated fixes — plus a daily digest and one tap to make a todo.
These are all facts that code can read. So there is one `attention_items` table keyed by
`(project, kind, key)`, and a set of **producers**, one per source (`git`, `github`, `engine`,
`plan`, `restart`). Each producer returns the items it sees now; one reconcile step inserts new
ones, refreshes `last_seen`, resolves the ones that went away, and reopens ones that came back. A
producer that fails changes nothing (no false "resolved"). GitHub is read by polling `gh … --json`
on a heartbeat step, one project at a time, with a timeout.

Restart-gated work is one producer: the daemon records its HEAD sha at boot, and the producer lists
what differs (commits after boot, unmerged fix branches, updater results that need a restart). It
replaces the hand-kept memory notes.

## Considered options

- **A separate list per source** (a GitHub page, a worktree page, …). Rejected: the operator asked for
  *one* list, and the digest, one-tap todo, snooze and resolve logic would be written five times.
- **An AI triage loop** that reads repos and writes a summary. Rejected: the engine holds no AI, a
  loop costs subscription headroom every day, and its output cannot be diffed or resolved.
- **GitHub webhooks.** Rejected for now: each repo would need a hook and a public endpoint, and
  polling ~15 repos every 30 minutes with ~6 calls each is under 200 API calls an hour, far under
  GitHub's 5,000-an-hour limit for an authenticated user.
- **Store raw GitHub data and compute views from it.** Rejected: we need the items, not a mirror.
