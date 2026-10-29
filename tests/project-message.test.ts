// `project_message` (ADR-0061): the chief of staff speaks to a project's open session exactly as the operator
// does — the same delivery (`deliverToSession`), refused in code for customer sessions, empty or long text,
// side lanes, the company itself and over the per-project rate limit. Every delivered message is marked.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { createApiWaits } from "../src/engine/api-wait";
import { sendProjectMessage, DEFAULT_PROJECT_MESSAGE_CFG } from "../src/engine/project-message";
import type { PipelineDeps } from "../src/engine/pipeline";
import type { Order } from "../src/types";

const ROOT = "/home";
const order = (over: Partial<Order> = {}): Order => ({ id: crypto.randomUUID(), source: "neo", folder: join(ROOT, "waselni"), task: "t", chatId: -2, createdAt: 0, ...over });

function setup(cfgOver: Record<string, unknown> = {}) {
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "pm-cfg-"))), workRoot: ROOT, ...cfgOver };
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const replies: Array<{ chat: number; text: string; project?: string; kind?: string }> = [];
  const starts: string[] = [];
  const deps = {
    cfg, ledger, registry,
    meter: createMeter({ windowMs: 3_600_000, windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    apiWaits: createApiWaits({ ledger }),
    reply: async (chat: number, text: string, project?: string, _p?: unknown, meta?: { kind?: string }) => void replies.push({ chat, text, project, kind: meta?.kind }),
    // A resume starts a fresh SDK run: record its task.
    start: (o: Order) => {
      starts.push(o.task);
      return { done: new Promise(() => {}), followUp: () => {}, interrupt: async () => {}, active: () => true, queued: () => 0 } as never;
    },
    now: () => 10_000_000,
  } as unknown as PipelineDeps;
  /** A live (running) session with a control that records what it is told. */
  const live = (over: Partial<Order> = {}) => {
    const s = registry.add(order(over), 0);
    registry.setStatus(s.id, "running");
    const told: string[] = [];
    registry.attachControl(s.id, { followUp: (t: string) => void told.push(t), interrupt: async () => {}, active: () => true, steersMidTurn: true } as never);
    return { s, told };
  };
  return { deps, ledger, registry, replies, starts, live };
}
const send = (deps: PipelineDeps, project: string, text: string) => sendProjectMessage(deps, { project, text, replyChat: 7 });

test("a working session gets the message at its next step, like the operator's own; the task is not replaced", async () => {
  const { deps, live, replies, ledger, starts } = setup();
  const { told } = live();
  const r = await send(deps, "waselni", "status?");
  expect(r).toMatchObject({ ok: true, outcome: "steered" });
  expect(r.text).toContain("next step");
  expect(told).toEqual(["status?"]);
  expect(starts).toEqual([]); // no new run
  // Marked: the stream line names the chief of staff, the ledger event holds no text.
  expect(replies).toContainEqual({ chat: 7, text: "🤖 chief of staff → waselni: status?", project: "waselni", kind: "agent_message" });
  const ev = ledger.listEvents({ kind: "project_message" })[0]!;
  expect(ev.data).toMatchObject({ project: "waselni", chars: 7, outcome: "steered" });
  expect(JSON.stringify(ev.data)).not.toContain("status?");
});

test("an idle session is resumed with the message", async () => {
  const { deps, registry, starts } = setup();
  const s = registry.add(order(), 0);
  registry.setStatus(s.id, "idle");
  const r = await send(deps, "waselni", "continue");
  expect(r).toMatchObject({ ok: true, outcome: "resumed" });
  await new Promise((res) => setTimeout(res, 20));
  expect(starts).toHaveLength(1);
  expect(starts[0]).toContain("continue");
});

test("a session held in a limit wait: the message goes in now and says so; no second run", async () => {
  const { deps, live, starts } = setup();
  const { s, told } = live();
  const sent: string[] = [];
  deps.apiWaits!.hold({ orderId: s.order.id, kind: "rate_limit", provider: "claude", until: 20_000_000 }, new Promise(() => {}), () => sent.push("re-send"));
  const r = await send(deps, "waselni", "resume");
  expect(r).toMatchObject({ ok: true, outcome: "steered" });
  expect(r.text).toContain("limit wait");
  expect(told).toEqual(["resume"]);
  expect(starts).toEqual([]);
});

test("refused in code: empty or long text, no session, a side lane, the company, a customer session", async () => {
  const { deps, live, registry, replies } = setup();
  live();
  expect((await send(deps, "waselni", "   ")).ok).toBe(false);
  const long = await send(deps, "waselni", "x".repeat(DEFAULT_PROJECT_MESSAGE_CFG.maxChars + 1));
  expect(long.ok).toBe(false);
  expect(long.text).toContain("dispatch");
  expect((await send(deps, "gold", "status?")).text).toContain("dispatch"); // no open session
  expect((await send(deps, "../etc", "status?")).ok).toBe(false);
  const company = registry.add(order({ folder: join(ROOT, "neo", "agent") }), 0);
  registry.setDefault(company.id);
  registry.setStatus(company.id, "running");
  expect((await send(deps, "agent", "hi")).ok).toBe(false);
  const { s: cust } = live({ folder: join(ROOT, "shop"), source: "customer" as never });
  void cust;
  expect((await send(deps, "shop", "status?")).text).toContain("customer");
  const { s: cchat } = live({ folder: join(ROOT, "desk"), chatId: -3 });
  void cchat;
  expect((await send(deps, "desk", "status?")).ok).toBe(false);
  expect(replies.filter((r) => r.kind === "agent_message")).toEqual([]); // nothing refused is shown as sent
});

test("rate limit: at most perProjectPerHour delivered messages per project; refusals do not count", async () => {
  const { deps, live } = setup({ projectMessage: { maxChars: 500, perProjectPerHour: 2 } });
  live();
  expect((await send(deps, "waselni", "")).ok).toBe(false);
  expect((await send(deps, "waselni", "one")).ok).toBe(true);
  expect((await send(deps, "waselni", "two")).ok).toBe(true);
  const third = await send(deps, "waselni", "three");
  expect(third.ok).toBe(false);
  expect(third.text).toContain("2 messages");
});

// The tool is the company's only (like `sessions` and `dispatch`), present when the operator dep is wired, and
// never on the customer (ingress) path.
import { neoMcpServers, type DispatchDeps } from "../src/engine/dispatch";
import { runCompanyBrief } from "../src/engine/ingress";
import { registerDefaultProject } from "../src/engine/default-project";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

const toolsOf = (servers: Record<string, unknown>): Record<string, { description: string; handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }> =>
  (servers.neo as { instance: { _registeredTools: Record<string, never> } }).instance._registeredTools;

function dispatchDeps(projectMessage?: DispatchDeps["projectMessage"]): DispatchDeps {
  return {
    ledger: openLedger(":memory:"), registry: createRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"), reply: () => {}, askApproval: async () => "deny", ...(projectMessage ? { projectMessage } : {}),
  };
}

test("project_message is on the company session with the operator dep, never on a project worker", async () => {
  const calls: unknown[] = [];
  const d = dispatchDeps(async (p) => (calls.push(p), { ok: true, outcome: "steered", text: "delivered to waselni" }));
  const company = toolsOf(neoMcpServers(d, 7, { dispatch: true, folder: "/home/neo/agent", cause: () => undefined }));
  expect(company.project_message).toBeDefined();
  expect(company.project_message!.description).toContain("dispatch");
  expect(company.project_message!.description).toContain("/kill");
  const r = await company.project_message!.handler({ project: "waselni", text: "resume" });
  expect(r.content[0]!.text).toBe("delivered to waselni");
  expect(calls).toEqual([{ project: "waselni", text: "resume", replyChat: 7, cause: undefined }]);
  expect(toolsOf(neoMcpServers(d, 7, { dispatch: false, folder: "/home/waselni" })).project_message).toBeUndefined();
  expect(toolsOf(neoMcpServers(dispatchDeps(), 7, { dispatch: true, folder: "/home/neo/agent" })).project_message).toBeUndefined(); // no dep, no tool
});

test("the customer (ingress) path never gets project_message, even when the deps carry it", async () => {
  const d = dispatchDeps(async () => ({ ok: true, text: "x" }));
  registerDefaultProject(d.registry, d.ledger, undefined, () => 1);
  let seen: { mcpServers?: Record<string, unknown> } | undefined;
  const fakeRun = async (_o: Order, _h: RunHandlers, x?: { mcpServers?: Record<string, unknown> }): Promise<RunResult> => {
    seen = x;
    return { ok: true, sessionId: "co-1", summary: "ok", costUsd: 0 };
  };
  await runCompanyBrief("a customer asks something", { ...d, cfg: { workers: {}, workerEnv: {} } as never, run: fakeRun as never, now: () => 2 });
  expect(seen?.mcpServers).toBeDefined();
  expect(Object.keys(toolsOf(seen!.mcpServers!))).not.toContain("project_message");
});

// Review fixes (ADR-0061).
test("a session a customer-driven run used is refused, however it looks now", async () => {
  const { deps, live, registry } = setup();
  const { s } = live();
  registry.markCustomerDriven(s.id);
  const r = await send(deps, "waselni", "status?");
  expect(r.ok).toBe(false);
  expect(r.text).toContain("customer-driven");
});

test("refused without waiting: still starting (no run attached), closing, held at a big plan, waiting for the operator's decision", async () => {
  const { deps, registry, live, starts } = setup();
  const starting = registry.add(order(), 0); // running, no control yet
  expect((await send(deps, "waselni", "status?")).text).toContain("still starting");
  expect(starts).toEqual([]); // no second run
  registry.remove(starting.id);

  const closing = live({ folder: join(ROOT, "a1") });
  registry.attachControl(closing.s.id, { followUp: () => {}, interrupt: async () => {}, active: () => true, closed: () => true } as never);
  const t0 = Date.now();
  expect((await send(deps, "a1", "status?")).text).toContain("closing");
  expect(Date.now() - t0).toBeLessThan(1_000);

  const plan = live({ folder: join(ROOT, "a2") });
  registry.attachControl(plan.s.id, { followUp: (t: string) => void plan.told.push(t), interrupt: async () => {}, active: () => true, held: () => "docs/superpowers/plans/p.md" } as never);
  expect((await send(deps, "a2", "resume")).text).toContain("big plan");
  expect(plan.told).toEqual([]);

  const dec = live({ folder: join(ROOT, "a3") });
  registry.noteBlocked(dec.s.id, { kind: "decision", label: "which colour?", since: 0 });
  const r = await send(deps, "a3", "blue");
  expect(r.text).toContain("operator's answer");
  expect(dec.told).toEqual([]);
});

test("the rate limit counts the folder, not the session name", async () => {
  const { deps, live, registry } = setup({ projectMessage: { maxChars: 500, perProjectPerHour: 1 } });
  const a = live();
  expect((await send(deps, "waselni", "one")).ok).toBe(true);
  registry.remove(a.s.id);
  live(); // re-opened: registered as "waselni" again or "waselni-2" — the same folder
  expect((await send(deps, "waselni", "two")).text).toContain("1 messages");
});
