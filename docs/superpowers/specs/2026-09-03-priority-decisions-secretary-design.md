# Priority tags · Decisions queue · Secretary loop — design

Date: 2026-09-03
Status: DESIGN — awaiting operator approval. Implement nothing yet.
Author: company session (design pass)

## 1. Problem

Neo runs many projects at once. It sends the operator a high volume of messages.
Progress notes, "done" notes, error notes, and the questions that BLOCK a project all
arrive as equal messages on one Telegram stream. The operator cannot tell signal from
noise. Blocking questions get lost. The operator muted the bot, so now the important
messages are also missed.

Two things must be true:
- No important message is lost.
- The operator keeps getting reminded of the decisions that wait on them.

## 2. Goal (operator-approved direction)

1. Give every outbound message a deterministic PRIORITY tag: `DECISION`, `ALERT`,
   `PROGRESS`, or `DONE`. The tag comes from intent the sender already has — no AI in
   the engine.
2. Split the output into two surfaces: a muted "firehose" for `PROGRESS`/`DONE`, and a
   high-priority "Decisions" channel for `DECISION`/`ALERT` that the operator keeps
   notified.
3. Keep a persistent pending-decisions queue in the ledger. Each `DECISION` stays OPEN
   until the operator answers. Answering resolves it and unblocks the project. The queue
   survives a daemon restart.
4. Add a secretary loop: a scheduled worker (latest model) that reviews the open queue,
   sends ONE digest ("N things wait on you across M projects: …"), and escalates
   reminders for stale items.
5. Later (not now): a web dashboard of the decision board.

## 3. What the engine already gives us

The current code makes this feature mostly a matter of TAGGING and ROUTING existing
message flows, plus one new durable table and one new loop. Key facts:

- Every outbound operator line already flows through one function: `reply(chatId, text,
  project)` in `pipeline.ts` (Telegram: `send()` + `bus.mirror`), and the same shape in
  `dispatch.ts` and the loop path. This is the ONE choke point to add a priority tag.
  - `src/engine/dispatch.ts:418` (worker text → `deps.reply`, PROGRESS)
  - `src/engine/dispatch.ts:563` (the `✅ finished` / `⛔ failed` line)
  - `src/frontends/telegram.ts:190` (pipeline `reply` → `send` + mirror)
- Blocking approvals already exist: the governor escalates a risky tool through
  `askApproval(chatId, reason)` → Telegram Allow/Deny inline buttons
  (`src/frontends/telegram.ts:194`). This IS a DECISION today; it is just not tagged,
  not persisted, and not routed to a quiet-proof channel.
- Two-surface fan-out already exists in spirit: the operator-bus mirrors one line to
  every OTHER surface (`src/engine/operator-bus.ts:46`). The `BusLine` union
  (`operator-bus.ts:14`) is where a `priority` field belongs.
- Reply routing already resolves "the operator replied to a worker message → route the
  follow-up into that project" (`src/engine/reply-routing.ts:52`), backed by the ledger
  `message_routes` table. Answering a decision reuses this exact machine.
- The ledger has a clean table-plus-methods pattern and an amortised-prune precedent
  (the `events` table + `recordEvent`/`listEvents`, `src/engine/ledger.ts:195,330`). The
  decisions table follows it.
- The loop runtime is data-driven and has the exact pattern the secretary loop needs:
  a `LoopDef` marked with a flag (`dreamMemory`) whose folder/prompt are rewritten from
  config at fire time (`resolveDreamLoop`, `src/engine/loops.ts:306`), which can no-op
  before spending a worker run (`dreamGateOutcome`, `loops.ts:322`), and which attaches a
  special MCP server only for that one loop (`loopRunExtras`, `loops.ts:364`). The
  secretary loop is the same shape.
- The firewall is by construction: the customer/ingress path passes no `dispatch`,
  `memory`, `stitch`, or `playwright` deps, so those tools never attach
  (`dispatch.ts:613` `neoMcpServers`). A new worker→engine decision tool attaches the
  same way, so customer-tainted work can never raise an operator decision.

## 4. Options considered (brainstorm)

### 4.1 How a worker signals a DECISION (the hard part)

The tag must be deterministic. The engine has no AI, so it cannot read a worker's prose
and decide "this is a question." The signal must come from the worker's INTENT, which it
expresses through a structured act.

- **Option A — infer from text (rejected).** Parse worker output for "?" or "should I".
  This is AI-like heuristic guessing in the engine. Brittle, wrong often, against the
  "no AI in the engine" rule. Rejected.
- **Option B — a dedicated worker→engine tool `ask_operator` (CHOSEN).** The worker
  calls a small MCP tool when it needs an operator answer. The tool call is the
  deterministic intent. The engine tags it `DECISION`, enqueues it, and posts it to the
  Decisions channel. This matches how Neo already exposes worker→engine acts
  (`send_file`, `dispatch`, `sessions`) as MCP tools, and it is firewalled by
  construction (operator paths only). Chosen.
- **Option C — only reuse the governor escalation (too narrow).** Escalations cover
  "risky tool needs allow/deny" but NOT "which of these two designs do you want?" or
  "I need the API key." A worker's real blocking question is not always a tool
  escalation. So we do BOTH: escalations are one DECISION source, `ask_operator` is the
  other. Chosen together (B + the existing escalation).

### 4.2 Where DECISION/ALERT go on Telegram

- **Option A — a dedicated Telegram chat/group the operator keeps unmuted (RECOMMENDED).**
  One bot, one config knob (`decisionsChatId`). The operator mutes their normal DM
  (firehose) and leaves the Decisions chat notified. Simple, no second token.
- **Option B — a forum topic (thread) in a group.** Telegram supports topics
  (`message_thread_id`). Keeps one chat, two threads. More moving parts (the operator
  must make the DM a forum group; per-topic mute is fiddly). Not recommended for MVP.
- **Option C — a second bot** whose notifications the operator never mutes. Two tokens,
  two logins, more setup. Rejected unless the operator wants hard isolation.

Recommendation: Option A. If `decisionsChatId` is unset the feature degrades safely —
decisions still get tagged, persisted, and reminded, but they post to the normal DM
(today's behavior, plus the digest and the queue).

### 4.3 Does the digest need a worker (AI), or can the engine render it?

- **Engine-rendered digest (deterministic).** The engine already has all the data (the
  open-decisions rows). It can render "3 decisions wait on you across 2 projects: …" with
  zero AI. Cheapest, always-on, YAGNI-friendly.
- **Worker digest (operator-approved direction).** A scheduled worker on the latest model
  reads the queue and writes a warm, prioritised, human-secretary digest. Adds judgment
  (grouping, urgency phrasing, "this one has waited 2 days").

Chosen: a worker loop (per the operator's direction), but grounded on engine-rendered
data. The engine reads the queue deterministically and interpolates a compact, factual
list into the loop prompt. The worker only phrases and prioritises — it never invents
facts, and it never mutates the queue. This keeps the engine AI-free and the digest
grounded. A deterministic-only fallback stays available as a config flip if the worker
digest proves too costly (see Open Questions).

## 5. The design

### 5.1 Priority model — `src/engine/priority.ts` (new, pure, AI-free)

```ts
export type Priority = "decision" | "alert" | "result" | "progress" | "done";

/** Which surface a priority goes to. decision+alert+result → the high-priority
 *  Decisions channel; progress+done → the muted firehose. Pure function, unit-tested. */
export function surfaceFor(p: Priority): "decisions" | "firehose";

/** A short leading marker for the line (e.g. "🔵 DECISION", "🔴 ALERT", "✅ RESULT"). Rendering only. */
export function priorityBadge(p: Priority): string;
```

The default priority everywhere is `progress`, so any un-tagged line keeps today's
behavior (it lands in the firehose). We only tag the specific call sites that carry
DECISION/ALERT/RESULT/DONE intent.

**`result` vs `done` — the split is the call site, never the text (added later).**
The operator keeps the Decisions group unmuted for two things only: decision
questions and important **outcomes**. So a genuine job outcome must reach the group,
but routine chatter must not. We split the two completion sites by intent:

- `result` = a background job/**dispatch** completion (the `"<name> finished: …"`
  line in `dispatch.ts` — an outcome the operator walked away from: shipped, fixed,
  committed, build-live). It routes to the Decisions group.
- `done` = an **interactive-turn** completion (`pipeline.ts` — the operator is
  already in that DM conversation). It stays in the muted DM firehose; an echo to the
  group would only be noise.

Because the decision is made by the emit site — not by scanning prose — streamed
`progress` can never be promoted to the group, and the model stays AI-free.

### 5.2 Deterministic tag sources (the full map)

| Source | Priority | Where |
|---|---|---|
| Governor escalation (`askApproval`) | `decision` | `telegram.ts:194` |
| New `ask_operator` MCP tool | `decision` | `dispatch.ts` `neoMcpServers` |
| Dispatch failure line (`⛔ …: failed`) | `alert` | `dispatch.ts:563` |
| API give-up notice (`apiFailureNotice`) | `alert` | `dispatch.ts:469`, `pipeline.ts` |
| Loop-failure alert (`⚠️ loop … failed`) | `alert` | `daemon.ts:186` |
| Stuck-session watchdog alert | `alert` | `daemon.ts:145` |
| Dispatch/job completion line (`✅ … finished`) | `result` | `dispatch.ts` finish path |
| Interactive-turn completion line | `done` | `pipeline.ts` turn end |
| Streamed worker text, `→ dispatching`, `→ queued`, iteration progress | `progress` | `dispatch.ts:418,305,300`, loops |
| Secretary digest | `decision` (or a `reminder` sub-kind) | secretary loop |

No other change to what a message SAYS — only which surface it goes to and whether it is
enqueued.

### 5.3 Two-surface routing (Telegram frontend)

`reply` gains an optional `priority` argument end to end:

- `PipelineDeps.reply(chatId, text, project?, priority?)` (`pipeline.ts`) and the same on
  `DispatchDeps.reply` (`dispatch.ts:56`) and the loop reply.
- `operator-bus.ts` `BusLine` `reply` variant gains `priority?: Priority`.
- In `telegram.ts`, `send()` and the operator-bus sink route by `surfaceFor(priority)`:
  - `firehose` → the admin DM (`admin.adminId()`), today's path.
  - `decisions` → `cfg.decisionsChatId` when set, else the admin DM.
- A DECISION/ALERT line posted to the Decisions channel is ALSO recorded in the queue
  (§5.4) and its channel `message_id` is stored, so a reply to it resolves it (§5.6).

The web console gets a mirrored copy of both surfaces as today (visibility only). The
priority is on the mirrored `BusLine` so the web can style it; deep web routing is
deferred.

### 5.4 Pending-decisions queue — ledger table `decisions`

New table (follows the `events`-table precedent at `ledger.ts:195`):

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id                 TEXT PRIMARY KEY,   -- uuid
  kind               TEXT NOT NULL,      -- 'decision' | 'alert'
  project            TEXT,               -- basename tag, e.g. "eticket-v3"
  folder             TEXT,               -- resume target for the answer
  order_id           TEXT,               -- raising order (bookkeeping)
  session_id         TEXT,               -- sdk session id for resume, if known
  chat_id            INTEGER,            -- raising chat (SUB_CHAT for dispatch)
  question           TEXT NOT NULL,      -- the decision/alert text
  status             TEXT NOT NULL,      -- 'open' | 'answered' | 'dismissed'
  created_at         INTEGER NOT NULL,
  answered_at        INTEGER,
  answer             TEXT,
  decision_chat_id   INTEGER,            -- the channel the decision message was posted in
  decision_message_id INTEGER,           -- message id in that channel (reply-routing + edit)
  last_reminded_at   INTEGER,
  reminder_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_msg ON decisions (decision_chat_id, decision_message_id);
```

Ledger methods (pure bookkeeping, no AI):

```ts
openDecision(rec: NewDecision): string;                 // returns id
setDecisionMessage(id, chatId, messageId): void;        // after the channel post
listOpenDecisions(): DecisionRow[];                      // status='open', oldest-first
decisionByMessage(chatId, messageId): DecisionRow | undefined;
resolveDecision(id, answer, at): void;                   // status='answered'
dismissDecision(id): void;                               // status='dismissed'
noteDecisionsReminded(ids: string[], at: number): void;  // stamp reminder fields
```

Retention: decisions are low-volume, but prune `answered`/`dismissed` rows older than a
generous window in an amortised batch (same style as events), keyed off a config
`decisionsKeep`.

### 5.5 Raising a decision

- **`ask_operator` MCP tool** (new, in `neoMcpServers`, attached to ALL operator project
  workers like `send_file` — NOT gated behind `opts.dispatch`, and NEVER on the
  customer/ingress path):

  ```
  ask_operator(question: string, options?: string[])
  ```

  On call, the engine: (1) `openDecision({kind:'decision', project, folder, order_id,
  session_id, chat_id, question})`; (2) posts the question to the Decisions channel via a
  DECISION-priority `reply`, capturing the channel `message_id` back into the row
  (`setDecisionMessage`); (3) records an `events` row `decision_raised`; (4) returns to
  the worker a short note: *"Your question is with the operator (decision #<short-id>).
  Check-point your work and stop — the operator's answer will resume this session as a
  follow-up."* This matches the single-shot dispatch + resume-on-reply model and the
  known rule that a dispatched worker cannot self-resume on a background wait.

- **Governor escalation** (`askApproval`): unchanged as the blocking allow/deny gate, but
  it ALSO calls `openDecision({kind:'decision', question: reason, …})` before showing the
  buttons and `resolveDecision`/`dismissDecision` when a button is pressed. So an ignored
  escalation shows up in `/decisions` and the digest. If the daemon restarts while an
  escalation is pending, the in-memory resolver is lost (the worker session is gone too),
  but the decision row stays OPEN so the digest surfaces it — no silent loss.

- **ALERT** rows (`kind:'alert'`) are opened for failures (dispatch/API/loop). They need
  no answer; they resolve when the operator dismisses them, or auto-expire under
  retention. They still show in the digest count until dismissed.

### 5.6 Answering resolves + unblocks

In the Telegram text handler, BEFORE `routeReply` (`telegram.ts:319`):

1. If the message is a reply, look up `ledger.decisionByMessage(chatId,
   replyToMessageId)`.
2. If a decision row is found and still `open`:
   - `resolveDecision(id, answer=text, now)`.
   - Deliver the answer into the raising project's session using the SAME resume path
     `routeReply` already builds: find the open session by `folder`, else re-register a
     focused, idle, resume-seeded entry from `ledger.lastSessionFor(folder, chat)`, seed
     it with the decision question as context (reuse `repliedContextBrief`), then
     `handleMessage` it. This unblocks the project.
   - Post a short `✅ answered` note.
3. Else, fall through to `routeReply` unchanged.

This means a decision can be answered from the Decisions channel by a normal Telegram
reply gesture — no new command needed for the common case.

### 5.7 Secretary / reminder loop

A new built-in `LoopDef` marked `secretary: true`:

- **Trigger:** cron, a few times a day (default `0 8,13,18 * * *` server-local; a config
  knob `secretaryCron`). Disabled by default; the operator turns it on (or it auto-enables
  when `decisionsChatId` is set — see Open Questions).
- **Folder:** `cfg.companyFolder` (rewritten at fire time, like `resolveDreamLoop`).
- **Model:** the latest model, via a new `workers.secretary` profile
  (`WorkerPathName` gains `"secretary"`). Default recommends the newest model in config.
- **Fire path (`resolveSecretaryLoop`, mirrors `resolveDreamLoop`):** the engine reads
  `ledger.listOpenDecisions()` deterministically, renders a compact factual list (project,
  age, reminder count, question), and interpolates it into the loop prompt at
  `{{OPEN_DECISIONS}}`. It also stamps `noteDecisionsReminded(openIds, now)`.
- **Silence gate (`secretaryGateOutcome`, mirrors `dreamGateOutcome`):** if
  `listOpenDecisions()` is empty, return a completed 0-iteration outcome and run NO
  worker — a quiet queue means a quiet secretary (same "only worker text reaches the
  operator on a scheduled fire" contract as other reminder loops).
- **Action:** the worker writes ONE digest as its text reply: "N things wait on you
  across M projects", grouped by project, oldest/stalest first, with a clear ask per item.
  It emphasises items past a staleness threshold (config `secretaryStaleHours`, default
  24) as escalations. The digest streams out as a DECISION-priority line → the Decisions
  channel.
- **Goal / bounds:** fire-once (goal never met + `maxIterations: 1`, the established
  reminder-loop shape), `budgetUsd` small (e.g. 2).
- **Read-only over the queue:** the worker never resolves/dismisses/edits decisions — only
  the operator (answer/dismiss) or the engine (on completion) changes state. No decisions
  MCP tool is needed for the worker; the data comes through the prompt.

### 5.8 `/decisions` command

A new COMMANDS entry (`commands.ts:87`): `/decisions` lists open decisions (project, age,
reminder count, question) with tappable actions to jump to / dismiss each. Web console
gets a read view for free via the mirrored lines; a full board is deferred.

## 6. Integration map (files · functions · lines)

New files:
- `src/engine/priority.ts` — `Priority`, `surfaceFor`, `priorityBadge` (pure).
- `tests/priority.test.ts`, `tests/decisions.test.ts`, `tests/secretary-loop.test.ts`.

Changed files:
- `src/engine/operator-bus.ts:14` — add `priority?` to the `reply` `BusLine`.
- `src/engine/ledger.ts:112` — add the `decisions` table + the six methods; `:195,330`
  is the precedent to copy (amortised prune keyed off `decisionsKeep`).
- `src/engine/dispatch.ts`
  - `:56` `DispatchDeps.reply` gains `priority?`.
  - `:418` worker `onMessage` stays PROGRESS (no change beyond the signature).
  - `:563` tag `✅`→DONE, `⛔`→ALERT; `:469` `apiFailureNotice`→ALERT.
  - `:613` `neoMcpServers` — add the `ask_operator` tool (all operator paths); thread a
    `ledger`+`decisions`+`postDecision` dependency through `DispatchDeps`.
- `src/frontends/telegram.ts`
  - `:42` `makeTelegramSink` / `:153` `send` — route by `surfaceFor(priority)` to
    `decisionsChatId` vs the DM; capture the Decisions-channel `message_id` into the row.
  - `:190` pipeline `reply` — accept + forward `priority`; mirror it on the bus.
  - `:194` `askApproval` — `openDecision` + route to Decisions channel; `:466` resolve on
    button press.
  - `:319` reply handler — `decisionByMessage` check BEFORE `routeReply`.
- `src/engine/reply-routing.ts:52` — reuse `repliedContextBrief` and the resume-seed
  path; optionally expose a small helper so the decision-answer path shares the exact
  session-seeding code (no duplication).
- `src/engine/loops.ts` — add the secretary `LoopDef` (`:201` `LOOPS`), `secretary`
  flag on `LoopDef` (`:33`), `resolveSecretaryLoop` (mirror `:306`),
  `secretaryGateOutcome` (mirror `:322`), prompt interpolation in `startScheduledLoop`
  (`:460`).
- `src/engine/scheduler.ts` — no change (the secretary loop rides the existing tick).
- `src/daemon.ts`
  - `:114` `loopReply` — a secretary/digest line routes to the Decisions channel.
  - `:176` `start` — pass the ledger so `resolveSecretaryLoop` can read the queue; the
    loop is already picked up by `effectiveLoops`.
  - `:145,186` watchdog + loop-failure alerts → ALERT priority + `openDecision`.
- `src/engine/commands.ts:87` — add the `/decisions` command; `:480` help line.
- `src/config.ts`
  - `:47` `WorkerPathName` gains `"secretary"`; `:217` defaults gain
    `secretary: {}` (recommend the latest model in `config.json`).
  - `NeoConfig` gains `decisionsChatId?: number`, `secretaryCron: string`,
    `secretaryStaleHours: number`, `decisionsKeep: number` (env→file→default precedence,
    documented in `docs/CONFIG.md`).
- Docs: update `docs/CONFIG.md` (new knobs), `docs/HISTORY.md` (the feature narrative),
  `README.md` (the two-surface behavior), `docs/loops.md` (the secretary loop).

## 7. Firewall / compliance check

- The `ask_operator` tool attaches through `neoMcpServers`, which the customer/ingress
  path never calls with the operator deps — so customer-tainted work can never raise a
  decision or reach the Decisions channel. Same guarantee as `dispatch`/`memory`.
- No AI is added to the engine. The engine only tags (deterministic map), routes
  (deterministic `surfaceFor`), stores (ledger), and renders queue data. The only AI is
  inside the secretary loop worker (an SDK worker on the subscription — own work), exactly
  like every other loop.
- Machine-local state stays out of tracked files: `decisionsChatId` and secretary knobs
  live in `config.json`/env, not in tracked docs. The queue lives in `data/ledger.db`.

## 8. Phasing (see the plan doc)

- MVP = Phase 1 (priority + two-surface routing) → Phase 2 (decisions queue + escalation
  recording + `ask_operator` + `/decisions`) → Phase 3 (answer-resolves-and-unblocks) →
  Phase 4 (secretary digest loop). Each phase is small and TDD.
- Deferred: web decision board, ALERT auto-ack heuristics, decision auto-close on session
  completion, forum-topic / second-bot channel variants.

## 9. Open questions (need an operator decision)

1. **Decisions channel mechanism** — dedicated Telegram chat/group (recommended, one
   config knob) vs a forum topic vs a second bot.
2. **Digest cadence + default** — cron times (default `0 8,13,18`), staleness threshold
   (default 24h), and whether the secretary loop auto-enables once `decisionsChatId` is
   set or stays opt-in like other loops.
3. **Worker digest vs deterministic digest** — the direction says a worker on the latest
   model; a deterministic engine-rendered digest is cheaper and always-on. Confirm the
   worker path, or take deterministic-first with the worker as an upgrade.
4. **Escalation mirroring** — mirror blocking allow/deny escalations into the Decisions
   channel too (recommended), or leave them only in the firehose with their buttons.
```
