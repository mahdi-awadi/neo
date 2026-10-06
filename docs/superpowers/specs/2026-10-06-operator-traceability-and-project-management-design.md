# Operator traceability and project management — design

**Date:** 2026-10-06 · **Status:** proposed (awaiting the operator's review)
**Plan:** `docs/superpowers/plans/2026-10-06-operator-traceability-and-project-management.md`
**ADRs:** 0015 (message refs and causes), 0016 (threads), 0017 (console history pages from the
ledger), 0018 (attention items), 0019 (plan registry). ADR-0013 (context window) and the
console-feed ADR (on `fix/console-feed-window`, to be renumbered **0014** at merge) come first.

This file is the contract: data model, seams, rules and edge cases. The plan file holds the
phases, tasks, UI sketches, risks and scope.

## 1. What the operator asked for, and what we understood

| # | Ask (operator) | Our reading |
|---|---|---|
| 1 | Every message has an ID, end to end | Every operator message gets a ledger id. Every artifact (reply, order, todo, decision, tool action, dispatch, dispatch result, file, plan) records the message that caused it. Replies show a short ref. `/trace <ref>` and the web show the tree. |
| 2 | Console by project and thread | The console gets a Threads view: list by project, with state, search and filters, paged from the ledger. The live feed stays a bounded window (console-feed ADR). |
| 3 | GitHub awareness | A deterministic scanner (`git` + `gh`) writes **attention items** per project. One list per project, a daily digest, and one tap to turn an item into a todo. |
| 4 | More code, less AI | Engine sweeps replace things the operator or a worker now does by hand: spinning dispatches, stuck approvals, lost direct requests, plans with no status, restart-gated work, ctx% over 100, leftover worktrees, uncommitted work. A per-project dashboard shows it all. |
| 5 | Every plan goes to the operator as a file | The engine detects plan/spec files that a worker writes and sends them. The dispatch preamble tells workers where to write plans and to send them. |

Assumptions (the operator can correct them):
- A "message" is an operator line from Telegram or the web, plus every line Neo sends back. Customer
  inbox mail is **not** an operator message; it keeps its own inbox ids.
- "Thread" means one conversation that starts with one operator message (or one engine trigger) and
  holds everything it caused. It is not the SDK session.
- No new AI anywhere. Every new feature is plain code over the ledger, `git` and `gh`.

## 2. Domain model (summary — the glossary is CONTEXT.md)

```
Thread 1 ──< Message (operator line or Neo line)            thread_id on every row
Message 1 ──< Order (an SDK run started for it)            orders.cause_msg_id
Order   1 ──< Todo / Decision / ToolAction / Event / File  via order_id (exists) + cause_msg_id (new)
Thread  1 ──< Plan (sent, approved, executed)              plans.thread_id
Project 1 ──< AttentionItem (github / engine / plan / restart)
AttentionItem 0..1 ── Todo                                 attention_items.todo_id
```

- **Cause** = `{ msgId, threadId }`. It is set once where work starts and is copied, never
  re-derived, into everything that work produces.
- The **order** stays the join key for what already references `order_id` (events, decisions,
  todos, auto-approvals). The new columns make the message link direct, so a query needs no
  chain of joins and survives a pruned order row.

## 3. Ledger changes (all in `data/ledger.db`; no new store)

### 3.1 Numbered migrations

`ledger.ts` today adds columns with ad-hoc `PRAGMA table_info` checks. That is fine for one
column. This change rebuilds a table (`messages`) and adds many columns, so the ledger moves to the
pattern `trust.ts` already uses: `PRAGMA user_version` plus an ordered list of migrations.

- `src/engine/ledger-migrations.ts` exports `MIGRATIONS: Array<{ version: number; name: string;
  up(db: Database): void }>` and `migrate(db, opts)`.
- Version 1 = today's schema. Its `up` runs the existing `CREATE IF NOT EXISTS` + column checks, so
  a fresh DB and a current production DB both reach version 1 with no change in behavior.
- Each migration after 1 runs in one transaction. On a file DB, before the first pending migration,
  the engine copies `ledger.db` to `ledger.db.bak-v<from>` (once per version, `VACUUM INTO`). A
  failed migration rolls back and the daemon exits as an **unrecoverable state** (ADR-0010: the
  ledger cannot be opened), with the backup path in the log.

### 3.2 Version 2 — messages with ids, threads

```sql
CREATE TABLE messages_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- the message ref (base36 in the UI)
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,                    -- 'user' | 'assistant' (unchanged values)
  content TEXT NOT NULL,
  at INTEGER NOT NULL,
  thread_id INTEGER,                     -- root message id of its thread
  cause_id INTEGER,                      -- the message this line answers (NULL for a root)
  surface TEXT,                          -- 'telegram' | 'web' | 'engine'
  channel_msg_id INTEGER,                -- Telegram message_id when known
  project TEXT, folder TEXT, order_id TEXT,
  kind TEXT NOT NULL DEFAULT 'text',     -- text|ack|progress|digest|result|decision|alert|approval|file|plan|notice
  priority TEXT                          -- priority.ts value, when one was given
);
INSERT INTO messages_v2 (chat_id, role, content, at, kind)
  SELECT chat_id, role, content, at, 'text' FROM messages ORDER BY rowid;
DROP TABLE messages; ALTER TABLE messages_v2 RENAME TO messages;
CREATE INDEX idx_messages_chat ON messages (chat_id, at);
CREATE INDEX idx_messages_thread ON messages (thread_id, id);
CREATE INDEX idx_messages_channel ON messages (chat_id, channel_msg_id);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,                -- = root message id
  origin TEXT NOT NULL,                  -- 'operator' | 'loop' | 'attention' | 'ingress' | 'legacy'
  project TEXT, folder TEXT,             -- NULL while only the company has touched it
  title TEXT NOT NULL,                   -- first line of the root, bounded (todoTitle rule)
  state TEXT NOT NULL,                   -- open | waiting | done | failed (derived, §5)
  closed_by_operator INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_msg_id INTEGER
);
CREATE INDEX idx_threads_project ON threads (project, updated_at DESC);
CREATE INDEX idx_threads_state ON threads (state, updated_at DESC);

CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
-- + the standard AFTER INSERT / AFTER DELETE triggers; 'rebuild' once at migration.
```

Legacy rows: the migration groups the old rows into one `origin='legacy'` thread per
`(chat_id, UTC day)`, state `done`. So old history shows in the console, but no ref claims a link
that was never recorded.

### 3.3 Version 3 — cause columns on what already exists

| Table | New columns | Note |
|---|---|---|
| `orders` | `cause_msg_id INTEGER`, `thread_id INTEGER`, `parent_order_id TEXT` | `parent_order_id` = the company order that dispatched it |
| `project_todos` | `cause_msg_id`, `thread_id`, `attention_id INTEGER`, `plan_id INTEGER` | |
| `decisions` | `cause_msg_id`, `thread_id` | |
| `dispatcher_inbox` | `cause_msg_id`, `thread_id` | the result goes back to its thread |
| `message_routes` | `msg_id INTEGER`, `thread_id INTEGER` | a Telegram reply joins the thread |
| `events` | `msg_id INTEGER` | engine events (dispatch_start/end, stall, abort…) per message |
| `open_sessions` | `cause_msg_id`, `thread_id` | a reload keeps each session's current cause (§11.3) |

Indexes: `(thread_id)` on orders, project_todos, decisions; `(msg_id)` on events.

### 3.4 Version 4 — tool actions

```sql
CREATE TABLE tool_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL, msg_id INTEGER, thread_id INTEGER, folder TEXT,
  tool TEXT NOT NULL, label TEXT NOT NULL,   -- the activity label, never full input
  verdict TEXT NOT NULL,                     -- allow | auto | escalate | deny
  at INTEGER NOT NULL
);
CREATE INDEX idx_tool_actions_thread ON tool_actions (thread_id, id);
```

Own retention (`toolActionsKeep`, default 100 000), pruned in batches like `events`. It is a
separate table so a busy worker cannot push diagnostic events out of `events`.

### 3.5 Version 5 — attention items, GitHub snapshot, plans, boot record

```sql
CREATE TABLE attention_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, folder TEXT NOT NULL,
  source TEXT NOT NULL,      -- 'github' | 'git' | 'engine' | 'plan' | 'restart'
  kind TEXT NOT NULL,        -- e.g. 'ci_failed', 'pr_open', 'unpushed', 'worktree', 'approval_stuck'
  key TEXT NOT NULL,         -- stable identity inside (project, kind), e.g. branch name or PR number
  title TEXT NOT NULL, detail TEXT, url TEXT,
  severity TEXT NOT NULL,    -- 'high' | 'normal' | 'low'
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  resolved_at INTEGER, snoozed_until INTEGER, todo_id INTEGER,
  UNIQUE (project, kind, key)
);
CREATE INDEX idx_attention_open ON attention_items (resolved_at, project, severity);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, folder TEXT NOT NULL, path TEXT NOT NULL,   -- path relative to folder
  title TEXT NOT NULL, sha256 TEXT NOT NULL,
  status TEXT NOT NULL,      -- draft | sent | approved | executing | done | abandoned
  steps_total INTEGER NOT NULL DEFAULT 0, steps_done INTEGER NOT NULL DEFAULT 0,
  thread_id INTEGER, order_id TEXT, todo_id INTEGER, decision_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER,
  UNIQUE (folder, path)
);

CREATE TABLE engine_boots (
  at INTEGER PRIMARY KEY, head_sha TEXT NOT NULL, branch TEXT NOT NULL,
  sdk_version TEXT, config_hash TEXT
);
```

GitHub data is not stored raw. The scanner turns it into attention items and keeps one small JSON
row per project in `meta` (`gh:<project>` → last scan time, counts, errors) for the dashboard.

## 4. The cause seam (ADR-0015)

One module, `src/engine/trace.ts`, owns ids and causes. Everything else calls it.

```ts
export interface Cause { msgId: number; threadId: number }

export interface Trace {
  /** An operator line arrives. Picks its thread (§4.1), writes the row, returns its cause. */
  inbound(p: { chatId: number; text: string; surface: "telegram" | "web";
               channelMsgId?: number; replyTo?: { chatId: number; channelMsgId: number };
               threadId?: number /* web composer inside a thread */ }): Cause;
  /** A Neo line goes out. Writes the row under `cause`, returns its id. */
  outbound(p: { chatId: number; text: string; cause?: Cause; kind?: MessageKind;
                project?: string; folder?: string; orderId?: string; priority?: Priority }): number;
  /** The channel posted an outbound row; remember its Telegram id (reply → thread). */
  bindChannel(msgId: number, chatId: number, channelMsgId: number): void;
  /** Engine-started work (loop fire, attention todo, ingress) gets its own root. */
  root(p: { origin: ThreadOrigin; title: string; project?: string; folder?: string }): Cause;
  /** Compact ref: base36 of the id with an 'm' prefix — `m4f2`. Parse accepts `m4f2`, `#m4f2`, `4f2`. */
  ref(msgId: number): string;
  parseRef(s: string): number | undefined;
  /** Everything a message (or its thread) produced, oldest first. Bounded, paged. */
  tree(msgId: number, opts?: { limit?: number }): TraceTree;
}
```

### 4.1 Which thread an operator message joins (deterministic, in this order)

1. Telegram reply to a message we know (`message_routes` / `messages.channel_msg_id`) → that
   message's thread.
2. Web composer opened inside a thread → that thread.
3. A `/trace`, `/todo` or other engine command → no thread (commands are not work).
4. Anything else → a **new thread**, rooted at this message.

No time window and no text matching. Those are guesses, and guesses here are AI by another name.

### 4.2 How the cause travels

- `handleMessage(text, chatId, deps, source, cause)` — the frontends call `trace.inbound` first and
  pass the cause in. `pipeline.ts` today records the message itself; that write moves into
  `trace.inbound` (the one choke point stays one).
- **The registry holds the current cause per session.** `registry.setCause(id, cause)` is called
  when a brief is pushed (`followUp`) or a run starts. A session works one turn at a time, but the
  SDK pulls queued input eagerly, so the turn boundary is the `result` / `idle` event. Rule: output
  is attributed to the **newest cause delivered to the session whose turn has not ended**; when the
  turn ends, every cause delivered so far is answered. When the CLI merges two queued messages
  into one turn, the later message gets the output and both are answered. This is a known, written
  limit; it never loses a message, it can only file one reply under the later of two messages.
- `neoMcpServers` gets `cause: () => Cause | undefined` (reads the registry at call time), so the
  `dispatch`, `todo`, `ask_operator` and `send_file` tools stamp the cause of the turn that called
  them, not of the session's first order.
- `dispatchToProject` writes `orders.cause_msg_id/thread_id/parent_order_id`, the todo row,
  `dispatch_*` events, the progress digests and the final result all under that cause.
- Background roots: a loop fire, a scheduler-fired dispatch, an attention-item todo and an ingress
  brief call `trace.root(...)` first. So every thread has a root, and no artifact has a NULL cause
  after Phase 1 (legacy rows excepted).

### 4.3 Showing the ref

- An ack line (`↩︎ queued for…`, `opening…`, `→ dispatching…`) and the **first** reply of a turn
  carry ` · m4f2` at the end, in monospace (Telegram: tap to copy).
- Results, decisions, alerts, digests, plan files and todo lines always carry the ref of their
  thread (`thread m4f2`).
- Streamed progress lines carry no ref. A ref on every line is noise.
- The rule lives in one pure function `refSuffix(kind, isFirstOfTurn)`; the knob
  `trace.showRefs: "auto" | "off"` turns it off.

### 4.4 Lookup

- `/trace m4f2` (Telegram and web compose box; one engine command) → the thread tree, text:
  root line, state, project, then each child in time order with its own ref, kind and status. Over
  40 children it shows the first 10 and the last 25 and links the web view.
- Reply `/trace` to any Neo message on Telegram → the trace of that message's thread.
- `GET /api/trace/:ref` → the same tree as JSON.

## 5. Thread state (ADR-0016)

Stored on `threads.state`, but **only** `refreshThread(threadId)` writes it. It reads the linked
facts and calls a pure function:

```ts
export type ThreadState = "open" | "waiting" | "done" | "failed";
export function deriveThreadState(f: {
  openDecisions: number;          // decisions.status='open' in this thread
  pendingApprovals: number;       // registry blockedOn kind 'approval' for a session in this thread
  activeWork: number;             // todos queued|running + sessions in-turn under this thread's cause
  lastEnd?: "ok" | "failed";      // the newest ended order/todo in this thread
  closedByOperator: boolean;
}): ThreadState
```

| Facts | State |
|---|---|
| operator closed it | `done` |
| an open decision or a pending approval | `waiting` (waiting on the operator wins over work) |
| active work | `open` |
| no active work, newest end failed | `failed` |
| no active work, newest end ok, or no work ever started (a pure chat answer) | `done` |

A new operator message in a `done` thread reopens it (it is new active work). `refreshThread` is
called by the trace module on every write that carries a cause, and by the todo queue, the decision
store and run-end. It is idempotent.

## 6. Console (ADR-0017)

- The live SSE feed stays the bounded window from the console-feed ADR. Each feed event now also
  carries `msgId` and `threadId`.
- New read endpoints, all keyset-paged (`before=<id>`, `limit` ≤ 100), all behind the existing admin
  session:
  - `GET /api/threads?project=&state=&origin=&q=&before=&limit=` — newest-updated first.
  - `GET /api/threads/:id?before=&limit=` — the thread's messages, newest page first, plus its
    linked todos, decisions, plans and tool-action counts.
  - `GET /api/search?q=&project=&before=&limit=` — FTS5 over `messages_fts`; the query is escaped
    with the same quoting rule as `memory-recall.ts` (`ftsQuery`), reused, not copied.
  - `GET /api/projects` and `GET /api/projects/:name` — the project dashboard (§9).
- SSE gets one more event type, `thread` (`{id, state, project, title, updatedAt}`), so the
  thread list moves a row to the top without a re-fetch.
- **i18n:** the console moves its strings into `src/frontends/web/locales/{en,ar}/console.json`
  (namespaced keys, AR+EN complete), loaded through `i18next` (vanilla, no React). The page sets
  `dir="rtl"` for Arabic. Numbers, refs and times render as LTR runs attached to their label (the
  RTL rule). All existing console strings move in the same phase; the console must not ship half
  translated.
- The page is split out of `web.ts` into `src/frontends/web/` (HTML, one client module, locales),
  built with `Bun.build` at startup. No new build tool.

## 7. Attention items (ADR-0018)

One table, many producers. A **producer** is a pure-ish function `(inputs) → AttentionDraft[]` for
one source. `attention.ts` reconciles drafts against the open rows of that `(project, source)`:
new → insert, still there → `last_seen`, gone → `resolved_at`. A resolved item that comes back is
reopened (same row, `resolved_at = NULL`). Snoozed items are kept but not shown until
`snoozed_until`.

| Source | Kind | Producer input | Severity |
|---|---|---|---|
| git | `unpushed` (branch ahead of upstream), `no_upstream`, `dirty` (uncommitted changes, no session in turn), `stale_branch` (no commit for `staleBranchDays`, not merged), `drift` (dev ahead of main by N), `worktree` (linked worktree, no session in it for `worktreeIdleHours`) | `git for-each-ref`, `git status --porcelain`, `git worktree list --porcelain`, `git rev-list --count` | normal; `dirty` after a todo ended = high |
| github | `pr_open`, `pr_review_requested`, `ci_failed` (latest run on a tracked branch failed), `issue_open` (assigned or labeled `neo`), `dependabot`, `code_scanning`, `secret_scanning` | `gh pr list`, `gh run list`, `gh issue list`, `gh api …/dependabot/alerts` etc., all `--json` | `ci_failed` on main/dev and critical/high alerts = high |
| engine | `approval_stuck` (pending > `approvalRemindMs`), `dispatch_spinning` (§8.1), `queue_paused` (> `queuePausedHours`), `thread_failed`, `thread_waiting` (> `waitingHours`), `ctx_window_suspect` (ctx% > 100), `decision_stale` | ledger + registry | approvals and spinning = high |
| plan | `plan_unreviewed` (sent, no answer in `planReviewHours`), `plan_unexecuted` (approved, no todo in `planIdleDays`), `plan_stalled` (executing, no step checked in `planIdleDays`) | `plans` table | normal |
| restart | `restart_gated` (§8.4) | `engine_boots` + git + updater | normal |

Rules:
- Producers never throw out of their unit. A `gh` failure for one project records `meta` error +
  one engine event and leaves that project's GitHub items untouched (no false resolves).
- `gh` and `git` run with a timeout (`github.callTimeoutMs`, default 20 s), with `GH_PAGER=` and
  `--json` only. One project at a time, so a scan never forks 50 processes.
- Which repos: every folder the ledger has seen (`folders()`) that is a git repo under `workRoot`,
  plus `/home/neo`. Per-project overrides live in `config.json` → `projects.<name>`
  (`trackedBranches`, `driftPairs`, `issueLabel`, `ignoreKinds`, `deployedVersionUrl`). No repo
  name or branch name is in code.
- The scan runs as a heartbeat step with its own interval (`github.scanEveryMs`, default 30 min) and
  on demand (`/attention refresh`, a console button).
- **One tap → todo:** the item's button calls `attention.toTodo(id)`. It builds the brief from a
  per-kind template in `src/engine/attention-briefs.ts` (data, one entry per kind: the facts, the
  URL, and the definition of done), roots a thread (`origin='attention'`), submits it through the
  existing todo queue with `createdBy: "operator"`, `workClass: "interactive"` (the operator tapped
  it), and stores `todo_id`. A second tap shows the existing todo; it never makes two.
- **Daily digest:** a heartbeat step at `attention.digestAt` (cron, default `0 8 * * *`, server
  time) sends one message: per project, the count by severity and the top 3 high items, each with a
  `→ todo` button; plus a link to the console. Priority `result` (Decisions group) only when there is
  a high item; otherwise `progress` (DM). Nothing new since yesterday and no high items → one line.

## 8. Engine sweeps (code instead of AI or the operator)

### 8.1 Spinning dispatch

The progress digest today is sent when there was **any** activity. A worker can loop for hours on
the same step and the digest repeats. New: each digest has a **fingerprint** = (activity label
without numbers/paths normalized, latest note, HEAD sha, `tool_actions` count since last digest
bucketed). When `dispatchSpinDigests` (default 3) digests in a row have the same label, note and
HEAD — the worker is active but nothing changes — the engine:
1. records `dispatch_spinning` (event + attention item, high),
2. sends one alert to the operator and the dispatcher ("eticket-v3 has repeated *Running tests* for
   30 min with no new commit or note · m4f2"),
3. with `dispatchSpinPolicy: "wrapup"` (default `"alert"`), sends the same wrap-up follow-up the
   stall abort uses.

A tool-loop guard sits next to it: the same `(tool, input hash)` `toolLoopLimit` (default 8) times
in a row inside one turn → the same alert. Both are counters; no AI reads the output.

### 8.2 Stuck approvals

ADR-0012 already reminds and then denies. On top: an `approval_stuck` attention item while one is
pending, so the dashboard and digest show it, and thread state `waiting`. The approval board in the
research plan (P0 Task 0.1) is the place to unify Telegram + web answers; this design only reads it.

### 8.3 Direct requests are never lost

A message to a project session (focus, `/open`, reply to a project line) is a thread like any
other, so `/trace` and the project's thread list answer "what happened to X". We do **not** turn
direct turns into todos (ADR-0016, considered options).

### 8.4 Restart-gated work, computed

At boot the daemon writes `engine_boots` (HEAD sha, branch, SDK version, config hash). The
`restart` producer then lists, for the Neo project only:
- commits on the running branch after the boot sha (`git log <boot>..HEAD`) — **live code differs
  from running code**;
- local branches not merged into the running branch, with their newest commit subject (`fix/*`
  and `feat/*` show as "waiting to merge");
- updater results with `restartNeeded` (they exist in `updater.ts` today);
- `config.json` hash differs from the boot hash and the changed key is not hot-reloadable.

`/gated` shows the list; the dashboard shows it on the Neo card. This replaces the hand-kept
"restart-gated" memory notes.

### 8.5 Context % sanity

ctx% over 100 is impossible by definition. When `sessionContext` returns occupancy > 1.0, the engine
records `ctx_window_suspect` (event + attention item naming the model and the window used) and the
console shows "?" instead of a number. ADR-0013 fixes the cause; this check catches the next one.

### 8.6 Leftover worktrees and uncommitted work

- The `git` producer reports each linked worktree with its branch, age, clean/dirty, and whether a
  session runs in it. A clean worktree whose branch is pushed or merged gets a **Remove** button:
  `git worktree remove <path>` (never `--force`). A dirty one only gets `→ todo`.
- After every dispatch/todo end, the engine runs `git status --porcelain` in the folder. Changes
  left behind → a `dirty` item (high) linked to that thread, and one line in the result
  ("left 3 uncommitted files").

## 9. Project dashboard

`projectView(name): ProjectView` in `src/engine/project-view.ts` — one read model, used by
`GET /api/projects/:name`, `/project <name>` on Telegram, and the company's `sessions` tool. It
reuses `dashboardSnapshot` pieces (sessions, todos) and adds:

```ts
interface ProjectView {
  name: string; folder: string;
  now: { state: SessionState; line: string; thread?: ThreadSummary } | null;
  queue: DashTodo[];                       // running + queued
  git: { branch: string; lastCommit?: string; unpushed: number; dirty: number;
         drift?: { from: string; to: string; ahead: number }; worktrees: number;
         undeployed?: number };            // only when deployedVersionUrl is configured
  github: { prs: number; ciFailed: number; issues: number; alerts: number; scannedAt?: number; error?: string };
  decisions: Array<{ id: string; question: string; ageMs: number; ref?: string }>;
  plans: Array<{ id: number; title: string; status: PlanStatus; steps: string; ref?: string }>;
  attention: AttentionItemView[];          // open, severity then age
  threads: ThreadSummary[];                // newest 10
  restartGated?: RestartGatedItem[];       // Neo only
  health: "ok" | "attention" | "down" | "unknown";  // down = configured healthUrl probe failed
}
```

Health rule (pure): `down` when `projects.<name>.healthUrl` is configured and its last probe failed
(the sentinel's targets can be reused as these URLs); `attention` when any high item is open; `ok`
otherwise; `unknown` when there is no data.

"Undeployed" is only shown when `projects.<name>.deployedVersionUrl` is set. The engine reads the
deployed sha from that URL (a JSON path in config) and counts commits on the deploy branch after
it. Without config the dashboard says nothing about deployment instead of guessing.

## 10. Plans (ADR-0019)

- **Plan paths** (config `plans.paths`, default `["docs/**/plans/**/*.md", "docs/**/specs/**/*.md",
  "specs/**/*.md", "plans/**/*.md"]`).
- **Detection:** at every run end (company, project, dispatch, loop), the engine lists files under
  the plan paths that changed since the run's start HEAD (`git diff --name-only <start>..HEAD`
  plus untracked files from `git status --porcelain`). No filesystem watcher.
- **Register:** upsert `plans` by `(folder, path)`, title = first `#` heading, `sha256` of the
  content, steps = count of `- [ ]` / `- [x]`.
- **Send:** if the content hash was never sent, send the file through the existing `sendFile` with
  caption `📄 plan · <project> · <title> · thread m4f2` and buttons **Approve**, **Changes**,
  **Execute**. The send is a `decision` (so it is tracked, reminded and answerable by reply).
  Status → `sent`.
- **Dedupe:** a worker's own `send_file` of a plan path goes through the same registry, so the
  operator gets each version once. A changed file (new hash) is sent again as "v2".
- **Lifecycle:** Approve → `approved`; Execute → a todo with the brief "Execute the plan at <path>
  task by task" (template), status `executing`; checkbox count reaches total, or the todo ends ok
  and the operator taps Done → `done`; operator taps Drop → `abandoned`. "Changes" opens a reply
  prompt; the text goes into the plan's thread as a follow-up to the worker that wrote it.
- **Preamble:** one more paragraph in `briefWithProjectDocs`: "Write any plan or spec under
  `docs/superpowers/plans/` or `docs/superpowers/specs/`. The engine sends it to the operator for
  review; you may also call `send_file` with it — the engine sends each version once."
- `/plans [project]` lists plans with status and refs.

## 11. Edge cases (each one has a test in the plan)

1. A Telegram reply to a message from before the migration → no thread known → new thread (rule 4),
   never an error.
2. Two operator messages while a turn runs, CLI merges them → output under the second, both
   answered (§4.2). The thread of the first shows "answered in m4f3".
3. The daemon restarts mid-turn → open sessions are restored without a live cause; the first
   output after restore goes to the thread of the last cause stored on the session snapshot
   (`open_sessions` gets `cause_msg_id`, `thread_id`).
4. A cause whose thread was deleted by retention → `refreshThread` is a no-op; artifacts keep the
   ids; `/trace` says "thread pruned".
5. `gh` not logged in, offline, or rate-limited → no items change; one `github_scan_error` event
   per project per hour; the dashboard shows the error and the last good scan time.
6. A repo with no remote → only git kinds; `no_upstream` is not raised for the repo itself.
7. A plan file deleted after it was sent → status unchanged; the dashboard marks it "file
   missing".
8. A plan path that a worker writes in a project the engine never ran → not detected (detection is
   per run). Documented, not a bug.
9. Search query with FTS operators (`"`, `-`, `NEAR`) → escaped, never a syntax error.
10. Arabic text search → FTS5 `unicode61` tokenizer, tested with an Arabic fixture.
11. 1 000 000 messages → thread list and thread page stay O(page) through the indexes;
    a test with 50 000 synthetic rows asserts query plans use the indexes (`EXPLAIN QUERY PLAN`).
12. One-tap todo tapped twice, or on both surfaces → one todo (unique `attention_items.todo_id`,
    checked in one transaction).

## 12. Out of scope

- Customer inbox threading (it has its own ids and draft versions).
- Webhooks from GitHub (polling is enough at this size; see ADR-0018).
- AI summaries of threads or digests.
- Running Neo itself in Docker (the engine needs the host's `/home` and `~/.claude`; this is an
  existing exception to baseline rule 3 and an operator decision, not part of this work).
- Merging the open branches other than the two prerequisites.
