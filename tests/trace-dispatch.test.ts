// Task 1.5 (spec §4.2, §3.3, §3.4, §5): dispatches, todos, decisions, files and tool actions carry
// the cause of the turn that made them — the company's CURRENT turn, read at tool-call time.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { neoMcpServers, type DispatchDeps } from "../src/engine/dispatch";
import { dispatchDepsFrom, handleMessage, type PipelineDeps } from "../src/engine/pipeline";
import { openLedger, type Cause } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { createTrace } from "../src/engine/trace";
import { createTodoQueue } from "../src/engine/todo-queue";
import { buildCanUseTool, type RunDeps, type RunHandlers, type RunResult, type SessionRun } from "../src/engine/session-runner";
import { startLoop, startScheduledLoop, type LoopDef } from "../src/engine/loops";
import { loadConfig } from "../src/config";
import type { Order } from "../src/types";

const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();

/** Fake worker runs: each keeps its handlers and run deps, and ends when the test says so. */
function fakeRuns() {
  const runs: Array<{ order: Order; h: RunHandlers; runDeps: RunDeps; finish: (r: RunResult) => void; followUps: string[] }> = [];
  const start = (order: Order, h: RunHandlers, runDeps: RunDeps = {}): SessionRun => {
    let finish!: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => (finish = res));
    const followUps: string[] = [];
    runs.push({ order, h, runDeps, finish, followUps });
    return { followUp: (t) => void followUps.push(t), queued: () => 0, active: () => true, closed: () => false, close: () => {}, interrupt: async () => {}, done };
  };
  return { runs, start };
}

function setup(opts: { progressMs?: number } = {}) {
  const dir = mkdtempSync(join(base, "neo-trace-disp-"));
  const root = join(dir, "work");
  mkdirSync(join(root, "eticket-v3"), { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  const path = join(dir, "ledger.db");
  const ledger = openLedger(path);
  const registry = createRegistry();
  const trace = createTrace({ ledger, registry });
  const cfg = loadConfig(dir);
  cfg.trustNewProjects = false;
  cfg.workRoot = root;
  if (opts.progressMs !== undefined) cfg.dispatchProgressMs = opts.progressMs;
  const sent: Array<{ text: string; priority?: string }> = [];
  const files: string[] = [];
  const { runs, start } = fakeRuns();
  const queue = createTodoQueue({ ledger, registry, onFailure: () => "continue", dispatchOpts: { start: start as never, root } });
  const pipeline: PipelineDeps = {
    cfg,
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, _p, priority) => void sent.push({ text, priority }),
    askApproval: async () => "deny",
    postDecision: async () => ({ chatId: 99, messageId: 1 }),
    sendFile: (_c, p) => void files.push(p),
    todo: queue,
    trace,
    start: start as never,
  };
  const deps: DispatchDeps = dispatchDepsFrom(pipeline, 7);
  queue.setLauncher(() => ({ deps, replyChat: 7 }));
  const db = () => new Database(path, { readonly: true });
  const inbound = (text: string): Cause => trace.inbound({ chatId: 7, text, surface: "telegram" });
  return { dir, root, ledger, registry, trace, cfg, pipeline, deps, queue, runs, sent, files, db, inbound };
}

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text?: string }> }>;
function tool(servers: Record<string, unknown> | undefined, name: string): (a: Record<string, unknown>) => Promise<string> {
  const neo = servers!.neo as { instance: { _registeredTools: Record<string, { handler: Handler }> } };
  const h = neo.instance._registeredTools[name]!.handler;
  return async (a) => (await h(a, {})).content[0]?.text ?? "";
}

const orderRow = (s: ReturnType<typeof setup>, id: string) =>
  s.db().query(`SELECT cause_msg_id, thread_id, parent_order_id FROM orders WHERE id = ?`).get(id) as {
    cause_msg_id: number | null; thread_id: number | null; parent_order_id: string | null;
  };

test("a dispatch made in a later company turn carries that turn's cause, not the first order's", async () => {
  const s = setup();
  // The company: idle at rest, resumed by the operator's first message (c1).
  const company = s.registry.add({ id: "co-0", source: "neo", folder: join(s.root, "agent"), task: "company", chatId: 7, createdAt: 0 });
  s.registry.setDefault(company.id);
  s.registry.setStatus(company.id, "idle");
  const c1 = s.inbound("look at the fares");
  await handleMessage("look at the fares", 7, s.pipeline, "neo", c1);
  const companyRun = s.runs[0]!;
  const companyOrder = s.ledger.listRecent().find((o) => o.folder === join(s.root, "agent"))!;
  companyRun.h.onTurnEnd?.(); // c1's turn is over
  // A second operator message (a new thread) is delivered into the live company: c2's turn.
  const c2 = s.inbound("now fix the seat map");
  await handleMessage("now fix the seat map", 7, s.pipeline, "neo", c2);
  expect(c2.threadId).not.toBe(c1.threadId);

  const out = await tool(companyRun.runDeps.mcpServers, "dispatch")({ project: "eticket-v3", task: "fix the seat map" });
  expect(out).toContain("dispatched to eticket-v3");
  const sub = s.runs[1]!.order;
  expect(orderRow(s, sub.id)).toEqual({ cause_msg_id: c2.msgId, thread_id: c2.threadId, parent_order_id: companyOrder.id });
  // The resumed company order is the one c1 started.
  expect(orderRow(s, companyOrder.id).cause_msg_id).toBe(c1.msgId);
});

test("the todo, dispatch_start/dispatch_end events, progress digest and final result share the cause", async () => {
  const s = setup({ progressMs: 8 });
  const c = s.inbound("ship the seat map");
  const servers = neoMcpServers({ ...s.deps }, 7, { dispatch: true, workClass: "interactive", folder: join(s.root, "agent"), orderId: "co-1", cause: () => c });
  await tool(servers, "dispatch")({ project: "eticket-v3", task: "ship the seat map" });
  const run = s.runs[0]!;
  const todo = s.ledger.listTodos({})[0]!;
  expect(todo.cause).toEqual(c);
  expect(s.ledger.threadById(c.threadId)?.state).toBe("open"); // work is running in this thread

  run.h.onMessage("working on it");
  await settle(60); // a digest tick fires with activity since the last one
  run.finish({ ok: true, sessionId: "s1", summary: "seat map shipped", costUsd: 0 });
  await settle();

  const db = s.db();
  const events = db.query(`SELECT kind, msg_id FROM events WHERE order_id = ? AND kind IN ('dispatch_start', 'dispatch_end')`).all(run.order.id) as Array<{ kind: string; msg_id: number | null }>;
  expect(events.map((e) => e.kind).sort()).toEqual(["dispatch_end", "dispatch_start"]);
  expect(events.every((e) => e.msg_id === c.msgId)).toBe(true);
  const inbox = db.query(`SELECT text, cause_msg_id, thread_id FROM dispatcher_inbox`).all() as Array<{ text: string; cause_msg_id: number; thread_id: number }>;
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ cause_msg_id: c.msgId, thread_id: c.threadId });
  // The company sees which thread the result belongs to.
  expect(inbox[0]!.text.startsWith(`[dispatch result · ${s.trace.ref(c.threadId)}] eticket-v3:`)).toBe(true);

  const lines = s.ledger.messagesInThread(c.threadId, { limit: 100 }).reverse();
  const digest = lines.find((m) => m.content.startsWith("[dispatch progress]"));
  const result = lines.find((m) => m.content.includes("finished: seat map shipped"));
  expect(digest).toMatchObject({ kind: "progress", causeId: c.msgId });
  expect(result).toMatchObject({ kind: "result", causeId: c.msgId });
  // The channel copy of the result carries the thread ref; the digest (progress) carries none.
  expect(s.sent.find((l) => l.text.includes("finished"))!.text).toContain(s.trace.ref(c.threadId));
  // The run ended ok, and its todo is done: the thread is done.
  expect(s.ledger.todoById(todo.id)?.status).toBe("done");
  expect(s.ledger.threadById(c.threadId)?.state).toBe("done");
});

test("a decision raised by ask_operator inside a dispatched run is in the root thread and the thread reads 'waiting'", async () => {
  const s = setup();
  const c = s.inbound("pick a db for the fares");
  const servers = neoMcpServers({ ...s.deps }, 7, { dispatch: true, workClass: "interactive", folder: join(s.root, "agent"), orderId: "co-1", cause: () => c });
  await tool(servers, "dispatch")({ project: "eticket-v3", task: "pick a db" });
  const sub = s.runs[0]!;
  await tool(sub.runDeps.mcpServers, "ask_operator")({
    title: "Postgres or Mongo?",
    context: "The fares store needs a database; both fit.",
    options: [
      { label: "Postgres", detail: "relational, existing infra", recommended: true },
      { label: "Mongo", detail: "document store, new infra" },
    ],
    recommendation: "Postgres — we already run it.",
  });
  const open = s.ledger.listOpenDecisions();
  expect(open).toHaveLength(1);
  expect(open[0]!.cause).toEqual(c);
  expect(s.ledger.threadById(c.threadId)?.state).toBe("waiting");
});

test("send_file records a 'file' message in the thread", async () => {
  const s = setup();
  const c = s.inbound("send me the report");
  const servers = neoMcpServers({ ...s.deps }, 7, { dispatch: true, workClass: "interactive", folder: join(s.root, "agent"), orderId: "co-1", cause: () => c });
  await tool(servers, "dispatch")({ project: "eticket-v3", task: "send the report" });
  const sub = s.runs[0]!;
  writeFileSync(join(s.root, "eticket-v3", "report.pdf"), "%PDF bytes");
  expect(await tool(sub.runDeps.mcpServers, "send_file")({ path: "report.pdf", caption: "the fares report" })).toContain("sent");
  expect(s.files).toHaveLength(1);
  const file = s.ledger.messagesInThread(c.threadId, { limit: 100 }).find((m) => m.kind === "file");
  expect(file).toMatchObject({ content: "the fares report", causeId: c.msgId, role: "assistant" });
  expect(file!.content).not.toContain("%PDF");
  // No caption: the file name, never the bytes.
  await tool(sub.runDeps.mcpServers, "send_file")({ path: "report.pdf" });
  expect(s.ledger.messagesInThread(c.threadId, { limit: 100 }).filter((m) => m.kind === "file").map((m) => m.content)).toContain("report.pdf");
});

test("a governor escalation records a tool action with verdict 'escalate'", async () => {
  // The runner reports each decided call once, with the activity label — never the raw input.
  const verdicts: Array<[string, string, string]> = [];
  const canUse = buildCanUseTool(
    { onMessage: () => {}, onEscalation: async () => "deny", onToolVerdict: (t, l, v) => void verdicts.push([t, l, v]) },
    "/home/acme",
    "neo",
  );
  await canUse("WebFetch", { url: "https://example.com/x", prompt: "a very long prompt body" });
  await canUse("Read", { file_path: "/home/acme/a.ts" });
  expect(verdicts).toEqual([
    ["WebFetch", "WebFetch: https://example.com/x", "escalate"],
    ["Read", "Read: a.ts", "allow"],
  ]);
  const trusted = buildCanUseTool(
    { onMessage: () => {}, onEscalation: async () => "deny", autoApprove: () => true, onToolVerdict: (t, l, v) => void verdicts.push([t, l, v]) },
    "/home/acme",
    "neo",
  );
  await trusted("WebFetch", { url: "https://example.com/y" });
  expect(verdicts.at(-1)).toEqual(["WebFetch", "WebFetch: https://example.com/y", "auto"]);

  // A dispatched run writes it under the order and the cause.
  const s = setup();
  const c = s.inbound("check the docs site");
  const servers = neoMcpServers({ ...s.deps }, 7, { dispatch: true, workClass: "interactive", folder: join(s.root, "agent"), orderId: "co-1", cause: () => c });
  await tool(servers, "dispatch")({ project: "eticket-v3", task: "check it" });
  const sub = s.runs[0]!;
  sub.h.onToolVerdict?.("WebFetch", "WebFetch: https://example.com/x", "escalate");
  const rows = s.db().query(`SELECT order_id, msg_id, thread_id, tool, label, verdict FROM tool_actions`).all();
  expect(rows).toEqual([{ order_id: sub.order.id, msg_id: c.msgId, thread_id: c.threadId, tool: "WebFetch", label: "WebFetch: https://example.com/x", verdict: "escalate" }]);
  expect(s.trace.tree(c.msgId).toolActions).toBe(1);
});

test("a session the operator opened records its tool actions under its turn's cause", async () => {
  const s = setup();
  const dir = join(s.root, "eticket-v3");
  const text = `/open ${dir} audit the fares`;
  const c = s.inbound(text);
  await handleMessage(text, 7, s.pipeline, "neo", c);
  const run = s.runs[0]!;
  run.h.onToolVerdict?.("Bash", "Bash: git push", "deny");
  const rows = s.db().query(`SELECT order_id, msg_id, verdict FROM tool_actions`).all();
  expect(rows).toEqual([{ order_id: run.order.id, msg_id: c.msgId, verdict: "deny" }]);
  // Its own send_file is filed under the same cause.
  writeFileSync(join(dir, "notes.md"), "x");
  await tool(run.runDeps.mcpServers, "send_file")({ path: "notes.md" });
  expect(s.ledger.messagesInThread(c.threadId, { limit: 100 }).some((m) => m.kind === "file" && m.content === "notes.md")).toBe(true);
});

test("a loop fire roots its own thread with origin 'loop'", async () => {
  const s = setup();
  const folder = join(s.root, "agent");
  const loop: LoopDef = {
    name: "nightly-docs", usage: "/loop nightly-docs", summary: "docs", folder, prompt: "sync docs",
    goal: { kind: "command", command: ["true"] }, trigger: { kind: "manual" }, bounds: { maxIterations: 1 },
  };
  let checks = 0;
  const check = async () => ({ met: checks++ > 0, detail: checks > 1 ? "docs in sync" : "docs stale" });
  const run = (async (_o: Order, h: RunHandlers) => {
    h.onMessage("updated README");
    return { ok: true, sessionId: "s1", summary: "ok", costUsd: 0 };
  }) as never;
  await startScheduledLoop(loop, { reply: () => {}, chatId: 7, run, check, trace: s.trace });
  const threads = s.db().query(`SELECT id, origin, title, project, folder FROM threads WHERE origin = 'loop'`).all() as Array<{ id: number; origin: string; title: string; project: string; folder: string }>;
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({ origin: "loop", title: "loop nightly-docs", project: "agent", folder });
  // The worker's line is filed in the loop's own thread.
  expect(s.ledger.messagesInThread(threads[0]!.id, { limit: 50 }).some((m) => m.content === "updated README")).toBe(true);

  // A manual /loop fire roots its own thread too, and its outcome line lands in it.
  checks = 0;
  await startLoop(loop, 7, { reply: () => {}, run, check, trace: s.trace });
  const all = s.db().query(`SELECT id FROM threads WHERE origin = 'loop' ORDER BY id`).all() as Array<{ id: number }>;
  expect(all).toHaveLength(2);
  const lines = s.ledger.messagesInThread(all[1]!.id, { limit: 50 });
  expect(lines.some((m) => m.kind === "result" && m.content.includes("goal met"))).toBe(true);

  // No trace: nothing is rooted, and the loop still runs.
  checks = 0;
  const out = await startScheduledLoop(loop, { reply: () => {}, chatId: 7, run, check });
  expect(out.met).toBe(true);
  expect(s.db().query(`SELECT count(*) AS n FROM threads WHERE origin = 'loop'`).get()).toEqual({ n: 2 });
});
