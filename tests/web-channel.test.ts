import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebChannel, type WebEvent } from "../src/engine/web-channel";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
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
    dispatchTimeoutMs: 900_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-web-"));

function fakeStart(onStart?: (h: RunHandlers) => void) {
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((r) => (resolveDone = r));
  const start = (_o: Order, h: RunHandlers): SessionRun => {
    onStart?.(h);
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done };
  };
  return { start, finish: (r: RunResult) => resolveDone(r) };
}

function engine(start: ReturnType<typeof fakeStart>["start"]) {
  return {
    cfg: cfg(),
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    start,
  };
}

test("send drives the pipeline and emits worker messages as events", async () => {
  const dir = scratch();
  const f = fakeStart((h) => h.onMessage("hi from worker"));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} do it`);

  const texts = events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  expect(texts).toContain("hi from worker");
});

test("worker messages are tagged with the project they came from", async () => {
  const dir = scratch();
  const f = fakeStart((h) => h.onMessage("hi from worker"));
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} do it`);

  const msg = events.find((e) => e.type === "message" && e.text === "hi from worker") as
    | { project?: string }
    | undefined;
  expect(msg?.project).toBe(eng.registry.list()[0].name); // the session's short name
});

test("escalations emit an event resolvable via resolveApproval", async () => {
  const dir = scratch();
  let captured!: RunHandlers;
  const f = fakeStart((h) => void (captured = h));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} go`);
  const decisionP = captured.onEscalation("risky shell command: rm -rf build");

  const esc = events.find((e) => e.type === "escalation") as { id: string; reason: string } | undefined;
  expect(esc).toBeTruthy();
  expect(esc!.reason).toContain("rm");
  expect(ch.resolveApproval(esc!.id, "allow")).toBe(true);
  expect(await decisionP).toBe("allow");
});

test("subscribers opened after activity get the replayed events", async () => {
  const dir = scratch();
  const f = fakeStart((h) => h.onMessage("earlier output"));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });

  await ch.send(`/open ${dir} x`); // emit before anyone subscribes
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  const texts = events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  expect(texts).toContain("earlier output");
});

test("send routes a slash-command through handleCommand and emits the reply", async () => {
  const f = fakeStart();
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send("/help");

  const texts = events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  // "/list" appears in the help text but NOT in handleMessage's "not an order" error.
  expect(texts.some((t) => t.includes("/list"))).toBe(true);
});

test("/list over the web emits a projects event with items; selectProject switches active", async () => {
  const dir = scratch();
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} build`);
  await ch.send("/list");

  const proj = events.find((e) => e.type === "projects") as { type: "projects"; items: Array<{ id: string }> } | undefined;
  expect(proj).toBeTruthy();
  expect(proj!.items.length).toBe(1);

  ch.selectProject(proj!.items[0].id);
  expect(eng.registry.findByChat(42)?.id).toBe(proj!.items[0].id);
});

test("killProject removes the session and emits a refreshed projects event", async () => {
  const dir1 = scratch();
  const dir2 = scratch();
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));
  await ch.send(`/open ${dir1} a`);
  await ch.send(`/open ${dir2} b`);

  const id = eng.registry.list()[0].id;
  ch.killProject(id);

  expect(eng.registry.get(id)).toBeUndefined();
  const proj = events.filter((e) => e.type === "projects").pop() as { items: unknown[] } | undefined;
  expect(proj?.items.length).toBe(1);
});

test("/loop alone emits a loops event with runnable items", async () => {
  const f = fakeStart();
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send("/loop");

  const loops = events.find((e) => e.type === "loops") as { items: Array<{ name: string }> } | undefined;
  expect(loops).toBeTruthy();
  expect(loops?.items.find((l) => l.name === "gold-gofmt")).toBeTruthy();
});

test("openProject starts a project (form-driven) and it shows in state()", async () => {
  const dir = scratch();
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });

  await ch.openProject(dir, "build it");

  expect(eng.registry.list().length).toBe(1);
  const st = ch.state();
  expect(st.projects[0].folder).toBe(dir);
  expect(st.projects[0].task).toBe("build it");
  expect(st.loops.find((l) => l.name === "gold-gofmt")).toBeTruthy();
});

test("resolveApproval returns false for an unknown id", () => {
  const f = fakeStart();
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  expect(ch.resolveApproval("nope", "deny")).toBe(false);
});

test("createLoop validates, persists, and emits a refreshed loops event", () => {
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  const bad = ch.createLoop({ name: "", summary: "", folder: "/nope", prompt: "", goalKind: "command", triggerKind: "manual", maxIterations: 1 });
  expect(bad.ok).toBe(false);
  expect(eng.ledger.listLoopDefs()).toEqual([]);

  const ok = ch.createLoop({ name: "tidy", summary: "tidy up", folder: "/home/neo", prompt: "tidy", goalKind: "command", goalCommand: "true", triggerKind: "manual", maxIterations: 2 });
  expect(ok.ok).toBe(true);
  expect(eng.ledger.listLoopDefs().map((r) => r.name)).toContain("tidy");
  const loops = events.filter((e) => e.type === "loops") as Array<{ items: Array<{ name: string }> }>;
  expect(loops.some((e) => e.items.some((i) => i.name === "tidy"))).toBe(true);
});

test("deleteLoop removes a custom loop", () => {
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  ch.createLoop({ name: "tidy", summary: "t", folder: "/home/neo", prompt: "p", goalKind: "command", goalCommand: "true", triggerKind: "manual", maxIterations: 1 });
  expect(ch.deleteLoop("tidy").ok).toBe(true);
  expect(eng.ledger.listLoopDefs()).toEqual([]);
});

test("sendFile emits a file event and registers a token getFile can resolve", () => {
  const f = fakeStart();
  const ch = createWebChannel({ engine: engine(f.start), chatId: 0 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  const token = ch._testSendFile("/tmp/report.pdf", "done"); // test seam added in Step 3

  const fileEvent = events.find((e) => e.type === "file") as { type: "file"; name: string; url: string };
  expect(fileEvent.name).toBe("report.pdf");
  expect(fileEvent.url).toContain(encodeURIComponent(token));
  expect(ch.getFile(token)).toBe("/tmp/report.pdf");
});
