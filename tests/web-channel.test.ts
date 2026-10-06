import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebChannel, type WebEvent } from "../src/engine/web-channel";
import { createOperatorBus, type BusLine, type OperatorSink } from "../src/engine/operator-bus";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { NeoConfig } from "../src/config";
import { DEFAULT_FAULTS, DEFAULT_HEALTH, DEFAULT_MODELS, DEFAULT_UPDATES } from "../src/config";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";
import { DEFAULT_GOVERNOR_CFG } from "../src/engine/governor";

function cfg(): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    botUsername: "",
    webHost: "127.0.0.1",
    webPort: 3003,
    publicUrl: "",
    companyFolder: "/tmp/agent",
    gatewaySendUrl: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    budgetWindowUsd: 100,
    budgetWindowMs: 3_600_000,
    agentIngressSecret: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
    codebaseMemoryBin: "",
    codebaseMemoryIndexTimeoutMs: 300_000,
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
    dispatchStallMs: 300_000,
    dispatchGraceMs: 75_000,
    dispatchProgressMs: 600_000,
    dispatchRecoverWindowMs: 86_400_000,
    todoOnFailure: "continue",
    apiRetryLadderMs: [30_000, 120_000, 480_000],
    apiRetryJitterFrac: 0.2,
    apiCooldownMs: 60_000,
    routeKeep: 20_000,
    eventsKeep: 50_000,
    decisionsKeep: 5_000,
    toolActionsKeep: 100_000,
    secretaryCron: "0 8-22/2 * * *",
    secretaryStaleHours: 24,
    codebaseMemoryListTimeoutMs: 15_000,
    inboxListDefault: 100,
    webFeedWindow: 500,
    messageRoutesCacheCap: 2_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
    drainWindowMs: 90_000,
    trustNewProjects: false,
    contextPolicy: { sweetSpotPct: 0.65, checkpointPct: 0.8, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 },
    models: DEFAULT_MODELS,
    updates: DEFAULT_UPDATES,
    faults: DEFAULT_FAULTS,
    health: DEFAULT_HEALTH,
    sqliteBusyTimeoutMs: 5_000,
    workers: { company: { effort: "low" }, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: { effort: "low" }, handoff: {}, secretary: {} },
    workerEnv: {},
    memory: { scopes: [], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 },
    telegramToolSteps: false,
    telegramFloodMaxWaitMs: 30_000,
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-web-"));

function fakeStart(onStart?: (h: RunHandlers) => void) {
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((r) => (resolveDone = r));
  const start = (_o: Order, h: RunHandlers): SessionRun => {
    onStart?.(h);
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false, close: () => {}, closed: () => false, done };
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
  expect(loops?.items.find((l) => l.name === "green")).toBeTruthy();
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
  expect(st.loops.find((l) => l.name === "green")).toBeTruthy();
});

test("state exposes the selected worker SDK and setSdk changes new-session routing", () => {
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  expect(ch.state().sdk.provider).toBe("subscription");
  const res = ch.setSdk("codex");

  expect(res.ok).toBe(true);
  expect(res.sdk.provider).toBe("codex");
  expect(eng.cfg.providers.ownWork).toBe("codex");
  expect(ch.state().sdk.label).toContain("Codex");
  expect(events.some((e) => e.type === "sdk" && e.sdk.provider === "codex")).toBe(true);
});

test("typed /sdk over the web mutates config and emits an sdk event", async () => {
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send("/sdk codex");

  expect(eng.cfg.providers.ownWork).toBe("codex");
  expect(events.some((e) => e.type === "sdk" && e.sdk.provider === "codex")).toBe(true);
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

// --- operator-channel mirroring (Telegram <-> web) ---

/** A recording sink for the other surface (stands in for Telegram in these web tests). */
function recorder(id: string): OperatorSink & { lines: BusLine[] } {
  const lines: BusLine[] = [];
  return { id, lines, deliver: (l) => lines.push(l) };
}

test("a bus reply line (from the other surface) is emitted as a web message event", () => {
  const bus = createOperatorBus();
  const ch = createWebChannel({ engine: engine(fakeStart().start), chatId: 0, bus });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  bus.mirror("telegram", { kind: "reply", text: "from telegram worker", project: "eticket" });

  const msg = events.find((e) => e.type === "message") as { text: string; project?: string } | undefined;
  expect(msg?.text).toContain("from telegram worker");
  expect(msg?.project).toBe("eticket");
});

test("a bus echo line is emitted as a web echo event (operator's own message from elsewhere)", () => {
  const bus = createOperatorBus();
  const ch = createWebChannel({ engine: engine(fakeStart().start), chatId: 0, bus });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  bus.mirror("telegram", { kind: "echo", text: "typed on telegram" });

  const echo = events.find((e) => e.type === "echo") as { text: string } | undefined;
  expect(echo?.text).toBe("typed on telegram");
});

test("a bus notice line is emitted as a web notice event (approval-pending indicator)", () => {
  const bus = createOperatorBus();
  const ch = createWebChannel({ engine: engine(fakeStart().start), chatId: 0, bus });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  bus.mirror("telegram", { kind: "notice", text: "⏳ approval pending on Telegram: rm -rf" });

  const notice = events.find((e) => e.type === "notice") as { text: string } | undefined;
  expect(notice?.text).toContain("approval pending");
});

test("worker replies mirror to the bus (origin web) so Telegram sees them", async () => {
  const dir = scratch();
  const bus = createOperatorBus();
  const tg = recorder("telegram");
  bus.register(tg);
  const f = fakeStart((h) => h.onMessage("hi from web-started worker"));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 0, bus });

  await ch.send(`/open ${dir} do it`);

  expect(tg.lines.some((l) => l.kind === "reply" && l.text === "hi from web-started worker")).toBe(true);
});

test("an inbound conversational message mirrors an echo to the bus, but a slash-command does not", async () => {
  const bus = createOperatorBus();
  const tg = recorder("telegram");
  bus.register(tg);
  const ch = createWebChannel({ engine: engine(fakeStart().start), chatId: 0, bus });

  await ch.send("hello from the web console");
  expect(tg.lines.filter((l) => l.kind === "echo").map((l) => (l as { text: string }).text)).toEqual([
    "hello from the web console",
  ]);

  await ch.send("/help"); // a synchronous command — its own reply, not an echo
  expect(tg.lines.filter((l) => l.kind === "echo").length).toBe(1); // unchanged
});

test("a web-raised escalation mirrors a pending notice to the bus, and its resolution mirrors too", async () => {
  const dir = scratch();
  const bus = createOperatorBus();
  const tg = recorder("telegram");
  bus.register(tg);
  let captured!: RunHandlers;
  const f = fakeStart((h) => void (captured = h));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 0, bus });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} go`);
  void captured.onEscalation("risky shell: rm -rf build");

  const pending = tg.lines.find((l) => l.kind === "notice") as { text: string } | undefined;
  expect(pending?.text).toContain("pending");
  expect(pending?.text).toContain("rm -rf");

  const esc = events.find((e) => e.type === "escalation") as { id: string } | undefined;
  ch.resolveApproval(esc!.id, "allow");
  expect(tg.lines.some((l) => l.kind === "notice" && (l as { text: string }).text.includes("allow"))).toBe(true);
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

test("todo(): the console's queue actions run the shared /todo command against the engine's queue", async () => {
  const { createTodoQueue } = await import("../src/engine/todo-queue");
  const eng = engine(fakeStart().start);
  const todo = createTodoQueue({ ledger: eng.ledger, registry: eng.registry, onFailure: () => "continue" });
  const ch = createWebChannel({ engine: { ...eng, todo }, chatId: 42 });
  expect(ch.todo("").text).toContain("every project queue is empty");
  expect(ch.todo("cancel 7").text).toContain("No todo #7");
  expect(createWebChannel({ engine: eng, chatId: 42 }).todo("").text).toContain("unavailable");
});

// ADR-0014: the console feed is a bounded replay window, resumed by event id.
function windowed(feedWindow: number, onStart?: (h: RunHandlers) => void) {
  const eng = engine(fakeStart(onStart).start);
  eng.cfg.webFeedWindow = feedWindow;
  return { eng, ch: createWebChannel({ engine: eng, chatId: 42 }) };
}
const texts = (es: WebEvent[]) => es.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);

test("a new subscriber gets only the newest webFeedWindow events, oldest first", () => {
  const { ch } = windowed(3);
  for (let i = 1; i <= 5; i++) ch.notify(`line ${i}`);
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));
  expect(events.length).toBe(3);
  expect(texts(events).map((t) => t.match(/line \d/)?.[0])).toEqual(["line 3", "line 4", "line 5"]);
});

test("every feed event carries an increasing id; a resume point replays only later events", () => {
  const { ch } = windowed(10);
  for (let i = 1; i <= 4; i++) ch.notify(`line ${i}`);
  const ids: number[] = [];
  ch.subscribe((_e, id) => ids.push(id));
  expect(ids.length).toBe(4);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  expect(new Set(ids).size).toBe(4);

  const resumed: WebEvent[] = [];
  ch.subscribe((e) => resumed.push(e), { after: ids[2] });
  expect(texts(resumed).length).toBe(1);
  expect(texts(resumed)[0]).toContain("line 4");
});

test("a pending escalation older than the window is still replayed; an answered one is not", async () => {
  const dir = scratch();
  let h!: RunHandlers;
  const { ch } = windowed(2, (x) => void (h = x));
  await ch.send(`/open ${dir} go`);
  void h.onEscalation("pending one");
  const answeredP = h.onEscalation("answered one");
  const first: WebEvent[] = [];
  ch.subscribe((e) => first.push(e));
  const answered = first.find((e) => e.type === "escalation" && e.reason.includes("answered")) as { id: string };
  ch.resolveApproval(answered.id, "deny");
  await answeredP;
  for (let i = 0; i < 5; i++) ch.notify(`noise ${i}`); // pushes both escalations out of the window

  const late: WebEvent[] = [];
  ch.subscribe((e) => late.push(e));
  const reasons = late.filter((e) => e.type === "escalation").map((e) => (e as { reason: string }).reason);
  expect(reasons).toEqual(["pending one"]);
});

test("a resumed subscriber that already has a pending escalation does not get it again", async () => {
  const dir = scratch();
  let h!: RunHandlers;
  const { ch } = windowed(2, (x) => void (h = x));
  await ch.send(`/open ${dir} go`);
  void h.onEscalation("pending one");
  let last = 0;
  ch.subscribe((_e, id) => (last = id));
  for (let i = 0; i < 5; i++) ch.notify(`noise ${i}`);
  const late: WebEvent[] = [];
  ch.subscribe((e) => late.push(e), { after: last });
  expect(late.filter((e) => e.type === "escalation").length).toBe(0);
});

test("feed ids keep increasing across a daemon restart, so an open console's stale resume point never hides new events", async () => {
  const before = windowed(10).ch;
  before.notify("old");
  let staleId = 0;
  before.subscribe((_e, id) => (staleId = id));
  await Bun.sleep(2);
  const after = windowed(10).ch; // a fresh channel = the daemon after a restart
  after.notify("new");
  const got: WebEvent[] = [];
  after.subscribe((e) => got.push(e), { after: staleId });
  expect(texts(got).some((t) => t.includes("new"))).toBe(true);
});

// The feed window (ADR-0014, console) meets the approval timeout (ADR-0012, governor): an escalation
// the engine gave up on is denied AND no longer replayed — a console must not show a dead prompt.
test("a timed-out escalation is not replayed to a console that connects later", async () => {
  const dir = scratch();
  let h!: RunHandlers;
  const { eng, ch } = windowed(10, (x) => void (h = x));
  eng.cfg.governor = { ...DEFAULT_GOVERNOR_CFG, approvalRemindMs: 0, approvalTimeoutMs: 20 };
  await ch.send(`/open ${dir} go`);
  const verdict = await h.onEscalation("nobody answers");
  expect(verdict).toBe("deny");
  const late: WebEvent[] = [];
  ch.subscribe((e) => late.push(e));
  expect(late.filter((e) => e.type === "escalation")).toEqual([]);
});
