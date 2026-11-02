// ADR-0027: a todo that ends for a passing reason is kept as `retry` and re-run with backoff; a failed
// todo is never dropped, can be retried, and is closed by a later finished run in its thread.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger, TODOS_KEEP } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { DispatchDeps } from "../src/engine/dispatch";
import type { RunResult } from "../src/engine/session-runner";
import { createTodoQueue } from "../src/engine/todo-queue";
import { classifyEnd, nextRetry, retryBrief, RETRY_PREAMBLE_MARK } from "../src/engine/todo-retry";
import { handleCommand } from "../src/engine/commands";
import { dashboardSnapshot } from "../src/engine/dashboard";
import { neoMcpServers } from "../src/engine/dispatch";
import { recoverInterruptedDispatches } from "../src/engine/dispatch-report";

const settle = () => new Promise((r) => setTimeout(r, 25));
const LADDER = [60_000, 600_000];

function setup(opts: { onFailure?: "continue" | "pause" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-retry-"));
  mkdirSync(join(root, "eticket-v3"));
  mkdirSync(join(root, "waselni"));
  const replies: string[] = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const clock = { t: 1_000 };
  const deps: DispatchDeps = {
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text) => void replies.push(text),
    askApproval: async () => "deny",
    workRoot: root,
  };
  const runs: Array<{ task: string; finish: (r: RunResult) => void }> = [];
  const start = (order: { task: string }) => {
    let finish!: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => (finish = res));
    runs.push({ task: order.task, finish });
    return { followUp: () => {}, queued: () => 0, active: () => true, closed: () => false, close: () => {}, interrupt: async () => {}, done };
  };
  const queue = createTodoQueue({
    ledger,
    registry,
    onFailure: () => opts.onFailure ?? "continue",
    retryBackoffMs: () => LADDER,
    dispatchOpts: { start: start as never, now: () => clock.t },
  });
  queue.setLauncher(() => ({ deps, replyChat: 1 }));
  const folder = join(root, "eticket-v3");
  return { root, folder, replies, ledger, registry, deps, queue, runs, clock };
}

const ok = (summary = "all green"): RunResult => ({ ok: true, sessionId: "s1", summary, costUsd: 0 });
const bad = (summary = "boom"): RunResult => ({ ok: false, sessionId: "", summary, costUsd: 0 });
const apiErr = (kind: string): RunResult => ({ ok: false, sessionId: "", summary: "Your organization has disabled Claude subscription access", costUsd: 0, apiError: kind as never });

// --- the pure rule -------------------------------------------------------------------------------

test("classifyEnd: stalls, reloads, restarts, checkpoints, launches and account/API errors are transient", () => {
  for (const f of ["stall", "reload", "restart", "checkpoint", "launch", "api:oauth_org_not_allowed", "api:authentication_failed", "api:rate_limit", "api:overloaded", "api:server_error", "api:billing_error", "api:unknown"]) {
    expect(classifyEnd(f)).toEqual({ transient: true, reason: f });
  }
});

test("classifyEnd: no reason, or an API error a re-run cannot fix, is a task failure", () => {
  for (const f of [undefined, "", "api:invalid_request", "api:model_not_found", "api:max_output_tokens", "something-new"]) {
    expect(classifyEnd(f)).toEqual({ transient: false });
  }
});

test("nextRetry walks the ladder, then gives up", () => {
  expect(nextRetry(0, LADDER, 1_000)).toEqual({ retryAt: 61_000 });
  expect(nextRetry(1, LADDER, 1_000)).toEqual({ retryAt: 601_000 });
  expect(nextRetry(2, LADDER, 1_000)).toBeUndefined();
  expect(nextRetry(0, [], 1_000)).toBeUndefined();
});

test("retryBrief: a fixed preamble with the attempt and the last result, then the original brief", () => {
  const b = retryBrief({ brief: "fix the hotel bugs", attempts: 1, result: "timed out: no activity for 5m" }, 2);
  expect(b.startsWith(RETRY_PREAMBLE_MARK)).toBe(true);
  expect(b).toContain("attempt 2 of 3");
  expect(b).toContain("timed out: no activity for 5m");
  expect(b).toContain("git log");
  expect(b.endsWith("fix the hotel bugs")).toBe(true);
});

// --- AC1 / AC2: a transient end keeps the todo as `retry` ---------------------------------------

test("an account error keeps the todo as `retry` with backoff, and the next todo still starts", async () => {
  const { queue, ledger, runs, replies } = setup({ onFailure: "pause" });
  const { deps } = queue.launcher()!;
  await queue.submit({ project: "eticket-v3", brief: "hotel bugs", workClass: "interactive" }, deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "wallet selector", workClass: "interactive" }, deps, 1);
  runs[0].finish(apiErr("oauth_org_not_allowed"));
  await settle();
  const t = ledger.todoById(1)!;
  expect(t).toMatchObject({ status: "retry", attempts: 1, retryAt: 61_000, failure: "api:oauth_org_not_allowed" });
  expect(t.result).toContain("disabled Claude subscription access");
  // not a final bad end: the pause policy does not apply, the next todo starts
  expect(ledger.todoPaused(t.folder)).toBeUndefined();
  expect(ledger.todoById(2)?.status).toBe("running");
  expect(replies.some((r) => r.includes("#1 stopped (api:oauth_org_not_allowed)") && r.includes("retry 1/2"))).toBe(true);
});

test("a task failure (no reason) is `failed` at once, as before", async () => {
  const { queue, ledger, runs } = setup();
  await queue.submit({ project: "eticket-v3", brief: "x", workClass: "interactive" }, queue.launcher()!.deps, 1);
  runs[0].finish(bad());
  await settle();
  expect(ledger.todoById(1)).toMatchObject({ status: "failed", attempts: 0 });
});

test("an API error a re-run cannot fix is `failed` at once", async () => {
  const { queue, ledger, runs } = setup();
  await queue.submit({ project: "eticket-v3", brief: "x", workClass: "interactive" }, queue.launcher()!.deps, 1);
  runs[0].finish(apiErr("invalid_request"));
  await settle();
  expect(ledger.todoById(1)?.status).toBe("failed");
});

// --- AC3 / AC4 / AC5: due retries re-run at the head, told they are retries, then park -------------

test("a due retry goes back to the head of the queue, runs with the retry preamble, and parks after the ladder", async () => {
  const { queue, ledger, runs, clock, replies } = setup({ onFailure: "pause" });
  const { deps } = queue.launcher()!;
  await queue.submit({ project: "eticket-v3", brief: "hotel bugs", workClass: "interactive" }, deps, 1);
  runs[0].finish(apiErr("rate_limit"));
  await settle();
  await queue.submit({ project: "eticket-v3", brief: "later work", workClass: "interactive" }, deps, 1);
  expect(runs).toHaveLength(2); // the project was free, so "later work" ran
  // not due yet: pump leaves it
  await queue.pump();
  expect(ledger.todoById(1)?.status).toBe("retry");
  runs[1].finish(ok());
  await settle();
  // due: back at the head and started
  clock.t = 61_000;
  await queue.pump();
  await settle();
  expect(ledger.todoById(1)?.status).toBe("running");
  expect(runs).toHaveLength(3);
  expect(runs[2].task).toContain(RETRY_PREAMBLE_MARK);
  expect(runs[2].task).toContain("attempt 2 of 3");
  expect(ledger.todoById(1)?.brief).toBe("hotel bugs"); // the stored brief is unchanged
  // second transient end → retry 2; third → parked as failed, and now the policy applies
  runs[2].finish({ ok: false, sessionId: "", summary: "overloaded", costUsd: 0, apiError: "overloaded" });
  await settle();
  expect(ledger.todoById(1)).toMatchObject({ status: "retry", attempts: 2, retryAt: 661_000 });
  clock.t = 661_000;
  await queue.submit({ project: "eticket-v3", brief: "third", workClass: "interactive" }, deps, 1);
  await queue.pump();
  await settle();
  expect(ledger.todoById(1)?.status).toBe("running"); // the due retry went ahead of "third"
  runs[3].finish({ ok: false, sessionId: "", summary: "overloaded", costUsd: 0, apiError: "overloaded" });
  await settle();
  const t = ledger.todoById(1)!;
  expect(t.status).toBe("failed");
  expect(t.result).toContain("gave up after 3 attempts");
  expect(ledger.todoPaused(t.folder)).toBeDefined(); // a parked failure applies `pause`
  expect(replies.some((r) => r.includes("#1 failed"))).toBe(true);
});

// --- AC6: restart ------------------------------------------------------------------------------

test("boot recovery: a todo cut short by a restart becomes `retry`, not failed", () => {
  const { queue, ledger, folder } = setup();
  const a = ledger.addTodo({ project: "eticket-v3", folder, brief: "was running", workClass: "interactive", createdBy: "operator" }, 1);
  ledger.updateTodo(a.id, { status: "running", orderId: "dead", startedAt: 2 });
  expect(queue.recover({ now: 100, lastCommit: () => "abc123 wip" })).toBe(1);
  const t = ledger.todoById(a.id)!;
  expect(t).toMatchObject({ status: "retry", attempts: 1, retryAt: 60_100, failure: "restart" });
  expect(t.result).toContain("engine restart");
  expect(t.result).toContain("abc123");
});

// --- AC7 / AC8: the retry action and cancel ------------------------------------------------------

test("retry re-queues a failed todo (same row, new budget); on a `retry` todo it runs it now", async () => {
  const { queue, ledger, runs, registry, deps } = setup();
  await queue.submit({ project: "eticket-v3", brief: "one", workClass: "interactive" }, deps, 1);
  runs[0].finish(bad());
  await settle();
  expect(queue.retry(1)).toContain("#1");
  await settle();
  expect(ledger.listTodos({})).toHaveLength(1); // no second todo
  expect(ledger.todoById(1)).toMatchObject({ status: "running", attempts: 0 });
  expect(runs).toHaveLength(2);
  // a fresh budget, but it ran before: it is still told to continue from what is done
  expect(runs[1].task).toContain(RETRY_PREAMBLE_MARK);
  expect(runs[1].task).toContain("re-run on request");
  runs[1].finish(apiErr("rate_limit"));
  await settle();
  expect(ledger.todoById(1)?.status).toBe("retry");
  expect(queue.retry(1)).toContain("#1");
  await settle();
  expect(ledger.todoById(1)?.status).toBe("running"); // no wait for the backoff
  expect(runs[2].task).toContain(RETRY_PREAMBLE_MARK);
  expect(queue.retry(1)).toContain("running");
  expect(queue.retry(99)).toContain("No todo #99");
  // the /todo command and the company tool offer it too
  const cmd = (t: string) => handleCommand(t, 1, { registry, ledger, trust: deps.trust, todo: queue })!.text;
  expect(cmd("/todo retry 1")).toContain("running");
  const servers = neoMcpServers({ ...deps, todo: queue }, 1, { dispatch: true, workClass: "interactive", folder: "/tmp/agent" });
  const todo = toolOf(servers, "todo")!;
  expect(await todo({ action: "retry", id: 1 })).toContain("running");
  expect(await todo({ action: "retry" })).toContain("needs");
});

test("a waiting `retry` todo can be cancelled", async () => {
  const { queue, ledger, runs } = setup();
  await queue.submit({ project: "eticket-v3", brief: "one", workClass: "interactive" }, queue.launcher()!.deps, 1);
  runs[0].finish(apiErr("rate_limit"));
  await settle();
  expect(queue.cancel(1)).toContain("cancelled #1");
  expect(ledger.todoById(1)?.status).toBe("cancelled");
});

// --- AC9: a later finished run in the same thread closes it -----------------------------------------

test("a todo dispatched after earlier ones stopped, and finished in the same thread and folder, closes them as done", async () => {
  const { queue, ledger, runs, folder, root } = setup();
  const { deps } = queue.launcher()!;
  const cause = rootCause(ledger, "fix it");
  const otherCause = rootCause(ledger, "other");
  const failed = ledger.addTodo({ project: "eticket-v3", folder, brief: "a", workClass: "interactive", createdBy: "operator", cause }, 1);
  ledger.updateTodo(failed.id, { status: "failed", result: "boom", endedAt: 2 });
  const waiting = ledger.addTodo({ project: "eticket-v3", folder, brief: "b", workClass: "interactive", createdBy: "operator", cause }, 3);
  ledger.updateTodo(waiting.id, { status: "retry", attempts: 1, retryAt: 999_999, failure: "stall", result: "timed out", endedAt: 4 });
  const otherFolder = ledger.addTodo({ project: "waselni", folder: join(root, "waselni"), brief: "c", workClass: "interactive", createdBy: "operator", cause }, 5);
  ledger.updateTodo(otherFolder.id, { status: "failed", endedAt: 6 });
  const otherThread = ledger.addTodo({ project: "eticket-v3", folder, brief: "d", workClass: "interactive", createdBy: "operator", cause: otherCause }, 7);
  ledger.updateTodo(otherThread.id, { status: "failed", endedAt: 8 });
  // a due retry already promoted back to the queue: also closed, or it would redo finished work
  const promoted = ledger.addTodo({ project: "eticket-v3", folder, brief: "e", workClass: "interactive", createdBy: "operator", cause }, 9);
  ledger.updateTodo(promoted.id, { status: "retry", attempts: 1, retryAt: 999_999, endedAt: 10, failure: "stall" });
  // a sibling queued with the finisher and failing only AFTER it was created: a separate task, kept
  const sibling = ledger.addTodo({ project: "eticket-v3", folder, brief: "f", workClass: "interactive", createdBy: "operator", cause }, 500);
  ledger.updateTodo(sibling.id, { status: "failed", result: "real failure", endedAt: 1_500 });

  await queue.submit({ project: "eticket-v3", brief: "finish it", workClass: "interactive", cause }, deps, 1);
  const finisher = ledger.listTodos({ statuses: ["running"] })[0]!;
  ledger.updateTodo(promoted.id, { status: "queued", retryAt: null }); // it came due while the redo ran
  runs[0].finish(ok());
  await settle();
  for (const t of [failed, waiting, promoted]) {
    const now = ledger.todoById(t.id)!;
    expect(now.status).toBe("done");
    expect(now.result).toContain(`finished by #${finisher.id} later in this thread`);
  }
  expect(ledger.todoById(failed.id)?.result).toContain("boom"); // the old result is kept
  expect(ledger.todoById(otherFolder.id)?.status).toBe("failed");
  expect(ledger.todoById(otherThread.id)?.status).toBe("failed");
  expect(ledger.todoById(sibling.id)?.status).toBe("failed");
});

// --- AC10 / AC11 / AC12: never pruned, open work, visible --------------------------------------------

test("pruning never removes failed or retry todos", () => {
  const ledger = openLedger(":memory:");
  const f = ledger.addTodo({ project: "p", folder: "/home/p", brief: "keep me", workClass: "interactive", createdBy: "operator" }, 1);
  ledger.updateTodo(f.id, { status: "failed", endedAt: 2 });
  const r = ledger.addTodo({ project: "p", folder: "/home/p", brief: "retry me", workClass: "interactive", createdBy: "operator" }, 3);
  ledger.updateTodo(r.id, { status: "retry", attempts: 1, retryAt: 10 });
  for (let i = 0; i < TODOS_KEEP + 5; i++) {
    const t = ledger.addTodo({ project: "p", folder: "/home/p", brief: `n${i}`, workClass: "interactive", createdBy: "operator" }, 10 + i);
    ledger.updateTodo(t.id, { status: "done", endedAt: 10 + i });
  }
  expect(ledger.todoById(f.id)?.status).toBe("failed");
  expect(ledger.todoById(r.id)?.status).toBe("retry");
});

test("a thread with a waiting retry is open work, not failed", () => {
  const ledger = openLedger(":memory:");
  const cause = rootCause(ledger, "x");
  const t = ledger.addTodo({ project: "p", folder: "/home/p", brief: "x", workClass: "interactive", createdBy: "operator", cause }, 1);
  ledger.updateTodo(t.id, { status: "retry", attempts: 1, retryAt: 10, endedAt: 2 });
  expect(ledger.threadFacts(cause.threadId).activeTodos).toBe(1);
});

test("the Queue tab and /todo show retry and failed todos with how to retry them", async () => {
  const { queue, ledger, runs, registry, deps } = setup();
  await queue.submit({ project: "eticket-v3", brief: "flaky", workClass: "interactive" }, deps, 1);
  runs[0].finish(apiErr("rate_limit"));
  await settle();
  await queue.submit({ project: "waselni", brief: "broken", workClass: "interactive" }, deps, 1);
  runs[1].finish(bad());
  await settle();
  const snap = dashboardSnapshot({ registry, ledger, chatId: 1, reposRoot: "/nonexistent" });
  expect(snap.todos.map((t) => [t.id, t.status])).toEqual(expect.arrayContaining([[1, "retry"], [2, "failed"]]));
  expect(snap.todos.find((t) => t.id === 1)).toMatchObject({ attempts: 1, retryAt: 61_000 });
  const cmd = (t: string) => handleCommand(t, 1, { registry, ledger, trust: deps.trust, todo: queue })!.text;
  const all = cmd("/todo");
  expect(all).toContain("↻ #1 retry 1/2");
  expect(all).toContain("✗ #2 failed");
  expect(all).toContain("/todo retry 2");
});

/** A thread root message and its cause (as the trace tests make one). */
function rootCause(ledger: ReturnType<typeof openLedger>, text: string) {
  const root = ledger.insertMessage({ chatId: 1, role: "user", content: text, at: 1 });
  ledger.insertThread({ id: root, origin: "operator", title: text, state: "open", createdAt: 1 });
  return { msgId: root, threadId: root };
}

/** Call a tool of the in-process MCP server by name (as the todo-queue tests do). */
function toolOf(servers: Record<string, unknown>, name: string) {
  const neo = servers.neo as { instance: { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text?: string }> }> }> } };
  const h = neo.instance._registeredTools[name]?.handler;
  return h ? async (a: Record<string, unknown>) => (await h(a, {})).content[0]?.text ?? "" : undefined;
}

test("boot: a cut-short todo run is reported as kept and re-run by itself, never as \"resume it\"", () => {
  const ledger = openLedger(":memory:");
  ledger.recordEvent("dispatch_start", { orderId: "o-todo", folder: "/home/p", data: { project: "p" }, at: 10 });
  ledger.recordEvent("dispatch_start", { orderId: "o-plain", folder: "/home/q", data: { project: "q" }, at: 10 });
  const n = recoverInterruptedDispatches(ledger, { now: 20, windowMs: 1_000, lastCommit: () => undefined, todoNote: (id) => (id === "o-todo" ? "[todo] #7 is kept — do NOT dispatch it again." : undefined) });
  expect(n).toBe(2);
  const [a, b] = ledger.pendingDispatcherReports().map((r) => r.text);
  const todoReport = [a, b].find((t) => t!.includes("p:"))!;
  const plainReport = [a, b].find((t) => t!.includes("q:"))!;
  expect(todoReport).toContain("do NOT dispatch it again");
  expect(todoReport).not.toContain("resume it");
  expect(plainReport).toContain("resume it from where it stopped");
});
