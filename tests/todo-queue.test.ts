import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { createApiCooldown } from "../src/engine/api-retry";
import type { DispatchDeps } from "../src/engine/dispatch";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";
import { continuationBrief } from "../src/engine/context-policy";
import { createTodoQueue, projectBusy, todoTitle } from "../src/engine/todo-queue";

const settle = () => new Promise((r) => setTimeout(r, 25));

/** A fake worker run whose end the test controls. */
function fakeRuns() {
  const runs: Array<{ task: string; finish: (r: RunResult) => void }> = [];
  const start = (order: { task: string }) => {
    let finish!: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => (finish = res));
    runs.push({ task: order.task, finish });
    return { followUp: () => {}, queued: () => 0, active: () => true, closed: () => false, close: () => {}, interrupt: async () => {}, done };
  };
  return { runs, start };
}

function setup(opts: { onFailure?: "continue" | "pause" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-todo-"));
  mkdirSync(join(root, "eticket-v3"));
  mkdirSync(join(root, "waselni"));
  const replies: Array<{ text: string; project?: string; priority?: string }> = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const deps: DispatchDeps = {
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, project, priority) => void replies.push({ text, project, priority }),
    askApproval: async () => "deny",
    workRoot: root,
  };
  const { runs, start } = fakeRuns();
  const queue = createTodoQueue({
    ledger,
    registry,
    onFailure: () => opts.onFailure ?? "continue",
    dispatchOpts: { start: start as never, now: () => 1_000 },
  });
  queue.setLauncher(() => ({ deps, replyChat: 1 }));
  return { root, replies, ledger, registry, deps, queue, runs };
}

const ok = (summary = "all green"): RunResult => ({ ok: true, sessionId: "s1", summary, costUsd: 0 });
const bad = (summary = "boom"): RunResult => ({ ok: false, sessionId: "", summary, costUsd: 0 });

// --- the ledger store -------------------------------------------------------------------------

test("ledger: todos are durable, numbered, and ordered by position within a project", () => {
  const ledger = openLedger(":memory:");
  const a = ledger.addTodo({ project: "p", folder: "/home/p", brief: "one", workClass: "interactive", createdBy: "operator" }, 10);
  const b = ledger.addTodo({ project: "p", folder: "/home/p", brief: "two", workClass: "interactive", createdBy: "operator" }, 11);
  const c = ledger.addTodo({ project: "p", folder: "/home/p", brief: "three", team: "frontend-backend", workClass: "background", createdBy: "company" }, 12);
  expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
  expect(ledger.listTodos({ folder: "/home/p", statuses: ["queued"] }).map((t) => t.brief)).toEqual(["one", "two", "three"]);
  expect(c.team).toBe("frontend-backend");
  expect(c.createdBy).toBe("company");

  ledger.moveTodo(c.id, 1);
  expect(ledger.listTodos({ folder: "/home/p", statuses: ["queued"] }).map((t) => t.brief)).toEqual(["three", "one", "two"]);

  ledger.updateTodo(a.id, { status: "running", orderId: "o-1", startedAt: 20 });
  expect(ledger.todoByOrder("o-1")?.id).toBe(a.id);
  expect(ledger.queuedTodoFolders()).toEqual(["/home/p"]);

  ledger.setTodoPaused("/home/p", "#1 failed", 30);
  expect(ledger.todoPaused("/home/p")?.reason).toBe("#1 failed");
  ledger.setTodoPaused("/home/p", null);
  expect(ledger.todoPaused("/home/p")).toBeUndefined();
});

// --- AC1/AC2: idle runs now, busy is queued ------------------------------------------------------

test("a brief to an idle project runs now and is tracked as a running todo", async () => {
  const { queue, ledger, runs } = setup();
  const out = await queue.submit({ project: "eticket-v3", brief: "fare step UI", workClass: "interactive" }, queue.launcher()!.deps, 1);
  expect(out).toContain("dispatched to eticket-v3");
  expect(out).toContain("#1");
  expect(runs).toHaveLength(1);
  const [t] = ledger.listTodos({});
  expect(t).toMatchObject({ id: 1, status: "running", project: "eticket-v3", createdBy: "operator" });
  expect(t.orderId).toBeTruthy();
});

test("a brief to a busy project is queued with its number and position, and nothing new starts", async () => {
  const { queue, ledger, runs, replies } = setup();
  const { deps } = queue.launcher()!;
  await queue.submit({ project: "eticket-v3", brief: "first", workClass: "interactive" }, deps, 1);
  const second = await queue.submit({ project: "eticket-v3", brief: "second", workClass: "interactive" }, deps, 1);
  const third = await queue.submit({ project: "eticket-v3", brief: "third", workClass: "interactive" }, deps, 1);
  expect(second).toContain("queued as #2 for eticket-v3, position 1");
  expect(third).toContain("queued as #3 for eticket-v3, position 2");
  expect(runs).toHaveLength(1); // never pushed into the running session, never a second run
  expect(ledger.listTodos({ statuses: ["queued"] }).map((t) => t.brief)).toEqual(["second", "third"]);
  expect(replies.some((r) => r.text.includes("queued #2"))).toBe(true);
});

test("two briefs for an idle project in the same instant: the first runs, the second waits", async () => {
  const { queue, runs } = setup();
  const { deps } = queue.launcher()!;
  const [a, b] = await Promise.all([
    queue.submit({ project: "eticket-v3", brief: "a", workClass: "interactive" }, deps, 1),
    queue.submit({ project: "eticket-v3", brief: "b", workClass: "interactive" }, deps, 1),
  ]);
  expect(a).toContain("dispatched");
  expect(b).toContain("queued as #2");
  expect(runs).toHaveLength(1);
});

test("an unknown project is refused exactly as before and creates no todo", async () => {
  const { queue, ledger } = setup();
  const out = await queue.submit({ project: "nope", brief: "x", workClass: "interactive" }, queue.launcher()!.deps, 1);
  expect(out).toContain('No project or desk named "nope"');
  expect(ledger.listTodos({})).toHaveLength(0);
});

test("a held brief to an idle project is refused as before (cooldown) and creates no todo", async () => {
  const { queue, ledger, deps } = setup();
  const cooldown = createApiCooldown({ cooldownMs: 60_000 });
  cooldown.note("rate_limit", 1_000);
  const out = await queue.submit({ project: "eticket-v3", brief: "x", workClass: "interactive" }, { ...deps, cooldown }, 1);
  expect(out).not.toContain("dispatched");
  expect(ledger.listTodos({})).toHaveLength(0);
});

// --- AC3: release on completion ------------------------------------------------------------------

test("when the running todo completes, its result goes out first, then the next todo starts with one line", async () => {
  const { queue, ledger, runs, replies } = setup();
  const { deps } = queue.launcher()!;
  await queue.submit({ project: "eticket-v3", brief: "first", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "fare step UI\nwith details", workClass: "interactive" }, deps, 1);
  runs[0].finish(ok());
  await settle();

  expect(runs).toHaveLength(2);
  expect(runs[1].task).toContain("fare step UI");
  expect(ledger.todoById(1)).toMatchObject({ status: "done", result: "all green" });
  expect(ledger.todoById(2)?.status).toBe("running");

  const finished = replies.findIndex((r) => r.text.includes("finished"));
  const line = replies.findIndex((r) => r.text === "eticket-v3: done #1, starting #2 'fare step UI'");
  expect(finished).toBeGreaterThanOrEqual(0);
  expect(line).toBeGreaterThan(finished); // the result reached the operator first
  expect(replies.filter((r) => r.text.startsWith("→ dispatching")).length).toBe(1); // no duplicate start line

  // the dispatcher's result says what the queue does next
  const report = ledger.pendingDispatcherReports().map((r) => r.text).join("\n");
  expect(report).toContain("[dispatch result] eticket-v3: all green");
  expect(report).toContain("next: #2");
});

test("a completion with an empty queue sends no extra queue line", async () => {
  const { queue, runs, replies } = setup();
  await queue.submit({ project: "eticket-v3", brief: "only", workClass: "interactive" }, queue.launcher()!.deps, 1);
  runs[0].finish(ok());
  await settle();
  expect(replies.some((r) => r.text.includes("done #1"))).toBe(false);
});

test("failure policy continue: a failed todo is reported and the next one starts", async () => {
  const { queue, ledger, runs, replies } = setup({ onFailure: "continue" });
  const { deps } = queue.launcher()!;
  await queue.submit({ project: "eticket-v3", brief: "first", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "second", workClass: "interactive" }, deps, 1);
  runs[0].finish(bad());
  await settle();
  expect(ledger.todoById(1)).toMatchObject({ status: "failed", result: "boom" });
  expect(runs).toHaveLength(2);
  expect(replies.some((r) => r.text === "eticket-v3: #1 failed, starting #2 'second'")).toBe(true);
});

test("failure policy pause: a failed todo pauses the queue and the next one waits", async () => {
  const { queue, ledger, runs, replies } = setup({ onFailure: "pause" });
  const { deps } = queue.launcher()!;
  await queue.submit({ project: "eticket-v3", brief: "first", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "second", workClass: "interactive" }, deps, 1);
  runs[0].finish(bad());
  await settle();
  expect(runs).toHaveLength(1);
  expect(ledger.todoById(2)?.status).toBe("queued");
  expect(ledger.todoPaused(join(queue.launcher()!.deps.workRoot!, "eticket-v3"))).toBeDefined();
  expect(replies.some((r) => r.text.includes("#1 failed") && r.text.includes("queue paused") && r.text.includes("1 waiting"))).toBe(true);
  const report = ledger.pendingDispatcherReports().map((r) => r.text).join("\n");
  expect(report).toContain("queue paused");

  // resume releases it
  expect(queue.resume("eticket-v3")).toContain("resumed");
  await settle();
  expect(runs).toHaveLength(2);
  expect(ledger.todoById(2)?.status).toBe("running");
});

// --- AC4: restart -------------------------------------------------------------------------------

test("boot recovery: a running todo is failed with where it stopped; queued ones resume in order", async () => {
  const { queue, ledger, runs } = setup();
  const folder = join(queue.launcher()!.deps.workRoot!, "eticket-v3");
  const a = ledger.addTodo({ project: "eticket-v3", folder, brief: "was running", workClass: "interactive", createdBy: "operator" }, 1);
  ledger.updateTodo(a.id, { status: "running", orderId: "dead", startedAt: 2 });
  ledger.addTodo({ project: "eticket-v3", folder, brief: "next one", workClass: "interactive", createdBy: "operator" }, 3);
  ledger.addTodo({ project: "eticket-v3", folder, brief: "after that", workClass: "interactive", createdBy: "operator" }, 4);

  expect(queue.recover({ now: 100, lastCommit: () => "abc123 wip (1 min ago)" })).toBe(1);
  expect(ledger.todoById(a.id)?.status).toBe("failed");
  expect(ledger.todoById(a.id)?.result).toContain("engine restart");
  expect(ledger.todoById(a.id)?.result).toContain("abc123");

  await queue.pump();
  await settle();
  expect(runs).toHaveLength(1);
  expect(runs[0].task).toContain("next one");
});

test("pump holds while the engine drains, and creates no refusal noise", async () => {
  const { queue, ledger, deps, runs } = setup();
  const folder = join(deps.workRoot!, "eticket-v3");
  ledger.addTodo({ project: "eticket-v3", folder, brief: "x", workClass: "interactive", createdBy: "operator" }, 1);
  queue.setLauncher(() => ({ deps: { ...deps, lifecycle: { draining: () => true } }, replyChat: 1 }));
  await queue.pump();
  expect(runs).toHaveLength(0);
  expect(ledger.todoById(1)?.status).toBe("queued");
  expect(ledger.listEvents({ kind: "dispatch_refused" })).toHaveLength(0);
});

test("a queued todo whose folder vanished fails at release and the next one starts", async () => {
  const { queue, ledger, deps, runs } = setup();
  ledger.addTodo({ project: "gone", folder: join(deps.workRoot!, "gone"), brief: "x", workClass: "interactive", createdBy: "operator" }, 1);
  await queue.pump();
  expect(ledger.todoById(1)?.status).toBe("failed");
  expect(runs).toHaveLength(0);
});

// --- busy detection -----------------------------------------------------------------------------

test("an operator-opened session mid-turn is busy; once between turns the queue delivers into it", async () => {
  const { queue, ledger, registry, deps } = setup();
  const folder = join(deps.workRoot!, "eticket-v3");
  const s = registry.add({ id: "op", source: "neo", folder, task: "op work", chatId: 1, createdAt: 0 }, 0);
  let active = true;
  const pushed: string[] = [];
  registry.attachControl(s.id, { followUp: (t: string) => void pushed.push(t), interrupt: async () => {}, queued: () => 0, active: () => active, closed: () => false });
  expect(projectBusy(registry, folder)).toBe(true);

  const out = await queue.submit({ project: "eticket-v3", brief: "follow on", workClass: "interactive" }, deps, 1);
  expect(out).toContain("queued as #1");
  expect(pushed).toHaveLength(0);

  active = false;
  await queue.pump();
  expect(pushed).toHaveLength(1);
  expect(ledger.todoById(1)?.status).toBe("done");
  expect(ledger.todoById(1)?.result).toContain("operator");
});

// --- AC5: control --------------------------------------------------------------------------------

test("control: cancel a queued todo, refuse to cancel a running one, move one up, pause absorbs new briefs", async () => {
  const { queue, ledger, deps, runs } = setup();
  await queue.submit({ project: "eticket-v3", brief: "run", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "a", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "b", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "c", workClass: "interactive" }, deps, 1);

  expect(queue.cancel(1)).toContain("running");
  expect(ledger.todoById(1)?.status).toBe("running");
  expect(queue.cancel(3)).toContain("cancelled #3");
  expect(ledger.todoById(3)?.status).toBe("cancelled");
  expect(queue.up(4)).toContain("position 1");
  expect(ledger.listTodos({ statuses: ["queued"] }).map((t) => t.brief)).toEqual(["c", "a"]);
  expect(queue.move(4, 2)).toContain("position 2");
  expect(ledger.listTodos({ statuses: ["queued"] }).map((t) => t.brief)).toEqual(["a", "c"]);

  // a paused queue holds even a free project
  expect(queue.pause("waselni")).toContain("paused");
  const out = await queue.submit({ project: "waselni", brief: "w", workClass: "interactive" }, deps, 1);
  expect(out).toContain("queued as");
  expect(out).toContain("paused");
  expect(runs).toHaveLength(1);
});

test("list renders running + queued per project, and a single project's recent history", async () => {
  const { queue, deps, runs } = setup();
  await queue.submit({ project: "eticket-v3", brief: "fare step UI", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "seat map", workClass: "interactive" }, deps, 1);
  const all = queue.list();
  expect(all).toContain("eticket-v3");
  expect(all).toContain("▶ #1 running");
  expect(all).toContain("1. #2 seat map");
  runs[0].finish(ok());
  await settle();
  const one = queue.list("eticket-v3");
  expect(one).toContain("✓ #1 done");
  expect(one).toContain("▶ #2 running");
  expect(queue.list("waselni")).toContain("empty");
});

test("todoTitle is the first non-empty line, bounded", () => {
  expect(todoTitle("\n  fare step UI \nmore")).toBe("fare step UI");
  expect(todoTitle("x".repeat(200)).length).toBeLessThanOrEqual(60);
});

// --- wiring: the company's tools, the /todo command, the dashboard, config ------------------------

import { neoMcpServers } from "../src/engine/dispatch";
import { handleCommand, telegramCommands } from "../src/engine/commands";
import { dashboardSnapshot } from "../src/engine/dashboard";
import { loadConfig } from "../src/config";
import { writeFileSync } from "node:fs";

function tool(servers: Record<string, unknown>, name: string) {
  const neo = servers.neo as { instance: { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text?: string }> }> }> } };
  const h = neo.instance._registeredTools[name]?.handler;
  return h ? async (a: Record<string, unknown>) => (await h(a, {})).content[0]?.text ?? "" : undefined;
}

test("the company's dispatch tool goes through the queue; a todo tool lists and controls it", async () => {
  const { queue, deps, runs } = setup();
  const servers = neoMcpServers({ ...deps, todo: queue }, 1, { dispatch: true, workClass: "interactive", folder: "/tmp/agent" });
  const dispatch = tool(servers, "dispatch")!;
  const todo = tool(servers, "todo")!;
  expect(await dispatch({ project: "eticket-v3", task: "first" })).toContain("dispatched to eticket-v3");
  expect(await dispatch({ project: "eticket-v3", task: "second" })).toContain("queued as #2 for eticket-v3, position 1");
  expect(await todo({ action: "add", project: "eticket-v3", task: "third" })).toContain("queued as #3");
  expect(runs).toHaveLength(1);
  expect(await todo({ action: "list" })).toContain("1. #2 second");
  expect(await todo({ action: "reorder", id: 3, position: 1 })).toContain("position 1");
  expect(await todo({ action: "cancel", id: 2 })).toContain("cancelled #2");
  expect(await todo({ action: "pause", project: "eticket-v3" })).toContain("paused");
  expect(await todo({ action: "resume", project: "eticket-v3" })).toContain("resumed");
  expect(await todo({ action: "list", project: "eticket-v3" })).toContain("#3 third");
  expect(await todo({ action: "cancel" })).toContain("needs");
});

test("only the company gets the todo tool", () => {
  const { queue, deps } = setup();
  const project = neoMcpServers({ ...deps, todo: queue }, 1, { dispatch: false, folder: "/tmp/x" });
  expect(tool(project, "todo")).toBeUndefined();
});

test("/todo commands: list all, one project, cancel, up, pause, resume", async () => {
  const { queue, deps, ledger, registry } = setup();
  await queue.submit({ project: "eticket-v3", brief: "run", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "a", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "b", workClass: "interactive" }, deps, 1);
  const cmd = (t: string) => handleCommand(t, 1, { registry, ledger, trust: deps.trust, todo: queue })!.text;
  expect(cmd("/todo")).toContain("▶ #1 running");
  expect(cmd("/todo eticket-v3")).toContain("2. #3 b");
  expect(cmd("/todo up 3")).toContain("position 1");
  expect(cmd("/todo cancel 2")).toContain("cancelled #2");
  expect(cmd("/todo pause eticket-v3")).toContain("paused");
  expect(cmd("/todo resume eticket-v3")).toContain("resumed");
  expect(cmd("/todo up x")).toContain("Usage");
  expect(handleCommand("/todo", 1, { registry, ledger, trust: deps.trust })!.text).toContain("unavailable");
  expect(telegramCommands().some((c) => c.command === "todo")).toBe(true);
});

test("the dashboard snapshot carries the todo queues", async () => {
  const { queue, deps, ledger, registry } = setup();
  await queue.submit({ project: "eticket-v3", brief: "run", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "next", workClass: "interactive" }, deps, 1);
  const snap = dashboardSnapshot({ registry, ledger, chatId: 1, reposRoot: "/nonexistent" });
  expect(snap.todos.map((t) => [t.id, t.status, t.position])).toEqual([
    [1, "running", 0],
    [2, "queued", 1],
  ]);
  expect(snap.todos[1]).toMatchObject({ project: "eticket-v3", title: "next" });
});

test("config todoOnFailure defaults to continue, accepts pause, and fails closed to continue", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-cfg-"));
  expect(loadConfig(dir).todoOnFailure).toBe("continue");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ todoOnFailure: "pause" }));
  expect(loadConfig(dir).todoOnFailure).toBe("pause");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ todoOnFailure: "explode" }));
  expect(loadConfig(dir).todoOnFailure).toBe("continue");
});

// --- code-review pass (2026-10-04) --------------------------------------------------------------

test("a run that throws while starting fails its todo, frees the project and starts the next", async () => {
  const { queue, ledger, deps, registry } = setup();
  let calls = 0;
  const started: string[] = [];
  queue.setLauncher(() => ({ deps, replyChat: 1 }));
  const q2 = createTodoQueue({
    ledger,
    registry,
    onFailure: () => "continue",
    dispatchOpts: {
      now: () => 1_000,
      start: ((order: { task: string }) => {
        calls++;
        if (calls === 1) throw new Error("worker failed to launch");
        started.push(order.task);
        return { followUp: () => {}, queued: () => 0, active: () => true, closed: () => false, close: () => {}, interrupt: async () => {}, done: new Promise(() => {}) };
      }) as never,
    },
  });
  q2.setLauncher(() => ({ deps, replyChat: 1 }));
  await q2.submit({ project: "eticket-v3", brief: "first", workClass: "interactive" }, deps, 1);
  await q2.submit({ project: "eticket-v3", brief: "second", workClass: "interactive" }, deps, 1);
  await settle();
  expect(ledger.todoById(1)).toMatchObject({ status: "failed" });
  expect(ledger.todoById(1)?.result).toContain("worker failed to launch");
  expect(ledger.todoById(2)?.status).toBe("running");
  expect(started).toHaveLength(1);
  expect(started[0]).toContain("second");
});

test("cancel refuses a running todo whose run is still live, even in the gap after the session went idle", async () => {
  const { queue, ledger, registry, deps, runs } = setup();
  await queue.submit({ project: "eticket-v3", brief: "first", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "second", workClass: "interactive" }, deps, 1);
  // The run's session reads idle (dispatch marks it idle before the result goes out) but its end
  // has not reached the queue yet.
  const s = registry.findByFolder(join(deps.workRoot!, "eticket-v3"))!;
  registry.setStatus(s.id, "idle");
  expect(queue.cancel(1)).toContain("running");
  expect(ledger.todoById(1)?.status).toBe("running");
  runs[0].finish(ok());
  await settle();
  expect(ledger.todoById(1)?.status).toBe("done");
  expect(runs).toHaveLength(2); // the next one still started on settle
});

test("cancelling a stale running todo (no live run) releases the next one at once", async () => {
  const { queue, ledger, deps, runs } = setup();
  const folder = join(deps.workRoot!, "eticket-v3");
  const a = ledger.addTodo({ project: "eticket-v3", folder, brief: "stale", workClass: "interactive", createdBy: "operator" }, 1);
  ledger.updateTodo(a.id, { status: "running", orderId: "gone", startedAt: 2 });
  ledger.addTodo({ project: "eticket-v3", folder, brief: "next", workClass: "interactive", createdBy: "operator" }, 3);
  expect(queue.cancel(a.id)).toContain("cancelled");
  await settle();
  expect(runs).toHaveLength(1);
  expect(runs[0].task).toContain("next");
});

test("/todo parsing: verbs ignore case, ids are plain digits (optional #), extra words are refused", async () => {
  const { queue, deps, ledger, registry } = setup();
  await queue.submit({ project: "eticket-v3", brief: "run", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "a", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "b", workClass: "interactive" }, deps, 1);
  const cmd = (t: string) => handleCommand(t, 1, { registry, ledger, trust: deps.trust, todo: queue })!.text;
  expect(cmd("/todo cancel 0x2")).toContain("Usage");
  expect(cmd("/todo cancel 2e0")).toContain("Usage");
  expect(cmd("/todo cancel 2 3")).toContain("Usage");
  expect(cmd("/todo pause eticket-v3 now")).toContain("Usage");
  expect(ledger.todoById(2)?.status).toBe("queued");
  expect(cmd("/todo UP #3")).toContain("position 1");
  expect(cmd("/todo Cancel #2")).toContain("cancelled #2");
});

// ADR-0014: a todo handed off at a safe checkpoint is not finished — its continuation goes to the
// head of the project's queue and starts at once, from the handoff note.
test("a checkpoint continuation becomes the next todo at the head of the queue and starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-todo-"));
  const folder = join(root, "eticket-v3");
  mkdirSync(folder);
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q");
  writeFileSync(join(folder, "a.txt"), "1");
  g("add", ".");
  g("commit", "-q", "-m", "first");
  const ledger = openLedger(":memory:");
  ledger.recordModelWindow("claude-opus-5-5", 1_000_000);
  const registry = createRegistry();
  const replies: string[] = [];
  const deps: DispatchDeps = {
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text) => void replies.push(text),
    askApproval: async () => "deny",
    workRoot: root,
    contextPolicy: { sweetSpotPct: 0.4, checkpointPct: 0.6, emergencyPct: 0.9, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70, maxTurns: 200, maxAgeMs: 1e12, handoffTimeoutMs: 1_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 },
  };
  const runs: Array<{ task: string; finish: (r: RunResult) => void }> = [];
  const start = (order: { task: string }, h: RunHandlers) => {
    let finish!: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => (finish = res));
    runs.push({ task: order.task, finish });
    if (runs.length === 1) {
      // the first run reaches a safe checkpoint in the heavy band and writes its note
      h.onUsage?.("claude-opus-5-5", { input_tokens: 700_000 });
      h.onToolUse?.("c1", "Bash", { command: "git commit -m 'phase 2'" });
      h.onToolResult?.("c1", false);
    }
    return { followUp: () => {}, queued: () => 0, active: () => false, closed: () => false, close: () => {}, interrupt: async () => {}, done };
  };
  const queue = createTodoQueue({ ledger, registry, onFailure: () => "continue", dispatchOpts: { start: start as never, now: () => 1_000, signals: () => ({ occupancy: 0.1, turns: 1, ageMs: 0, idleMs: 0 }) } });
  queue.setLauncher(() => ({ deps, replyChat: 1 }));
  await queue.submit({ project: "eticket-v3", brief: "build all phases", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "later work", workClass: "interactive" }, deps, 1);
  await settle();
  writeFileSync(join(folder, "HANDOFF.md"), "## Goal\nall phases\n## Next steps\n1. phase 3\n");
  runs[0].finish({ ok: true, sessionId: "s1", summary: "note written", costUsd: 0 });
  await settle();
  const all = ledger.listTodos({ folder });
  const [first, cont, later] = [all.find((t) => t.brief === "build all phases")!, all.find((t) => t.brief === continuationBrief("build all phases"))!, all.find((t) => t.brief === "later work")!];
  expect(first.status).toBe("done");
  expect(first.result).toContain(`#${cont.id}`);
  expect(cont.status).toBe("running"); // released at once, ahead of "later work"
  expect(later.status).toBe("queued");
  expect(runs).toHaveLength(2);
  expect(runs[1].task).toContain("phase 3"); // the continuation starts from the note, inline
  expect(replies.some((r) => r.includes(`continuing as #${cont.id}`))).toBe(true);
});
