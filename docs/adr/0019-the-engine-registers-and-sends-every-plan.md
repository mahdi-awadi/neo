# The engine registers and sends every plan

**Status:** proposed (2026-10-06)

Operator default (2026-10-06): every plan goes to the operator as a file in Telegram for review.
Today a worker sends it only if its brief says so, and plans then sit with no status. So the engine
does it: at the end of every run it lists the files under the configured **plan paths** that changed
since the run's start HEAD (git diff + untracked files), registers each in a `plans` table (path,
title, content hash, checkbox steps, thread), and sends any content hash it has not sent before,
with Approve / Changes / Execute buttons. The send is a tracked decision, so it is reminded and
answerable by reply. The dispatch preamble tells workers where to write plans and that they may also
`send_file` them; both paths go through the registry, so each version reaches the operator once.
Plan status (`draft → sent → approved → executing → done | abandoned`) moves only on operator taps
and on deterministic facts (an Execute todo, its end, the checkbox count).

## Considered options

- **Rely on the preamble alone.** Rejected: a brief can be a loop's standing brief (never wrapped)
  or an interactive turn (no preamble), and a worker can forget. The default must hold in code.
- **A filesystem watcher (inotify) over every repo.** Rejected: many repos and deep trees, events
  for half-written files, and it fires for edits nobody ran through Neo. Run end is the moment the
  file is final and the thread is known.
- **Send on every change.** Rejected: a worker that edits a plan ten times in one run would send ten
  files. One send per content hash at run end.
