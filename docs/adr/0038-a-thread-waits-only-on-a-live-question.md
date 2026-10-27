# A thread waits only on a live question

**Status:** accepted (2026-10-15); the "answered in chat" rule is **removed by ADR-0054** (2026-10-27): it closed a real question (d83217cb) · amends ADR-0016 (thread state). Builds on ADR-0019/0036 (plan
cards), ADR-0029 (a run parks on its open decision).

On 2026-10-15 the console's Threads tab, filtered to `waiting`, listed 19 threads whose work had
finished: m7nk8, m75b1, m73xw (eticket-v3), m9g0b (contantme), m74i2 (mirshad), m723u (neo), m748q
and m74a3 (prod-ops), m9a1n and m95c1 (gold), and more.

`deriveThreadState` returns `waiting` while the thread has any `decisions.status = 'open'` row, or a
session blocked on an approval. That rule is right. Its inputs were wrong:
- **Decisions never closed.** Only three paths close a decision: a reply to the decision message, a
  tap, or the plan-card actions. A question the operator answered by writing in the thread, a
  question the worker asked again, and the review decision of a plan that was later executed or
  finished in another way all stay `open` for ever.
- **No close.** `threads.closed_by_operator` exists, and the glossary says the operator may close a
  thread, but nothing writes the flag.
- **Approvals.** A session that left `running` kept its approval block, and `refreshThread` counted
  approvals on sessions of any status.

## Decision

### 1. A decision can be superseded — the engine closes it, with a reason
New status `superseded`, next to `answered` and `dismissed`. A decision closed without an answer
keeps WHY in `answer` ("asked again as #ab12cd34", "answered in chat (m9g0x); the thread's work then
finished", "plan done"). It stays in the thread view; nothing is deleted. No schema change: `status`
is free text, and `answer` already holds the closing text.

### 2. The rules (deterministic, `decision-settle.ts`, applied by `trace.refreshThread`)
An open decision of a thread is superseded when one of these is true:
- **Asked again.** A later decision in the same thread has the same question (trimmed, whitespace
  collapsed, case-folded).
- **Answered in chat.** It is the thread's only live question, it names its project folder, the
  operator then wrote in the thread, and later an order or todo of the thread in that SAME folder
  ended `done`. The operator went on in chat instead of through the decision, and the work it asked
  for finished. Not chat:
  - an answer line, meaning a line whose text is the answer of one of the thread's decisions (a tap
    writes one);
  - an approval verdict, which is an engine line.

  A batch of open questions (Q1 … Q7) is never closed by this rule, because one chat line cannot say
  which question it answers. A "status?" handled by the company is not the project's work.
- **Plan settled.** It is a plan card's review decision, and the plan is `done`, `abandoned` or
  `executing`.

Never superseded:
- A decision a `waiting` todo is parked on (ADR-0029). That todo IS the open work.
- A plan's review decision while the plan still awaits (only "plan settled" applies to plan cards).

`refreshThread` applies the rules before it derives the state, so every place that refreshes a
thread (each line, each run end, each todo end) settles its decisions. Config
`decisionSettle.enabled` (default true) turns the automatic rules off.

### 3. The operator closes a thread
- Console: a **Close thread** button in the thread view (AR+EN), behind the admin session like
  every `/api` route. `POST /api/thread/close { id }`.
- Telegram: `/close <thread ref>`.

A new decision in a closed thread reopens it, so a question is never hidden behind "done". Close
sets `closed_by_operator`, dismisses the thread's open decisions with the reason "thread
closed by the operator", and cancels the todos parked on them. Queued and running todos are not
touched: Close says how many are still active. A new operator message in the thread reopens it.

### 4. An approval needs a running session
The registry clears an approval block when a session leaves `running`. `refreshThread` counts
approvals only on running sessions.

## Rejected
- **"The decision's own order ended done."** ADR-0029 parks a run on its open decision on purpose:
  the answer resumes that work. The end of the run that asked is not evidence that the question is
  moot.
- **"Any later decision of the same order supersedes the earlier ones."** Workers ask several
  separate questions in a row (gold's Q1 … Q7). Each still needs an answer.
- **Change `deriveThreadState` to ignore old decisions (an age limit).** It hides a real open
  question that happens to be old, and leaves the stale rows open in `/decisions`.
- **A new `close_reason` column.** `answer` already holds the closing text for answered decisions;
  one field for "how it closed" is enough, and no migration runs under the live daemon.
