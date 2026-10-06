# A thread is the unit the operator tracks, and its state is derived from its facts

**Status:** proposed (2026-10-06)

The operator wants each message and its responses grouped into a conversation with a state: open,
waiting on the operator, or done. A **thread** starts at one operator message (or one engine
trigger) and holds everything that message caused: replies, dispatches, progress, results, todos,
decisions, plans and follow-ups. Its **state** (`open | waiting | done | failed`) is stored on the
`threads` row for fast lists, but only one function writes it: `refreshThread` reads the linked
facts (open decisions, pending approvals, active todos/turns, the newest end) and applies the pure
`deriveThreadState`. Waiting on the operator beats active work. The operator may close a thread;
a new message in it reopens it.

A message joins a thread only by an explicit link: a Telegram reply to a known message, or the web
composer inside a thread. Anything else starts a new thread. No time window and no text matching.

## Considered options

- **Make every direct turn to a project a todo** (to fix "a request went to a project directly and
  never got a todo"). Rejected: a todo is a dispatched brief in a queue (ADR-0008). Two units for
  "what happened to X" would drift apart. The thread covers both direct turns and dispatches.
- **State set by whoever touches the thread.** Rejected: many writers drift. ADR-0003 already chose
  "derive, don't store" for session state; this keeps that, with a stored copy for list speed.
- **Derive state on every read.** Rejected for lists: one page of 50 threads would run 50 fact
  queries. The stored copy is refreshed on each write instead.
- **Join threads by time window ("same project within 10 minutes").** Rejected: a guess. Wrong
  joins hide a request inside an unrelated thread, which is the failure we are fixing.
- **An AI summary of each thread's state.** Rejected: the engine holds no AI, and every fact the
  state needs is already in the ledger.
