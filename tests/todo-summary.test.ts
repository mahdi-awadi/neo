// A todo's summary (ADR-0059): one short human line for every surface, instead of the brief's first 60
// characters. Deterministic at once; an AI line may replace it, only if the code accepts it.
import { expect, test } from "bun:test";
import { summarizeBrief, todoLabel } from "../src/engine/todo-title";
import { continuationBrief } from "../src/engine/context-policy";

test("a continuation shows its original task, not the engine's continuation head", () => {
  expect(summarizeBrief(continuationBrief("Complete the waselni project: trips screen, driver map."))).toBe("Complete the waselni project: trips screen, driver map.");
  expect(summarizeBrief(continuationBrief(continuationBrief("Fix the fare cache")))).toBe("Fix the fare cache");
  expect(summarizeBrief(continuationBrief(undefined))).toBe("Continue the previous session's task");
});

test("engine and operator prefixes, markdown and long first sentences are cleaned and bounded", () => {
  expect(summarizeBrief("Operator order (2026-10-29): resume and FINISH this project's open work.\nMore detail")).toBe("resume and FINISH this project's open work.");
  expect(summarizeBrief("Operator UI order: the **agency hotel results table** (agency portal) must show prices")).toBe("the agency hotel results table (agency portal) must show prices");
  expect(summarizeBrief("Execute the plan at docs/superpowers/plans/2026-10-08-asfoor-charter-seed.md task by task. Tick each step's checkbox in the file when it is done.")).toBe("Execute plan: asfoor charter seed");
  const long = summarizeBrief("Follow-up to the finance-sync plan (#879): " + "x".repeat(200));
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith("…")).toBe(true);
  expect(summarizeBrief("   \n\n  ")).toBe("(empty brief)");
});

test("a head that says what the work is stays; only real order labels go", () => {
  expect(summarizeBrief("Operator-delegated decisions from the old decision backlog: do them all on dev.")).toBe("Operator-delegated decisions from the old decision backlog: do them all on dev.");
  expect(summarizeBrief("Operator bug report (engine + chief-of-staff tools): the main agent told the operator to /kill.")).toBe("the main agent told the operator to /kill.");
});

test("an Arabic brief keeps its words", () => {
  expect(summarizeBrief("أصلح صفحة الحجز في التطبيق. ثم اختبرها")).toBe("أصلح صفحة الحجز في التطبيق.");
});

test("todoLabel: the stored summary wins; an older row derives it", () => {
  expect(todoLabel({ brief: "Operator order (2026-10-29): fix the cart", summary: "Fix the cart total on checkout" })).toBe("Fix the cart total on checkout");
  expect(todoLabel({ brief: "Operator order (2026-10-29): fix the cart" })).toBe("fix the cart");
});

// The AI upgrade: AI proposes, the engine accepts or keeps its own line.
import { acceptSummary, createTodoSummarizer, summaryPrompt } from "../src/engine/todo-summary";
import { DEFAULT_TODO_SUMMARY_CFG } from "../src/engine/todo-summary-cfg";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTodoQueue } from "../src/engine/todo-queue";
import type { RunResult } from "../src/engine/session-runner";

const todo = { id: 1, project: "adminli", folder: "/home/adminli", brief: "Operator order: make attention items explain themselves", workClass: "interactive", createdBy: "operator", status: "queued", position: 1, createdAt: 0, attempts: 0, lane: "main" } as never;

test("acceptSummary: one plain line of 8-90 chars, no secret shape, no markdown or prefix", () => {
  expect(acceptSummary("Make attention items explain themselves")).toBe("Make attention items explain themselves");
  expect(acceptSummary("“Make attention items explain themselves”")).toBe("Make attention items explain themselves");
  expect(acceptSummary("short")).toBeUndefined();
  expect(acceptSummary("line one\nline two")).toBeUndefined();
  expect(acceptSummary("x".repeat(91))).toBeUndefined();
  expect(acceptSummary("Summary: fix it all now")).toBeUndefined();
  expect(acceptSummary("**Fix** the attention list")).toBeUndefined();
  expect(acceptSummary("rotate key ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")).toBeUndefined();
});

test("the summary run is one turn, no tools, no settings or MCP servers; the brief goes as quoted data", async () => {
  const seen: Array<{ task: string; deps: Record<string, unknown> }> = [];
  const run = (async (o: { task: string }, h: { onMessage: (t: string) => void }, d: Record<string, unknown>): Promise<RunResult> => {
    seen.push({ task: o.task, deps: d });
    h.onMessage("Make attention items explain themselves");
    return { ok: true, sessionId: "s", summary: "", costUsd: 0 };
  }) as never;
  const s = createTodoSummarizer({ cfg: DEFAULT_TODO_SUMMARY_CFG, model: "claude-haiku-4-5", run });
  expect(await s(todo)).toBe("Make attention items explain themselves");
  expect(seen[0]!.deps).toMatchObject({ model: "claude-haiku-4-5", effort: "low", maxTurns: 1, settingSources: [], skills: [] });
  expect((seen[0]!.deps.disallowedTools as string[]).length).toBeGreaterThan(5);
  expect(seen[0]!.task).toBe(summaryPrompt((todo as { brief: string }).brief));
  expect(seen[0]!.task).toContain(JSON.stringify("Operator order: make attention items explain themselves"));
});

test("a bad AI line, a failed run or ai:false keeps the deterministic summary", async () => {
  const say = (text: string) => (async (_o: unknown, h: { onMessage: (t: string) => void }) => (h.onMessage(text), { ok: true, sessionId: "", summary: "", costUsd: 0 })) as never;
  expect(await createTodoSummarizer({ cfg: DEFAULT_TODO_SUMMARY_CFG, model: "m", run: say("a\nb") })(todo)).toBeUndefined();
  expect(await createTodoSummarizer({ cfg: DEFAULT_TODO_SUMMARY_CFG, model: "m", run: (async () => { throw new Error("limit"); }) as never })(todo)).toBeUndefined();
  let ran = false;
  expect(await createTodoSummarizer({ cfg: { ...DEFAULT_TODO_SUMMARY_CFG, ai: false }, model: "m", run: (async () => { ran = true; return { ok: true }; }) as never })(todo)).toBeUndefined();
  expect(ran).toBe(false);
});

test("the queue writes the deterministic summary at once, the accepted AI line after; a continuation keeps it", async () => {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const q = createTodoQueue({ ledger, registry, onFailure: () => "continue", summarize: async () => "Make attention items explain themselves" });
  void q;
  // The queue's own addTodo path: submit to a busy project queues a todo.
  const busy = registry.add({ id: "o1", source: "neo", folder: "/home/adminli", task: "x", chatId: -2, createdAt: 0 }, 0);
  registry.attachControl(busy.id, { followUp: () => {}, interrupt: async () => {}, active: () => true, queued: () => 0 } as never);
  await q.submit({ project: "/home/adminli", brief: "Operator order (2026-10-29): make attention items explain themselves\nDetails…", workClass: "interactive" }, { ledger, registry } as never, 1).catch(() => "");
  const t = ledger.listTodos({ folder: "/home/adminli" })[0];
  expect(t).toBeDefined(); // queued behind the busy session
  await new Promise((r) => setTimeout(r, 10));
  expect(ledger.todoById(t!.id)!.summary).toBe("Make attention items explain themselves");
});
