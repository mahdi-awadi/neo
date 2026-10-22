# Projects exchange notes as attention items, and only the operator starts work

**Status:** accepted (2026-10-22; built on `dev`, restart-gated). Extends ADR-0018 (attention items). Related: ADR-0008 (todo queue),
ADR-0015/0016 (cause, threads), ADR-0031 (project fence).

A project often finds something that belongs to another project. prod-ops, for example, found D13–D19
for eticket-v3. Today the worker can only write "for Neo to send" in its report. The company (chief of
staff) must notice that line and dispatch it by hand. Notes get lost, and they go stale: a prod-ops
note still listed D16 as open after eticket-v3 had fixed and deployed it, because nothing told
prod-ops.

The operator asked us to choose between: (A) direct project-to-project messaging, (B) the company as
the middleman, and (C) a hybrid: an engine-owned, typed outbox that the engine routes by rule.

## Decision

We use **(C), built on attention items**. We do not make a second store.

1. **A project note** is a typed record that one project sends to another with the worker tool
   `project_notes` (action `send`): target project, kind (`finding`, `fyi` or `request`), severity,
   title, body, refs and a sender-chosen `ref` (for example `D16`). The engine sets the sender from
   the session (`projectName`). A worker cannot choose or fake the sender.
2. **Each note is an attention item on the target project** (source `note`). The note's text and
   lifecycle live in the attention row, plus three new columns: `from_project`, `cause_msg_id` and
   `resolution`. The project dashboard, the daily digest, `/attention`, the console, snooze, dismiss
   and **→ todo** then work for notes with no new UI path.
3. **Routing is a fixed table in code, with no AI.** No kind starts work. Every note is information
   for the target. A `request` or a `high` finding also sends one line to the operator at once,
   through the flood gate. Work starts only when the operator taps **→ todo** (or orders the company
   to dispatch it). That todo goes through the target's todo queue (ADR-0008), with the note's cause,
   so `/trace` shows the chain from the finding to the fix.
4. **The target sees its open notes when a fresh session starts.** The block is bounded and
   deduplicated (only titles, ids and senders; the worker reads a body with `show`). It goes in at the
   same two places as the frozen memory snapshot (fresh dispatch, fresh operator session), never on a
   resume, never in a tainted or customer run. The block says the notes are information, not orders.
5. **Notes resolve themselves from facts.** The target resolves a note with
   `project_notes resolve <id> fixed <commit>`. The engine checks that the commit exists in the
   target repository and that a branch holds it. It does not judge the content. Other ways to close a
   note: `not_needed` or `duplicate` (with a reason), a todo made from the note that ends `done`, the
   sender's `withdraw`, or the operator's dismiss. A resend with the same `ref` refreshes the note,
   and if it was resolved, opens it again (the existing upsert rule).
6. **The sender sees the outcome.** A fresh session of the sender gets the state of the notes it sent
   (open, acknowledged, resolved at which commit). So prod-ops learns at its next start that D16 is
   resolved.
7. **Guards in code:** the target must be a project folder under the work root (not the sender
   itself, not a desk); sizes are capped (title, body, refs); the body is refused if it matches a
   known secret pattern; the number of notes a sender can send per day and have open per target is
   capped. All limits live in config (`notes.*`), with safe defaults. The tool is attached only to
   operator workers, through the same gate as `ask_operator`, so the customer path never has it.

## Why (C) fits Neo's rules

- **No AI in the engine:** the engine validates, stores, injects and routes by a table.
- **Default-escalate and approval:** a note never starts a run, never enters a live session, and
  never goes around the todo queue. A project cannot make another project act. The operator's tap is
  the approval.
- **Customer taint:** tainted briefs run with no tools and no MCP, so they cannot send. Notes are
  never injected into an ingress or tainted run.
- **Flood gate and budget reserve:** a note costs no worker run. Only `request` and `high` notes send
  an immediate line, through the existing flood gate. Everything else waits for the daily digest. The
  injected block is capped, so it costs few tokens.
- **Trace spine:** a note carries the cause of the turn that sent it. The todo made from it joins that
  thread.
- **prod-ops stays read-only:** sending a note writes to Neo's ledger, not to another project's
  folder, so the project fence (ADR-0031) is not touched.

## Rejected alternatives

- **(A) Direct project-to-project messaging.** A brief that one worker sends would start work in
  another project with no approval. That breaks the default-escalate rule. It is also a prompt-
  injection path: text from a worker that read prod logs would become another worker's orders.
  Pushing into a live session also breaks the todo queue's "never push into a busy project" rule.
- **(B) The company (chief of staff) as the middleman.** Routing depends on an AI noticing a line in a
  report. That is today's process, and it is the one that loses notes. Every note would also cost
  company context and a company turn. Nothing would close a note when the target fixes the problem.
- **(C) with its own `project_notes` table and inbox.** It would copy the attention lifecycle (open,
  refresh, resolve, reopen, snooze, dismiss, → todo, digest, dashboard, console). That is a second
  implementation, against the engineering baseline.
- **Resolve a note when the target's worker says so in its result text.** That makes AI output decide
  state. A commit the engine can check, or a todo that ended `done`, is a fact.
- **Copy the note into the target's `HANDOFF.md` or `CLAUDE.local.md`.** Neo would write into another
  project's files (the fence), and the text would never resolve.
