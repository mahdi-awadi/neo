# Neo

Neo is a deterministic **engine**: it takes the operator's orders, routes them to coding-agent SDK
workers, governs what those workers may do, meters what they spend, and records everything. The
engine holds no AI. This file is the glossary for that domain — what the words mean here, nothing
about how they are implemented.

## Language

### Who and what asks for work

**Operator**:
The single human this engine serves, addressed as Neo. The subscription is theirs.
_Avoid_: user, owner, admin, Mahdi

**Order**:
One unit of work handed to a worker: a folder, a task, and the source that asked for it.
_Avoid_: job, request, ticket

**Source**:
Who an order originates from — the operator (`neo`) or an outside customer (`customer`). The
compliance firewall keys off this: customer-sourced work may never reach the subscription.
_Avoid_: origin, requester

**Work class**:
Whether the operator is *waiting* for the answer. An order is either an **interactive turn** or
**background work**. It follows the **originating trigger**, not the mechanism: what matters is
what set the work in motion, not how the engine carries it out. Orthogonal to source: both classes
are the operator's own work.
_Avoid_: mode, kind, type

**Originating trigger**:
The event a piece of work traces back to — an operator message or command, or a schedule firing.
Decided once, when a worker is launched, and inherited by everything that launch goes on to start.
_Avoid_: caller, parent, entry point

**Interactive turn**:
An order the operator typed and is waiting on — a Telegram message or command, `/open`, a reply in
a project chat, a web-console message — *and* whatever the engine does on their behalf while
servicing it, such as a dispatch the company makes one hop from their message. The operator is at
the keyboard either way.
_Avoid_: foreground, live message, manual run

**Background work**:
An order the engine starts while the operator is elsewhere — a loop fire, a scheduler tick, the
secretary, the dream/memory sweep, a run driven by a customer brief. Nobody is waiting on it.
_Avoid_: async work, automation, autonomous run

### Budget and limits

**Window budget**:
The engine's own spend ceiling over a rolling window, in USD. An engine-local accounting device,
not something Anthropic enforces.
_Avoid_: quota, limit, cap

**Interactive reserve**:
The slice of the window budget held back for the operator's own interactive turns. What it gates is
**background work**: once total window spend reaches the rest of the budget, background work stops,
because only the reserve is left and the reserve is the operator's. It is never a ceiling on an
interactive turn — capping the operator is the exact thing it exists to prevent. Note that *total*
spend is what it measures, so a heavy interactive day also stops background work; that is intended,
since the pool it is protecting is the same pool either way.
_Avoid_: headroom cap, interactive budget

**Background allowance**:
The part of the window budget outside the interactive reserve — `windowBudgetUsd × (1 - reservePct)`.
The number background work is actually measured against.
_Avoid_: background budget, background quota

**Throttle**:
The engine refusing to *start* background work because it has used up everything outside the
interactive reserve. Applies to background work alone — including a dispatch, when a schedule is
what originated it.
_Avoid_: rate limit, block, pause

**Rate limit**:
Anthropic refusing a request server-side, reported with a real reset time. External, authoritative,
and class-blind — it stops the operator and background work alike. Distinct from a throttle: a
throttle is the engine's own choice, a rate limit is not.
_Avoid_: throttle, 429, quota error

**Cooldown**:
A short engine-wide hold on starting new background work after a worker reports a rate limit, so
retries and the scheduler do not amplify the storm. Never holds an interactive turn.
_Avoid_: backoff, freeze

### Running work

**Worker**:
A coding-agent SDK process the engine starts in a project folder to carry out an order. The only
place AI runs.
_Avoid_: agent, bot, model

**Session**:
A worker's living conversation for one folder, resumable across orders.
_Avoid_: thread, conversation

**Dispatch**:
Sending an order into another project's folder as its own governed session, streaming its progress
back and returning its result. Its work class is inherited, not fixed: a dispatch made while
servicing an operator message is an interactive turn; a scheduler-fired one is background work.
_Avoid_: delegate, forward, handoff

**Dispatcher**:
The session that made a dispatch: the company. It gets a progress digest while the dispatch runs,
and the dispatch's final result when it ends (ADR-0007).
_Avoid_: main agent, parent, caller

**Settled**:
A worker session at rest. The SDK reports `idle`, and no background agent or task is still
running. A `result` only ends a turn. While background agents work, the session is not settled,
so the brief is not done.
_Avoid_: finished, done (for a single turn)

**Stall limit**:
The only automatic abort of a dispatch: true silence (no streamed SDK event) for
`dispatchStallMs`, not counting time spent waiting on the operator or in an API backoff. A
dispatch has no wall-clock limit (ADR-0007).
_Avoid_: timeout, ceiling

**Progress digest**:
A short line about a running dispatch, built by the engine: elapsed time, current activity, the
latest note and the last commit. It goes to the operator and the live dispatcher every
`dispatchProgressMs`, and only when there was new activity. It never wakes the dispatcher.
_Avoid_: status update, heartbeat

**Dispatcher inbox**:
The ledger's durable queue of final dispatch results for the dispatcher. A result stays there
until it is delivered, so a reload or a closed company session cannot lose it.
_Avoid_: mailbox, outbox

**Stop point**:
Where an interrupted dispatch stopped: the folder's last commit, the worker's latest note and its
last activity. Every abnormal final result carries one, so the dispatcher can resume.
_Avoid_: checkpoint

**Todo**:
One dispatched brief the engine tracks from hand-over to end: its project, brief, who it came from,
and its status — `queued`, `running`, then `done`, `failed` or `cancelled`. Every brief the company
dispatches is a todo, whether it starts at once or waits. Known by its number (`#12`).
_Avoid_: task, job, ticket, item

**Todo queue**:
A project's ordered list of todos waiting to run. Durable: it survives a reload. A project runs one
todo at a time; the rest wait in order and are never merged or dropped. The operator and the company
can reorder, cancel, pause and resume it.
_Avoid_: backlog, task list, session queue

**Busy project**:
A project that cannot take a new brief now: a todo of its is running, its session is preparing or
closing, or its session is in a turn or has a follow-up waiting. A brief for a busy project is
queued, never pushed into the running session.
_Avoid_: active, running (unqualified)

**Release**:
The engine starting a project's next queued todo. It happens when the current todo ends — after its
result has reached the operator and the dispatcher — and on the engine's regular tick, for queues a
hold or a restart left waiting. Never while the engine is draining, cooling down, or held by the
interactive reserve.
_Avoid_: dequeue, pop, next

**Failure policy**:
What a project's todo queue does when a todo ends badly (failed, stall-aborted, killed, cut short by
a reload or restart): `continue` with the next todo and report the failure, or `pause` the queue
until someone resumes it. Never a silent start of the next todo.
_Avoid_: retry policy, on-error

**Paused queue**:
A todo queue that is not released. Its todos stay queued, and new briefs for the project join the
end of it, even when the project is free.
_Avoid_: stopped, frozen, disabled

**Loop**:
A trigger, a repeated action, and a goal that ends it. Always background work.
_Avoid_: cron job, automation, schedule

**Standing brief**:
A loop's prompt. Unlike a dispatched brief it is never wrapped — the engine hands it to the worker
verbatim — so everything the dispatch preamble would have carried, the loop's own prompt must carry:
the project's rules, the engineering baseline, the governance envelope it runs under, and how to
raise a blocking question. Written once, re-read by a fresh worker every iteration.
_Avoid_: loop task, loop prompt, instructions

**Dispatch preamble**:
The fixed instruction block the engine prepends to every dispatched brief, before the brief's own
text. It carries what a worker cannot be trusted to know or be told by hand: read the project's
rules, query the structural map first, design then build, meet the engineering baseline, challenge
yourself before asking, stay alive. It is engine-owned, so no brief can omit it — and it is context
the operator pays for on every run, so it stays terse.
_Avoid_: prompt, system prompt, header

**Engineering baseline**:
The operator's standing definition of acceptable code — standard i18n catalogues, `.env` +
environments defaulting to dev, Docker, no hardcoding, reuse what exists. Not a style preference:
code that misses it is a failed order, even when it runs. Stated once in `CLAUDE.md` and carried to
every worker by the dispatch preamble.
_Avoid_: guidelines, best practices, coding standards

**Escalation**:
The governor stopping a worker to ask the operator for permission to do something risky.
_Avoid_: approval request, prompt, confirmation

**Governor hook**:
The governor's `PreToolUse` hook. The SDK runs it before a project's settings allow rules. It runs
the same `decide()` as `canUseTool` and sends every call the governor does not allow to
`canUseTool`, so no allow rule can approve that call first (ADR-0006).
_Avoid_: permission hook, pre-hook

### What a worker remembers

**Auto-memory**:
Claude Code's own per-repository notes: a `MEMORY.md` index plus one topic file per note, at
`~/.claude/projects/<repo root, path chars as "-">/memory/`. The CLI writes it and loads the index
(first 200 lines or 25KB) into every session in that repo. All worktrees of a repo share one dir,
and the operator's own interactive Claude Code sessions use the same dir as Neo workers. It is the
project memory (ADR-0020). Tainted briefs run with it off.
_Avoid_: Claude memory, the memory folder, ~/.claude memory

**Neo memory**:
The engine's Phase 2 memory: capped `§`-entry files in `<folder>/memory/`, a frozen snapshot, FTS
recall and the dream loop. Off by default (`memory.scopes: []`). It overlaps auto-memory (ADR-0020).
_Avoid_: curated memory (as a synonym), memory (bare)

**Project docs**:
A repo's tracked instructions and status files: CLAUDE.md/AGENTS.md (rules), HANDOFF.md/WIP.md (where
the work stands for the next session). Shared through git, so they hold no machine-local facts.
_Avoid_: memory

**Tainted brief**:
A brief that embeds untrusted customer text (an inbox draft). It runs as an isolated one-shot: no
mutating tools, no MCP, no resume, no auto-memory.
_Avoid_: customer brief (that is any customer-driven brief, tainted or not)

### Which model a worker runs

**Model id**:
The exact string that names one model to the SDK — `claude-opus-5-5`, `claude-sonnet-5-5`,
`claude-fable-5-1`. Release-stable: the same id always means the same model. Optionally carries a
context-size tag (`claude-opus-5-5[1m]`), which the SDK strips when it reports the model back.
_Avoid_: model, model name, version

**Tier alias**:
A family word — `opus`, `sonnet`, `haiku`, `fable` — that stands for "the current model of that
family". Convenient to write and **release-dependent by design**, so it is a spelling the operator
may use, never a value the engine sends. Every alias is expanded to a **model id** before it reaches
a worker.
_Avoid_: model, shorthand, tier

**Pinned model**:
The model id the engine actually sends, named in `config.models`. Pinned because the engine chose
it, not because a release did: the operator can read it, diff it, and roll it back. The opposite of
an **inherited model** — whatever the subscription happened to default to, which no config records
and no reload makes visible.
_Avoid_: default model, configured model

**Worker profile**:
The per-launch-path override of the pinned model and its run settings (`model`, `effort`, `skills`,
`maxTurns`), one per path — `company`, `project`, `dispatch`, `loop`, `judge`, `ingress`, `handoff`,
`secretary`. A path only names a model to *differ* from the pinned default; saying nothing means the
default, not "whatever the SDK picks".
_Avoid_: worker config, path settings

### How full a session is

**Context window**:
The most tokens one model can hold in a single request — a fact about the model. The SDK reports it
on every turn it completes. A **model id**'s context-size tag does not always change it: Opus 5.5 has
a 1M window with or without `[1m]` (ADR-0013).
_Avoid_: context size, context limit, max tokens

**Context occupancy**:
The share of the **context window** the session's last turn used: that turn's input, cache-read and
cache-write tokens, divided by the window. Not a sum over turns. It is 0 to 1; above 1 means the
window is wrong, not that the session overran. The console shows it as ctx%.
_Avoid_: context use, fill, ctx (except as the display label)

**Sweet spot**:
The occupancy range in which a session is cheap and sharp enough to keep: below the sweet-spot
line. Above it, every turn pays to re-read a large cached context, so the session is handed off at
the next **task boundary**.
_Avoid_: healthy zone, threshold, limit

**Context band**:
Where a session's occupancy sits, in one word: **healthy** (inside the sweet spot), **above** (past
the sweet spot: hand off at the next task boundary), **heavy** (past the checkpoint line: hand off
at the next **safe checkpoint**, even mid-task), **emergency** (near the real limit: the last
resort).
_Avoid_: level, status, zone

**Task boundary**:
A moment between two pieces of work, when nothing is lost by starting fresh: a session **settled**
after its task, or an idle session about to be resumed for a new one. The normal place for a
**context handoff**.
_Avoid_: break, pause, end

**Safe checkpoint**:
A point inside a task where the work so far is complete and committed: a commit just succeeded or
the worker marked a plan step done, and the folder has no uncommitted changes. The only mid-task
moment the engine may hand a session off.
_Avoid_: savepoint, stop point (that is where an interrupted dispatch stopped)

**Context handoff**:
Replacing a full session with a fresh one without losing the work's thread: the old session writes
a **handoff note**, the engine forgets its resume id, and the next session starts from the note.
Always recorded with its reason. Never done with uncommitted work, except in the emergency band.
_Avoid_: reset, compact, clear, restart

**Handoff note**:
The state-of-work note (`HANDOFF.md`) a session writes for its successor: the goal, what is done,
the next steps, the branch and commit, open decisions, gotchas. The engine appends the facts it can
check itself (branch, last commit, uncommitted files).
_Avoid_: summary, WIP note, memory

**Continuation**:
The fresh session that picks up a task a mid-task handoff interrupted. Its first brief carries the
handoff note itself, not a pointer to it.
_Avoid_: retry, resume (resume keeps the old session)

**Emergency clear**:
Dropping a session's resume id with no handoff note, because it is too close to the real limit to
write one safely. The last resort. Always recorded and alerted.
_Avoid_: reset, wipe, clear (unqualified)

**Orientation**:
How much work a session started from a handoff note does before its first productive action (an
edit or a commit). A short orientation means the note carried the thread; a long one means the new
session had to rediscover it.
_Avoid_: warm-up, ramp-up

### Telling a working session from a wedged one

**Activity**:
Any evidence that a worker is still doing something — *any* streamed SDK event: a partial
generation delta, a tool call, a tool result, a system event, a turn result. Deliberately wider
than anything the operator can read: a worker writing one enormous file for ten minutes is
producing activity and no output.
_Avoid_: heartbeat, progress, event, output

**Last activity**:
When the engine last saw activity from a session. The single authoritative liveness clock:
everything that judges alive-or-wedged reads this and nothing else.
_Avoid_: last seen, last touch, last message

**Last output**:
When a session last produced something the operator can read. Useful ("it has told me nothing for
20 minutes"), but it is *not* a liveness signal — judging liveness by it is what makes a busy
worker look dead.
_Avoid_: last activity, last reply

**Turn**:
One brief handed to a session and worked to its conclusion. A session works one turn at a time.
An operator's follow-up waits inside the session behind the turn in flight. A dispatched brief for
a busy project does not: it waits in the project's **todo queue** until the current task is
**settled**.
_Avoid_: request, job, run

**In-turn / between-turns**:
Whether a turn is being worked *right now*. Orthogonal to whether the session is open: a session
sitting between turns is healthy and instantly available, however long it has sat there.
_Avoid_: busy, active, running

**Session state**:
The one word for what a session is doing, **derived** from the clocks above and never stored:
- **starting** — registered, but its worker is not attached yet (the engine is still preparing it:
  indexing the folder, running the context gate). It cannot take a brief; nothing is wrong either.
- **working** — in-turn, activity seen recently.
- **quiet** — in-turn and alive, but nothing operator-visible for a while (a long build, a big file).
- **idle** — open, between turns. Healthy and available now, at any age.
- **awaiting-operator** — in-turn but blocked on the operator (a permission escalation, or a raised
  decision). The clock that matters is the operator's, so this state is never wedged and never
  stall-aborted.
- **wedged** — in-turn, and no activity past the wedge threshold. The only state that means
  something is actually wrong.
_Avoid_: busy, stuck, hung, running

**Session status**:
The lifecycle of the registry entry — `running` while a run is open, `idle` once it ends, then
`done`/`error`. Bookkeeping, *not* what the worker is doing: it stays `running` for a session's
whole life, including while it sits between turns. Never report it to the operator; report the
**session state**.
_Avoid_: state, status (unqualified)

**Stall abort**:
Dispatch ending a sub-run that has shown no **activity** for the stall window. It measures activity
and never output, it is paused while the session is awaiting the operator, and it records the
evidence it acted on before it fires.
_Avoid_: timeout, kill, watchdog

### Keeping the toolchain current

**Update item**:
One thing outside the engine's own code that a newer release can replace: the worker Agent SDK, a
Claude Code plugin, or an MCP server. Each item has a **category** (`sdk`, `plugins`, `mcp`), a
current version, and — once checked — the latest version.
_Avoid_: package, dependency, component

**Floating item**:
An update item that names no version (`npx some-mcp`, `pkg@latest`, a docker image with no tag, a
remote HTTP MCP server). It resolves when it is launched, so the updater has nothing to apply and
only reports it.
_Avoid_: unpinned, auto-updating

**Auto-apply**:
The updater replacing an item with its latest version, then verifying it, with no operator step.
Switched per category in config. A failed verification rolls the item back at once.
_Avoid_: auto-upgrade, self-update

**Held update**:
A newer version the updater found but did not apply because its release notes flag a breaking
change. It waits for the operator (`/updates apply <item>`).
_Avoid_: blocked, skipped, pending

**Restart-gated update**:
An applied update that running code cannot see until the daemon restarts — the Agent SDK always.
The updater reports it and waits; it never restarts the daemon.
_Avoid_: pending restart, needs reload

### Trust

**Trust**:
A per-folder operator setting. When a folder is trusted, an **escalation** in that folder is
approved automatically instead of asking the operator. Trust never lifts a **fence escalation**,
and it never applies to customer-sourced work (ADR-0011).
_Avoid_: auto-approve mode, allowlist

**Seen folder**:
A folder with a row in the trust store, `on` or `off`. A folder with no row has never been seen and
is not trusted. Its first sight at an operator session start records it — `on` when
`trustNewProjects` is set. After that, only the operator (`/trust`) changes it.
_Avoid_: trust flag, known project

**Fence escalation**:
An escalation that only the operator can approve: a file write outside the session's project
folder, when `governor.outOfFolderWrites` is `"ask"` or the work is customer-sourced. **Trust**
never approves it automatically; autonomous paths deny it.
_Avoid_: hard escalation, blocked write

**Standing write approval**:
The operator's permanent "yes" to file writes outside the project folder
(`governor.outOfFolderWrites: "allow"`, the default since 2026-10-06). Own work only: customer
work and ingress keep the fence (ADR-0012).
_Avoid_: write allowlist, trusted writes

**Approval patience**:
How long a pending approval waits: a reminder to the operator every `approvalRemindMs`, then a
deny after `approvalTimeoutMs` (fails closed). An approval never waits silently forever (ADR-0012).
_Avoid_: approval TTL, auto-approve on timeout

### Tracing work back to the operator

**Operator message**:
One line the operator sends from Telegram or the web console. It gets a ledger id the moment it
arrives. Customer mail is not an operator message.
_Avoid_: input, prompt, request

**Message ref**:
The short form of a message id that the operator reads and types — `m4f2`. One ref names one
message, and the ref of a thread's root names the thread.
_Avoid_: message id (in operator text), ticket number

**Cause**:
The operator message (and its thread) that a piece of work traces back to. Set once where the work
starts, then copied into everything that work produces: replies, orders, todos, decisions, tool
actions, dispatch results, files and plans. The message-level form of the **originating trigger**.
_Avoid_: parent, source, context

**Thread**:
One operator message, or one engine trigger, and everything it caused, in time order — replies,
dispatches, progress, results, decisions, plans and the operator's follow-ups. A message joins a
thread only by an explicit link (a reply, or the console's thread composer). Not a **session**: one
session serves many threads, and one thread can reach many sessions.
_Avoid_: conversation, chat, session, ticket

**Thread root**:
The first message of a thread. For background work (a loop fire, an attention todo, an ingress
brief) the engine writes the root itself, so every thread has one.
_Avoid_: first message, parent

**Thread state**:
What a thread needs, derived from its facts: **open** (work is queued or running), **waiting** (an
open decision or approval — the operator owes an answer), **done**, or **failed** (the newest work
ended badly and nothing runs). Waiting beats open. The operator may close a thread; a new message
reopens it.
_Avoid_: status (unqualified), progress

**Trace**:
The tree of everything one message or thread produced, read from the ledger. What `/trace` shows.
_Avoid_: log, history, audit

### What needs the operator

**Attention item**:
One fact about a project that needs someone to act — a failed CI run, a branch not pushed, a
leftover worktree, an approval waiting for hours, a plan nobody executed. It is opened, refreshed
and resolved by code, never by AI. It can become one todo.
_Avoid_: alert, issue, warning, notification

**Producer**:
The code that reads one source (git, GitHub, the engine, plans, the running build) and returns the
attention items it sees now. A producer that cannot read its source changes nothing.
_Avoid_: scanner, checker, watcher

**Daily digest**:
One message a day with each project's open attention items, the worst first, each one tap away from
a todo.
_Avoid_: report, summary, newsletter

**Project dashboard**:
One view of a project: what runs now, its queue, git and GitHub state, open decisions, plans,
attention items, recent threads and health. The same view on the web, on Telegram and for the
company.
_Avoid_: project page, status page, overview

**Spinning dispatch**:
A dispatch that shows activity but no progress: several progress digests in a row with the same
step, the same note and the same last commit. Different from **wedged** (no activity at all).
_Avoid_: stuck, looping, hung

**Leftover worktree**:
A linked git worktree that no session works in. Worktree folders are temporary by operator rule, so
one that stays is an attention item.
_Avoid_: stale checkout, extra folder

### Plans

**Plan**:
A design or implementation document a worker writes under a project's **plan paths**. The engine
registers each one, sends it to the operator, and tracks its status.
_Avoid_: spec (when the tracked document is meant), proposal, design doc

**Plan paths**:
The folders, set in config, where plans and specs live (`docs/**/plans/`, `docs/**/specs/`, …). A
file written there in a run is a plan.
_Avoid_: plan folder, docs

**Plan status**:
`draft` (registered, not sent), `sent` (the operator has it), `approved`, `executing` (a todo works
it), `done`, or `abandoned`. Moves only on an operator tap or a fact the engine can read.
_Avoid_: plan state, phase

**Plan card**:
One version of a plan as the operator receives it: the file, a caption with its project, title,
version and thread ref, and the buttons its status offers. It is a tracked decision, so it is
reminded, and a reply to it is the operator's change request.
_Avoid_: plan message, plan notification

### The running engine

**Running build**:
The engine code the daemon actually runs — the commit it booted from, recorded at boot.
_Avoid_: current version, deployed version

**Restart-gated change**:
A change that exists on disk but not in the running build: a commit after the boot commit, a fix
branch not merged yet, an update that needs a restart. Computed from git and the updater, never
remembered by hand. Wider than a **restart-gated update**, which is one kind of it.
_Avoid_: pending restart, waiting fix

### Errors that must not stop the engine

**Unit of work**:
The smallest thing that can fail on its own: one session turn, one dispatch, one loop fire, one
Telegram update, one web request, one tool call, one heartbeat step. A failure ends that unit only.
Whoever waits on it (the operator, the company) gets a failure result, never silence.
_Avoid_: job, task, request (when the general idea is meant)

**Engine fault**:
An error the engine caught that no unit's own handling dealt with — a throw in a heartbeat step, a
rejected promise nobody awaited, an uncaught exception. It is logged with its stack and context,
recorded (`engine_fault` event), sent to the operator, and queued for the company to investigate.
The engine keeps running.
_Avoid_: crash, panic, exception

**Fault signature**:
The component plus the first line of the error message. Faults with the same signature inside the
dedupe window are counted, not re-sent, so one repeating error cannot flood a channel.
_Avoid_: error hash, fingerprint

**Unrecoverable state**:
A state in which running on would be worse than exiting: the ledger cannot be opened, the web
port cannot be bound at startup, or Telegram long polling has stopped for good (a revoked token,
401, or a second poller on the same token, 409). Only these exit the process (the supervisor
restarts it). Any other polling stop is reported and polling restarts.
_Avoid_: fatal error

### The operator web console

**Console feed**:
The console's running list of lines: worker output, mirrored echoes and notices, escalations, and
files. It is a live view, not a record — the ledger and Telegram keep the record.
_Avoid_: history, transcript, log

**Replay window**:
The newest feed events the engine keeps for a console that opens or reconnects (`webFeedWindow`).
Older events drop out. A pending **escalation** is always replayed, even when it is older than the
window, because the operator must still be able to answer it.
_Avoid_: backlog, buffer, history

**Resume point**:
The id of the last feed event a console received. A reconnecting console sends it and gets only the
later events, so a dropped connection never shows a line twice.
_Avoid_: cursor, offset, checkpoint

**Draft version**:
A counter on an inbox item, bumped by every change to its draft reply. A Send names the version the
operator approved. The send is refused (*stale*) when the draft changed since, or the item was
already replied (from any channel). A second Send while one is in flight is refused (*busy*). This is the send's
idempotency key: a customer never gets a reply twice or a reply the operator did not see.
_Avoid_: revision, draft id
