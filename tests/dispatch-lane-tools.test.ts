// ADR-0057: the chief of staff picks the lane in the `dispatch` / `todo add` call; the tools carry it.
import { test, expect } from "bun:test";
import { neoMcpServers, type DispatchDeps } from "../src/engine/dispatch";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { LANE_KINDS } from "../src/engine/lanes";

type Tool = { description: string; inputSchema: { parse: (v: unknown) => unknown }; handler: (a: Record<string, unknown>, x: unknown) => Promise<{ content: Array<{ text?: string }> }> };
function tools() {
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
  const servers = neoMcpServers(d, 1, { dispatch: true, folder: "/home/neo/agent" });
  const reg = (servers.neo as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools;
  return { dispatch: reg["dispatch"]!, todo: reg["todo"]!, submitted };
}
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

test("dispatch and todo accept lane + kind; a bad lane or kind is rejected; both stay optional", () => {
  const { dispatch, todo } = tools();
  expect(() => dispatch.inputSchema.parse({ project: "p", task: "x" })).not.toThrow();
  expect(() => dispatch.inputSchema.parse({ project: "p", task: "x", lane: "side", kind: "ops" })).not.toThrow();
  expect(() => dispatch.inputSchema.parse({ project: "p", task: "x", lane: "queue" })).not.toThrow();
  expect(() => dispatch.inputSchema.parse({ project: "p", task: "x", lane: "fast" })).toThrow();
  expect(() => dispatch.inputSchema.parse({ project: "p", task: "x", lane: "side", kind: "deploy" })).toThrow();
  expect(() => todo.inputSchema.parse({ action: "add", project: "p", task: "x", lane: "side", kind: "test" })).not.toThrow();
});

test("the descriptions tell the chief of staff when to pick side, and name every kind", () => {
  const { dispatch, todo } = tools();
  for (const desc of [dispatch.description, todo.description]) {
    expect(desc).toContain('lane: "side"');
    for (const k of LANE_KINDS) expect(desc).toContain(`\`${k}\``);
  }
  expect(dispatch.description).toContain("does not edit the files, branch or containers");
});

test("a side lane without a kind is refused with the four kinds named, and nothing is queued", async () => {
  const { dispatch, todo, submitted } = tools();
  const r = text(await dispatch.handler({ project: "p", task: "x", lane: "side" }, {}));
  for (const k of LANE_KINDS) expect(r).toContain(k);
  const r2 = text(await todo.handler({ action: "add", project: "p", task: "x", lane: "side" }, {}));
  expect(r2).toContain("kind");
  expect(submitted).toEqual([]);
});

test("lane and kind reach the todo queue from both tools", async () => {
  const { dispatch, todo, submitted } = tools();
  await dispatch.handler({ project: "p", task: "check docker", lane: "side", kind: "ops" }, {});
  await todo.handler({ action: "add", project: "p", task: "run the API test", lane: "side", kind: "test" }, {});
  await dispatch.handler({ project: "p", task: "build" }, {});
  expect(submitted.map((s) => [s.lane, s.kind])).toEqual([["side", "ops"], ["side", "test"], [undefined, undefined]]);
});

// ADR-0058: the chief of staff stops or backgrounds a worker's command with a tool, never ps/kill.
test("tool_control exists only on the dispatcher's server and acts through the seam", async () => {
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "deny",
  };
  const s = d.registry.add({ id: "w", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  const calls: string[] = [];
  d.registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, tools: { provider: "claude", running: () => [{ toolUseId: "toolu_X", tool: "Bash", summary: "semgrep .", since: 0 }], background: async (id: string) => (calls.push(id), { ok: true }), stop: async () => ({ ok: true }) } } as never);
  const company = neoMcpServers(d, 1, { dispatch: true, folder: "/home/neo/agent" });
  const worker = neoMcpServers(d, 1, { dispatch: false, folder: "/home/eticket-v3" });
  const reg = (x: Record<string, unknown>) => (x.neo as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools;
  expect(reg(worker)["tool_control"]).toBeUndefined();
  const tc = reg(company)["tool_control"]!;
  expect(tc.description).toContain("instead of ps/kill");
  const out = text(await tc.handler({ action: "background", project: "eticket-v3" }, {}));
  expect(out).toContain("Moved `semgrep .` in eticket-v3 to the background");
  expect(calls).toEqual(["toolu_X"]);
  expect(d.ledger.listEvents({ kind: "tool_control" })[0]!.data).toMatchObject({ by: "company", action: "background" });
});

test("ADR-0060: the todo tool says retry resumes a limit-held running todo now, and never to /kill it", () => {
  const { todo } = tools();
  expect(todo.description).toContain("held: limit wait");
  expect(todo.description).toContain("resumes that run NOW");
  expect(todo.description).toContain("Never tell the operator to /kill a held todo");
  expect(todo.description).not.toContain("stopped by the operator with /kill");
});
