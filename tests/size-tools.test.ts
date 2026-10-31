// ADR-0072: the chief of staff sets the size in the `dispatch` / `todo add` call; the operator's own
// message overrides it in code (`/quick`, `/full`, "quick fix"); the pipeline and the "/" menu know both.
import { test, expect } from "bun:test";
import { neoMcpServers, type DispatchDeps } from "../src/engine/dispatch";
import { openLedger, type Cause } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { SIZE_GUIDE } from "../src/engine/order-size";
import { telegramCommands, handleCommand } from "../src/engine/commands";

type Tool = { description: string; inputSchema: { parse: (v: unknown) => unknown }; handler: (a: Record<string, unknown>, x: unknown) => Promise<{ content: Array<{ text?: string }> }> };

function tools(o: { live?: () => Cause | undefined } = {}) {
  const submitted: Array<Record<string, unknown>> = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "deny",
    todo: { submit: async (p: Record<string, unknown>) => (submitted.push(p), "ok") } as never,
  };
  const servers = neoMcpServers(d, 1, { dispatch: true, folder: "/home/neo/agent", ...(o.live ? { cause: o.live, workCause: o.live } : {}) });
  const reg = (servers.neo as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools;
  return { d, dispatch: reg["dispatch"]!, todo: reg["todo"]!, submitted };
}

/** An operator line (role user, on `surface`), as a thread root or a reply in `threadId`. */
function line(d: DispatchDeps, content: string, o: { threadId?: number; role?: "user" | "assistant"; surface?: "telegram" | "web" | "engine" } = {}): Cause {
  const id = d.ledger.insertMessage({ chatId: 1, role: o.role ?? "user", content, at: 1, surface: o.surface ?? "telegram", ...(o.threadId !== undefined ? { threadId: o.threadId } : {}) });
  return { msgId: id, threadId: o.threadId ?? id };
}

test("both tools accept `size` and reject a value that is not a size; the dispatch description carries SIZE_GUIDE", () => {
  const { dispatch, todo } = tools();
  for (const s of ["quick", "standard", "big"]) {
    expect(() => dispatch.inputSchema.parse({ project: "p", task: "x", size: s })).not.toThrow();
    expect(() => todo.inputSchema.parse({ action: "add", project: "p", task: "x", size: s })).not.toThrow();
  }
  expect(() => dispatch.inputSchema.parse({ project: "p", task: "x", size: "huge" })).toThrow();
  expect(() => todo.inputSchema.parse({ action: "add", project: "p", task: "x", size: "huge" })).toThrow();
  expect(() => dispatch.inputSchema.parse({ project: "p", task: "x" })).not.toThrow();
  expect(dispatch.description).toContain(SIZE_GUIDE);
  expect(todo.description).toContain("`size`: as in `dispatch`");
});

test("`size` reaches submit from both tools; no operator message → no operatorSize", async () => {
  const { dispatch, todo, submitted } = tools();
  await dispatch.handler({ project: "p", task: "fix the picker", size: "quick" }, {});
  await todo.handler({ action: "add", project: "p", task: "add a filter", size: "standard" }, {});
  await dispatch.handler({ project: "p", task: "build" }, {});
  expect(submitted.map((s) => [s.size, s.operatorSize])).toEqual([["quick", undefined], ["standard", undefined], [undefined, undefined]]);
});

test("the live operator message `/quick fix x` → operatorSize quick, whatever `size` says", async () => {
  let live: Cause | undefined;
  const t = tools({ live: () => live });
  live = line(t.d, "/quick fix x");
  await t.dispatch.handler({ project: "p", task: "fix x", size: "big" }, {});
  await t.todo.handler({ action: "add", project: "p", task: "fix x", size: "standard" }, {});
  expect(t.submitted.map((s) => s.operatorSize)).toEqual(["quick", "quick"]);
  live = line(t.d, "quick fix: the label", { surface: "web" });
  await t.dispatch.handler({ project: "p", task: "fix the label" }, {});
  expect(t.submitted.at(-1)!.operatorSize).toBe("quick");
});

test("a live `ok go` in a thread rooted at `/full …` → big; a live `/full` beats a root `/quick`", async () => {
  let live: Cause | undefined;
  const t = tools({ live: () => live });
  const root = line(t.d, "/full add the wallet top-up");
  live = line(t.d, "ok go", { threadId: root.threadId });
  await t.dispatch.handler({ project: "p", task: "wallet", size: "quick" }, {});
  expect(t.submitted.at(-1)!.operatorSize).toBe("big");
  const qroot = line(t.d, "/quick fix the picker");
  live = line(t.d, "/full actually do it properly", { threadId: qroot.threadId });
  await t.dispatch.handler({ project: "p", task: "picker" }, {});
  expect(t.submitted.at(-1)!.operatorSize).toBe("big");
});

test("no override from an engine-written root, an assistant message, or a scheduler-fired turn", async () => {
  let live: Cause | undefined;
  const t = tools({ live: () => live });
  const engineRoot = line(t.d, "/quick something", { surface: "engine" });
  live = line(t.d, "ok", { threadId: engineRoot.threadId });
  await t.dispatch.handler({ project: "p", task: "x" }, {});
  live = line(t.d, "/quick fix x", { role: "assistant" });
  await t.dispatch.handler({ project: "p", task: "x" }, {});
  live = undefined; // a scheduler-fired company turn has no operator message
  await t.dispatch.handler({ project: "p", task: "x" }, {});
  expect(t.submitted.map((s) => s.operatorSize)).toEqual([undefined, undefined, undefined]);
});

test("the size is an override only at the start: `this is not a quick fix` gives none", async () => {
  let live: Cause | undefined;
  const t = tools({ live: () => live });
  live = line(t.d, "this is not a quick fix");
  await t.dispatch.handler({ project: "p", task: "x" }, {});
  expect(t.submitted[0]!.operatorSize).toBeUndefined();
});

test("telegramCommands and /help list quick and full", () => {
  const names = telegramCommands().map((c) => c.command);
  expect(names).toContain("quick");
  expect(names).toContain("full");
  const help = handleCommand("/help", 1, {} as never)!.text;
  expect(help).toContain("/quick <order>");
  expect(help).toContain("/full <order>");
});
