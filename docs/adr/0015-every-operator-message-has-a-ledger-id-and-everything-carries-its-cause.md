# Every operator message has a ledger id, and everything it causes carries that cause

**Status:** proposed (2026-10-06)

The operator asked "what happened to X?" several times this week. The engine could not answer:
`messages` has no id and no link, a dispatch only knows the company's *first* order, and a todo,
decision or result cannot be traced back to the line that caused it. So every operator message now
gets an integer id in the ledger (shown as a short base36 ref, `m4f2`), and every artifact — Neo's
reply, order, todo, decision, tool action, dispatch event, dispatch result, file, plan — stores a
**cause**: the message id and its thread id. The cause is set once where work starts and is copied,
never guessed again.

## Decision

1. **Ids live in the ledger.** `messages` is rebuilt with `id INTEGER PRIMARY KEY AUTOINCREMENT`
   (the implicit rowid can change on `VACUUM`, so it is not an id). The ledger moves to numbered
   migrations (`PRAGMA user_version`, the pattern `trust.ts` already uses) with a `VACUUM INTO`
   backup before the first pending migration.
2. **Cause columns, not a link table.** `orders`, `project_todos`, `decisions`, `dispatcher_inbox`,
   `message_routes` and `events` get `cause_msg_id`/`thread_id` (or `msg_id`). Each is indexed.
3. **The registry holds the current cause of each session.** It changes when a brief is pushed and
   when a turn ends. In-process tools (`dispatch`, `todo`, `ask_operator`, `send_file`) read it at
   call time, so a dispatch made in turn 40 of the company session carries turn 40's message.
4. **Attribution is per turn.** Output belongs to the newest message delivered to the session whose
   turn has not ended. If the CLI merges two queued messages into one turn, the reply files under
   the later one and both are marked answered. We accept this limit; it never drops a message.
5. **Every thread has a root.** Background work (loop fire, scheduler dispatch, attention todo,
   ingress) creates a root of its own, so no new artifact has a NULL cause.

## Considered options

- **A generic `links(from, to, rel)` edge table.** Rejected: no foreign-key shape, every query is a
  recursive join, and it duplicates the `order_id` links that already exist.
- **`AsyncLocalStorage` to carry the cause.** Rejected: worker output comes from an SDK stream, not
  from the call stack that pushed the message, so the context is lost exactly where it is needed.
- **Telegram's `message_id` as the id.** Rejected: it exists only on Telegram, is per chat, and the
  web console has none.
- **UUIDs.** Rejected for display: an operator cannot type or read `3f2a…` on a phone. The integer id
  is the key; base36 is only how it is shown.
