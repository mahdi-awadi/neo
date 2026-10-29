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

**Limit wait**:
A running todo whose dispatch is waiting out a rate limit before it re-sends the brief into the same
session. Derived from the order's newest `api_retry` event (`kind: rate_limit`, still before
`at + delayMs`, and not ended early by an `api_wait_ended`); never a todo status. The queue and
`sessions` show it as "held: limit wait · resumes HH:MM" (ADR-0047, ADR-0060). `todo retry` ends it now.
_Avoid_: stuck, paused, limit_wait status

**Held run**:
A running todo's dispatch that waits on an API error before it re-sends its brief: a limit wait, or a
shorter error backoff ("held: API retry"). It has a handle (ADR-0060): `todo retry` wakes it, a turn that
goes through on it (the operator's own message) sends its re-send at once instead of days later, and a turn
that goes through on the same provider wakes the other limit holds early. Its brief is re-sent at most once.
_Avoid_: stuck, blocked, needs /kill

**Project message**:
A few words the chief of staff speaks into a project's open session with `project_message` ("resume",
"status?", "continue"), delivered exactly like the operator's own message (ADR-0061). It never starts new
work (that is a dispatch) and is not a project note (information read later). It is marked "chief of staff →
<project>" wherever the operator reads it.
_Avoid_: dispatch, note, nudge (as a separate mechanism), injecting

**Item facts**:
The structured facts of an attention item (ADR-0059): the branch, the PR number, how many days. The producer
writes them; an older row derives them from its kind, key and title. The console builds the item's reason from
them with catalogue templates.
_Avoid_: metadata, detail (the free-text detail is separate)

**Plain title**:
An attention item's one-line title without engine prefixes ("PR #31:", "thread waiting 2d:") and with a
Dependabot bump read as "name from → to". Shown with the kind badge and the project.
_Avoid_: clean title, display name

**Todo summary**:
One short human line that names a todo on every surface (ADR-0059): the stored one (an accepted AI line or the
deterministic one), else the one its brief gives. A continuation keeps its task's summary.
_Avoid_: todo title (the first-60-characters rule it replaces), label

**Standing rules**:
The rules every worker gets in every project, from one text (`standing-rules.ts`, ADR-0063): plan fully,
then finish non-stop; rich, complete plans; production-grade code; the best technology, recorded in an ADR.
The dispatch preamble, loop briefs and consult runs carry them.
_Avoid_: preamble rules (the preamble is one carrier), guidelines

**Planner**:
The SDK subagent every dispatch, project and loop run gets for its DESIGN phase and final review, on the
planning model at the planning effort (config `planner`, default Opus at `max`). The main run builds.
_Avoid_: plan run, planning session (it runs inside the worker's task)

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

**Commit finish**:
The one follow-up the engine sends into a dispatch run that settled with its own changes still
uncommitted: commit them, or say why not, then end. Sent at most once per run, into the same
session. While it runs, every worktree of the repository waits (ADR-0037).
_Avoid_: auto-commit (the engine never commits), nudge, cleanup run

**Run's own changes**:
The uncommitted paths at a run's end that are new or changed since the run started, minus
`commitFinish.ignore`. A path that was already dirty and untouched is not the run's.
_Avoid_: dirty files (unqualified)

**Uncommitted work (of a folder)**:
The changed, staged or untracked paths under the folder, minus its own `HANDOFF.md`. A sub-folder
of a repo counts only what is under it, never its parent repo's changes. A folder its repo ignores
(a desk under `/home/neo/agent/`) is not under version control and has none (ADR-0048).
_Avoid_: repo status (for a sub-folder)

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

**Project fence**:
The governor rule that keeps a dispatched or loop worker, and its helper agents, inside its own
project. A write, a branch or a commit in another top-level folder under the work root (`/home`) is a
fenced escalation; reading it, and writing outside the work root, are allowed (ADR-0031).
_Avoid_: path fence (that is the older "inside the session folder" rule, ADR-0011)

**Shared browser**:
The one memory-capped Chromium service (`neo-browser`, loopback 9222) that workers' Playwright and
Chrome DevTools MCPs attach to over CDP, instead of each starting its own browser (ADR-0032).
_Avoid_: browser pool, headless farm

**Project index**:
A project's codebase-memory graph, known by the name the binary gives its root path (for example
`home-eticket-v3`). Before every dispatch the engine makes sure it exists and is fresh at the
folder's HEAD, then hands the worker that exact name, so the worker never lists, checks or indexes
(ADR-0028). A worktree of the project uses the same index.
_Avoid_: index (unqualified), codebase map, project name (for the index name)

**Todo**:
One dispatched brief the engine tracks from hand-over to end: its project, brief, who it came from,
and its status — `queued`, `running`, then `done`, `failed` or `cancelled`, or `retry` while it
waits to re-run after a transient end. Every brief the company dispatches is a todo, whether it
starts at once or waits. Known by its number (`#12`). A `failed` todo is never removed (ADR-0027).
_Avoid_: task, job, ticket, item

**Transient end**:
A todo run that stopped for a reason outside the task, which a later run can get past: a stall
abort, an engine reload or restart, a context checkpoint that could not complete, a worker that
failed to start, or an API/account error (rate limit, overload, auth, subscription access). Code
decides it from facts that dispatch reports, never from the result text. Every other bad end is a
**task failure**: the worker reported that it failed, or the operator stopped it with `/kill`.
_Avoid_: soft failure, flaky

**Retry**:
(1) The status of a todo after a transient end. It waits out a backoff (`todoRetryBackoffMs`), then
goes back to the head of its project's queue. The run gets a preamble that tells it to continue from
what is already done. After the last step of the ladder, the todo is parked as `failed`. (2) The
operator's or the company's action that puts a `failed` todo back in the queue (or runs a `retry`
todo now). It re-runs the same row and never creates a second todo.
_Avoid_: resume brief, re-dispatch, requeue (as a noun)

**Todo queue**:
A project's ordered list of todos waiting to run. Durable: it survives a reload. A project runs one
todo at a time; the rest wait in order and are never merged or dropped. The operator and the company
can reorder, cancel, pause and resume it.
_Avoid_: backlog, task list, session queue

**Lane** (ADR-0057):
Where a todo runs in its project. The **main lane** is the project's one session, the one the todo
queue feeds: it owns the working tree, the branch and the containers. A **side lane** is a separate,
single-brief session that runs at the same time as the main lane. The governor keeps it out of the
main lane's way. The chief of staff picks the lane when it writes the brief (`lane: "side" | "queue"`);
a brief with no lane goes to the main lane's queue.
_Avoid_: parallel task, background job, fork

**Lane kind** (ADR-0057):
What a side-lane todo declares it will do, so the governor knows what to allow:
- `read-only`: reads and checks; writes no files except temporary ones.
- `ops`: runs commands against running services (a DB row through `docker exec`, an API call, a
  log check). Never edits project files, never runs git writes, never starts or stops containers.
- `test`: runs tests or checks as they are. Same limits as `ops`.
- `code`: changes code in its own temporary git worktree on a `side/<todo>` branch. The engine
  removes the worktree when the task ends. A main-lane todo later merges the branch.
_Avoid_: type, category, mode

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
What a project's todo queue does when a todo ends `failed` (a task failure, or a transient end
whose retries are used up): `continue` with the next todo and report the failure, or `pause` the
queue until someone resumes it. A todo that waits as `retry` has not ended, so the policy does not
apply to it. Never a silent start of the next todo.
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
The state-of-work note a session writes for its successor: the goal, what is done, the next steps,
the branch and commit, open decisions, gotchas. The engine appends the facts it can check itself
(branch, last commit, uncommitted files). It is **Neo's note**: kept in `handoffNotesDir`, outside
the project repo (ADR-0029). A project's own `HANDOFF.md` is the project's file, and Neo never
writes it.
_Avoid_: summary, WIP note, memory, HANDOFF.md (for Neo's note)

**Continuation**:
The todo that carries a handed-off task on in a fresh session. A mid-task (checkpoint) handoff always
makes one. A handoff after the task is done makes one only when the note's next steps list work and
the run raised no decision that is still open. If it did raise one, the continuation is **parked** as
`waiting` on that decision and is queued when it is answered (ADR-0029). Its first brief carries the
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

**Running tool call** (ADR-0058):
One tool call a worker has started and that has not returned yet (a Bash command, a subagent), known by
its tool-use id. The engine keeps a live list of them per session; the console's "Running now" strip,
`/stop`, `/bg` and the company's `tool_control` tool act on it.
_Avoid_: job, process, task (the SDK's word for a backgrounded call)

**Stop (a tool call)** (ADR-0058):
The operator ends ONE running tool call and nothing else: its process tree on the host, and the
processes its `docker exec` calls started inside containers. The worker gets a result saying the
operator stopped it and not to retry; the session goes on. Not `/kill`, which ends the session.
_Avoid_: kill (for one call), abort, cancel

**Send to background** (ADR-0058):
The operator detaches a running tool call: it keeps running, its output goes to a log file, and the
worker gets a result at once that says where the log is. The SDK's own Ctrl+B (`backgroundTasks`).
_Avoid_: detach, nohup, fork

**Long check**:
A worker's verification step that takes minutes: a vet/test/lint loop across modules, a build, an
image pull, a CI wait. It starts in the background (a background Bash command or a subagent), with
one log per module. The worker keeps working, reads the result before its turn ends, and never wraps
it in `timeout` (ADR-0055).
_Avoid_: blocking check, timeout wrapper

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

### Security checks

**Scan layer**:
One point where the security checks run: **write-time** (each file a worker edits), **pre-commit**
(staged files), **pre-push** (the commit range, dependencies, security tests) or **nightly**
(everything, history, images, dev URLs). Earlier layers are fast and narrow; later ones are deep
(ADR-0024).
_Avoid_: stage, phase, gate

**Finding**:
One problem a scanner reported, in one shape for every scanner: tool, rule, severity, repo-relative
file and line, message, and a **fingerprint**. A secret's value is never part of it.
_Avoid_: alert, issue, vuln

**Fingerprint**:
A finding's identity: tool, rule, file and the matched code, without the line number. A finding
keeps its fingerprint when code above it moves.
_Avoid_: finding id, hash

**Security baseline**:
A project's findings recorded once (`.security/baseline.json`), by fingerprint. They are tracked,
never blocking. Only a **new** high or critical finding blocks a layer. A baseline whose scan had a
**missing part** is *incomplete*: its `incomplete` list names the parts, and later layers warn that
old findings may show as new (ADR-0051).
_Avoid_: allowlist, ignore list, suppression

**Missing part**:
A piece of one scan that produced no result: a semgrep part (a group of `semgrepChunkFiles` files)
that timed out or failed, or a gitleaks scan with no output. It is recorded, never silently dropped
(ADR-0051).
_Avoid_: skipped file, partial finding

**Chained hook**:
The project's own git hook that ran before the kit was turned on. The kit's hook runs it after the
scan. When it is recorded but missing, the kit's hook fails (exit 1), never skips it (ADR-0051).
_Avoid_: old hook, legacy hook

**Host environment**:
What this server is: `dev` or `prod`. It is set once per host in the installed kit
(`~/.claude/security/host.json`, `{ "hostEnv": "dev" }`, written by `install.ts --host-env`). A
missing or unreadable value means `prod`. On a `dev` host the secret guard lets a worker **write** a
secret file; reads stay blocked on every host (ADR-0039).
_Avoid_: mode, stage, deployment env (that is a project's own `.env` setting, not the host's)

### Disk space

**Tier A** (disk cleanup):
Space that can be rebuilt, which the disk-cleanup tool removes on its own every day. It covers
images, build cache, stopped containers, the journal, logs, package caches, `/tmp`, core dumps,
unused rebuildable volumes, mounted cache volumes over a cap, big container logs, build outputs of
projects with no live dev server, old test artifacts and clean finished worktrees (ADR-0040,
ADR-0041).
_Avoid_: safe items, junk

**Tier B** (disk cleanup):
Space whose removal cannot be undone: named volumes that may hold real DB data, data folders of
stopped DB containers, dumps and backups, and worktrees with work in them. The tool only lists it,
each item with a stable **candidate id**. It deletes an item only when the operator approves that
exact id.
_Avoid_: unsafe items, manual items

**Live project** (disk cleanup):
A folder `/home/<p>` that a running container bind-mounts, or where a host process has its working
folder. Its build outputs stay, because a dev server uses them (ADR-0041).
_Avoid_: active project, running project

**Cache wipe** (disk cleanup):
Emptying a mounted cache volume: its running users are stopped, the volume's mountpoint is emptied,
and the same containers are started again. The volume and the containers stay (ADR-0041).
_Avoid_: cache reset, volume purge

**Test temp root** (disk cleanup):
The one folder (`$TMPDIR/neo-test-XXXX`) that a `bun test` run makes in its preload and sets as
`TMPDIR`. Every temp folder the run's tests make goes inside it, and the run removes it after the
last test, so tests leave nothing in `/tmp` (ADR-0042).
_Avoid_: test sandbox, scratch dir

**Protected** (disk cleanup):
Never touched by either tier: a running container and its volumes, anything matching a protect
pattern (`prod`, `/home/neo/data`, `/home/neo/company`), `.env` files and the security kit's pinned
scanner images.
_Avoid_: excluded, allowlisted

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
New work (a dispatch, a todo, a decision) takes only a **live** cause: the input the session works on
now, or the thread the dispatcher names with `thread`. It never takes the cause of a turn that has
already ended (ADR-0053).
_Avoid_: parent, source, context

**Thread**:
One operator message, or one engine trigger, and everything it caused, in time order — replies,
dispatches, progress, results, decisions, plans and the operator's follow-ups. A message joins a
thread only by an explicit link (a reply, or the console's thread composer). Not a **session**: one
session serves many threads, and one thread can reach many sessions.
_Avoid_: conversation, chat, session, ticket

**Thread root**:
The first message of a thread. For background work (a loop fire, an attention todo, an ingress
brief), or work the dispatcher starts with no live cause (origin `dispatcher`, ADR-0053), the engine
writes the root itself, so every thread has one.
_Avoid_: first message, parent

**Thread state**:
What a thread needs, derived from its facts: **open** (work is queued or running), **waiting** (an
open decision or approval — the operator owes an answer), **done**, or **failed** (the newest work
ended badly and nothing runs). Waiting beats open. The operator may close a thread; a new message
reopens it.
_Avoid_: status (unqualified), progress

**Superseded decision**:
An open decision the engine closed because it no longer needs an answer: the same question was
asked again later in the thread, its plan was done, dropped or executed, its plan was built by other
work (a later todo that names it ran and ended done; the plan is marked done too, ADR-0054), or it is an
older card of a plan (`replaced by plan card v<N>`). It keeps the reason in its answer (ADR-0038, ADR-0053). The waiting sweep also supersedes a
decision that was **acted on** (ADR-0045). An answer the operator gives in chat is not a supersede: the
dispatcher records it as their answer with the `decision` tool (ADR-0054).
_Avoid_: stale, auto-answered

**Expired decision**:
An open question whose work moved on without its answer (ADR-0053): it is older than
`decisionSettle.expireAfterDays`, its order ended, and later work in the same folder ended `done`.
It stops counting as waiting, but its card still takes the operator's answer, which resumes the
project. A plan card, a governor escalation, a question a todo is parked on, and a question about an
irreversible or prod action (`keepPatterns`) never expire.
_Avoid_: stale, timed out, closed

**Acted-on decision**:
An open decision whose project repository holds a commit, on any branch and made after the question
was asked, that cites the decision as `#<first 8 characters of its id>` in its message or its
changes. The cited commit is the evidence. Workers cite the decision they act on (ADR-0045).
_Avoid_: implemented, done decision

**Waiting sweep**:
The hourly pass over the WAITING threads (loop `waiting-sweep`). The engine first applies the rules
it can check (ADR-0038, acted-on). A worker then judges only the decisions that have new evidence in
their repository, and closes a decision only with a commit or a file as evidence. At the end the
engine sends **one** reminder of what still needs the operator, and only when that list changed
(ADR-0045).
_Avoid_: cleanup, stale-bot, auto-close

**Operator reminder**:
The one message in which the waiting sweep lists the threads that still need the operator: the
thread ref, the project, and the open question. It is sent only when the list is not empty and is
different from the last one sent.
_Avoid_: digest (that is the daily attention digest), nag, notification

**Waiting item** (ADR-0054):
One thing that holds work back: an open decision, a todo parked on a decision, or a plan held for
Approve & build. It always has an **owner** (`operator`, `sweep` or `engine`) and a **next
action** (the one-line ask, "judge against the repo", or "resumes when X"). A thread is WAITING
only while it has a waiting item. The Queue and Threads views read the same list.
_Avoid_: pending, blocked, stuck

**Interrupted order** (ADR-0054):
An order that never recorded an outcome and had no activity after a later engine boot. At boot the
engine records its outcome as `interrupted`, so a question it raised can expire.
_Avoid_: orphan, lost order

**Close (a thread)**:
The operator's action that marks a thread done whatever its facts say: its open decisions are
dismissed and the todos parked on them cancelled. A new operator message in the thread reopens it.
_Avoid_: archive, resolve, delete

**Trace**:
The tree of everything one message or thread produced, read from the ledger. What `/trace` shows.
_Avoid_: log, history, audit

### What needs the operator

**Decision card**:
One question a worker raises for the operator, written for a non-technical reader: a title, the
context (what is happening and why a choice is needed), 2–5 numbered options each with a short
label and an explanation of its effect and risk, and the recommended option with a one-line reason.
The engine rejects a card with a blank part, an over-long button label, or unexplained jargon (an ADR
number or a code name). One decision per card (ADR-0049).
_Avoid_: question (unqualified), prompt, poll

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

### Projects telling each other

**Project note**:
A typed record that one project sends to another through the engine: a kind, a severity, a title, a
body, refs and the sender's own `ref` (for example `D16`). It is an attention item on the **target
project** (source `note`), so it shows on the dashboard and in the digest, and it can become a todo.
A note never starts work by itself (ADR-0043). A note from the main agent also reaches a running
worker of the target at its next step (**Live note**, ADR-0050).
_Avoid_: message, mail, inbox (the inbox is customer mail), handoff, brief

**Sender project / target project**:
The project whose session sent a note, and the project the note is for. The engine sets the sender
from the session; a worker never names it. A target is a project folder under the work root, never
the sender itself and never a desk.
_Avoid_: from/to, source (that is the attention source), recipient

**Note kind**:
What a note is for: `finding` (a defect or a risk the target owns), `fyi` (information only) or
`request` (the sender asks the target to do work). The kind decides only how loud the note is. No kind
starts work; the operator's **→ todo** does.
_Avoid_: type, category, priority

**Note resolution**:
How a note closed, from a fact the engine can check: `fixed` at a commit that exists in the target
repository on a branch, `not_needed` or `duplicate` with a reason, a todo made from the note that
ended `done`, the sender's `withdraw`, or the operator's dismiss. A resend with the same `ref` opens a
resolved note again.
_Avoid_: done, closed (unqualified), acked

**Notes block**:
The short list the engine puts at the start of a fresh session: the open notes for this project, and
the state of the notes it sent. Titles, ids and senders only, capped in size; never on a resume, a
tainted run or the customer path. It tells the worker that notes are information, not orders.
A running worker gets new notes from main live instead (ADR-0050).
_Avoid_: inbox, mailbox, notifications

### Agents asking each other

**Main agent**:
The company session (chief of staff, `/home/neo/agent`) as a note target or sender. In a worker's
`project_notes` call it is the target `main`, the one desk a note may address. It is the same session
as the **dispatcher**; the word is used only for notes and questions.
_Avoid_: company (in worker-facing text), parent, boss

**Question (note)**:
A project note of kind `question` that a worker sends with `project_notes ask` to the main agent or
another project, with a **need**: `info` (a fact), `resource` (a shared tool or key) or `help` (how
to do something). A consult run answers it, and the note resolves as `answered` with the answer on
it. A question can make another agent answer; it can never make it act (ADR-0050).
_Avoid_: message, request (that is the note kind that asks for work), dispatch

**Consult run**:
The short, read-only one-shot run that answers one question in the target's folder. It forks the
target's last saved session when the target is between turns, so it knows what that agent knows;
otherwise it starts fresh there. It can read, search and look up tools; it cannot write, run
commands, send notes, dispatch or raise a decision. It is never a registry session, so it never
makes a project busy.
_Avoid_: sub-agent, helper, side session, fork (alone)

**Live note**:
A note from the main agent (`fyi` or `request`), or a held answer, that the engine hands to a
running worker of the target folder at its next step instead of waiting for its next fresh start.
It is framed as information, never a brief: it starts no work and never wakes an idle session. All
other notes wait for the notes block (ADR-0043).
_Avoid_: tell, push, order, interrupt

**Next step (delivery)**:
The running turn's next tool boundary, where the SDK attaches a user message sent with priority
`next` (follow-up timing `steer`). A brief queued into a busy session uses timing `after-turn`
(priority `later`) and never steers. A Codex session has no next step; it receives at its next turn.
_Avoid_: safe point (that is the context checkpoint, ADR-0021), interrupt, inject

**Answer wait**:
How long `project_notes ask` holds the asking worker for the answer (`notes.questions.answerWaitMs`).
The stall limit does not run during it, as with an operator decision. A later answer becomes a live
note to the asker.
_Avoid_: timeout (alone), deadline

### Shared tools

**Tools catalogue**:
The single tracked list of the shared tools that Neo and every project can use, as one **tool card**
per tool (ADR-0044). If a tool has no card, workers are not told about it.
_Avoid_: registry, marketplace, tool list, toolbox

**Tool card**:
One tool's record in the catalogue: its purpose, when to use it, how to call it, the NAMES of its env
keys (never the values), its limits and cost, its owner, its **tool kind** and its **card status**.
_Avoid_: tool doc, manifest, plugin

**Tool kind**:
How a worker reaches a tool. `mcp` is an MCP server that a worker is given. `cli` is a command on this
host. `api` is an external HTTP API whose key only the engine holds. A skill is not a tool kind:
skills are how a worker learns about tools.
_Avoid_: type, category, integration

**Card status**:
Where a card is in its life. `active`: workers are told about it. `candidate`: it was evaluated but is
not offered (for example ScaleDown). `retired`: it is kept for history only. Only `active` cards
reach workers.
_Avoid_: enabled, state, stage

**Tool skill**:
The skill that the engine generates from an `active` card and installs in the user's skills, so that
every Claude worker in every project sees the card's when-to-use line. It is never edited by hand.
_Avoid_: tool prompt, tool instructions

**API relay**:
The engine's one worker tool that calls an `api`-kind card when a worker asks for it. The engine adds
the key from its own env, so the key never reaches a worker or a project. The engine never calls an
API on its own initiative. The worker decides; the engine acts.
_Avoid_: proxy, gateway, wrapper

**Data leaves host**:
A card's flag for an API that sends the text of a call to a third party. A relay call to such a card
refuses text that matches a secret pattern. Customer and tainted runs never get the API relay.
_Avoid_: external, remote, egress (unqualified)

**Recipe**:
A tool card of kind `recipe`: a named chain of steps over other cards for a task that comes up
again and again, such as a deploy check, a read-only prod query, an E2E test or a store build.
_Avoid_: playbook, workflow (a workflow is a multi-agent script), runbook

**Tool search**:
The engine's ranked word search over the catalogue and the installed skill descriptions, for a piece
of task text. It is BM25 plus a usage count, with no AI. A worker reaches it as `tools_for`. It
returns candidates; the worker chooses.
_Avoid_: tool recommendation, tool matching (both suggest that the engine judges)

**Tools hint**:
The few lines the engine puts at the start of a fresh brief, naming the best tool-search matches
for that brief, plus "ask `tools_for` for more". If nothing scores above the threshold, there is no
hint.
_Avoid_: tool suggestions, tool context

**Tool miss**:
A tool search whose best score is below the threshold. It is recorded so that the gaps in the
catalogue can be seen and filled, by a worker that improves the cards.
_Avoid_: failed search, no result

**Usage count**:
How many orders in the last 30 days ended `done` after they used a card: a call its `usage` globs
match, or a load of its generated skill (only calls allowed without asking). It raises the card in tool
search. It counts orders, not calls.
_Avoid_: popularity, hits, calls (one order may make many calls)

**Skillify item**:
An attention item (source `skillify`) the engine raises when the operator gave one project the same
kind of task on at least `tools.skillifyMin` different days in 30 days and no card or skill fits it. It asks for a
recipe or a skill; a worker writes it. Engine-made todos (plan steps, continuations, todos from an
attention item) and cancelled todos never count.
_Avoid_: automation suggestion, AI suggestion (the engine only counts words)

**Miss mark**:
The point up to which the tool misses are handled, set by the `tools-enrich` worker with
`misses.ts mark`, through the misses it listed, only on a card branch the engine checked or a stated
reason. The loop's goal is met when
no miss is newer than the mark.
_Avoid_: ack, checkpoint (a checkpoint is a context handoff)

**Project capabilities**:
What one project can use: the active cards whose scope includes it, plus its own MCP servers and
skills. They are worked out read-only when they are asked for, and never stored in the project.
_Avoid_: manifest (there is no file), permissions

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
it), `done`, or `abandoned`. Moves only on an operator tap or a fact the engine can read. A plan the
registry first sees finished is recorded `done` and never sent; it goes back to `draft` if its file
gets work again (ADR-0035). A sent plan whose file is finished at a run end becomes `done` at the
commit it was seen at (ADR-0036).
_Avoid_: phase

**Plan state**:
Where a plan is, as the operator sees it, derived from its status and gate (ADR-0036): `draft`,
`awaiting` (sent, waiting for Approve & build), `info` (a small plan the worker is building now),
`approved` (rows approved before ADR-0036), `building`, `done`, `dropped`. The card's state line and
the console show it.
_Avoid_: plan status (the stored field)

**Plan gate**:
What a plan version's card asks for (ADR-0036). `approval`: the operator must Approve & build before
any implementation. `info`: the card informs, and the worker goes on. A **big** plan gets
`approval`: front matter `approval: required`, more tasks or steps than `plans.approval`, or a line
that matches `plans.approval.patterns` (migrations, auth, money, deploy, deletes). A worker can make a
plan big but never small. At a run end every unfinished plan waits (`approval`), because nobody is
building it any more.
_Avoid_: size, risk level

**Held plan**:
A big plan its writing worker is stopped at (ADR-0036). The worker's tool calls are denied with a
STOP reason until the operator acts, except reads, Neo's own tools and edits to plan files. Its
decision is blocking: a todo run parks on it. **Approve & build** answers that decision, so the same
worker resumes. A held session takes no new brief: dispatch refuses it (`plan_held`), and a todo for
that folder waits queued until the hold lifts (ADR-0052).
_Avoid_: paused plan, blocked plan

**Approve & build**:
The plan card's one primary button (`approve`). On a held plan it resumes the worker that wrote it.
Otherwise it is an Execute (ADR-0034): judged, then queued once. The engine verb `execute` stays
only for old cards and the API.
_Avoid_: Approve then Execute

**Plan card**:
One version of a plan as the operator receives it: the file, a caption with its project, title,
version, thread ref and state line, and the buttons its state offers (`planActions`). Every state
change edits the same message (ADR-0036), and a newer version marks the older card "superseded".
An `awaiting` card is a tracked decision, so it is reminded, and a reply to it is the operator's
change request. An `info` card is not a decision.
_Avoid_: plan message, plan notification

**Design unit**:
A spec and the plans derived from it: each plan file whose text names the spec's path. A spec is a
file under a `specs/` folder. Execute on either one acts on the unit: a spec resolves to its one
open plan, and one active todo for the unit blocks the others (ADR-0034).
_Avoid_: feature, epic, plan set

**Execute verdict**:
What the engine decides before an Execute queues anything (ADR-0034). It reads the file, git, the
todos and the live sessions:
- `done`: nothing left a worker may do.
- `busy`: the unit is already queued or running in the same repository.
- `choose`: a spec has several open plans.
- `run`: a todo starts, in the repository's main checkout when the file is there.

Every verdict except `run` is a reply that says why nothing started.
_Avoid_: check, guard, dedupe

**Same repository**:
Folders that share one git common dir (`git rev-parse --git-common-dir`): a main checkout and all
its worktrees, whatever their folder names. The **main checkout** is the first entry of
`git worktree list`.
_Avoid_: same project, same folder

**Operator-gated step**:
A plan step a worker must not do alone (push, deploy, restart, ask the operator…), matched by
`plans.gatedStepPatterns`. A plan whose only unticked steps are gated counts as done for Execute,
and for the registry's first sight (ADR-0035).
_Avoid_: manual step, blocked step

### The running engine

**Running build**:
The engine code the daemon actually runs — the commit it booted from, recorded at boot.
_Avoid_: current version, deployed version

**Build label** (ADR-0056):
The small line under the console logo that names the running build: `v<package version> · <short
boot commit>`, both read once at boot. It never reads `dev` or the files on disk later, so it cannot
show a build that is not running.
_Avoid_: version badge, app version

**Restart-gated change**:
A change that exists on disk but not in the running build: a commit after the boot commit, a fix
branch not merged yet, an update that needs a restart. Computed from git and the updater, never
remembered by hand. Wider than a **restart-gated update**, which is one kind of it.
_Avoid_: pending restart, waiting fix

**Integration branch** (ADR-0054):
The branch where finished work collects before it runs (`restart.integrationBranch`, default `dev`).
Its commits that are not in the running build are reported as one restart-gated item. A fix is
**live** when its commit is in the running build. Until then it is "built on dev", never "done".
_Avoid_: staging, next

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

**Staged attachment**:
A file the operator attached in the console composer but has not sent yet. It is already saved in an
inbox, and the web channel holds a one-shot token for it. Send turns the text and its staged
attachments into one message (`withAttachments`), so the worker gets the files in the same turn as
the text (ADR-0026).
_Avoid_: upload (the transfer, not the thing), pending file

**Compose box**:
Any console field that takes a message or a brief: the main composer, the thread reply, the
new-project task, the inbox instructions and notes (Enter sends), and the customer draft and loop
prompt (Enter is always a new line). One shared component (`compose-box.ts`), bound once by
delegation. It is a multi-line textarea that grows to a max height and keeps every line break. Its
text takes its own direction (`dir="auto"`) (ADR-0033).
_Avoid_: input, text field, chat box

**Line direction**:
The direction of one line of a message, taken from its own first strong letter (`dir="auto"`). An
Arabic line runs right-to-left and the English line under it left-to-right. Numbers stay an LTR run
(ADR-0033).
_Avoid_: RTL mode, message direction

**Step line**:
A line the engine itself writes about a worker's tool use: `🔧 Tool: target`, `↳ output`, `⚠️ ↳ error
output`, `🔓 auto-approved: reason`. Its payload (a command, an output) is shown as code, never parsed
as Markdown (ADR-0025).
_Avoid_: log line, tool message

**Line tone**:
The colour class of a feed line: tool, result, error, warn, done, approval, info or none. Derived
from the line's step prefix or its leading priority accent, never from AI.
_Avoid_: status, level, severity

**Folded block**:
A code block longer than `COLLAPSE_LINES` lines, shown at that height with a fade and a "show all
lines (N)" toggle until the operator unfolds it. Display only: the copy button copies the whole block.
_Avoid_: truncated, hidden

**Markdown file link**:
An absolute path to a `.md` file inside a feed line (inline code or plain text), shown as a link with
a download icon. Clicking it downloads the file through `/md-file`. The server serves it only to the
admin session, and only when the real path is a regular `.md` file inside a **readable root**
(ADR-0046). The path stays LTR in RTL text.
_Avoid_: file link (unqualified), attachment (that is a staged or sent file)

**Readable root**:
A folder the console may serve Markdown files from (`mdFiles.roots`, default `[workRoot]`). A path
counts only by its real path (symlinks resolved), never by how it was written (ADR-0046).
_Avoid_: allowed dir, whitelist, sandbox

**App shell**:
The public, static, non-personal files the installed console may keep on the device: the web app
manifest, the icons and the offline page (ADR-0022). Never the page at `/`, the bundle, API answers,
the live feed or anything from login.
_Avoid_: cache, offline app, bundle

**Bundle version**:
The content hash of the console's browser bundle. The page loads `/app.js?v=<bundle version>`, so a
new bundle is a new URL and no cached copy of an old one can run under a new page (ADR-0023).
_Avoid_: build number, release, cache-buster

**Installed console**:
The same web console, added to a phone's home screen from the browser (a PWA). It opens without the
browser's address bar and uses the same session cookie. It is not a second app.
_Avoid_: mobile app, APK, native app

**Narrow layout**:
The console's layout on a phone (≤ 768 px wide). The sidebar is a drawer (from 1024 px down) and a
list and its detail never show side by side.
_Avoid_: mobile version, mobile site

**Detail view**:
In the narrow layout, the full-width pane of one thread or one project, opened from its list and
left with a back button.
_Avoid_: modal, page

**Draft version**:
A counter on an inbox item, bumped by every change to its draft reply. A Send names the version the
operator approved. The send is refused (*stale*) when the draft changed since, or the item was
already replied (from any channel). A second Send while one is in flight is refused (*busy*). This is the send's
idempotency key: a customer never gets a reply twice or a reply the operator did not see.
_Avoid_: revision, draft id
