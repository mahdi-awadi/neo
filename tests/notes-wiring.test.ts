// The live-delivery wiring of ADR-0050 rev. 2 (spec §2, §4, §10 criteria 6, 8, 11): notes from main and
// held answers reach a running worker at its next step (`followUp(frame, "steer")`), an idle worker gets
// them in front of its next follow-up, the tool's sender comes from its closure, and the stall clock is
// held while a worker waits for an answer. Fakes only — no real worker.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { createRegistry, type Registry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { dispatchToProject, neoMcpServers, type DispatchDeps } from "../src/engine/dispatch";
import { handleMessage } from "../src/engine/pipeline";
import {
  createProjectNotes, DEFAULT_NOTES_CFG, LIVE_FRAME_HEAD, notesWiring,
  type ConsultRunner, type NotesDeps, type ProjectNotes, type SenderCtx,
} from "../src/engine/project-notes";
import type { FollowUpTiming, Order, SessionControl } from "../src/types";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
const neoTools = (servers: Record<string, unknown>) =>
  (servers.neo as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools;

/** A control the test reads: every follow-up with its timing; `active` says whether a turn runs now. */
function control(active: boolean) {
  const sent: Array<{ text: string; timing: FollowUpTiming }> = [];
  const c: SessionControl & { sent: typeof sent; setActive: (v: boolean) => void } = {
    sent,
    followUp: (text, timing) => void sent.push({ text, timing }),
    interrupt: async () => {},
    queued: () => 0,
    active: () => active,
    closed: () => false,
    setActive: (v) => void (active = v),
  };
  return c;
}

function rig(over: Partial<NotesDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-wire-root-"));
  const company = mkdtempSync(join(tmpdir(), "neo-wire-agent-"));
  for (const p of ["prod-ops", "eticket-v3"]) mkdirSync(join(root, p));
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  let notes: ProjectNotes | undefined;
  const wiring = notesWiring({ registry, notes: () => notes, worker: "subscription" });
  notes = createProjectNotes({ ledger, cfg: DEFAULT_NOTES_CFG, workRoot: root, desksDir: join(root, "no-desks"), companyFolder: company, ...wiring, ...over });
  const main: SenderCtx = { project: basename(company), folder: company, chatId: 1, sessionId: "s-main", orderId: "o-main", workClass: "interactive" };
  let opened = 0;
  const open = (folder: string, c?: SessionControl) => {
    const s = registry.add({ id: `o-${basename(folder)}-${++opened}`, source: "neo", folder, task: "t", chatId: 1, createdAt: 0 }, 0);
    registry.setStatus(s.id, "running");
    if (c) registry.attachControl(s.id, c);
    return s;
  };
  return { root, company, ledger, registry, notes: notes!, main, open };
}

const fyi = (to: string, ref = "n1") => ({ to, kind: "fyi" as const, severity: "normal" as const, title: "deploy window moved to 22:00", body: "from the operator", ref });

test("criterion 8: a fyi from main to a project in a turn → exactly one followUp(frame, \"steer\")", () => {
  const r = rig();
  const c = control(true);
  r.open(join(r.root, "prod-ops"), c);
  expect(r.notes.send(r.main, fyi("prod-ops"), 10).ok).toBe(true);
  expect(c.sent.length).toBe(1);
  expect(c.sent[0]!.timing).toBe("steer");
  expect(c.sent[0]!.text.startsWith(LIVE_FRAME_HEAD)).toBe(true);
  expect(c.sent[0]!.text).toContain("deploy window moved to 22:00");
  // Delivered once: nothing is left to take.
  const s = r.registry.findByFolder(join(r.root, "prod-ops"))!;
  expect(r.notes.takeLive(s.id, s.order.folder, 11)).toBe("");
});

test("criterion 8: to an idle session nothing is sent — a delivery never starts a turn", () => {
  const r = rig();
  const c = control(false);
  const s = r.open(join(r.root, "prod-ops"), c);
  r.notes.send(r.main, fyi("prod-ops"), 10);
  expect(c.sent).toEqual([]);
  // It is held for the next follow-up.
  expect(r.notes.takeLive(s.id, s.order.folder, 11).startsWith(LIVE_FRAME_HEAD)).toBe(true);
});

test("criterion 8: a fyi from another project is never delivered live", () => {
  const r = rig();
  const c = control(true);
  const s = r.open(join(r.root, "prod-ops"), c);
  const etkt: SenderCtx = { project: "eticket-v3", folder: join(r.root, "eticket-v3"), chatId: 2, sessionId: "s-e", orderId: "o-e", workClass: "interactive" };
  expect(r.notes.send(etkt, fyi("prod-ops"), 10).ok).toBe(true);
  expect(c.sent).toEqual([]);
  expect(r.notes.takeLive(s.id, s.order.folder, 11)).toBe("");
});

test("criterion 8: the next operator follow-up to an idle session starts with the frame", async () => {
  const r = rig();
  const c = control(false);
  const s = r.open(join(r.root, "prod-ops"), c);
  r.notes.send(r.main, fyi("prod-ops"), 10);
  r.registry.setFocus(5, s.id, "once");
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), "neo-wire-cfg-")));
  const deps = {
    cfg, ledger: r.ledger, registry: r.registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"),
    reply: () => {}, askApproval: async () => "allow" as const, notes: r.notes,
  };
  await handleMessage("please carry on", 5, deps);
  expect(c.sent.length).toBe(1);
  expect(c.sent[0]!.timing).toBe("steer");
  expect(c.sent[0]!.text.startsWith(LIVE_FRAME_HEAD)).toBe(true);
  expect(c.sent[0]!.text.endsWith("please carry on")).toBe(true);
  // A second follow-up carries no frame: it was delivered once.
  r.registry.setFocus(5, s.id, "once");
  await handleMessage("and again", 5, deps);
  expect(c.sent[1]!.text).toBe("and again");
});

test("an idle session resumed by an operator message gets the frame in front of the resumed task", async () => {
  const r = rig();
  const s = r.open(join(r.root, "prod-ops"));
  r.registry.setStatus(s.id, "idle");
  r.registry.setSdkSessionId(s.id, "sdk-1", "subscription");
  r.notes.send(r.main, fyi("prod-ops"), 10);
  r.registry.setFocus(5, s.id, "once");
  let task = "";
  const start = (o: Order): SessionRun => {
    task = o.task;
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false, close: () => {}, closed: () => false, done: new Promise<RunResult>(() => {}) };
  };
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), "neo-wire-cfg-")));
  await handleMessage("resume please", 5, {
    cfg, ledger: r.ledger, registry: r.registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"),
    reply: () => {}, askApproval: async () => "allow" as const, notes: r.notes, start,
  });
  expect(task.startsWith(LIVE_FRAME_HEAD)).toBe(true);
  expect(task).toContain("resume please");
});

function dispatchDeps(r: ReturnType<typeof rig>, over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    ledger: r.ledger, registry: r.registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"),
    reply: () => {}, askApproval: async () => "deny", notes: r.notes, ...over,
  };
}

test("a dispatch into an idle live session carries the held frame in front of the brief", async () => {
  const r = rig();
  const c = control(false);
  r.open(join(r.root, "prod-ops"), c);
  r.notes.send(r.main, fyi("prod-ops"), 10);
  await dispatchToProject("prod-ops", "next brief", dispatchDeps(r), 1, { root: r.root, start: (() => { throw new Error("must not start"); }) as never });
  expect(c.sent.length).toBe(1);
  expect(c.sent[0]!.text.startsWith(LIVE_FRAME_HEAD)).toBe(true);
  expect(c.sent[0]!.text.endsWith("next brief")).toBe(true);
});

test("criterion 11: ingress (notes undefined) and consult servers never have project_notes", () => {
  const r = rig();
  const d = dispatchDeps(r);
  const folder = join(r.root, "prod-ops");
  const ctx = { dispatch: false, folder, projectName: "prod-ops", sessionId: "s1", orderId: "o1" };
  expect(Object.keys(neoTools(neoMcpServers(d, 1, ctx)))).toContain("project_notes");
  expect(Object.keys(neoTools(neoMcpServers({ ...d, notes: undefined }, 1, ctx)))).not.toContain("project_notes");
  const consult = Object.keys(neoTools(neoMcpServers(d, 1, { ...ctx, profile: "consult" })));
  for (const t of ["project_notes", "ask_operator", "send_file", "tool_api", "dispatch", "todo", "sessions"]) expect(consult).not.toContain(t);
});

test("the tool's SenderCtx comes from the closure: args cannot set the session, order or work class", async () => {
  const r = rig();
  const jobs: Array<Parameters<ConsultRunner>[0]> = [];
  const consult: ConsultRunner = async (job) => (jobs.push(job), { ok: true, answer: "port 5432" });
  const notes = createProjectNotes({ ledger: r.ledger, cfg: DEFAULT_NOTES_CFG, workRoot: r.root, desksDir: join(r.root, "no-desks"), companyFolder: r.company, consult });
  const tools = neoTools(neoMcpServers(dispatchDeps(r, { notes }), 1, { dispatch: false, folder: join(r.root, "prod-ops"), projectName: "prod-ops", sessionId: "s-real", orderId: "o-real", workClass: "background" }));
  const out = await tools.project_notes!.handler(
    { action: "ask", to: "eticket-v3", question: "Which port does the db use?", need: "info", sessionId: "s-fake", orderId: "o-fake", workClass: "interactive", from: "main" },
    {},
  );
  expect(out.content[0]?.text).toContain("port 5432");
  expect(jobs[0]!.workClass).toBe("background");
  const row = r.ledger.attentionRows("eticket-v3", "note")[0]!;
  expect(row).toMatchObject({ fromProject: "prod-ops", fromSession: "s-real", key: "prod-ops:q-o-real-1" });
});

test("without a session id and order the tool is not attached (they are required at the tool boundary)", () => {
  const r = rig();
  const tools = neoTools(neoMcpServers(dispatchDeps(r), 1, { dispatch: false, folder: join(r.root, "prod-ops"), projectName: "prod-ops" }));
  expect(Object.keys(tools)).not.toContain("project_notes");
});

test("the company acts as main in the tool: list/show/ack see notes sent to main", async () => {
  const r = rig();
  const etkt: SenderCtx = { project: "eticket-v3", folder: join(r.root, "eticket-v3"), chatId: 2, sessionId: "s-e", orderId: "o-e", workClass: "interactive" };
  const sent = r.notes.send(etkt, { ...fyi("main"), title: "prod cert expires friday" }, 10);
  expect(sent.ok).toBe(true);
  const tools = neoTools(neoMcpServers(dispatchDeps(r, { companyFolder: r.company }), 1, { dispatch: true, folder: r.company, projectName: basename(r.company), sessionId: "s-main", orderId: "o-main" }));
  const text = async (args: Record<string, unknown>) => (await tools.project_notes!.handler(args, {})).content[0]?.text ?? "";
  expect(await text({ action: "list" })).toContain("prod cert expires friday");
  expect(await text({ action: "show", id: sent.id })).toContain("prod cert expires friday");
  expect(await text({ action: "ack", id: sent.id })).toBe(`note #${sent.id} acknowledged`);
});

test("a fresh company session's notes block lists what was sent to main", async () => {
  const r = rig();
  const etkt: SenderCtx = { project: "eticket-v3", folder: join(r.root, "eticket-v3"), chatId: 2, sessionId: "s-e", orderId: "o-e", workClass: "interactive" };
  r.notes.send(etkt, { ...fyi("main"), title: "prod cert expires friday" }, 10);
  let task = "";
  const start = (o: Order): SessionRun => {
    task = o.task;
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false, close: () => {}, closed: () => false, done: new Promise<RunResult>(() => {}) };
  };
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-wire-cfg-"))), companyFolder: r.company };
  await handleMessage(`/open ${r.company} morning review`, 5, {
    cfg, ledger: r.ledger, registry: r.registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"),
    reply: () => {}, askApproval: async () => "allow" as const, notes: r.notes, start,
  });
  expect(task).toContain("[PROJECT NOTES");
  expect(task).toContain("prod cert expires friday");
});

test("criterion 6: the dispatch stall clock does not run while the worker waits for an answer (blockedOn agent)", async () => {
  const r = rig();
  const registry: Registry = r.registry;
  // The consult never settles and the answer wait never fires: the worker is blocked on the agent.
  const notes = createProjectNotes({
    ledger: r.ledger, cfg: DEFAULT_NOTES_CFG, workRoot: r.root, desksDir: join(r.root, "no-desks"), companyFolder: r.company,
    consult: () => new Promise(() => {}),
    timer: () => ({ done: new Promise<void>(() => {}), cancel: () => {} }),
    ...notesWiring({ registry, notes: () => notes, worker: "subscription" }),
  });
  const d = dispatchDeps(r, { notes });
  d.dispatchStallMs = 40;
  d.dispatchGraceMs = 20;
  let handlers!: RunHandlers;
  const start = (_o: unknown, h: RunHandlers) => {
    handlers = h;
    return { followUp: () => {}, queued: () => 0, active: () => true, interrupt: async () => {}, close: () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("prod-ops", "task", d, 1, { start: start as never, root: r.root });
  await settle();
  expect(handlers).toBeDefined();
  const s = registry.findByFolder(join(r.root, "prod-ops"))!;
  const from: SenderCtx = { project: "prod-ops", folder: s.order.folder, chatId: 1, sessionId: s.id, orderId: s.order.id, workClass: "interactive" };
  void notes.ask(from, { to: "eticket-v3", question: "Which port?" }, Date.now());
  await settle(1);
  expect(registry.get(s.id)!.blockedOn).toMatchObject({ kind: "agent", label: "asked eticket-v3" });
  await settle(250); // ≫ the 40ms stall window
  expect(r.ledger.listEvents({ limit: 50 }).map((e) => e.kind)).not.toContain("dispatch_abort");
}, 10_000);

test("fork facts come from the registry: a session in a turn is never forked; an idle one names its SDK session", () => {
  const r = rig();
  const c = control(true);
  const s = r.open(join(r.root, "eticket-v3"), c);
  r.registry.setSdkSessionId(s.id, "sdk-e", "subscription");
  const w = notesWiring({ registry: r.registry, notes: () => r.notes, worker: "subscription", occupancyPct: () => 40 });
  expect(w.forkFacts(s.order.folder)).toEqual({ inTurn: true, lastSessionId: "sdk-e", sameSdk: true, occupancyPct: 40 });
  c.setActive(false);
  expect(w.forkFacts(s.order.folder).inTurn).toBe(false);
  const codex = notesWiring({ registry: r.registry, notes: () => r.notes, worker: "codex", occupancyPct: () => 40 });
  expect(codex.forkFacts(s.order.folder).sameSdk).toBe(false);
  // liveSession: a session is live while it is running in the registry.
  expect(w.liveSession(s.id)).toBe(true);
  r.registry.setStatus(s.id, "idle");
  expect(w.liveSession(s.id)).toBe(false);
  expect(w.liveSession("gone")).toBe(false);
});
