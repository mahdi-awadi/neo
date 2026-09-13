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

**Loop**:
A trigger, a repeated action, and a goal that ends it. Always background work.
_Avoid_: cron job, automation, schedule

**Escalation**:
The governor stopping a worker to ask the operator for permission to do something risky.
_Avoid_: approval request, prompt, confirmation
