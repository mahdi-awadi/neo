import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMessage } from "../src/engine/pipeline";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter, type Meter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { NeoConfig } from "../src/config";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function cfg(): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    budgetWindowUsd: 100,
    budgetWindowMs: 3_600_000,
    agentIngressSecret: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
    gitnexusBin: "",
    codebaseMemoryBin: "",
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-pipe-"));

// A controllable fake live session: completes only when finish() is called.
function fakeStart(opts: { onStart?: (h: RunHandlers) => void } = {}) {
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => {
    resolveDone = res;
  });
  let resumeSeen: string | undefined;
  const followUps: string[] = [];
  const start = (_o: Order, h: RunHandlers, d?: { resume?: string }): SessionRun => {
    resumeSeen = d?.resume;
    opts.onStart?.(h);
    return { followUp: (t) => void followUps.push(t), interrupt: async () => {}, queued: () => 0, done };
  };
  return { start, finish: (r: RunResult) => resolveDone(r), resumeSeen: () => resumeSeen, followUps: () => followUps };
}

function harness(over: { meter?: Meter; start?: ReturnType<typeof fakeStart>["start"] } = {}) {
  const replies: string[] = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const meter = over.meter ?? createMeter({ windowBudgetUsd: 100, reservePct: 0.2 });
  const base = {
    cfg: cfg(),
    ledger,
    registry,
    meter,
    trust: openTrustStore(":memory:"),
    reply: (_c: number, t: string) => void replies.push(t),
    askApproval: async () => "allow" as const,
    start: over.start,
  };
  return { replies, ledger, registry, meter, base };
}

test("replies with a usage hint for a non-order message when no session is live", async () => {
  const h = harness();
  await handleMessage("nonsense", 1, h.base);
  expect(h.replies.some((r) => r.includes("/open"))).toBe(true);
});

test("starts a live order, streams text, registers it, then records the outcome on completion", async () => {
  const dir = scratch();
  const f = fakeStart({ onStart: (h) => h.onMessage("doing work") });
  const h = harness({ start: f.start });

  const run = await handleMessage(`/open ${dir} do the thing`, 9, h.base);
  expect(h.replies).toContain("doing work");
  expect(h.registry.list().length).toBe(1); // registered while running

  f.finish({ ok: true, sessionId: "sdk-1", summary: "completed", costUsd: 0.02 });
  await run!.done;

  expect(h.replies.some((r) => r.includes("completed"))).toBe(true);
  const recent = h.ledger.listRecent();
  expect(h.ledger.getOutcome(recent[0].id)?.status).toBe("done");
  // The finished project stays listed as IDLE (resumable/selectable), not deleted — the
  // idle watchdog or /kill removes it later. (Removing it on completion made opened
  // projects vanish from /list and the web dashboard within a second.)
  expect(h.registry.list().length).toBe(1);
  expect(h.registry.list()[0].status).toBe("idle");
  expect(h.registry.getControl(h.registry.list()[0].id)).toBeUndefined(); // dead handle dropped
});

test("logs the full conversation: inbound user text and every outbound reply", async () => {
  const dir = scratch();
  const f = fakeStart({ onStart: (h) => h.onMessage("doing work") });
  const h = harness({ start: f.start });

  const run = await handleMessage(`/open ${dir} do the thing`, 9, h.base);
  f.finish({ ok: true, sessionId: "sdk-1", summary: "completed", costUsd: 0 });
  await run!.done;

  const convo = h.ledger.conversation(9);
  expect(convo[0]).toMatchObject({ role: "user", content: `/open ${dir} do the thing` });
  expect(convo.some((m) => m.role === "assistant" && m.content === "doing work")).toBe(true);
  expect(convo.some((m) => m.role === "assistant" && m.content.includes("completed"))).toBe(true);
});

test("logs approval prompts and the operator's decision into the conversation", async () => {
  const dir = scratch();
  let captured!: RunHandlers;
  const f = fakeStart({ onStart: (h) => void (captured = h) });
  const h = harness({ start: f.start });

  await handleMessage(`/open ${dir} go`, 3, h.base);
  await captured.onEscalation("risky shell command: rm -rf build");

  const convo = h.ledger.conversation(3);
  expect(convo.some((m) => m.role === "assistant" && m.content.includes("rm -rf build"))).toBe(true);
  expect(convo.some((m) => m.role === "user" && m.content.includes("allow"))).toBe(true);
});

test("a follow-up to a completed (idle) session resumes it carrying its sdk id", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });

  const run = await handleMessage(`/open ${dir} start`, 4, h.base);
  f.finish({ ok: true, sessionId: "sdk-42", summary: "done", costUsd: 0 });
  await run!.done;
  await new Promise((r) => setTimeout(r, 0)); // let the supervisor mark it idle
  expect(h.registry.list()[0].status).toBe("idle");

  await handleMessage("now do part two", 4, h.base);

  expect(f.resumeSeen()).toBe("sdk-42"); // resumed with the persisted sdk session id
  expect(h.replies.some((r) => r.toLowerCase().includes("resum"))).toBe(true);
  expect(h.registry.list().length).toBe(1); // still the same single project
});

test("routes a plain-text message to the live session as a follow-up", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });

  await handleMessage(`/open ${dir} start`, 5, h.base);
  await handleMessage("also write a README", 5, h.base);

  expect(f.followUps()).toContain("also write a README");
  expect(h.replies.some((r) => r.includes("added"))).toBe(true);
});

test("a free-text order with no active project routes to the default project", async () => {
  const f = fakeStart();
  const h = harness({ start: f.start });
  // a default (idle, resumable) project is registered — the chief-of-staff fallback
  const def = h.registry.add(
    { id: "def", source: "neo", folder: "/home/neo/agent", task: "init", chatId: -1, createdAt: 1 },
    1,
  );
  h.registry.setDefault(def.id);
  h.registry.setStatus(def.id, "idle");
  h.registry.setSdkSessionId(def.id, "sdk-def");

  await handleMessage("check docker status in eticket-v3", 9, h.base);

  expect(f.resumeSeen()).toBe("sdk-def"); // resumed the default project
  expect(h.replies.some((r) => r.includes("not an order"))).toBe(false);
  expect(h.replies.some((r) => r.toLowerCase().includes("resum"))).toBe(true);
});

test("throttles a new order when the meter is over the reserve, and does not start it", async () => {
  const dir = scratch();
  const meter = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // available $8
  meter.note({ costUsd: 9 }); // over reserve
  const f = fakeStart();
  const h = harness({ start: f.start, meter });

  await handleMessage(`/open ${dir} do it`, 1, h.base);

  expect(h.replies.some((r) => r.toLowerCase().includes("throttle"))).toBe(true);
  expect(h.registry.list().length).toBe(0);
});

test("refuses a customer-source order (firewall) and never starts it", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });

  await handleMessage(`/open ${dir} do it`, 1, h.base, "customer");

  expect(h.replies.some((r) => r.includes("refused"))).toBe(true);
  expect(h.registry.list().length).toBe(0);
});

test("wires worker escalations through askApproval", async () => {
  const dir = scratch();
  let asked = "";
  let captured!: RunHandlers;
  const f = fakeStart({ onStart: (h) => void (captured = h) });
  const h = harness({ start: f.start });
  const base = { ...h.base, askApproval: async (_c: number, reason: string) => ((asked = reason), "allow" as const) };

  await handleMessage(`/open ${dir} go`, 3, base);
  const decision = await captured.onEscalation("risky shell command: rm -rf build");

  expect(asked).toContain("rm");
  expect(decision).toBe("allow");
});

test("a follow-up routes to the actively-selected project", async () => {
  const dirA = scratch();
  const dirB = scratch();
  const followed: string[] = [];
  const start = (o: Order, _h: RunHandlers): SessionRun => ({
    followUp: (t) => void followed.push(`${o.folder}:${t}`),
    interrupt: async () => {},
    queued: () => 0,
    done: new Promise<RunResult>(() => {}),
  });
  const h = harness({ start });
  await handleMessage(`/open ${dirA} a`, 5, h.base);
  await handleMessage(`/open ${dirB} b`, 5, h.base);

  const aId = h.registry.list().find((s) => s.order.folder === dirA)!.id;
  h.registry.setActive(5, aId);
  await handleMessage("keep going", 5, h.base);

  expect(followed).toContain(`${dirA}:keep going`);
});

test("resumes when a prior session id exists for the folder/chat", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });
  h.ledger.recordOrder({ id: "prev", source: "neo", folder: dir, task: "t", chatId: 7, createdAt: 1 });
  h.ledger.recordSession("prev", "sdk-prev");

  await handleMessage(`/open ${dir} continue`, 7, h.base);

  expect(f.resumeSeen()).toBe("sdk-prev");
  expect(h.replies.some((r) => r.toLowerCase().includes("resum"))).toBe(true);
});

test("worker output touches the session so producing output counts as activity", async () => {
  let handlers: RunHandlers | undefined;
  const fs = fakeStart({ onStart: (h) => (handlers = h) });
  const h = harness({ start: fs.start });
  let clock = 1000;
  await handleMessage("/open " + scratch() + " do work", 7, { ...h.base, now: () => clock });

  const id = h.registry.list()[0].id;
  clock = 5000;
  handlers!.onMessage("progress line"); // worker emits output at t=5000

  expect(h.registry.get(id)?.lastActivityAt).toBe(5000);
});

test("a trusted project auto-approves: onAutoApprove records to the ledger and replies", async () => {
  let handlers: RunHandlers | undefined;
  const fs = fakeStart({ onStart: (h) => (handlers = h) });
  const folder = scratch();
  const trust = openTrustStore(":memory:");
  trust.setTrust(folder, true);
  const h = harness({ start: fs.start });

  await handleMessage("/open " + folder + " do it", 7, { ...h.base, trust });

  expect(handlers!.autoApprove?.()).toBe(true);
  handlers!.onAutoApprove?.("risky shell command: git push");

  const orderId = h.ledger.listRecent(1)[0].id;
  expect(h.ledger.autoApprovalsFor(orderId)).toContain("risky shell command: git push");
  expect(h.replies.some((r) => r.includes("auto-approved"))).toBe(true);
});
