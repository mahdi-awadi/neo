# Operator traceability and project management — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every operator message has an id that links forward to all the work it caused. The
console shows work by project and thread. A deterministic engine layer tracks each project's git and
GitHub state, plans and restart-gated fixes, and puts them in one "needs attention" list and one
dashboard per project.

**Architecture:** One trace module (`trace.ts`) owns message ids, threads and causes. The registry
carries each session's current cause, so tools and dispatches stamp it. Everything else is ledger
tables read by small pure functions: thread state, attention producers, plan registry, project view.
No AI is added anywhere.

**Tech stack:** Bun + TypeScript, `bun:sqlite` (FTS5), grammY (Telegram), Bun.serve + SSE (web),
`git` and `gh` CLIs, `i18next` for the console.

**Spec:** `docs/superpowers/specs/2026-10-06-operator-traceability-and-project-management-design.md`
(the contract: schemas, interfaces, rules, edge cases). **ADRs:** 0015–0019. **Glossary:**
`CONTEXT.md` → "Tracing work back to the operator", "What needs the operator", "Plans", "The running
engine".

---

## Summary for the operator (read this first)

| Phase | What you get | Restart? |
|---|---|---|
| **P0** Prerequisites | Merge the console-feed fix and the context-window fix (ctx% ≤ 100). | yes |
| **P1** Trace spine | Every message has a ref (`m4f2`). Replies, dispatches, todos, decisions, results and tool actions link to it. `/trace m4f2` shows the tree. | yes |
| **P2** Plans | Every plan/spec a worker writes is sent to you as a file with Approve / Changes / Execute. `/plans` shows status. | yes |
| **P3** Console threads | Threads by project with state (open / waiting / done / failed), search, filters, paged history. Console in AR + EN. | yes |
| **P4** Attention + engine sweeps | One "needs attention" list. Spinning dispatches, stuck approvals, uncommitted work, ctx% > 100, leftover worktrees, restart-gated fixes (`/gated`) — all found by code. | yes |
| **P5** Git + GitHub | Unpushed work, PRs, failed CI, stale branches, drift, issues, Dependabot/security alerts. Daily digest. One tap → todo. | yes |
| **P6** Project dashboard | One page per project (web + `/project <name>` on Telegram): now, queue, git, GitHub, decisions, plans, attention, threads, health. | yes |

Each phase is shippable alone and goes live only after a restart **you** approve. Order: P1 first
(everything links to it). P2 is small and stops the hand-sending of plans, so it comes next.

---

## Global Constraints

- No AI in the engine. Every new feature is code over the ledger, `git` and `gh`.
- TDD: the failing test first, per acceptance criterion. `bunx tsc --noEmit` and `bun test` green
  before a task is done. One commit per task.
- Ledger only: no new database file. Schema changes go through numbered migrations (Task 1.1).
- No hardcoding: every interval, limit, path glob, branch name and template lives in config
  (`src/config.ts` defaults + `config.json` + env), documented in `docs/CONFIG.md`.
- Engineering baseline: console strings in `src/frontends/web/locales/{en,ar}/console.json`
  through `i18next`, namespaced keys, AR + EN complete, RTL correct. Telegram engine lines stay in
  the engine's existing English line builders (the bot's lines are operator chrome; moving them
  to catalogues is listed under "More features", not done here).
- Every new unit of work is contained (ADR-0010): a producer, scan, send or refresh that throws is
  an engine fault for that unit only.
- Customer firewall unchanged: nothing here routes customer work to the subscription. Customer
  inbox items are not operator messages.
- Bounded everything: every list endpoint pages (≤ 100 rows), every subprocess has a timeout, every
  new table has a retention cap or is naturally small.
- The daemon is never restarted by a worker. Each phase ends "restart-gated"; the operator restarts.
- Commit messages end with the co-author line of the model that wrote them (CLAUDE.md).

## Review Focus

1. **A Telegram reply to an old (pre-migration or pruned) message** → it must start a new thread,
   never throw or attach to a random thread. Test in Task 1.3.
2. **Two operator messages queued while a turn runs** → both are answered; the reply files under the
   later one; no message stays "open" forever. Test in Task 1.4.
3. **The daemon restarts mid-turn** → the restored session keeps its last cause, so its next output
   is not orphaned. Test in Task 1.4 (snapshot round-trip).
4. **`gh` logged out, offline or rate-limited** → no GitHub item is resolved by mistake; the
   dashboard shows the error and the last good scan. Test in Task 5.2.
5. **Search text with quotes, `-`, `NEAR`, or Arabic** → results or an empty list, never a 500.
   Test in Task 3.2.

---

## File map

| File | New/changed | Responsibility |
|---|---|---|
| `src/engine/ledger-migrations.ts` | new | `MIGRATIONS`, `migrate(db, {path})`, backup before the first pending one |
| `src/engine/ledger.ts` | changed | calls `migrate`; new cause columns in writes; thread/messages/tool-action/attention/plan reads |
| `src/engine/trace.ts` | new | ids, refs, thread choice, causes, `refreshThread`, `tree` |
| `src/engine/thread-state.ts` | new | pure `deriveThreadState` |
| `src/engine/registry.ts` | changed | `setCause` / `causeOf` / `endTurn` per session |
| `src/engine/pipeline.ts` | changed | takes a `Cause`; outbound lines through `trace.outbound` |
| `src/engine/dispatch.ts` | changed | `neoMcpServers` `cause` getter; cause on orders/todos/events/results; preamble plan paragraph; spin detection |
| `src/engine/todo-queue.ts` | changed | cause on todos; `attention_id`, `plan_id` |
| `src/engine/session-runner.ts` | changed | turn-end callback carries the turn index (for `endTurn`) |
| `src/engine/commands.ts` | changed | `/trace`, `/plans`, `/attention`, `/gated`, `/project` |
| `src/frontends/telegram.ts` | changed | `trace.inbound` with reply-to; ref suffix; `bindChannel`; new callbacks (`plan:`, `att:`) |
| `src/engine/web-channel.ts` | changed | feed events carry ids; `thread` event; new read methods |
| `src/frontends/web.ts` | changed | new `/api/*` routes; page moved out |
| `src/frontends/web/` | new | `index.html`, `app.ts`, `locales/{en,ar}/console.json` |
| `src/engine/plans.ts` | new | plan detection, registry, send, lifecycle |
| `src/engine/attention.ts` | new | reconcile, snooze, `toTodo`, digest render |
| `src/engine/attention-briefs.ts` | new | per-kind brief templates (data) |
| `src/engine/producers/{git,github,engine,plan,restart}.ts` | new | one producer per source |
| `src/engine/git-read.ts` | new | the only place `git`/`gh` are spawned (timeouts, `--json`, env) |
| `src/engine/project-view.ts` | new | the project dashboard read model |
| `src/engine/dashboard.ts` | changed | reuses `project-view` pieces |
| `src/daemon.ts` | changed | boot record; heartbeat steps `attention`, `digest` |
| `src/config.ts`, `docs/CONFIG.md` | changed | new knobs (listed per task) |

---

## P0 — Prerequisites (operator-gated)

Not code in this plan; listed so no phase starts on the wrong base.

- [ ] Merge `fix/console-feed-window` (b44a975) into master. Resolve the `web-channel.ts` conflict
      with master's governor commits (f1d4112, f55f70f). Rename its ADR file to
      `docs/adr/0014-the-console-feed-is-a-bounded-window-resumed-by-event-id.md` (it collides with
      master's 0012) and fix the references to it.
- [ ] Merge `fix/context-window-from-sdk` (d1b682d, 0b4996f; ADR-0013).
- [ ] `bunx tsc --noEmit` and `bun test` green on master.
- [ ] Operator approves a restart. After it: `model_windows` holds `claude-opus-5-5 → 1000000`;
      the console shows ctx% ≤ 100.

**Acceptance:** master contains both fixes; ADR numbers 0012, 0013, 0014 are unique; tests green.

---

## P1 — Trace spine

**Acceptance criteria**
- AC1.1 Every operator message (Telegram, web) is stored with an integer id before any work starts.
- AC1.2 Every Neo line, order, todo, decision, dispatch event, dispatcher-inbox result, file send
  and tool action written after P1 carries `cause_msg_id` + `thread_id`.
- AC1.3 A Telegram reply to a known Neo line joins that line's thread; anything else starts a new one.
- AC1.4 The ack and first reply of a turn, and every result/decision/alert/digest/todo line, end
  with the ref (` · m4f2`); progress lines do not.
- AC1.5 `/trace <ref>` (Telegram + web) and `GET /api/trace/:ref` return the tree.
- AC1.6 Existing ledgers migrate with no data loss and a backup file; legacy rows land in legacy
  threads.

### Task 1.1: Numbered ledger migrations

**Files:**
- Create: `src/engine/ledger-migrations.ts`
- Modify: `src/engine/ledger.ts:239-406` (move the schema block into migration 1; call `migrate`)
- Test: `tests/ledger-migrations.test.ts`

**Interfaces:**
- Produces: `export interface Migration { version: number; name: string; up(db: Database): void }`,
  `export const MIGRATIONS: Migration[]`, `export function migrate(db: Database, opts: { path: string; now?: () => number }): { from: number; to: number; backup?: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, MIGRATIONS } from "../src/engine/ledger-migrations";
import { openLedger } from "../src/engine/ledger";

test("a fresh db migrates to the newest version", () => {
  const db = new Database(":memory:");
  const r = migrate(db, { path: ":memory:" });
  expect(r.from).toBe(0);
  expect(r.to).toBe(MIGRATIONS.at(-1)!.version);
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(r.to);
});

test("migrate is idempotent", () => {
  const db = new Database(":memory:");
  migrate(db, { path: ":memory:" });
  const again = migrate(db, { path: ":memory:" });
  expect(again.from).toBe(again.to);
});

test("a pre-migration ledger (user_version 0, legacy schema) keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const legacy = new Database(path);
  legacy.run(`CREATE TABLE messages (chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL)`);
  legacy.run(`INSERT INTO messages VALUES (7, 'user', 'hello', 1000), (7, 'assistant', 'hi', 1001)`);
  legacy.close();
  const led = openLedger(path);
  expect(led.conversation(7).map((m) => m.content)).toEqual(["hello", "hi"]);
});

test("a file db that has tables gets a backup before its first pending migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  const seed = new Database(path);
  seed.run(`CREATE TABLE orders (id TEXT PRIMARY KEY)`);
  seed.close();
  const r = migrate(new Database(path), { path });
  expect(r.backup).toBe(`${path}.bak-v0`);
  expect(existsSync(r.backup!)).toBe(true);
});

test("an empty new file db needs no backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const path = join(dir, "ledger.db");
  expect(migrate(new Database(path), { path }).backup).toBeUndefined();
});

test("a failing migration rolls back and throws", () => {
  const db = new Database(":memory:");
  const bad = [...MIGRATIONS, { version: 999, name: "boom", up: () => { throw new Error("boom"); } }];
  expect(() => migrate(db, { path: ":memory:", migrations: bad })).toThrow("boom");
  const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  expect(v).toBe(MIGRATIONS.at(-1)!.version); // the good ones stayed, 999 did not
});
```

- [ ] **Step 2: Run, expect FAIL** — `bun test tests/ledger-migrations.test.ts` → "Cannot find module".
- [ ] **Step 3: Implement.** Migration 1 = the existing `CREATE TABLE IF NOT EXISTS` statements and
      column checks, moved verbatim from `openLedger` (so v0 production DBs and fresh DBs both end at
      v1 with the same schema). `migrate` reads `user_version`; if pending and `path !== ":memory:"`,
      runs `VACUUM INTO '<path>.bak-v<from>'` once; then each pending migration inside
      `db.transaction(() => { m.up(db); db.run(\`PRAGMA user_version = ${m.version}\`) })()`.
      Accept an optional `migrations` override for tests. A v0 production DB already has tables,
      so the backup guard is "the file has any table", not "user_version > 0".

```ts
export function migrate(db: Database, opts: { path: string; migrations?: Migration[] }): { from: number; to: number; backup?: string } {
  const list = opts.migrations ?? MIGRATIONS;
  const from = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const pending = list.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const hasTables = (db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n > 0;
  let backup: string | undefined;
  if (pending.length && opts.path !== ":memory:" && hasTables) {
    backup = `${opts.path}.bak-v${from}`;
    if (!existsSync(backup)) db.run(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  }
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version = ${m.version}`);
    })();
  }
  return { from, to: pending.at(-1)?.version ?? from, backup };
}
```

- [ ] **Step 4: Run** `bun test tests/ledger-migrations.test.ts tests/ledger.test.ts` → PASS (the
      existing ledger tests prove migration 1 is behavior-preserving).
- [ ] **Step 5: Commit** `feat(ledger): numbered migrations with a backup before the first pending one`.

### Task 1.2: Migration 2 — message ids and threads; migration 3 — cause columns; migration 4 — tool actions

**Files:**
- Modify: `src/engine/ledger-migrations.ts` (add v2, v3, v4 — DDL exactly as spec §3.2–3.4)
- Modify: `src/engine/ledger.ts` (new methods below)
- Test: `tests/ledger-trace.test.ts`

**Interfaces:**
- Produces on `Ledger`:
  - `insertMessage(m: NewMessage): number`
  - `messagesInThread(threadId: number, opts: { before?: number; limit: number }): MessageRow[]`
  - `messageByChannel(chatId: number, channelMsgId: number): MessageRow | undefined`
  - `setChannelMsg(msgId: number, chatId: number, channelMsgId: number): void`
  - `insertThread(t: NewThread): void`, `threadById(id: number): ThreadRow | undefined`,
    `setThreadState(id: number, state: ThreadState, at: number): void`, `touchThread(id, lastMsgId, at)`
  - `threadFacts(id: number): ThreadFacts` (counts for `deriveThreadState`, minus registry facts)
  - `recordToolAction(a: NewToolAction): void` (pruned to `toolActionsKeep`)
  - Existing writers gain an optional `cause?: Cause` (`recordOrder`, `addTodo`, `openDecision`,
    `queueDispatcherReport`, `rememberRoute`, `recordEvent`).
- Types (in `ledger.ts`): `NewMessage { chatId; role: "user" | "assistant"; content; at; threadId?; causeId?; surface?; channelMsgId?; project?; folder?; orderId?; kind?: MessageKind; priority?: Priority }`,
  `MessageKind = "text" | "ack" | "progress" | "digest" | "result" | "decision" | "alert" | "approval" | "file" | "plan" | "notice"`.

- [ ] **Step 1: Failing tests** — one per behavior:

```ts
test("insertMessage returns increasing ids and conversation() still reads oldest-first", () => {
  const led = openLedger(":memory:");
  const a = led.insertMessage({ chatId: 7, role: "user", content: "a", at: 1 });
  const b = led.insertMessage({ chatId: 7, role: "assistant", content: "b", at: 2 });
  expect(b).toBeGreaterThan(a);
  expect(led.conversation(7).map((m) => m.content)).toEqual(["a", "b"]);
});

test("messagesInThread pages newest-first with a keyset cursor", () => {
  const led = openLedger(":memory:");
  const root = led.insertMessage({ chatId: 7, role: "user", content: "r", at: 1 });
  led.insertThread({ id: root, origin: "operator", title: "r", state: "open", createdAt: 1 });
  const ids = [root];
  for (let i = 0; i < 5; i++) ids.push(led.insertMessage({ chatId: 7, role: "assistant", content: `x${i}`, at: 2 + i, threadId: root, causeId: root }));
  const page1 = led.messagesInThread(root, { limit: 2 });
  expect(page1.map((m) => m.id)).toEqual([ids[5], ids[4]]);
  const page2 = led.messagesInThread(root, { before: page1.at(-1)!.id, limit: 2 });
  expect(page2.map((m) => m.id)).toEqual([ids[3], ids[2]]);
});

test("legacy rows are grouped into one legacy thread per chat per UTC day", () => {
  // build a v0 file db with rows on two days for chat 7, open it, expect 2 threads with origin 'legacy', state 'done'
});

test("recordOrder stores the cause; an order without a cause stays NULL", () => { /* … */ });
test("tool actions prune to toolActionsKeep in batches", () => { /* insert keep+batch rows, expect ≤ keep */ });
test("EXPLAIN QUERY PLAN for messagesInThread uses idx_messages_thread", () => {
  const led = openLedger(":memory:");
  const plan = led._explain("messagesInThread"); // test-only seam returning the plan text
  expect(plan).toContain("idx_messages_thread");
});
```

  (Write the two stubbed tests in full in the same style: concrete rows, concrete expectations.)
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the migrations (spec DDL), the legacy grouping (one `INSERT INTO threads
      … SELECT MIN(id), 'legacy', … GROUP BY chat_id, at/86400000` then `UPDATE messages SET
      thread_id = …`), and the methods. `recordMessage` stays as a thin wrapper over `insertMessage`
      so existing callers keep working until Task 1.3 moves them.
- [ ] **Step 4: Run** `bun test` → all PASS.
- [ ] **Step 5: Commit** `feat(ledger): message ids, threads, cause columns, tool actions (migrations 2-4)`.

### Task 1.3: `trace.ts` — inbound, outbound, roots, refs, thread choice

**Files:**
- Create: `src/engine/trace.ts`, `src/engine/thread-state.ts`
- Test: `tests/trace.test.ts`, `tests/thread-state.test.ts`

**Interfaces:**
- Consumes: Task 1.2 ledger methods.
- Produces: `createTrace(deps: { ledger: Ledger; registry: Registry; now?: () => number }): Trace`
  with the `Trace` interface from spec §4; `deriveThreadState(f: ThreadFacts & { pendingApprovals: number; activeTurns: number }): ThreadState`;
  `refSuffix(kind: MessageKind, firstOfTurn: boolean, ref: string, mode: "auto" | "off"): string`.

- [ ] **Step 1: Failing tests**

```ts
test("ref is base36 with an m prefix and parseRef accepts m4f2, #m4f2 and 4f2", () => {
  const t = createTrace({ ledger: openLedger(":memory:"), registry: createRegistry() });
  expect(t.ref(5762)).toBe("m4g2");
  for (const s of ["m4g2", "#m4g2", "4g2", " M4G2 "]) expect(t.parseRef(s)).toBe(5762);
  expect(t.parseRef("hello")).toBeUndefined();
});

test("a new operator message roots a new thread", () => {
  const led = openLedger(":memory:");
  const t = createTrace({ ledger: led, registry: createRegistry() });
  const c = t.inbound({ chatId: 7, text: "fix the login bug", surface: "telegram", channelMsgId: 100 });
  expect(c.threadId).toBe(c.msgId);
  // No session has the message yet, so nothing is active: 'done'. The pipeline's setCause makes it 'open' (Task 1.4).
  expect(led.threadById(c.threadId)).toMatchObject({ origin: "operator", title: "fix the login bug", state: "done" });
});

test("a Telegram reply to a known Neo line joins that line's thread", () => {
  const led = openLedger(":memory:");
  const t = createTrace({ ledger: led, registry: createRegistry() });
  const root = t.inbound({ chatId: 7, text: "deploy gold", surface: "telegram", channelMsgId: 100 });
  const out = t.outbound({ chatId: 7, text: "gold finished", cause: root, kind: "result" });
  t.bindChannel(out, 7, 101);
  const reply = t.inbound({ chatId: 7, text: "and the admin too", surface: "telegram", channelMsgId: 102, replyTo: { chatId: 7, channelMsgId: 101 } });
  expect(reply.threadId).toBe(root.threadId);
});

test("a reply to an unknown or pre-migration message starts a new thread, never throws", () => {
  const t = createTrace({ ledger: openLedger(":memory:"), registry: createRegistry() });
  const c = t.inbound({ chatId: 7, text: "what about this?", surface: "telegram", channelMsgId: 9, replyTo: { chatId: 7, channelMsgId: 1 } });
  expect(c.threadId).toBe(c.msgId);
});

test("the web composer inside a thread joins it", () => { /* threadId passed → same thread */ });
test("a root for background work has its origin and no operator message", () => {
  const t = createTrace({ ledger: openLedger(":memory:"), registry: createRegistry() });
  const c = t.root({ origin: "loop", title: "loop docs-sweep", project: "neo" });
  expect(t.tree(c.msgId).thread.origin).toBe("loop");
});

test("refSuffix: ack, first reply and result-like lines get the ref; progress does not; off hides all", () => {
  expect(refSuffix("ack", false, "m4g2", "auto")).toBe(" · `m4g2`");
  expect(refSuffix("text", true, "m4g2", "auto")).toBe(" · `m4g2`");
  expect(refSuffix("text", false, "m4g2", "auto")).toBe("");
  expect(refSuffix("progress", false, "m4g2", "auto")).toBe("");
  for (const k of ["result", "decision", "alert", "digest", "plan"] as const) expect(refSuffix(k, false, "m4g2", "auto")).toBe(" · `m4g2`");
  expect(refSuffix("result", false, "m4g2", "off")).toBe("");
});
```

  `thread-state.test.ts` — a table test over spec §5's table (one row per line, plus "waiting beats
  open" and "closed by operator wins").
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Thread choice in `inbound` follows spec §4.1 in order. `refreshThread`
      reads `ledger.threadFacts` + registry facts (sessions whose `causeOf()` is in the thread and in
      turn; `blockedOn.kind === "approval"`) and writes only on change. Title = `todoTitle(text)`
      (reuse from `todo-queue.ts`).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(trace): message refs, thread choice, derived thread state`.

### Task 1.4: The cause travels — registry, pipeline, session runner, restore

**Files:**
- Modify: `src/engine/registry.ts` (`setCause`, `causeOf`, `endTurn`), `src/engine/pipeline.ts:166-300`,
  `src/engine/session-runner.ts` (turn-end callback), `src/engine/ledger.ts` (`open_sessions`
  cause columns — part of migration 3), `src/engine/reload.ts` (snapshot carries the cause)
- Test: `tests/trace-pipeline.test.ts`

**Interfaces:**
- Produces: `registry.setCause(id: string, cause: Cause): void` (pushes onto the session's delivered
  list), `registry.causeOf(id: string): Cause | undefined` (newest delivered, turn not ended),
  `registry.endTurn(id: string): Cause[]` (returns and clears the delivered list);
  `handleMessage(text, chatId, deps, source = "neo", cause?: Cause)`.
- `PipelineDeps.trace?: Trace` (absent in old tests → today's behavior).

- [ ] **Step 1: Failing tests** (fake `start` like `tests/pipeline.test.ts` does):

```ts
test("handleMessage stamps the order and every reply line with the inbound cause", async () => {
  // trace.inbound → cause; handleMessage("/open /tmp/p build x", 7, deps, "neo", cause)
  // expect ledger order.cause_msg_id === cause.msgId and every assistant row in the thread has thread_id === cause.threadId
});

test("two follow-ups queued during one turn: output goes to the later one, both are answered at turn end", async () => {
  // fake run: followUp A, followUp B, then emit onMessage("x"), then onTurnComplete({})
  // expect the "x" row's cause_id === B.msgId; registry.causeOf() undefined after the turn; both threads 'done'
});

test("the first reply of a turn carries the ref, the next ones do not", async () => { /* … */ });

test("an open-session snapshot keeps the cause across a reload", () => {
  // saveOpenSessions([{…, causeMsgId, threadId}]); takeOpenSessions() returns them; restore calls setCause
});
```

- [ ] **Step 2: FAIL.** **Step 3: Implement.** In `handleMessage`, replace `ledger.recordMessage(chatId,
      "user", text)` with the given cause (frontends now call `trace.inbound`; when `deps.trace` is
      absent, keep the old call). The `reply` wrapper calls `trace.outbound` with `registry.causeOf`
      of the replying session, the line's `priority` → `kind`, and appends `refSuffix`. The Claude
      and Codex runners call a new `onTurnEnd` handler at the same place they clear `inTurn`;
      pipeline maps it to `registry.endTurn` + `refreshThread` for each returned cause.
- [ ] **Step 4: PASS** (all existing pipeline tests unchanged). **Step 5: Commit**
      `feat(trace): the cause travels with each turn — pipeline, registry, restore`.

### Task 1.5: Dispatch, todos, decisions, files and tool actions carry the cause

**Files:**
- Modify: `src/engine/dispatch.ts` (`neoMcpServers` opts gain `cause: () => Cause | undefined`;
  `dispatchToProject` opts gain `cause?: Cause`; all `recordEvent`, `recordOrder`, digest and
  result lines pass it), `src/engine/todo-queue.ts` (`submit` takes `cause`), `src/engine/session-runner.ts`
  (`onActivity` → `recordToolAction` with the governor verdict), `src/engine/dispatch-report.ts`
  (dispatcher inbox rows carry the cause; the company sees `[dispatch result · m4g2]`)
- Test: `tests/trace-dispatch.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("a dispatch made in a later company turn carries that turn's cause, not the first order's", async () => {
  // company session: setCause(c1) … endTurn … setCause(c2); call the dispatch tool handler
  // expect the sub-order row: cause_msg_id === c2.msgId, parent_order_id === company order id
});
test("the todo, dispatch_start/dispatch_end events, progress digest and final result share the cause", async () => {});
test("a decision raised by ask_operator inside a dispatched run is in the root thread and the thread reads 'waiting'", async () => {});
test("send_file records a 'file' message in the thread", async () => {});
test("a governor escalation records a tool action with verdict 'escalate'", async () => {});
test("a loop fire roots its own thread with origin 'loop'", async () => {});
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** — pass `cause` everywhere `orderId` is passed today.
      The loop runner and scheduler call `trace.root({ origin: "loop", … })` before the run.
- [ ] **Step 4: PASS.** **Step 5: Commit** `feat(trace): dispatches, todos, decisions, files and tool actions carry the cause`.

### Task 1.6: Frontends — Telegram reply-to, web composer, `/trace`

**Files:**
- Modify: `src/frontends/telegram.ts` (call `trace.inbound` with `reply_to_message`; after each
  `sendMessage`, `trace.bindChannel`; keep `rememberRoute` and add `msg_id`/`thread_id`),
  `src/engine/web-channel.ts` (`send(text, opts?: { threadId?: number })`; feed events carry
  `msgId`, `threadId`), `src/engine/commands.ts` (`/trace`), `src/frontends/web.ts`
  (`GET /api/trace/:ref`)
- Test: `tests/trace-command.test.ts`, extend `tests/telegram-sink.test.ts`, `tests/web-channel.test.ts`

**Interfaces:** `renderTrace(tree: TraceTree, ref: (id: number) => string): string` (pure, in
`trace.ts`; ≤ 40 children → all; more → first 10, "… N more …", last 25, and the console link).

- [ ] **Step 1: Failing tests:** `/trace m4g2` renders root, state, project and children in order
      with refs and kinds; `/trace` with a bad ref → "No message m… — check the ref"; reply `/trace`
      to a bot message → that message's thread; 60 children → truncated form; an artifact whose
      thread row was pruned → "thread pruned" plus the artifacts that still exist; `GET /api/trace/:ref`
      returns JSON with the same children; unknown ref → 404.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** Add `/trace` to `COMMANDS` (summary "show everything
      a message caused") so it appears in the Telegram "/" menu.
- [ ] **Step 4: PASS.** **Step 5: Commit** `feat(trace): /trace and GET /api/trace on both surfaces`.

### Task 1.7: Docs + config for P1

- [ ] `docs/CONFIG.md`: `trace.showRefs` (`"auto"` | `"off"`, default `"auto"`), `toolActionsKeep`
      (default 100000).
- [ ] `docs/HISTORY.md`: P1 entry. `CLAUDE.md` "Current status": one line.
- [ ] `bunx tsc --noEmit`, `bun test` green. Commit `docs: trace spine (ADR-0015/0016)`.
- [ ] Report to the operator: P1 is restart-gated.

---

## P2 — Plan registry and auto-send (ADR-0019)

**Acceptance criteria**
- AC2.1 A plan/spec file written in a run (under `plans.paths`) is sent to the operator as a file
  within the same run-end, once per content version, with Approve / Changes / Execute.
- AC2.2 A worker's own `send_file` of a plan path does not cause a second send of the same version.
- AC2.3 `/plans [project]` lists plans with status, steps (`3/12`) and thread ref.
- AC2.4 Approve / Execute / Done / Drop move the status; Execute creates exactly one todo.
- AC2.5 The dispatch preamble has the plan paragraph (spec §10), and its test asserts it.

### Task 2.1: Plan detection and registry

**Files:** Create `src/engine/plans.ts`; migration 5 (the `plans` table only); Test `tests/plans.test.ts`.

**Interfaces:** `changedPlanFiles(folder: string, sinceSha: string | undefined, globs: string[], git?: GitRead): string[]`;
`registerPlan(ledger, p: { project; folder; path; content; cause?: Cause; orderId?: string }): { plan: PlanRow; isNewVersion: boolean }`;
`countSteps(md: string): { total: number; done: number }` (counts `- [ ]` / `- [x]`, ignores fenced code).

- [ ] Tests (in a temp git repo built in the test): a new file under `docs/superpowers/plans/` is
      found; a file outside the globs is not; an untracked plan is found; an unchanged file is not;
      a second register of the same content → `isNewVersion: false`; changed content → `true`;
      `countSteps` ignores checkboxes inside ``` fences; title = first `# ` heading, else the filename.
- [ ] Implement; PASS; commit `feat(plans): detect and register plan files at run end`.

### Task 2.2: Send, buttons, lifecycle

**Files:** Modify `src/engine/plans.ts`, `src/engine/dispatch.ts` (`sendProjectFile` checks the
registry), `src/engine/pipeline.ts` + `dispatch.ts` + `loop-runner.ts` (call `onRunEndPlans` after
run end with the run's start HEAD — record it at run start with `lastCommitIn`), `src/frontends/telegram.ts`
(`plan:<id>:approve|changes|execute|done|drop` callbacks), `src/engine/web-channel.ts` (same actions),
`src/engine/commands.ts` (`/plans`). Test `tests/plans-send.test.ts`.

- [ ] Tests: run end with a new plan → `sendFile` called once with caption
      `📄 plan · gold · Fare list port · thread m4g2`, a decision row opened with the five options;
      a second run end, same content → no send; worker `send_file` then run end → one send;
      Execute twice → one todo (the second tap answers "already executing as #12"); todo ends ok →
      status stays `executing` until Done or all steps checked; Drop → `abandoned`.
- [ ] Implement; PASS; commit `feat(plans): engine sends every plan once, tracks its status`.

### Task 2.3: Preamble paragraph + config + docs

- [ ] Test first in `tests/dispatch.test.ts`: `briefWithProjectDocs("x")` contains
      "docs/superpowers/plans/" and "sends it to the operator".
- [ ] Add the paragraph (spec §10) — keep it two sentences; the preamble is paid on every run.
- [ ] Config: `plans.paths` (default list in spec §10), `plans.send` (`true`). `docs/CONFIG.md`.
- [ ] Commit `feat(dispatch): the preamble tells workers where plans go and that the engine sends them`.

---

## P3 — Console: threads by project (ADR-0017)

**Acceptance criteria**
- AC3.1 The console has a Threads view: a project rail, a thread list (state chip, title, ref,
  age, counts) and a thread pane (messages, todos, decisions, plans, tool-action count).
- AC3.2 Filters: project, state, origin, date; search box (FTS). All paged, ≤ 100 rows per request.
- AC3.3 Live: a new message in an open thread appends; a state change moves the row.
- AC3.4 The composer inside a thread posts into it (joins the thread).
- AC3.5 All console strings come from `locales/{en,ar}/console.json`; Arabic renders RTL with refs
  and numbers as attached LTR runs.
- AC3.6 With 50 000 messages, the first paint of Threads is < 300 ms server time (test asserts the
  query plans; a bench script prints timings).

### UI sketch (text)

```
┌ Neo console ─────────────────────────────────────────────── EN | ع ─┐
│ [Feed] [Threads] [Projects] [Queue] [Loops] [Inbox]                  │
├──────────────┬───────────────────────────────┬──────────────────────┤
│ PROJECTS     │ 🔎 search…   state:[all▾]      │ m4g2 · gold · WAITING │
│ ● all   (42) │ origin:[all▾] since:[7d▾]      │ "fix the fare list"   │
│ ● gold   (9) │───────────────────────────────│ ───────────────────── │
│ ● waselni(7) │ 🟠 WAITING  m4g2  fix the fare │ you      10:02 fix …  │
│ ● eticket(12)│    list · gold · 2h · 1 dec    │ neo      10:02 → #31  │
│ ● neo    (5) │ 🔵 OPEN     m4f9  ota server … │ gold     10:09 prog…  │
│ ● company(9) │    waselni · 25m · #30 running │ gold     10:41 ✅ done │
│              │ 🟢 DONE     m4f1  backup che…  │ 🔵 decision: ship …?   │
│              │    eticket · 1d                │   [Ship] [Hold]       │
│              │ 🔴 FAILED   m4e7  ci fix …     │ files: plan.md (v2)   │
│              │ … [load older]                 │ tools: 214 (3 esc.)   │
│              │                               │ ───────────────────── │
│              │                               │ [reply in thread…   ] │
└──────────────┴───────────────────────────────┴──────────────────────┘
```

### Task 3.1: Read endpoints (threads, thread, search)

**Files:** Modify `src/engine/ledger.ts` (`listThreads(f: ThreadFilter & Page)`, `searchMessages(q, f)`),
`src/engine/web-channel.ts` (methods), `src/frontends/web.ts` (routes, admin-session-gated);
migration 2 already created `messages_fts`. Test `tests/console-threads.test.ts`.

**Interfaces:** `ThreadFilter = { project?: string; state?: ThreadState; origin?: ThreadOrigin; since?: number }`,
`Page = { before?: number; limit: number }` (limit clamped to 1..100).

- [ ] Tests: filter by each field; `before` cursor gives the next page with no overlap or gap;
      limit 1000 → 100 rows; unauthenticated → 401 (reuse the existing session check);
      `EXPLAIN QUERY PLAN` uses `idx_threads_project` / `idx_threads_state`.
- [ ] Implement; PASS; commit `feat(web): paged thread and message endpoints`.

### Task 3.2: Search

- [ ] Tests: search reuses `ftsQuery` from `memory-recall.ts` (export it; do not copy it); queries
      `"`, `foo -bar`, `NEAR(a b)`, `(` return rows or `[]`, never throw; Arabic fixture
      ("تذكرة الطيران") is found by "تذكرة"; results carry `threadId` and a snippet.
- [ ] Implement; PASS; commit `feat(web): message search over FTS5`.

### Task 3.3: Live thread events

- [ ] Tests: `refreshThread` that changes state emits `{ type: "thread", id, state, project, title, updatedAt }`
      once; no change → no event; message feed events carry `msgId`/`threadId`.
- [ ] Implement (trace gets an `onThreadChange` listener that web-channel subscribes); commit.

### Task 3.4: Console page split + i18n + Threads view

**Files:** Create `src/frontends/web/index.html`, `src/frontends/web/app.ts`,
`src/frontends/web/locales/en/console.json`, `src/frontends/web/locales/ar/console.json`;
modify `src/frontends/web.ts` (serve the built bundle via `Bun.build` at startup, cached);
`package.json` (`i18next`). Test `tests/console-page.test.ts` (extend), `tests/console-i18n.test.ts`.

- [ ] Tests: every key in `en` exists in `ar` and the reverse (catalogue parity); no literal
      user-facing string in `app.ts` (a test greps the bundle source for text nodes outside `t(…)`,
      with an allow-list for refs and emoji); `lang=ar` page has `dir="rtl"`; refs render inside
      `<bdi dir="ltr">`.
- [ ] Implement the Threads view per the sketch; move every existing console string into the
      catalogues in the same task.
- [ ] Commit `feat(console): threads by project, search, filters; console in AR + EN`.

---

## P4 — Attention core and engine sweeps (ADR-0018)

**Acceptance criteria**
- AC4.1 `attention_items` reconcile: insert, refresh, resolve, reopen, snooze — one function.
- AC4.2 Engine producers raise: `approval_stuck`, `dispatch_spinning`, `queue_paused`,
  `thread_failed`, `thread_waiting`, `decision_stale`, `ctx_window_suspect`, `dirty` after a todo.
- AC4.3 A spinning dispatch (same label + note + HEAD for `dispatchSpinDigests` digests) alerts the
  operator and the dispatcher once; with `dispatchSpinPolicy: "wrapup"` it also sends the wrap-up.
- AC4.4 The same `(tool, input hash)` `toolLoopLimit` times in a row in one turn → the same alert.
- AC4.5 `/attention [project]` lists open items, severity first; each has `→ todo`, `snooze 1d`,
  `dismiss`.
- AC4.6 `/gated` lists restart-gated changes computed from `engine_boots` + git + updater.
- AC4.7 ctx% > 100 shows "?" and raises `ctx_window_suspect`.

### Task 4.1: Reconcile + table (migration 5 adds `attention_items`, `engine_boots`)

**Files:** Create `src/engine/attention.ts`; Test `tests/attention.test.ts`.

**Interfaces:** `AttentionDraft = { project; folder; source; kind; key; title; detail?; url?; severity }`;
`reconcile(ledger, source: AttentionSource, project: string, drafts: AttentionDraft[] | "error", now: number): { opened: number[]; resolved: number[] }`
(`"error"` = the producer could not read; nothing changes); `snooze(id, untilMs)`, `dismiss(id)`
(= resolved by operator, not reopened until the key disappears and comes back), `listOpen(f)`.

- [ ] Tests: new draft → opened; same draft again → `last_seen` moves, nothing opened; draft gone →
      resolved; comes back → same row reopened; `"error"` → no change; snoozed item hidden until
      its time; two producers for the same project never resolve each other's items.
- [ ] Implement; PASS; commit `feat(attention): one reconcile for every producer`.

### Task 4.2: Engine producer

**Files:** Create `src/engine/producers/engine.ts`; modify `src/daemon.ts` (heartbeat step
`attention.engine`, every tick — it reads only ledger + registry). Test `tests/producer-engine.test.ts`.

- [ ] Tests, one per kind, with a fake clock and registry: approval pending > `approvalRemindMs`;
      queue paused > `queuePausedHours`; thread `failed`; thread `waiting` > `waitingHours`; open
      decision > `decisionStaleHours`; session ctx occupancy 1.4 → `ctx_window_suspect` naming the
      model and window.
- [ ] Implement; PASS; commit.

### Task 4.3: Spinning dispatch + tool-loop guard

**Files:** Modify `src/engine/dispatch.ts:769-780` (digest block) and the `onActivity` path;
`src/engine/dispatch-report.ts` (`digestFingerprint(label, note, head)` — labels normalized: digits,
hex runs and absolute paths replaced by `#`). Test `tests/dispatch-spin.test.ts`.

- [ ] Tests: 3 identical fingerprints → one alert (priority `alert`) to operator + dispatcher, one
      `dispatch_spinning` event, one attention item; a 4th identical digest → no second alert; a new
      commit resets the count; policy `"wrapup"` → the wrap-up follow-up is pushed; 8 identical
      `(tool, inputHash)` in one turn → alert; a turn end resets the tool counter.
- [ ] Implement; PASS; commit `feat(dispatch): detect spinning work by fingerprint, not by AI`.

### Task 4.4: Uncommitted work after a todo

- [ ] Tests: todo ends with `git status --porcelain` non-empty → result line gains
      "left N uncommitted files", `dirty` item (high) linked to the thread; clean → nothing.
- [ ] Implement in the todo-queue end hook via `git-read.ts`; commit.

### Task 4.5: Restart-gated producer + `/gated`

**Files:** Create `src/engine/producers/restart.ts`, `src/engine/git-read.ts` (first version: `git`
only); modify `src/daemon.ts` (write `engine_boots` at boot), `src/engine/updater.ts` (expose
`restartNeeded` results), `src/engine/commands.ts` (`/gated`). Test `tests/producer-restart.test.ts`.

- [ ] Tests (temp repo): commit after boot sha → item "live code differs" with the commit list;
      unmerged `fix/x` branch → "waiting to merge: fix/x — <subject>"; merged branch → none;
      updater `restartNeeded` → item; nothing differs → `/gated` says "running build = HEAD".
- [ ] Implement; PASS; commit `feat(engine): restart-gated changes computed from git, /gated`.

### Task 4.6: `/attention` + one-tap actions + docs

- [ ] Tests: `/attention` groups by project, severity first, ≤ 30 lines + console link; buttons
      `att:<id>:todo|snooze|dismiss` work on Telegram and web; `→ todo` twice → one todo.
- [ ] `attention-briefs.ts`: one template per kind (facts, URL, done-when). Test: every kind any
      producer emits has a template (the test imports every producer's kind list).
- [ ] Config + `docs/CONFIG.md`: `dispatchSpinDigests` (3), `dispatchSpinPolicy` (`"alert"`),
      `toolLoopLimit` (8), `queuePausedHours` (6), `waitingHours` (12), `decisionStaleHours` (24).
- [ ] Commit.

---

## P5 — Git and GitHub awareness, daily digest

**Acceptance criteria**
- AC5.1 For every tracked repo the `git` producer raises `unpushed`, `no_upstream`, `dirty`,
  `stale_branch`, `drift`, `worktree` per spec §7.
- AC5.2 The `github` producer raises `pr_open`, `pr_review_requested`, `ci_failed`, `issue_open`,
  `dependabot`, `code_scanning`, `secret_scanning`.
- AC5.3 A `gh` failure changes no items and shows on the dashboard with the last good scan time.
- AC5.4 A clean, pushed-or-merged leftover worktree has a Remove action (`git worktree remove`, no
  `--force`); a dirty one only `→ todo`.
- AC5.5 The daily digest is sent at `attention.digestAt`, to Decisions only when a high item exists.
- AC5.6 No repo, branch or label name is in code.

### Task 5.1: `git-read.ts` — the only process boundary

**Interfaces:** `GitRead = { git(folder: string, args: string[]): Promise<{ ok: boolean; out: string; err?: string }>; gh(folder: string, args: string[]): Promise<…> }`,
`createGitRead({ timeoutMs })`. Runs with `GH_PAGER=`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`,
kills on timeout. Producers take a `GitRead`, so tests use a fake.

- [ ] Tests: timeout → `{ ok: false, err: "timeout" }`; non-zero exit → `ok: false` with stderr;
      never throws. Commit.

### Task 5.2: `git` and `github` producers

**Files:** Create `src/engine/producers/git.ts`, `src/engine/producers/github.ts`; modify
`src/daemon.ts` (heartbeat step `attention.scan` gated by `github.scanEveryMs`; one project per
call, sequential). Test `tests/producer-git.test.ts` (temp repos with a bare remote),
`tests/producer-github.test.ts` (fake `gh` JSON fixtures).

- [ ] git tests: branch 2 ahead of upstream → `unpushed` key = branch; no upstream → `no_upstream`;
      `dev` 14 ahead of `main` with `driftPairs: [["dev","main"]]` → `drift`; branch idle 30 d and
      unmerged → `stale_branch`; linked worktree with no session → `worktree` with clean/dirty and
      pushed/merged facts.
- [ ] github tests: fixtures for each command → the right drafts and severities; `gh` exit 1 →
      `"error"` → reconcile changes nothing (Review Focus 4); 403 rate-limit body → same, plus one
      `github_scan_error` event per project per hour.
- [ ] Implement; PASS; commit `feat(attention): git and GitHub producers`.

### Task 5.3: Worktree Remove action

- [ ] Tests: Remove on a clean, merged worktree runs `git worktree remove <path>` once and resolves
      the item; on a dirty one the button is absent and a direct call refuses; a session running in
      the worktree → refuse with "in use by <session>".
- [ ] Implement; commit.

### Task 5.4: Daily digest

**Files:** `src/engine/attention.ts` (`renderDigest(items, prev): { text; priority; buttons }`),
`src/daemon.ts` (cron step via `trigger.ts`'s cron matcher). Test `tests/attention-digest.test.ts`.

- [ ] Tests: high item → priority `result`; none → `progress`; nothing new and nothing high → one
      line; ≤ 3 items per project with `→ todo` buttons; a project with 0 items is omitted; the
      digest roots its own thread (`origin: "attention"`), so taps link to it.
- [ ] Implement; commit.

### Task 5.5: Config + docs

- [ ] `github.scanEveryMs` (1800000), `github.callTimeoutMs` (20000), `attention.digestAt`
      (`"0 8 * * *"`), `staleBranchDays` (21), `worktreeIdleHours` (12), `projects.<name>`:
      `trackedBranches`, `driftPairs`, `issueLabel` (`"neo"`), `ignoreKinds`, `deployedVersionUrl`,
      `healthUrl`. `docs/CONFIG.md`, `docs/HISTORY.md`. Commit.

---

## P6 — Project dashboard

**Acceptance criteria**
- AC6.1 `projectView(name)` returns spec §9's shape; the web Projects tab, `/project <name>` and the
  company's `sessions` tool all read it.
- AC6.2 "Undeployed" shows only when `deployedVersionUrl` is configured.
- AC6.3 Health follows the pure rule in spec §9.
- AC6.4 The Neo project card shows restart-gated changes.

### UI sketch (web)

```
┌ gold ───────────────────────────────── health: 🟠 attention ─┐
│ NOW      working · 12m · "fare list port" · thread m4g2      │
│ QUEUE    #31 running · #32 queued "admin fees" · #33 queued  │
│ GIT      dev @ a1b2c3 "fix fees" 2h · 3 unpushed · dirty 0   │
│          dev → main: 14 ahead · worktrees: 1 (gold-ota, 2d)  │
│ DEPLOY   2 commits not deployed (main @ 9f8e7d live)         │
│ GITHUB   PRs 2 · CI ❌ dev (build #812) · issues 4 · alerts 1 │
│ DECIDE   🔵 "ship fee change to prod?" 3h · m4g7             │
│ PLANS    Fare list port — executing 7/12 · m4g2              │
│          OTA server — sent, not reviewed 2d · m4c1           │
│ ATTENTION (5)  🔴 CI failed on dev        [→ todo] [snooze]  │
│                🔴 3 commits not pushed    [→ todo] [snooze]  │
│                🟡 worktree gold-ota idle  [remove] [→ todo]  │
│ THREADS  m4g2 WAITING fix the fare list · m4f9 DONE …        │
└──────────────────────────────────────────────────────────────┘
```

### Telegram sketch (`/project gold`)

```
gold · 🟠 attention
now: working 12m — fare list port · m4g2
queue: #31 running, 2 queued
git: dev a1b2c3 · 3 unpushed · dev→main +14 · 1 worktree
github: 2 PRs · CI ❌ dev · 1 alert
decide: ship fee change to prod? (3h) · m4g7
plans: Fare list port 7/12 · OTA server (unreviewed 2d)
[attention (5)] [threads] [open console]
```

### Task 6.1: `projectView` read model

**Files:** Create `src/engine/project-view.ts`; modify `src/engine/dashboard.ts` (reuse its
session/todo mapping; do not duplicate it). Test `tests/project-view.test.ts`.

- [ ] Tests: each field from fixtures (ledger rows + fake registry + attention rows + `meta` gh
      row); health table; no `deployedVersionUrl` → `undeployed` absent; Neo → `restartGated` set;
      a sent plan whose file was deleted → the plan line reads "file missing" (spec §11.7).
- [ ] Implement; commit.

### Task 6.2: Surfaces

- [ ] Web: `GET /api/projects`, `GET /api/projects/:name`; Projects tab per sketch, strings in the
      catalogues; buttons reuse the attention actions.
- [ ] Telegram: `/project <name>` (alias `/p`) per sketch; inline buttons.
- [ ] Company: the `sessions` tool output gains the one-line project summary (no new tool).
- [ ] Tests for each surface; commit `feat: project dashboard on web, Telegram and for the company`.

### Task 6.3: Deployed-version probe (optional per project)

- [ ] Tests: URL returns `{ "version": "9f8e7d" }` with `deployedVersionPath: "version"` → undeployed
      = commits after it on the deploy branch; URL down → `undeployed` absent + `meta` error; never
      throws. The probe runs in the scan step with the same timeout. Commit.

---

## More features proposed (beyond the asks — each needs the operator's yes)

Ranked by value for managing many projects. None is in the phases above.

1. **"Since you were away" brief.** When the operator sends the first message after N hours of
   silence, Neo answers it and adds one block: threads that changed state, results, open decisions,
   new high items. Code over the ledger; no AI.
2. **Weekly project report as a file.** Per project: threads done/failed, todos, commits, CI pass
   rate, open items trend. Markdown file sent on Friday. Pure SQL + git.
3. **Ref everywhere.** Commit trailers `Neo-Thread: m4g2` added by the preamble, so `git log`
   links back to the thread, and the git producer can show "commits for this thread".
4. **Done-means-verified gate** (the research plan's P3): a todo is `done` only if its folder is
   clean and the result names a commit; else `done-unverified`. Uses Task 4.4's check.
5. **Telegram lines in catalogues.** Move engine chrome lines (acks, digests, `/trace` text) into
   `locales/{en,ar}/engine.json` so the bot can speak Arabic too. Large but mechanical.
6. **Thread-scoped `/kill` and `/retry`.** `/retry m4g2` re-submits the root brief as a new todo in
   the same thread; `/kill m4g2` stops every run under that thread.
7. **Budget per thread.** Sum `costUsd` of the orders in a thread; show it on the thread and the
   dashboard. The data is already in run results.
8. **Approval board** (research plan P0 Task 0.1) as the single answer path, which this plan's
   `approval_stuck` and thread state read from.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Migration 2 rebuilds `messages` on a large live DB | slow boot; a failure blocks start | `VACUUM INTO` backup first; one transaction; test on a copy of the production ledger before the restart; boot logs row counts |
| Turn attribution when the CLI merges queued input | a reply filed under the later of two messages | documented in ADR-0015; both messages answered; `/trace` shows "answered in" |
| More writes per line (message row + FTS) | ledger contention | single INSERTs on the existing busy timeout; FTS triggers are cheap; tool actions pruned in batches |
| `gh`/`git` subprocess cost and hangs | slow tick | separate heartbeat step, one project per tick, timeout, kill on timeout |
| GitHub rate limits | missing data | ~200 calls/hour; error → no change + visible error |
| Noise (too many attention items) | operator ignores the list | severities, snooze, `ignoreKinds` per project, digest shows top 3 per project |
| Console rewrite (page split + i18n) regresses the bounded feed | freeze returns | keep the feed code from b44a975 unchanged; extend `console-page.test.ts`; Threads is a new tab |
| The plan send floods Telegram with many plan versions | flood ban (2026-10-01) | one send per content hash per run end; all sends go through the existing flood gate |
| Worktree Remove deletes work | data loss | only clean + pushed/merged; no `--force`; operator tap required |

## Scope

**In:** everything in P1–P6; the ADRs 0015–0019; `CONTEXT.md`; config + docs for each knob.

**Out:** customer inbox threading; GitHub webhooks; AI summaries; Neo in Docker (an existing
exception — the engine needs the host's `/home` and `~/.claude`; the operator decides); merging any
branch other than the two P0 prerequisites; the "More features" list until approved; mobile app.

## Self-review

- Spec coverage: §3 schemas → Tasks 1.1, 1.2, 2.1, 4.1; §4 cause seam → 1.3–1.6; §5 thread state →
  1.3; §6 console → P3; §7 attention → P4, P5; §8 sweeps → 4.2–4.5, 5.3; §9 dashboard → P6; §10 plans
  → P2; §11 edge cases → 1 (1.3), 2 (1.4), 3 (1.4), 4 (1.6 "thread pruned" — in its test list), 5–6 (5.2), 7 (6.1
  "file missing"), 8 (documented), 9–10 (3.2), 11 (1.2, 3.1), 12 (4.6, 2.2).
- Detail level: P1 has full test code. P2–P6 list every test case by name and expectation; each
  phase's executor writes the test code in the P1 style at the start of the phase, because the exact
  helper names come from P1's merged code.
- Types: `Cause`, `ThreadState`, `MessageKind`, `AttentionDraft`, `ProjectView`, `GitRead` are
  defined once (spec §4, §5, §7, §9 and this plan's tasks) and used with the same names throughout.
