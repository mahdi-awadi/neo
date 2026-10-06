# The console feed is a bounded window, resumed by event id

**Status:** accepted (2026-10-06)

The web console froze. The web channel kept every feed event since the daemon started, in memory,
and replayed all of them to each new SSE connection. After 32 h of uptime that was 9,729 events
(3.6 MB) per page load. The page then appended each one with a full scan of every feed node and a
forced layout (`scrollTop = scrollHeight`), so the work grew with the square of the history. A fresh
browser profile showed a 50 s long task, 14.8 s of layout, and a page that did not answer for
minutes. An EventSource reconnect replayed the full history again, so the feed also doubled.

## Decision

1. **The engine keeps only a replay window** of the newest feed events (`webFeedWindow`, default
   500). Older events drop out. Pending escalations are always replayed, even when they are older
   than the window, and an answered escalation is never replayed as answerable.
2. **Every feed event has an increasing id**, sent as the SSE `id:`. A reconnect sends
   `Last-Event-ID` (the browser does this itself) and gets only the later events in the window.
3. **The page keeps the same window** of feed rows and does O(1) work per event: it styles only the
   new row and scrolls at most once per animation frame.

## Considered options

- **Persist the feed and page through it.** Rejected: the feed is a live view. The ledger and
  Telegram already keep the record; a second store would duplicate it.
- **Fix only the page (virtualize the list).** Rejected: the server would still send 3.6 MB per
  connect and keep an array that grows for the life of the daemon.
- **A time-based window (e.g. last 6 h).** Rejected: a busy hour can still be thousands of events;
  a count bounds the cost directly.
