# Console history is paged from the ledger; the live feed stays a bounded window

**Status:** proposed (2026-10-06) · amends the console-feed ADR (`fix/console-feed-window`,
renumbered 0014 at merge)

The console-feed ADR bounded the SSE replay and rejected "persist the feed and page through it",
because a second store would duplicate the ledger. That still holds. What is new: the operator wants
history by project and thread, with search. That history is **already** in the ledger (`messages`,
now with ids and threads, ADR-0015). So the console reads it with keyset-paged JSON endpoints
(`/api/threads`, `/api/threads/:id`, `/api/search`, `before=<id>`, at most 100 rows), and search uses
an FTS5 index over `messages`. The SSE feed is still only the live window; its events now carry
`msgId`/`threadId`, plus a small `thread` event when a thread's state changes.

## Considered options

- **Replay more feed into the page.** Rejected: that is the freeze the console-feed ADR fixed.
- **Load all threads, filter in the browser.** Rejected: unbounded, the same failure in a new place.
- **A separate search service.** Rejected: SQLite FTS5 is already in use (`memory-recall.ts`) and is
  enough for one operator's history.
