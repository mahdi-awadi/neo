import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProject, dispatchToProject, briefWithProjectDocs, sendProjectFile, neoMcpServers, STITCH_MCP_URL, SUB_CHAT, type DispatchDeps } from "../src/engine/dispatch";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { Order } from "../src/types";
import type { StructuredAsk } from "../src/engine/structured-question";
import { startOrder, type RunHandlers, type RunResult } from "../src/engine/session-runner";
import { trackHandoff, continuationBrief, type ContextPolicyCfg, type ContextSignals } from "../src/engine/context-policy";
import { DEFAULT_MODELS } from "../src/config";

const TEST_CONTEXT_POLICY: ContextPolicyCfg = {
  sweetSpotPct: 0.65, checkpointPct: 0.8, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70,
  emergencyPct: 0.85,
  maxTurns: 200,
  maxAgeMs: 7 * 24 * 3600 * 1000,
  handoffTimeoutMs: 180_000,
  staleResumePct: 0.35,
  cacheTtlFallbackMs: 3_600_000,
  cacheTtlMinObservations: 5,
};

test("resolveProject finds a folder by name under root or by absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  expect(resolveProject("eticket-v3", root)).toBe(join(root, "eticket-v3"));
  expect(resolveProject(join(root, "eticket-v3"), root)).toBe(join(root, "eticket-v3"));
  expect(resolveProject("nope", root)).toBeUndefined();
});

test("resolveProject resolves a desk name (research, dev, …), projects winning ties", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-root-"));
  const desks = mkdtempSync(join(tmpdir(), "neo-desks-"));
  mkdirSync(join(desks, "research"));
  expect(resolveProject("research", root, desks)).toBe(join(desks, "research")); // no project → desk
  mkdirSync(join(root, "research"));
  expect(resolveProject("research", root, desks)).toBe(join(root, "research")); // a real project wins
});

function makeDeps() {
  const replies: Array<{ text: string; project?: string; priority?: string }> = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, project, priority) => void replies.push({ text, project, priority }),
    askApproval: async () => "deny",
  };
  return { d, replies };
}

test("dispatch returns immediately while the sub-run is still going", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let interrupted = false;
  const never = new Promise<RunResult>(() => {});
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => { interrupted = true; }, done: never });
  const out = await dispatchToProject("eticket-v3", "report docker status", d, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
  });
  expect(out).toContain("dispatched to");
  expect(interrupted).toBe(false); // still running in the background — not awaited, not killed
});

test("dispatch records dispatch_start then dispatch_end in the event log", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const done = Promise.resolve<RunResult>({ ok: true, sessionId: "s9", summary: "all green", costUsd: 0.02 });
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done });
  await dispatchToProject("eticket-v3", "task", d, 1, { start: fakeStart as never, now: () => 1000, root });
  await new Promise((r) => setTimeout(r, 10)); // let the background continuation settle
  const kinds = d.ledger.listEvents({ limit: 50 }).map((e) => e.kind);
  expect(kinds).toContain("dispatch_start");
  expect(kinds).toContain("dispatch_end");
  const end = d.ledger.listEvents({ kind: "dispatch_end" })[0];
  expect(end.data).toMatchObject({ ok: true, timedOut: false });
  expect(end.folder).toBe(join(root, "eticket-v3"));
});

test("dispatch tags its final line: DONE on success, ALERT on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  // success → the completion line is tagged result: a finished background job is an important
  // outcome, so it routes to the unmuted Decisions group (✅ accent added by the frontend, Feature 2)
  {
    const { d, replies } = makeDeps();
    const done = Promise.resolve<RunResult>({ ok: true, sessionId: "s1", summary: "all green", costUsd: 0 });
    const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done });
    await dispatchToProject("eticket-v3", "t", d, 1, { start: fakeStart as never, now: () => 0, root });
    await new Promise((r) => setTimeout(r, 10));
    const finished = replies.find((r) => r.text.includes("finished"));
    expect(finished?.priority).toBe("result");
  }
  // failure → the completion line is tagged alert (an ALERT surfaces on the Decisions channel)
  {
    const { d, replies } = makeDeps();
    const done = Promise.resolve<RunResult>({ ok: false, sessionId: "s2", summary: "boom", costUsd: 0 });
    const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done });
    await dispatchToProject("eticket-v3", "t", d, 1, { start: fakeStart as never, now: () => 0, root });
    await new Promise((r) => setTimeout(r, 10));
    const failed = replies.find((r) => r.text.includes("boom"));
    expect(failed?.priority).toBe("alert");
  }
});

test("a refused dispatch (unknown project) records dispatch_refused with reason not_found", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const { d } = makeDeps();
  await dispatchToProject("nope", "task", d, 1, { root, now: () => 0 });
  const ev = d.ledger.listEvents({ kind: "dispatch_refused" })[0];
  expect(ev.data).toMatchObject({ project: "nope", reason: "not_found" });
});

// The other half of the interactive reserve: background work is exactly what the reserve caps.
// Before this, dispatch never consulted the meter at all, so background dispatches kept starting
// while over budget — and the operator got throttled instead. See docs/adr/0001-*.md.
test("a loop-originated (background) dispatch IS held when spend is over the interactive reserve", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  d.meter = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // background allowance $8
  d.meter.note({ costUsd: 42 });
  let started = false;
  const fakeStart = () => {
    started = true;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };

  const out = await dispatchToProject("eticket-v3", "task", d, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    workClass: "background",
  });

  expect(started).toBe(false);
  expect(out.toLowerCase()).toContain("hold");
  const ev = d.ledger.listEvents({ kind: "dispatch_refused" })[0];
  expect(ev.data).toMatchObject({ project: "eticket-v3", reason: "budget", workClass: "background" });
});

// The ADR 0001 follow-up: work class follows the ORIGINATING TRIGGER, not the mechanism. The
// company's `dispatch` tool is one hop from the operator's own message, so a dispatch it makes
// while servicing that message is the operator's turn continuing — the reserve is held FOR it and
// must never hold it. Same meter, same usage, opposite answer from the loop-originated case above.
test("an operator-originated (interactive) dispatch starts at the SAME usage that holds a background one", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  d.meter = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // background allowance $8
  d.meter.note({ costUsd: 42 }); // …spent 5× over
  let started = false;
  const fakeStart = () => {
    started = true;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };

  const out = await dispatchToProject("eticket-v3", "task", d, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    workClass: "interactive",
  });

  expect(started).toBe(true);
  expect(out).toContain("dispatched to");
  expect(d.ledger.listEvents({ kind: "dispatch_refused" })).toHaveLength(0);
});

test("a dispatch that states no class is treated as background (fail-safe default)", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  d.meter = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 });
  d.meter.note({ costUsd: 42 });

  const out = await dispatchToProject("eticket-v3", "task", d, 1, { now: () => 0, root });

  expect(out.toLowerCase()).toContain("hold");
});

test("dispatch events carry the work class, so spend can later be split interactive vs background", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const done = Promise.resolve<RunResult>({ ok: true, sessionId: "s9", summary: "done", costUsd: 0.42 });
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done });

  await dispatchToProject("eticket-v3", "task", d, 1, {
    start: fakeStart as never,
    now: () => 1000,
    root,
    workClass: "interactive",
  });
  await new Promise((r) => setTimeout(r, 10)); // let the background continuation settle

  expect(d.ledger.listEvents({ kind: "dispatch_start" })[0].data).toMatchObject({ workClass: "interactive" });
  expect(d.ledger.listEvents({ kind: "dispatch_end" })[0].data).toMatchObject({ workClass: "interactive", costUsd: 0.42 });
});

// Inheritance: the class is decided ONCE, when the worker that owns the `dispatch` tool is
// launched, and every dispatch that worker makes inherits it. Both cases use an over-budget meter
// and a folder whose session is mid-turn, so the brief queues instead of starting a real worker —
// the ONLY difference is the class the session was launched with.
test("the dispatch tool inherits the work class its session was launched with", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));

  const busyDeps = (): DispatchDeps => {
    const { d } = makeDeps();
    d.workRoot = root;
    d.meter = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 });
    d.meter.note({ costUsd: 42 }); // over the background allowance
    const live = d.registry.add({ id: "d1", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: -2, createdAt: 0 }, 0);
    d.registry.setStatus(live.id, "running");
    d.registry.attachControl(live.id, { followUp: () => {}, queued: () => 1, active: () => true, interrupt: async () => {} });
    return d;
  };

  // An operator session (pipeline.ts) → its dispatches are interactive → past the reserve.
  const operator = busyDeps();
  const opTool = neoToolHandler(
    neoMcpServers(operator, 1, { dispatch: true, folder: "/home/neo/agent", workClass: "interactive" }),
    "dispatch",
  )!;
  const opOut = (await opTool({ project: "eticket-v3", task: "ship it" }, {})).content[0].text ?? "";
  expect(opOut).toContain("queued"); // passed the budget gate (and queued behind the live turn)

  // A scheduler-fired session → its dispatches are background → held by the reserve.
  const scheduled = busyDeps();
  const bgTool = neoToolHandler(
    neoMcpServers(scheduled, 1, { dispatch: true, folder: "/home/neo/agent", workClass: "background" }),
    "dispatch",
  )!;
  const bgOut = (await bgTool({ project: "eticket-v3", task: "ship it" }, {})).content[0].text ?? "";
  expect(bgOut.toLowerCase()).toContain("hold");
});

test("a background dispatch still runs while spend is under the interactive reserve", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  d.meter = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 });
  d.meter.note({ costUsd: 1 });
  let started = false;
  const fakeStart = () => {
    started = true;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };

  await dispatchToProject("eticket-v3", "task", d, 1, { start: fakeStart as never, now: () => 0, root });

  expect(started).toBe(true);
});

test("a queued-behind-busy dispatch records dispatch_queued (a turn is in flight)", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const first = d.registry.add({ id: "d1", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: -2, createdAt: 0 }, 0);
  d.registry.setStatus(first.id, "running");
  // A turn IS being processed right now (active) → the brief queues behind it, not delivered-idle.
  d.registry.attachControl(first.id, { followUp: () => {}, queued: () => 1, active: () => true, interrupt: async () => {} });
  await dispatchToProject("eticket-v3", "run docker ps", d, 1, {
    start: (() => {
      throw new Error("no start");
    }) as never,
    root,
    now: () => 0,
  });
  expect(d.ledger.listEvents({ kind: "dispatch_queued" })).toHaveLength(1);
  expect(d.ledger.listEvents({ kind: "dispatch_delivered" })).toHaveLength(0);
});

test("dispatch to a running folder refuses instead of stacking", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  // register a session for the folder and mark it running, then dispatch again
  const first = d.registry.add(
    { id: "d1", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: -2, createdAt: 0 },
    0,
  );
  d.registry.setStatus(first.id, "running");
  d.registry.noteActivity(first.id, "running tests", 0); // what it's currently doing
  const out = await dispatchToProject("eticket-v3", "task", d, 1, {
    start: (() => {
      throw new Error("must not start");
    }) as never,
    root,
    now: () => 120_000,
  });
  // Not an opaque "busy": the company gets the REAL state so it can tell the operator + decide.
  // A registered session with no worker handle is `starting` (the engine is still preparing it) —
  // calling that "busy" is what made healthy projects read as broken.
  expect(out).toContain("starting");
  expect(out).toContain("running tests");
  expect(out).toContain("2m"); // how long it has been in this state
  expect(out).toContain("did NOT start a second run");
});

test("dispatch to a folder mid-turn QUEUES the brief (like an operator reply) instead of refusing", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const first = d.registry.add(
    { id: "d1", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: -2, createdAt: 0 },
    0,
  );
  d.registry.setStatus(first.id, "running");
  const followUps: string[] = [];
  // A live worker mid-turn (active) means dispatch must queue behind its turn, not refuse.
  d.registry.attachControl(first.id, {
    followUp: (t: string) => void followUps.push(t),
    queued: () => 1,
    active: () => true,
    interrupt: async () => {},
  });
  const out = await dispatchToProject("eticket-v3", "run docker ps and report", d, 1, {
    start: (() => {
      throw new Error("must not start a second run onto a live folder");
    }) as never,
    root,
    now: () => 0,
  });
  expect(followUps.length).toBe(1); // the brief was queued into the live session
  expect(followUps[0]).toContain("run docker ps and report");
  expect(out.toLowerCase()).toContain("queued");
});

test("dispatch to an idle-but-'running' session (no turn in flight) delivers the brief NOW, not queue-as-busy", async () => {
  // The bug: a live session's registry status stays "running" for its WHOLE lifetime (it flips back
  // to "idle" only when the whole run ends), so a session sitting idle BETWEEN turns still reads
  // "running". Deciding busy on that coarse signal parks a free project behind a false "busy". The
  // real signal is the control's active() — a turn genuinely in flight. Here active() is false.
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const first = d.registry.add(
    { id: "d1", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: -2, createdAt: 0 },
    0,
  );
  d.registry.setStatus(first.id, "running");
  const followUps: string[] = [];
  // Live control, but NO turn is being processed right now (active() === false).
  d.registry.attachControl(first.id, {
    followUp: (t: string) => void followUps.push(t),
    queued: () => 0,
    active: () => false,
    interrupt: async () => {},
  });
  const out = await dispatchToProject("eticket-v3", "run docker ps and report", d, 1, {
    start: (() => {
      throw new Error("must not start a second run onto a live folder");
    }) as never,
    root,
    now: () => 0,
  });
  expect(followUps.length).toBe(1); // delivered into the warm session — runs immediately
  expect(followUps[0]).toContain("run docker ps and report");
  expect(out.toLowerCase()).not.toContain("busy"); // it was idle — never report a false "busy"
  expect(out.toLowerCase()).not.toContain("queued"); // delivered now, not parked behind a turn
  // Recorded as an idle delivery, not a busy enqueue.
  expect(d.ledger.listEvents({ kind: "dispatch_delivered" })).toHaveLength(1);
  expect(d.ledger.listEvents({ kind: "dispatch_queued" })).toHaveLength(0);
});

test("background completion books the result and reports back to operator + company", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const replies: string[] = [];
  const companyFollowUps: string[] = [];
  // register the company as default with a live control
  const co = d.registry.add({ id: "co", source: "neo", folder: "/home/neo/agent", task: "hq", chatId: 1, createdAt: 0 }, 0);
  d.registry.setDefault(co.id);
  d.registry.attachControl(co.id, { followUp: (t) => void companyFollowUps.push(t), interrupt: async () => {} });
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => {
    resolveDone = res;
  });
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, done });
  await dispatchToProject("eticket-v3", "task", { ...d, reply: (_c, t) => void replies.push(t) }, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
  });
  resolveDone({ ok: true, sessionId: "sub-1", summary: "built the thing", costUsd: 0.02 });
  await new Promise((r) => setTimeout(r, 0)); // let the continuation run
  expect(replies.some((t) => t.includes("finished") && t.includes("built the thing"))).toBe(true);
  expect(companyFollowUps.some((t) => t.includes("[dispatch result]") && t.includes("built the thing"))).toBe(true);
});

// --- Liveness-based dispatch timeout (2026-07-08: 18 long builds in a row were killed by the
// fixed 15m wall clock; the timeout must protect against a HUNG worker, not a busy one). ---

test("a silent sub-run is aborted by the STALL limit and the result names the stall", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let interrupted = false;
  const fakeStart = () => ({
    followUp: () => {},
    queued: () => 0,
    interrupt: async () => {
      interrupted = true;
    },
    done: new Promise<RunResult>(() => {}),
  });
  const replies: string[] = [];
  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, dispatchStallMs: 10, dispatchGraceMs: 5, reply: (_c, t) => void replies.push(t) },
    1,
    { start: fakeStart as never, root },
  );
  await new Promise((r) => setTimeout(r, 80));
  expect(interrupted).toBe(true);
  expect(replies.some((t) => t.includes("timed out") && t.includes("stall"))).toBe(true);
});

test("a BUSY sub-run (streaming activity) is NOT stall-aborted even long past the stall window", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let interrupted = false;
  let handlers: RunHandlers | undefined;
  const fakeStart = (_o: Order, h: RunHandlers) => {
    handlers = h;
    return {
      followUp: () => {},
      queued: () => 0,
      interrupt: async () => {
        interrupted = true;
      },
      done: new Promise<RunResult>(() => {}),
    };
  };
  await dispatchToProject(
    "eticket-v3",
    "long build",
    { ...d, dispatchStallMs: 200, dispatchGraceMs: 20 },
    1,
    { start: fakeStart as never, root },
  );
  // Keep the worker "busy": activity every 20ms, an order of magnitude inside the 200ms stall
  // window. (The margin is deliberate — at 5ms/20ms a single event-loop hiccup under a full-suite
  // run false-failed this test.)
  const beat = setInterval(() => handlers?.onActivity?.("Bash"), 20);
  await new Promise((r) => setTimeout(r, 700)); // 3.5x the stall window
  clearInterval(beat);
  expect(interrupted).toBe(false);
});

// --- BUG 1 (2026-07-17): a worker actively producing a large file / long model turn was
// stall-aborted with "no activity for 5m" and the write died with "Stream closed". The stall clock
// was only bumped on COMPLETED assistant/result turns; one long generation streams partial deltas
// (stream_event) but no completed turn, so it looked like silence. Genuine streamed progress must
// reset the clock; only TRUE silence (no SDK events at all) may abort. ---

test("a sub-run emitting a steady drip of partial stream_events (one long generation) is NOT stall-aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let interrupted = false;
  let stopped = false;
  // Real SDK-shaped stream: after init, emit ONLY partial stream_event deltas (a single long
  // generation, e.g. writing a huge plan file) — never a completed assistant/result turn — spaced
  // well inside the stall window, for several stall windows' worth of time.
  const q = (_args: { prompt: AsyncIterable<unknown>; options: unknown }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sub-1" };
      while (!stopped) {
        yield { type: "stream_event", event: { type: "content_block_delta" }, session_id: "sub-1" };
        await new Promise((r) => setTimeout(r, 20)); // 20ms gap << 200ms stall window
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        interrupted = true;
      },
    });
  };
  const start = (o: Order, h: RunHandlers, dd?: Record<string, unknown>) => startOrder(o, h, { ...dd, query: q as never });
  await dispatchToProject(
    "eticket-v3",
    "write a huge plan file",
    { ...d, dispatchStallMs: 200, dispatchGraceMs: 20 },
    1,
    { start: start as never, root },
  );
  await new Promise((r) => setTimeout(r, 700)); // 3.5x the stall window, while deltas keep dripping
  expect(interrupted).toBe(false); // busy generating → never falsely stall-aborted
  stopped = true; // let the fake stream end so no timer outlives the test
});

test("a sub-run that goes truly silent after init IS stall-aborted after the grace window", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let interrupted = false;
  // init, then GENUINE silence — no further SDK events at all (a hung worker).
  const q = (_args: { prompt: AsyncIterable<unknown>; options: unknown }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sub-1" };
      await new Promise(() => {}); // hang forever — true silence
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        interrupted = true;
      },
    });
  };
  const start = (o: Order, h: RunHandlers, dd?: Record<string, unknown>) => startOrder(o, h, { ...dd, query: q as never });
  const replies: string[] = [];
  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, dispatchStallMs: 20, dispatchGraceMs: 5, reply: (_c, t) => void replies.push(t) },
    1,
    { start: start as never, root },
  );
  await new Promise((r) => setTimeout(r, 120));
  expect(interrupted).toBe(true);
  expect(replies.some((t) => t.includes("timed out") && t.includes("stall"))).toBe(true);
});

test("on timeout the worker first gets a wrap-up follow-up, and finishing within the grace window keeps its result", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let interrupted = false;
  const followUps: string[] = [];
  let resolveDone!: (r: RunResult) => void;
  const fakeStart = () => ({
    followUp: (t: string) => {
      followUps.push(t);
      // the worker "wraps up" when told: commit + WIP note, then finish within the grace window
      setTimeout(() => resolveDone({ ok: true, sessionId: "sub-1", summary: "committed green work + WIP note", costUsd: 0 }), 5);
    },
    queued: () => 0,
    interrupt: async () => {
      interrupted = true;
    },
    done: new Promise<RunResult>((res) => {
      resolveDone = res;
    }),
  });
  const replies: string[] = [];
  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, dispatchStallMs: 10, dispatchGraceMs: 200, reply: (_c, t) => void replies.push(t) },
    1,
    { start: fakeStart as never, root },
  );
  await new Promise((r) => setTimeout(r, 120));
  expect(followUps.some((t) => t.toLowerCase().includes("commit") && t.toLowerCase().includes("wip"))).toBe(true);
  expect(interrupted).toBe(false); // wrapped up gracefully — never hard-aborted
  expect(replies.some((t) => t.includes("finished") && t.includes("committed green work"))).toBe(true);
});

test("dispatching twice to the same folder reuses one registry entry (no '<name>-2' duplicate)", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const fakeStart = () => {
    const done = Promise.resolve<RunResult>({ ok: true, sessionId: "sub-1", summary: "done", costUsd: 0 });
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done };
  };
  await dispatchToProject("eticket-v3", "first task", d, 1, { start: fakeStart as never, now: () => 0, root });
  await new Promise((r) => setTimeout(r, 0)); // let the continuation settle -> status idle

  await dispatchToProject("eticket-v3", "second task", d, 1, { start: fakeStart as never, now: () => 1, root });
  await new Promise((r) => setTimeout(r, 0));

  const forFolder = d.registry.list().filter((s) => s.order.folder === join(root, "eticket-v3"));
  expect(forFolder).toHaveLength(1);
  expect(forFolder[0].name).toBe("eticket-v3"); // never "eticket-v3-2"
});

test("a timed-out dispatch is removed from the registry, and the next dispatch reuses the base name (no zombie accumulation)", async () => {
  // Regression (2026-07-08): 18 sequential dispatches to one project each hit the dispatch limit,
  // were left as status:"error" zombies, and every retry registered "<name>-N".
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "waselni"));
  const { d } = makeDeps();
  const hangingStart = () => ({
    followUp: () => {},
    queued: () => 0,
    interrupt: async () => {},
    done: new Promise<RunResult>(() => {}),
  });
  const fast = { ...d, dispatchStallMs: 5, dispatchGraceMs: 5 };
  await dispatchToProject("waselni", "task 1", fast, 1, { start: hangingStart as never, root });
  await new Promise((r) => setTimeout(r, 60)); // let the timeout + grace fire and bookkeeping settle

  expect(d.registry.list().filter((s) => s.order.folder === join(root, "waselni"))).toHaveLength(0);

  await dispatchToProject("waselni", "task 2", fast, 1, { start: hangingStart as never, root });
  await new Promise((r) => setTimeout(r, 60));
  await dispatchToProject("waselni", "task 3", fast, 1, { start: hangingStart as never, root });

  const forFolder = d.registry.list().filter((s) => s.order.folder === join(root, "waselni"));
  expect(forFolder).toHaveLength(1); // only the live third run
  expect(forFolder[0].name).toBe("waselni"); // never "waselni-2"
});

test("dispatchToProject reports a clear error for an unknown project (and never runs)", async () => {
  const { d } = makeDeps();
  const out = await dispatchToProject("ghost", "do x", d, 99, {
    run: (async () => {
      throw new Error("should not run");
    }) as never,
    root: "/nonexistent",
  });
  expect(out.toLowerCase()).toContain("no project");
});

test("sendProjectFile sends a file inside the folder and refuses one outside it", async () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-send-"));
  writeFileSync(join(folder, "report.txt"), "ok");
  const sent: Array<{ path: string; caption?: string }> = [];
  const deps = { sendFile: (_c: number, path: string, caption?: string) => void sent.push({ path, caption }) };

  const ok = await sendProjectFile(deps, 1, folder, "report.txt", "here");
  expect(ok).toContain("sent");
  expect(sent[0].path).toBe(join(folder, "report.txt"));

  const bad = await sendProjectFile(deps, 1, folder, "../escape.txt");
  expect(bad).toContain("outside");
  expect(sent.length).toBe(1); // not sent
});

test("neoMcpServers attaches the Stitch HTTP server only when enabled AND a key is set (operator path)", () => {
  const { d } = makeDeps();
  const servers = neoMcpServers(d, 1, { dispatch: true, folder: "/home/neo/agent", stitch: true, stitchKey: "k-123" });
  expect(servers.neo).toBeDefined(); // the in-process server is always present
  const stitch = servers.stitch as { type: string; url: string; headers: Record<string, string> };
  expect(stitch).toBeDefined();
  expect(stitch.type).toBe("http"); // SDK McpHttpServerConfig shape
  expect(stitch.url).toBe(STITCH_MCP_URL);
  expect(stitch.url).toBe("https://stitch.googleapis.com/mcp");
  expect(stitch.headers["X-Goog-Api-Key"]).toBe("k-123");
});

test("neoMcpServers OMITS Stitch on the customer path (stitch:false) and when no key is configured", () => {
  const { d } = makeDeps();
  // customer/ingress path: stitch flag off → never attached, even with a key present
  expect(neoMcpServers(d, 1, { dispatch: true, folder: "/x", stitch: false, stitchKey: "k-123" }).stitch).toBeUndefined();
  // operator path but no key configured → nothing to attach
  expect(neoMcpServers(d, 1, { dispatch: true, folder: "/x", stitch: true, stitchKey: "" }).stitch).toBeUndefined();
  // default (no stitch opts) → off
  expect(neoMcpServers(d, 1, { dispatch: false, folder: "/x" }).stitch).toBeUndefined();
});

test("neoMcpServers attaches the codebase-memory stdio server when its bin is set (operator path)", () => {
  const { d } = makeDeps();
  const servers = neoMcpServers(d, 1, {
    dispatch: true,
    folder: "/home/neo/agent",
    codebaseMemoryBin: "/root/.local/bin/codebase-memory-mcp",
  });
  const mem = servers["codebase-memory"] as { type: string; command: string; args: string[] };
  expect(mem.type).toBe("stdio");
  expect(mem.command).toBe("/root/.local/bin/codebase-memory-mcp");
  expect(mem.args).toEqual([]);
});

test("neoMcpServers OMITS codebase-memory on the customer path (bin unset)", () => {
  const { d } = makeDeps();
  // customer/ingress path passes no bin → never attached
  const servers = neoMcpServers(d, 1, { dispatch: true, folder: "/x" });
  expect(servers["codebase-memory"]).toBeUndefined();
  // empty string bin → skipped
  expect(neoMcpServers(d, 1, { dispatch: true, folder: "/x", codebaseMemoryBin: "" })["codebase-memory"]).toBeUndefined();
});

// --- Problem 1: deterministic routing — the engine guarantees a valid, in-/home target and that
// the sub-session only ever receives the crafted brief (never the operator's raw message). ---

test("resolveProject rejects an existing directory OUTSIDE the allowed roots (no /etc, /root escapes)", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-root-"));
  // /etc exists and is a directory, but it is not under root nor a desk → must NOT resolve.
  expect(resolveProject("/etc", root)).toBeUndefined();
  // a relative name that traverses out of root resolves outside → rejected too.
  expect(resolveProject("../../../../etc", root)).toBeUndefined();
});

test("dispatchToProject refuses an out-of-tree absolute path and never runs it", async () => {
  const { d } = makeDeps();
  let ran = false;
  const out = await dispatchToProject("/etc", "exfiltrate", d, 99, {
    run: (async () => {
      ran = true;
      throw new Error("should not run");
    }) as never,
    root: mkdtempSync(join(tmpdir(), "neo-root-")),
  });
  expect(out.toLowerCase()).toContain("no project");
  expect(ran).toBe(false);
});

test("dispatchToProject sends ONLY the crafted brief to the sub-session (isolation), never raw text", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let seen: Order | undefined;
  const fakeStart = (o: Order) => {
    seen = o;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "CRAFTED BRIEF for the project", d, 99, {
    start: fakeStart as never,
    now: () => 1,
    root,
  });
  // the crafted brief verbatim (never the operator's raw text), preceded only by the docs preamble
  expect(seen!.task.endsWith("CRAFTED BRIEF for the project")).toBe(true);
  expect(seen!.task).toBe(briefWithProjectDocs("CRAFTED BRIEF for the project"));
  expect(seen!.chatId).toBe(-2); // SUB_CHAT — isolated from the operator's routing
});

test("preamble wires the two-phase design→build flow: domain-modeling (CONTEXT.md/ADR) before superpowers TDD", () => {
  const brief = briefWithProjectDocs("X");
  // Design phase: the mattpocock design skills adopted 2026-09-10 (model-invocable only).
  expect(brief).toContain("domain-modeling");
  expect(brief).toContain("CONTEXT.md");
  expect(brief).toContain("codebase-design");
  // Ordering language: design/model first, THEN build.
  expect(brief.indexOf("domain-modeling")).toBeLessThan(brief.indexOf("test-driven-development"));
  // The interactive-only slash-command skills must NOT be told to workers (disable-model-invocation).
  expect(brief).not.toContain("grill-with-docs");
  expect(brief).not.toContain("to-tickets");
});

const MEMORY_CFG = {
  scopes: [] as string[],
  snapshotMaxPct: 0.004,
  userMaxPct: 0.0025,
  dreamMaxMutations: 3,
  dreamMaxAdds: 1,
  dreamMaxNetChars: 250,
  dreamLookbackDays: 14,
};

test("memory: default config (scopes: []) never injects the snapshot, even with a leftover memory/MEMORY.md", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const projectDir = join(root, "eticket-v3");
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, "memory"));
  writeFileSync(join(projectDir, "memory", "MEMORY.md"), "§ leftover fact from a previous scope");
  const { d } = makeDeps();
  let seen: Order | undefined;
  const fakeStart = (o: Order) => {
    seen = o;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject(
    "eticket-v3",
    "CRAFTED BRIEF for the project",
    { ...d, memory: MEMORY_CFG, companyFolder: "/tmp/agent" },
    99,
    { start: fakeStart as never, now: () => 1, root },
  );
  expect(seen!.task).not.toContain("[MEMORY — authoritative");
  expect(seen!.task).toBe(briefWithProjectDocs("CRAFTED BRIEF for the project")); // byte-identical to today
});

test("memory: folder in scope (absolute path) gets the snapshot prepended before the preamble", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const projectDir = join(root, "eticket-v3");
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, "memory"));
  writeFileSync(join(projectDir, "memory", "MEMORY.md"), "§ Working on the payments migration");
  const { d } = makeDeps();
  let seen: Order | undefined;
  const fakeStart = (o: Order) => {
    seen = o;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject(
    "eticket-v3",
    "CRAFTED BRIEF for the project",
    { ...d, memory: { ...MEMORY_CFG, scopes: [projectDir] }, companyFolder: "/tmp/agent" },
    99,
    { start: fakeStart as never, now: () => 1, root },
  );
  expect(seen!.task.startsWith("[MEMORY — authoritative")).toBe(true);
  expect(seen!.task).toContain("Working on the payments migration");
  expect(seen!.task.endsWith(briefWithProjectDocs("CRAFTED BRIEF for the project"))).toBe(true);
});

test("memory: \"company\" scope does NOT leak into a dispatch to a different folder with a leftover memory dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const projectDir = join(root, "eticket-v3");
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, "memory"));
  writeFileSync(join(projectDir, "memory", "MEMORY.md"), "§ leftover fact");
  const { d } = makeDeps();
  let seen: Order | undefined;
  const fakeStart = (o: Order) => {
    seen = o;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject(
    "eticket-v3",
    "CRAFTED BRIEF for the project",
    { ...d, memory: { ...MEMORY_CFG, scopes: ["company"] }, companyFolder: "/tmp/agent" }, // company != projectDir
    99,
    { start: fakeStart as never, now: () => 1, root },
  );
  expect(seen!.task).not.toContain("[MEMORY — authoritative");
  expect(seen!.task).toBe(briefWithProjectDocs("CRAFTED BRIEF for the project"));
});

test("memory: a repeat dispatch that RESUMES an already-open sub-session does NOT re-inject the frozen snapshot (no stacking mid-conversation)", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const projectDir = join(root, "eticket-v3");
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, "memory"));
  writeFileSync(join(projectDir, "memory", "MEMORY.md"), "§ Working on the payments migration");
  const { d } = makeDeps();
  // A prior dispatch already left this folder's sub-session open+idle (resumable) in the registry.
  const priorOrder: Order = { id: "prior", source: "neo", folder: projectDir, task: "prior brief", chatId: SUB_CHAT, createdAt: 0 };
  const existing = d.registry.add(priorOrder, 0);
  d.registry.setSdkSessionId(existing.id, "sdk-existing-session");
  d.registry.setStatus(existing.id, "idle");

  let seen: Order | undefined;
  const fakeStart = (o: Order) => {
    seen = o;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject(
    "eticket-v3",
    "CRAFTED BRIEF for the project",
    { ...d, memory: { ...MEMORY_CFG, scopes: [projectDir] }, companyFolder: "/tmp/agent" },
    99,
    { start: fakeStart as never, now: () => 1, root },
  );
  expect(seen!.task).not.toContain("[MEMORY — authoritative");
  expect(seen!.task).toBe(briefWithProjectDocs("CRAFTED BRIEF for the project")); // resume → byte-identical, no snapshot
});

test("memory: the ledger's recorded order stays in sync — no snapshot recorded for a refused/resumed dispatch, present once the context-policy gate CLEARS a stale resume back to a fresh start", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const projectDir = join(root, "eticket-v3");
  mkdirSync(projectDir);
  mkdirSync(join(projectDir, "memory"));
  writeFileSync(join(projectDir, "memory", "MEMORY.md"), "§ Working on the payments migration");
  const { d } = makeDeps();
  const priorOrder: Order = { id: "prior", source: "neo", folder: projectDir, task: "prior brief", chatId: SUB_CHAT, createdAt: 0 };
  const existing = d.registry.add(priorOrder, 0);
  d.registry.setSdkSessionId(existing.id, "sdk-existing-session");
  d.registry.setStatus(existing.id, "idle");

  let seen: Order | undefined;
  const fakeStart = (o: Order) => {
    seen = o;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject(
    "eticket-v3",
    "CRAFTED BRIEF for the project",
    { ...d, memory: { ...MEMORY_CFG, scopes: [projectDir] }, companyFolder: "/tmp/agent", contextPolicy: TEST_CONTEXT_POLICY },
    99,
    {
      start: fakeStart as never,
      now: () => 1,
      root,
      // Forces decideContext → "clear": the stale resume is dropped, so this becomes a genuine
      // fresh start again, and the snapshot IS re-injected.
      signals: () => ({ occupancy: 0.9, turns: 0, ageMs: 0, idleMs: 0 }),
    },
  );
  expect(seen!.task.startsWith("[MEMORY — authoritative")).toBe(true);
  expect(seen!.task).toContain("Working on the payments migration");
});

// The in-process "neo" server is an SDK McpServer instance (createSdkMcpServer), not a plain
// tools array — its registered tool names live on the private-in-TS-but-public-at-runtime
// `_registeredTools` map, the only way to assert presence/absence without going through the full
// MCP wire protocol.
function neoToolNames(servers: Record<string, unknown>): string[] {
  const neo = servers.neo as { instance: { _registeredTools: Record<string, unknown> } };
  return Object.keys(neo.instance._registeredTools);
}

/** Pull a `tool()`-built handler off the in-process "neo" MCP server so a test can invoke it directly. */
function neoToolHandler(
  servers: Record<string, unknown>,
  toolName: string,
): ((args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>) | undefined {
  const neo = servers.neo as { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }> } };
  return neo.instance._registeredTools[toolName]?.handler;
}

test("neoMcpServers attaches memory + memory_search when the memory gate is open (scope enabled + folder matches)", () => {
  const { d } = makeDeps();
  const servers = neoMcpServers(
    { ...d, memory: { ...MEMORY_CFG, scopes: ["/home/neo/agent"] }, companyFolder: "/tmp/agent" },
    1,
    { dispatch: true, folder: "/home/neo/agent" },
  );
  const names = neoToolNames(servers);
  expect(names).toContain("memory");
  expect(names).toContain("memory_search");
});

test("neoMcpServers OMITS memory tools for the ingress-style opts (no memory/companyFolder deps at all)", () => {
  const { d } = makeDeps();
  // d has no `memory`/`companyFolder` set — mirrors the customer/ingress path, which never passes them.
  const servers = neoMcpServers(d, 1, { dispatch: true, folder: "/home/neo/agent" });
  const names = neoToolNames(servers);
  expect(names).not.toContain("memory");
  expect(names).not.toContain("memory_search");
});

test("neoMcpServers OMITS memory tools when memory is configured but scopes: [] (feature off) or the folder is out of scope", () => {
  const { d } = makeDeps();
  const offByDefault = neoMcpServers(
    { ...d, memory: MEMORY_CFG, companyFolder: "/tmp/agent" }, // scopes: []
    1,
    { dispatch: true, folder: "/home/neo/agent" },
  );
  expect(neoToolNames(offByDefault)).not.toContain("memory");

  const outOfScope = neoMcpServers(
    { ...d, memory: { ...MEMORY_CFG, scopes: ["/some/other/folder"] }, companyFolder: "/tmp/agent" },
    1,
    { dispatch: true, folder: "/home/neo/agent" },
  );
  expect(neoToolNames(outOfScope)).not.toContain("memory");
});

test("ask_operator attaches on operator paths ONLY when postDecision is wired (firewall)", () => {
  const { d } = makeDeps();
  // No postDecision → not attached (the customer/ingress path never wires it).
  expect(neoToolNames(neoMcpServers(d, 1, { dispatch: false, folder: "/home/acme" }))).not.toContain("ask_operator");
  // postDecision present → attached, regardless of the dispatch flag (all operator project workers).
  const withPost = { ...d, postDecision: async () => ({ chatId: 7, messageId: 8 }) };
  expect(neoToolNames(neoMcpServers(withPost, 1, { dispatch: false, folder: "/home/acme" }))).toContain("ask_operator");
  expect(neoToolNames(neoMcpServers(withPost, 1, { dispatch: true, folder: "/home/acme" }))).toContain("ask_operator");
});

// A fully-matured decision the worker raises: one title, the problem/root cause, options that each
// explain what they mean + their trade-off, and a recommendation. This is the shape the operator
// asked for (no more bundled, contextless, bare-label "patch menus").
const MATURED_ARGS = {
  title: "Fix the log-ingestion consumer",
  context:
    "Vector is deployed but not consuming: the JetStream consumer was never created, so logs queue and drop after retention. Root cause is missing consumer wiring, not Vector.",
  options: [
    { label: "Redeploy Vector", detail: "quickest; but does not create the missing consumer, so ingestion still fails" },
    { label: "JetStream + consumer", detail: "create the durable consumer Vector reads from; fixes the root cause with existing infra", recommended: true },
    { label: "Dedicated Go consumer", detail: "most control; a new service to own and deploy" },
  ],
  recommendation: "JetStream + consumer — fixes the root cause with infra we already run, no new service to maintain.",
};

test("ask_operator matures the question: ONE tracked decision carrying title/context/options+details/recommendation", async () => {
  const { d } = makeDeps();
  const posted: Array<{ id: string; question: string; options?: string[]; spec?: StructuredAsk }> = [];
  const deps: DispatchDeps = {
    ...d,
    postDecision: async (rec, question, options, spec) => {
      posted.push({ id: rec.id, question, options, spec });
      return { chatId: 222, messageId: 900 };
    },
  };
  const servers = neoMcpServers(deps, 1, { dispatch: false, folder: "/home/acme", projectName: "acme", orderId: "ord-1" });
  const handler = neoToolHandler(servers, "ask_operator")!;
  const res = await handler(MATURED_ARGS, {});

  // One open decision, carrying the project/folder/order; the crisp title is the row's `question`,
  // the rich content (context, per-option details, recommendation) rides on the structured spec.
  const open = d.ledger.listOpenDecisions();
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ kind: "decision", project: "acme", folder: "/home/acme", orderId: "ord-1" });
  expect(open[0]!.question).toBe(MATURED_ARGS.title);
  const spec = open[0]!.spec!;
  expect(spec.title).toBe(MATURED_ARGS.title);
  expect(spec.context).toBe(MATURED_ARGS.context);
  expect(spec.recommendation).toBe(MATURED_ARGS.recommendation);
  expect(spec.questions[0]!.options).toEqual(["Redeploy Vector", "JetStream + consumer", "Dedicated Go consumer"]);
  expect(spec.questions[0]!.optionDetails?.[1]).toContain("durable consumer");
  expect(spec.questions[0]!.recommended).toBe(1);
  // Posted to the Decisions channel WITH the spec (not the flat options); message id captured back.
  expect(posted).toHaveLength(1);
  expect(posted[0]!.spec).toEqual(spec);
  expect(d.ledger.decisionByMessage(222, 900)?.id).toBe(open[0]!.id);
  expect(d.ledger.listEvents({ kind: "decision_raised" })).toHaveLength(1);
  // The worker is told to checkpoint + stop (single-shot; the answer resumes it as a follow-up).
  expect(res.content[0]?.text?.toLowerCase()).toContain("stop");
});

test("ask_operator honours multiSelect and a distinct crisp question", async () => {
  const { d } = makeDeps();
  const deps: DispatchDeps = { ...d, postDecision: async () => ({ chatId: 5, messageId: 6 }) };
  const handler = neoToolHandler(neoMcpServers(deps, 1, { dispatch: false, folder: "/home/acme", projectName: "acme" }), "ask_operator")!;
  await handler({ ...MATURED_ARGS, question: "How should we fix ingestion?", multiSelect: true }, {});
  const spec = d.ledger.listOpenDecisions()[0]!.spec!;
  expect(spec.questions[0]!.question).toBe("How should we fix ingestion?");
  expect(spec.questions[0]!.multiSelect).toBe(true);
});

// The HARD guarantee: the schema makes a shapeless question impossible to raise. Invalid inputs are
// rejected at the tool boundary (Zod .parse), so a worker cannot bundle decisions or drop the
// context/options/recommendation — it is forced to re-ask in the matured shape.
test("ask_operator SCHEMA enforces the matured shape (shapeless questions rejected at the boundary)", () => {
  const { d } = makeDeps();
  const withPost = { ...d, postDecision: async () => ({ chatId: 7, messageId: 8 }) };
  const servers = neoMcpServers(withPost, 1, { dispatch: false, folder: "/home/acme" });
  const neo = servers.neo as { instance: { _registeredTools: Record<string, { inputSchema: { parse: (v: unknown) => unknown } }> } };
  const schema = neo.instance._registeredTools["ask_operator"]!.inputSchema;
  expect(() => schema.parse(MATURED_ARGS)).not.toThrow(); // a full matured decision validates
  expect(() => schema.parse({ question: "Which DB — Postgres or Mongo?" })).toThrow(); // old bare question
  expect(() => schema.parse({ question: "?", options: ["Postgres", "Mongo"] })).toThrow(); // flat string options
  expect(() => schema.parse({ ...MATURED_ARGS, options: [MATURED_ARGS.options[0]] })).toThrow(); // <2 options
  const { context: _c, ...noContext } = MATURED_ARGS;
  expect(() => schema.parse(noContext)).toThrow(); // root cause is required
  const { recommendation: _r, ...noRec } = MATURED_ARGS;
  expect(() => schema.parse(noRec)).toThrow(); // recommendation is required
  const bareOptions = { ...MATURED_ARGS, options: [{ label: "A" }, { label: "B" }] };
  expect(() => schema.parse(bareOptions)).toThrow(); // each option needs a detail (trade-off)
});

// The operator's rule (2026-09-03): questions raised via ask_operator were "shallow, patch-shaped,
// not standard." The tool DESCRIPTION must force the worker to challenge itself first — root-cause,
// standard fix (not a patch), self-critique — escalate only a genuine operator decision, ONE per call.
test("ask_operator description forces self-challenge + one-decision-per-call", () => {
  const { d } = makeDeps();
  const withPost = { ...d, postDecision: async () => ({ chatId: 7, messageId: 8 }) };
  const servers = neoMcpServers(withPost, 1, { dispatch: false, folder: "/home/acme" });
  const neo = servers.neo as { instance: { _registeredTools: Record<string, { description: string }> } };
  const desc = neo.instance._registeredTools["ask_operator"]!.description.toLowerCase();
  expect(desc).toContain("root cause"); // trace the real cause first
  expect(desc).toContain("industry-standard"); // the correct standard fix...
  expect(desc).toContain("patch"); // ...not the quickest patch
  expect(desc).toContain("do it and report"); // one right fix exists → don't ask
  expect(desc).toContain("one decision"); // one decision per call — never bundle several
});

test("the company `dispatch` MCP tool exposes an optional, enum-guarded `team` param (backward-compatible)", () => {
  const { d } = makeDeps();
  const servers = neoMcpServers(d, 1, { dispatch: true, folder: "/home/neo/agent" });
  const neo = servers.neo as {
    instance: { _registeredTools: Record<string, { inputSchema: { parse: (v: unknown) => unknown } }> };
  };
  const disp = neo.instance._registeredTools["dispatch"];
  expect(disp).toBeDefined();
  // team accepted when the operator asks for a team run
  expect(() => disp.inputSchema.parse({ project: "eticket-v3", task: "do x", team: "frontend-backend" })).not.toThrow();
  // team is optional → every existing caller (project + task only) still validates
  expect(() => disp.inputSchema.parse({ project: "eticket-v3", task: "do x" })).not.toThrow();
  // an unknown team value is rejected (enum guard — can't silently pass a bad flag through)
  expect(() => disp.inputSchema.parse({ project: "eticket-v3", task: "do x", team: "solo" })).toThrow();
});

test("a dispatched sub-session streams its TOOL ACTIVITY to the operator, tagged with the project name, and reports the final result on completion", async () => {
  // End-to-end: the real consumeStream (via startOrder) surfaces a tool milestone, which
  // dispatchToProject forwards to the operator's reply path tagged with the project name —
  // and the final result is reported back to the operator as a follow-up once the sub-run ends.
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = makeDeps();
  const q = () =>
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "docker ps" } }] } };
      yield { type: "result", subtype: "success", result: "3 containers up", total_cost_usd: 0, session_id: "sub-1" };
    })();
  const start = (o: Order, h: RunHandlers, dd?: Record<string, unknown>) => startOrder(o, h, { ...dd, query: q as never });

  const out = await dispatchToProject("eticket-v3", "check docker", d, 99, { start: start as never, now: () => 1, root });

  expect(out).toContain("dispatched to"); // returns immediately
  await new Promise((r) => setTimeout(r, 0)); // let the background continuation run
  expect(replies.some((r) => r.text.includes("Bash") && r.text.includes("docker ps") && r.project === "eticket-v3")).toBe(true);
  expect(replies.some((r) => r.text.includes("finished") && r.text.includes("3 containers up"))).toBe(true);
});

// --- Turn-boundary completion (2026-07-08 regression: the real SDK stream stays OPEN after the
// "result" message — the input channel never closes — so run.done never resolved on its own,
// every dispatch died as a false "stall" timeout, and the worker's real report was lost). A
// single-brief dispatch must treat a turn boundary with an empty follow-up queue as done. ---

test("dispatch detects sub-run completion at the turn boundary (open stream) instead of stall-timing out", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = makeDeps();
  let interrupted = false;
  // Real-SDK shape: the generator consumes the input channel and stays open after emitting the
  // turn's result, waiting for a next message that never comes.
  const q = (args: { prompt: AsyncIterable<{ message: { content: string } }>; options: unknown }) => {
    const gen = (async function* () {
      for await (const _m of args.prompt) {
        yield { type: "result", subtype: "success", result: "final report text", total_cost_usd: 0.01, session_id: "sub-1" };
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        interrupted = true;
      },
    });
  };
  const start = (o: Order, h: RunHandlers, dd?: Record<string, unknown>) => startOrder(o, h, { ...dd, query: q as never });
  await dispatchToProject(
    "eticket-v3",
    "single brief",
    { ...d, dispatchStallMs: 40, dispatchGraceMs: 10 },
    1,
    { start: start as never, root },
  );
  await new Promise((r) => setTimeout(r, 150)); // well past the stall window
  expect(replies.some((r) => r.text.includes("finished") && r.text.includes("final report text"))).toBe(true);
  expect(replies.some((r) => r.text.includes("timed out"))).toBe(false);
  expect(interrupted).toBe(false); // graceful close, never hard-aborted
  // success-path bookkeeping: session kept idle + resumable, sdk session id persisted
  const forFolder = d.registry.list().filter((s) => s.order.folder === join(root, "eticket-v3"));
  expect(forFolder).toHaveLength(1);
  expect(forFolder[0].status).toBe("idle");
  expect(forFolder[0].sdkSessionId).toBe("sub-1");
});

// --- context-policy gate on dispatch reuse (2026-07-08 finding: repeated dispatch into one
// folder must not resume a session forever without ever checking its context load). ---

test("dispatch with a 'clear' verdict drops resume, clears the ledger session, and records a clear event", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const folder = join(root, "eticket-v3");
  d.ledger.recordOrder({ id: "prev", source: "neo", folder, task: "x", chatId: SUB_CHAT, createdAt: 0 });
  d.ledger.recordSession("prev", "fat-session-id");
  const deps: DispatchDeps = { ...d, contextPolicy: TEST_CONTEXT_POLICY };
  let seenResume: string | undefined = "unset";
  const fakeStart = (_o: Order, _h: RunHandlers, dd?: { resume?: string }) => {
    seenResume = dd?.resume;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  const fakeSignals = (): ContextSignals => ({ occupancy: 0.9, turns: 5, ageMs: 0, idleMs: 0 }); // >= emergencyPct → clear
  await dispatchToProject("eticket-v3", "task", deps, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    signals: fakeSignals,
  });
  await new Promise((r) => setTimeout(r, 0)); // let the background continuation run the gate + start
  expect(seenResume).toBeUndefined();
  expect(d.ledger.lastSessionFor(folder, SUB_CHAT)).toBeUndefined();
});

test("dispatch with a 'handoff' verdict runs the handoff BEFORE start, and drops resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const folder = join(root, "eticket-v3");
  d.ledger.recordOrder({ id: "prev", source: "neo", folder, task: "x", chatId: SUB_CHAT, createdAt: 0 });
  d.ledger.recordSession("prev", "fat-session-id");
  const deps: DispatchDeps = { ...d, contextPolicy: TEST_CONTEXT_POLICY };
  const order: string[] = [];
  let seenResume: string | undefined = "unset";
  const fakeStart = (_o: Order, _h: RunHandlers, dd?: { resume?: string }) => {
    seenResume = dd?.resume;
    order.push("start");
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  const fakeSignals = (): ContextSignals => ({ occupancy: 0.7, turns: 5, ageMs: 0, idleMs: 0 }); // >= sweetSpotPct, < emergencyPct → handoff
  const fakeHandoff = async () => {
    order.push("handoff");
  };
  await dispatchToProject("eticket-v3", "task", deps, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    signals: fakeSignals,
    handoff: fakeHandoff as never,
  });
  await new Promise((r) => setTimeout(r, 0)); // let the background continuation run the gate + start
  expect(order).toEqual(["handoff", "start"]);
  expect(seenResume).toBeUndefined();
});

test("dispatch with a 'keep' verdict passes the prior resume id through unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const folder = join(root, "eticket-v3");
  d.ledger.recordOrder({ id: "prev", source: "neo", folder, task: "x", chatId: SUB_CHAT, createdAt: 0 });
  d.ledger.recordSession("prev", "fat-session-id");
  const deps: DispatchDeps = { ...d, contextPolicy: TEST_CONTEXT_POLICY };
  let seenResume: string | undefined;
  const fakeStart = (_o: Order, _h: RunHandlers, dd?: { resume?: string }) => {
    seenResume = dd?.resume;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  const fakeSignals = (): ContextSignals => ({ occupancy: 0.1, turns: 5, ageMs: 0, idleMs: 0 }); // well under sweetSpotPct → keep
  await dispatchToProject("eticket-v3", "task", deps, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    signals: fakeSignals,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(seenResume).toBe("fat-session-id");
});

// --- Project-docs preamble (2026-07-08: only CLAUDE.md auto-loads; AGENTS.md/DESIGN.md/docs never
// reach a dispatched worker unless the brief tells it to read them). ---

test("dispatch prepends a read-the-project-docs preamble to the brief", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let seenTask = "";
  const fakeStart = (o: Order) => {
    seenTask = o.task;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "report docker status", d, 1, { start: fakeStart as never, root });
  await new Promise((r) => setTimeout(r, 0));
  expect(seenTask).toContain("report docker status"); // the original brief survives verbatim
  expect(seenTask).toContain(".md"); // and is preceded by the docs-reading rule
  expect(seenTask.toLowerCase()).toContain("agents.md");
});

// --- BUG 2 (2026-07-17): the automatic dispatch preamble must ALSO tell the worker to query the
// codebase-memory MCP for a structural map before cold-reading files, and to use the superpowers
// skills — so the operator never has to add it by hand and it can't be omitted. ---

test("briefWithProjectDocs preamble requires codebase-memory + superpowers, states the engine indexed it, then the task verbatim", () => {
  const out = briefWithProjectDocs("DO THE WORK");
  expect(out.toLowerCase()).toContain("agents.md"); // read project docs (existing)
  expect(out).toContain("REQUIRED"); // MANDATORY, not optional
  expect(out.toLowerCase()).toContain("codebase-memory"); // structural map FIRST
  expect(out.toLowerCase()).toContain("already indexed"); // engine guarantees the map is ready
  expect(out.toLowerCase()).toContain("list_projects"); // look up the EXACT project name, don't guess it
  expect(out.toLowerCase()).toContain("superpowers"); // use the skills
  // Challenge-yourself-first mandate (2026-09-03): no shallow patch-menu decisions — the worker
  // must root-cause + reach for the standard fix + self-critique BEFORE raising anything.
  const low = out.toLowerCase();
  expect(low).toContain("root cause"); // trace the real cause, not the symptom
  expect(low).toContain("industry-standard"); // the correct standard fix...
  expect(low).toContain("patch"); // ...not the quickest patch
  // Liveness contract (2026-09-13 engine-bug fix): the stall detector sees only streamed activity, so
  // a worker that parks on a background wait/Monitor (or one long silent step) is killed though not
  // hung. The preamble must forbid background waits and require short foreground polling.
  expect(low).toContain("background wait"); // never park on a background wait...
  expect(low).toContain("monitor"); // ...or a Monitor
  expect(low).toContain("poll"); // poll instead
  expect(low).toContain("foreground"); // ...in short FOREGROUND steps
  expect(low).toContain("single-shot"); // finish within this run — not re-invoked later
  expect(out.endsWith("DO THE WORK")).toBe(true); // the brief is appended verbatim, last
});

// --- Engineering baseline (operator hard rule, 2026-09-18): non-standard code is a failure even
// when it works. The rule lives in this repo's CLAUDE.md, which a worker dispatched into ANOTHER
// folder never loads — so the preamble is the only place it can't be forgotten by whoever writes
// the brief (docs/adr/0002-engineering-baseline-lives-in-the-dispatch-preamble.md). ---

test("briefWithProjectDocs carries the engineering baseline: i18n · env/dev · Docker · no hardcoding · reuse", () => {
  const low = briefWithProjectDocs("DO THE WORK").toLowerCase();
  expect(low).toContain("not industry-standard"); // framed as a no-go, not a preference
  expect(low).toContain("i18n"); // 1. standard per-locale catalogues...
  expect(low).toContain("ar+en"); // ...complete in both languages
  expect(low).toContain(".env"); // 2. env + environments...
  expect(low).toContain("dev by default"); // ...fail closed to dev, never prod
  expect(low).toContain("docker"); // 3. everything runs in Docker
  expect(low).toContain("hardcod"); // 4. no hardcoding — values live in env/DB/config
  expect(low).toContain("reuse"); // 5. read what exists and extend it...
  expect(low).toContain("second implementation"); // ...never a parallel one
});

test("the dispatch preamble stays terse — every worker pays for it on every run", () => {
  // A ceiling, not a target: the preamble is engine-owned context charged to the operator on each
  // dispatch, so a new rule must be phrased tightly rather than appended as prose.
  expect(briefWithProjectDocs("").length).toBeLessThan(5000);
});

test("dispatch injects the codebase-memory + superpowers instruction into every brief automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let seenTask = "";
  const fakeStart = (o: Order) => {
    seenTask = o.task;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "fix the partner leak", d, 1, { start: fakeStart as never, root });
  await new Promise((r) => setTimeout(r, 0));
  expect(seenTask).toContain("fix the partner leak"); // the original brief survives verbatim
  expect(seenTask.toLowerCase()).toContain("codebase-memory"); // map before cold-reading files
  expect(seenTask.toLowerCase()).toContain("superpowers"); // use the skills
});

test("dispatch indexes the folder (and emits the operator line) BEFORE starting the worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const events: string[] = [];
  const codebaseMemory = {
    ensureIndexed: async (folder: string, onFirstIndex?: () => void | Promise<void>) => {
      events.push("index:" + folder);
      if (onFirstIndex) await onFirstIndex();
    },
  };
  const fakeStart = () => {
    events.push("start");
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  const replies: string[] = [];
  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, codebaseMemory, reply: (_c, t) => void replies.push(t) },
    1,
    { start: fakeStart as never, now: () => 0, root },
  );
  await new Promise((r) => setTimeout(r, 0)); // let the background continuation run
  expect(events).toEqual(["index:" + join(root, "eticket-v3"), "start"]);
  expect(replies.some((t) => t.includes("indexing") && t.includes("codebase-memory"))).toBe(true);
});

// --- Opt-in team mode (spike/agent-team-spike-findings.md GO): a dispatch may run the brief with
// a lead-orchestrated frontend+backend subagent team. Default OFF → byte-for-byte unchanged. ---

test("dispatch with team:'frontend-backend' attaches the agents map to the run AND wraps the brief with the team-lead preamble", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let seenTask = "";
  let seenDeps: Record<string, unknown> | undefined;
  const fakeStart = (o: Order, _h: RunHandlers, dd?: Record<string, unknown>) => {
    seenTask = o.task;
    seenDeps = dd;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "build a dashboard", d, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    team: "frontend-backend",
  });
  await new Promise((r) => setTimeout(r, 0));
  // agents attached to the run
  const agents = seenDeps?.agents as Record<string, unknown> | undefined;
  expect(agents).toBeDefined();
  expect(Object.keys(agents!).sort()).toEqual(["backend", "frontend"]);
  // brief wrapped with the team-lead preamble (names both agents), original task still present
  expect(seenTask).toContain("backend");
  expect(seenTask).toContain("frontend");
  expect(seenTask.toLowerCase()).toContain("file ownership");
  expect(seenTask).toContain("build a dashboard");
});

test("dispatch WITHOUT team attaches no agents and leaves the brief byte-for-byte unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let seenTask = "";
  let seenDeps: Record<string, unknown> | undefined;
  const fakeStart = (o: Order, _h: RunHandlers, dd?: Record<string, unknown>) => {
    seenTask = o.task;
    seenDeps = dd;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "build a dashboard", d, 1, { start: fakeStart as never, now: () => 0, root });
  await new Promise((r) => setTimeout(r, 0));
  expect(seenDeps).toBeDefined();
  expect(seenDeps!).not.toHaveProperty("agents"); // no team → no agents key at all
  expect(seenTask).toBe(briefWithProjectDocs("build a dashboard")); // identical to today
});

test("dispatch team mode falls back to a normal single-worker brief when Codex is selected", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  d.providers = { ownWork: "codex", customerWork: "gemini" };
  let seenTask = "";
  let seenDeps: Record<string, unknown> | undefined;
  const fakeStart = (o: Order, _h: RunHandlers, dd?: Record<string, unknown>) => {
    seenTask = o.task;
    seenDeps = dd;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };

  await dispatchToProject("eticket-v3", "build a dashboard", d, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    team: "frontend-backend",
  });
  await new Promise((r) => setTimeout(r, 0));

  expect(seenDeps?.provider).toBe("codex");
  expect(seenDeps!).not.toHaveProperty("agents");
  expect(seenTask).toBe(briefWithProjectDocs("build a dashboard"));
});

test("dispatch still starts the worker when ensureIndexed throws (best-effort)", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let started = false;
  const codebaseMemory = {
    ensureIndexed: async () => {
      throw new Error("cm down");
    },
  };
  const fakeStart = () => {
    started = true;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "task", { ...d, codebaseMemory }, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(started).toBe(true);
});

test("a dispatched worker runs the PINNED model, not whatever the SDK defaults to", async () => {
  // Regression: DispatchDeps carried `workers`/`providers`/`workerEnv` but not `models`, so
  // profileDeps got no pin and dispatch — the path nearly all project work goes through — kept
  // inheriting the subscription default. Asserting profileDeps in isolation did not catch it, so
  // this drives the real launch and reads the RunDeps the worker is actually started with.
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let runDeps: Record<string, unknown> | undefined;
  const fakeStart = ((_o: Order, _h: RunHandlers, deps: Record<string, unknown>) => {
    runDeps = deps;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  }) as unknown as typeof startOrder;

  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, models: DEFAULT_MODELS },
    1,
    { start: fakeStart as never, now: () => 0, root },
  );

  expect(runDeps?.model).toBe(DEFAULT_MODELS.default);
});

test("a dispatch honours the operator's own models override, not the code-baked pin", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let runDeps: Record<string, unknown> | undefined;
  const fakeStart = ((_o: Order, _h: RunHandlers, deps: Record<string, unknown>) => {
    runDeps = deps;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  }) as unknown as typeof startOrder;

  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, models: { default: "claude-opus-5", aliases: { opus: "claude-opus-5" } } },
    1,
    { start: fakeStart as never, now: () => 0, root },
  );

  expect(runDeps?.model).toBe("claude-opus-5"); // a rollback in config.json must actually take effect
});

// --- ADR-0007 (2026-10-04): no wall clock; progress + final result always reach the dispatcher. ---

/** A fake run whose handlers the test drives by hand. */
function drivenStart() {
  const ctl: { h?: RunHandlers; closes: number; followUps: string[]; resolve?: (r: RunResult) => void; reject?: (e: unknown) => void } = {
    closes: 0,
    followUps: [],
  };
  const start = (_o: Order, h: RunHandlers) => {
    ctl.h = h;
    return {
      followUp: (t: string) => void ctl.followUps.push(t),
      queued: () => 0,
      active: () => false,
      interrupt: async () => {},
      close: () => void ctl.closes++,
      done: new Promise<RunResult>((res, rej) => {
        ctl.resolve = res;
        ctl.reject = rej;
      }),
    };
  };
  return { ctl, start };
}

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("the dispatch tool takes no timeout argument and dispatch_start records no ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const { start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", d, 1, { start: start as never, root });
  await settle();
  const ev = d.ledger.listEvents({ kind: "dispatch_start" })[0];
  expect(ev?.data).not.toHaveProperty("ceilingMs");
  const src = await Bun.file(join(import.meta.dir, "../src/engine/dispatch.ts")).text();
  expect(src).not.toContain("timeoutMinutes");
});

test("a turn boundary does not close the brief; the SDK's settled signal does", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "run the plan", d, 1, { start: start as never, root });
  await settle();
  ctl.h!.onTurnComplete!({ ok: true, sessionId: "s", summary: "launched task 1 in the background", costUsd: 0 });
  expect(ctl.closes).toBe(0); // background agents may still be working
  ctl.h!.onSettled!();
  expect(ctl.closes).toBe(1);
});

test("a pending API retry keeps the channel open across a settle", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  let wake!: () => void;
  const sleep = () => new Promise<void>((r) => (wake = r));
  await dispatchToProject("eticket-v3", "t", d, 1, { start: start as never, root, sleep, rand: () => 0.5 });
  await settle();
  ctl.h!.onTurnComplete!({ ok: false, sessionId: "s", summary: "", costUsd: 0, apiError: "rate_limit" });
  ctl.h!.onSettled!();
  expect(ctl.closes).toBe(0); // the retry will re-send the brief into this run
  wake();
  await settle();
  expect(ctl.followUps.length).toBe(1);
  ctl.h!.onTurnComplete!({ ok: true, sessionId: "s", summary: "done", costUsd: 0 });
  ctl.h!.onSettled!();
  expect(ctl.closes).toBe(1);
});

test("a brief for a session that is closing is refused out loud, never pushed into the dead channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const pushed: string[] = [];
  const s = d.registry.add({ id: "o1", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: SUB_CHAT, createdAt: 0 }, 0);
  d.registry.setStatus(s.id, "running");
  d.registry.attachControl(s.id, { followUp: (t) => void pushed.push(t), interrupt: async () => {}, active: () => false, closed: () => true });
  const out = await dispatchToProject("eticket-v3", "second brief", d, 1, { root, now: () => 0 });
  expect(pushed).toHaveLength(0);
  expect(out.toLowerCase()).toContain("retry");
  expect(d.ledger.listEvents({ kind: "dispatch_refused" })[0]?.data).toMatchObject({ reason: "closing" });
});

test("a progress digest reaches the operator and the live company while the worker is active", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = makeDeps();
  const sent: Array<{ text: string; wake: boolean }> = [];
  d.dispatcher = { deliver: (text, opts) => (sent.push({ text, wake: opts.wake }), true) };
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", { ...d, dispatchProgressMs: 40, dispatchStallMs: 60_000 }, 1, {
    start: start as never,
    root,
    lastCommit: () => "8694a46 feat: task 5",
  });
  const beat = setInterval(() => {
    ctl.h!.onMessage("Task 5 is approved. Next, Task 6.", "text");
    ctl.h!.onActivity!("Agent: Implement Task 6");
  }, 10);
  await settle(150);
  clearInterval(beat);
  const toOperator = replies.filter((r) => r.text.startsWith("[dispatch progress]"));
  expect(toOperator.length).toBeGreaterThan(0);
  expect(toOperator[0]!.priority).toBeUndefined(); // the muted project chat, never the Decisions group
  expect(toOperator[0]!.text).toContain("Task 5 is approved");
  expect(toOperator[0]!.text).toContain("8694a46");
  const toCompany = sent.filter((s) => s.text.startsWith("[dispatch progress]"));
  expect(toCompany.length).toBe(toOperator.length);
  expect(toCompany.every((s) => s.wake === false)).toBe(true); // progress never wakes the company
  ctl.resolve!({ ok: true, sessionId: "s", summary: "done", costUsd: 0 });
});

test("no digest is sent when the worker has shown no activity since the last one", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", { ...d, dispatchProgressMs: 20, dispatchStallMs: 60_000 }, 1, { start: start as never, root });
  await settle(120);
  expect(replies.filter((r) => r.text.startsWith("[dispatch progress]"))).toHaveLength(0);
  ctl.resolve!({ ok: true, sessionId: "s", summary: "done", costUsd: 0 });
});

test("dispatchProgressMs 0 turns digests off", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", { ...d, dispatchProgressMs: 0, dispatchStallMs: 60_000 }, 1, { start: start as never, root });
  const beat = setInterval(() => ctl.h!.onActivity!("Bash"), 5);
  await settle(80);
  clearInterval(beat);
  expect(replies.filter((r) => r.text.startsWith("[dispatch progress]"))).toHaveLength(0);
  ctl.resolve!({ ok: true, sessionId: "s", summary: "done", costUsd: 0 });
});

test("the final result goes to the dispatcher with wake, and is kept in the inbox until delivered", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const sent: Array<{ text: string; wake: boolean }> = [];
  let up = false;
  d.dispatcher = { deliver: (text, opts) => (up ? (sent.push({ text, wake: opts.wake }), true) : false) };
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", d, 1, { start: start as never, root });
  ctl.resolve!({ ok: true, sessionId: "s", summary: "built the thing", costUsd: 0 });
  await settle();
  expect(sent).toHaveLength(0);
  expect(d.ledger.pendingDispatcherReports().map((r) => r.text)).toEqual(["[dispatch result] eticket-v3: built the thing"]);
  up = true; // the next dispatch's result flushes the backlog too
  const second = drivenStart();
  await dispatchToProject("eticket-v3", "t2", d, 1, { start: second.start as never, root });
  second.ctl.resolve!({ ok: true, sessionId: "s", summary: "second", costUsd: 0 });
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.wake).toBe(true);
  expect(sent[0]!.text).toContain("built the thing");
  expect(sent[0]!.text).toContain("second");
  expect(d.ledger.pendingDispatcherReports()).toHaveLength(0);
});

test("a stall-aborted dispatch reports where it stopped: last commit, latest note, last activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = makeDeps();
  const sent: string[] = [];
  d.dispatcher = { deliver: (text) => (sent.push(text), true) };
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", { ...d, dispatchStallMs: 30, dispatchGraceMs: 5 }, 1, {
    start: start as never,
    root,
    lastCommit: () => "2f51a025 feat: task 4",
  });
  ctl.h!.onMessage("Task 4 complete, starting Task 5.", "text");
  ctl.h!.onActivity!("Agent: Implement Task 5");
  ctl.h!.onMessage("🔧 Bash: go test", "tool"); // a tool line is never the "latest note"
  await settle(150);
  const report = sent.find((t) => t.startsWith("[dispatch result]"));
  expect(report).toBeDefined();
  expect(report).toContain("stall");
  expect(report).toContain("2f51a025 feat: task 4");
  expect(report).toContain("Task 4 complete, starting Task 5.");
  expect(report).toContain("Agent: Implement Task 5");
  expect(report).not.toContain("go test");
  // the operator's alert line carries the same stop point
  expect(replies.some((r) => r.priority === "alert" && r.text.includes("2f51a025"))).toBe(true);
});

test("a crashed run (done rejects) still reports to the dispatcher, with its stop point", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const sent: string[] = [];
  d.dispatcher = { deliver: (text) => (sent.push(text), true) };
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", d, 1, { start: start as never, root, lastCommit: () => "abc1234 wip" });
  ctl.reject!(new Error("worker process exited"));
  await settle();
  const report = sent.find((t) => t.startsWith("[dispatch result]"));
  expect(report).toContain("worker process exited");
  expect(report).toContain("abc1234 wip");
});

test("without a wired dispatcher the result still reaches a live company control", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const got: string[] = [];
  const co = d.registry.add({ id: "co", source: "neo", folder: "/home/neo/agent", task: "hq", chatId: 1, createdAt: 0 }, 0);
  d.registry.setDefault(co.id);
  d.registry.attachControl(co.id, { followUp: (t) => void got.push(t), interrupt: async () => {} });
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", d, 1, { start: start as never, root });
  ctl.resolve!({ ok: true, sessionId: "s", summary: "ok", costUsd: 0 });
  await settle();
  expect(got).toEqual(["[dispatch result] eticket-v3: ok"]);
});

test("a brief pushed into an operator-opened session does not promise a result back to the dispatcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const s = d.registry.add({ id: "op", source: "neo", folder: join(root, "eticket-v3"), task: "x", chatId: 7, createdAt: 0 }, 0);
  d.registry.setStatus(s.id, "running");
  d.registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, active: () => true });
  const out = await dispatchToProject("eticket-v3", "also do y", d, 1, { root, now: () => 0 });
  expect(out).toContain("NOT");
  expect(out).not.toContain("you get progress digests");
});

test("a brief queued behind a dispatch-owned run is covered by that run's digests and result", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "first", d, 1, { start: start as never, root });
  await settle();
  const out = await dispatchToProject("eticket-v3", "second", d, 1, { root });
  expect(out).toContain("you get progress digests and the result");
  ctl.resolve!({ ok: true, sessionId: "s", summary: "done", costUsd: 0 });
});

test("a run that ends during a reload drain says it was cut short for the reload, with its stop point, and stays queued", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let draining = false;
  d.lifecycle = { draining: () => draining };
  const { ctl, start } = drivenStart();
  await dispatchToProject("eticket-v3", "t", d, 1, { start: start as never, root, lastCommit: () => "9f9f9f9 wip: task 3" });
  draining = true; // the reload begins; the worker wraps up and its run ends
  ctl.resolve!({ ok: true, sessionId: "s", summary: "committed task 3", costUsd: 0 });
  await settle();
  const pending = d.ledger.pendingDispatcherReports(); // the link refuses while draining → kept for after the restart
  expect(pending).toHaveLength(1);
  expect(pending[0]!.text).toContain("engine reload");
  expect(pending[0]!.text).toContain("9f9f9f9 wip: task 3");
  // and the run is not mistaken for an unfinished one at the next boot
  expect(d.ledger.unfinishedDispatches(0)).toHaveLength(0);
});

test("trustNewProjects: dispatching into a never-seen project trusts it; an explicit off stays off", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "fresh"));
  mkdirSync(join(root, "kept-off"));
  const { d } = makeDeps();
  d.trust = openTrustStore(":memory:", { trustNewProjects: true });
  d.trust.setTrust(join(root, "kept-off"), false);
  const seen: Array<boolean | undefined> = [];
  const never = new Promise<RunResult>(() => {});
  const fakeStart = (_o: unknown, h: RunHandlers) => {
    seen.push(h.autoApprove?.());
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done: never };
  };
  await dispatchToProject("fresh", "t", d, 1, { start: fakeStart as never, now: () => 0, root });
  await dispatchToProject("kept-off", "t", d, 1, { start: fakeStart as never, now: () => 0, root });
  await new Promise((r) => setTimeout(r, 10));
  expect(d.trust.isTrusted(join(root, "fresh"))).toBe(true);
  expect(d.trust.isTrusted(join(root, "kept-off"))).toBe(false);
  expect(d.ledger.listEvents({ kind: "trust_default_on" }).map((e) => e.folder)).toEqual([join(root, "fresh")]);
});

// ---- ADR-0014: a finished dispatch above the sweet spot hands off; a safe checkpoint continues ----

function gitProject(): { root: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  const folder = join(root, "eticket-v3");
  mkdirSync(folder);
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q");
  writeFileSync(join(folder, "a.txt"), "1");
  g("add", ".");
  g("commit", "-q", "-m", "first");
  return { root, folder };
}
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const finished = (sessionId: string): RunResult => ({ ok: true, sessionId, summary: "done", costUsd: 0 });

test("a dispatch that ends above the sweet spot hands off before the todo queue releases the next brief", async () => {
  const { root } = gitProject();
  const { d } = makeDeps();
  const calls: string[] = [];
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done: Promise.resolve(finished("s1")) });
  await dispatchToProject("eticket-v3", "task", { ...d, contextPolicy: TEST_CONTEXT_POLICY }, 1, {
    start: fakeStart as never,
    root,
    signals: () => ({ occupancy: 0.7, turns: 5, ageMs: 0, idleMs: 0 }),
    handoff: (async (_s: unknown, _c: unknown, hd: { boundary?: string; decision?: { reason?: string } }) => void calls.push(`handoff:${hd.boundary}:${hd.decision?.reason}`)) as never,
    hooks: { onEnd: () => void calls.push("end") },
  });
  await tick();
  expect(calls).toEqual(["handoff:settled:above-sweet-spot", "end"]);
});

test("a dispatch that ends inside the sweet spot keeps its session", async () => {
  const { root } = gitProject();
  const { d } = makeDeps();
  let handedOff = false;
  const fakeStart = () => ({ followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done: Promise.resolve(finished("s1")) });
  await dispatchToProject("eticket-v3", "task", { ...d, contextPolicy: TEST_CONTEXT_POLICY }, 1, {
    start: fakeStart as never,
    root,
    signals: () => ({ occupancy: 0.3, turns: 5, ageMs: 0, idleMs: 0 }),
    handoff: (async () => void (handedOff = true)) as never,
  });
  await tick();
  expect(handedOff).toBe(false);
});

test("the dispatch gate waits for the folder's in-flight handoff before it measures", async () => {
  const { root, folder } = gitProject();
  const { d } = makeDeps();
  d.ledger.recordOrder({ id: "prev", source: "neo", folder, task: "x", chatId: SUB_CHAT, createdAt: 0 });
  d.ledger.recordSession("prev", "sid");
  let release!: () => void;
  trackHandoff(folder, new Promise<void>((r) => (release = r)));
  let started = false;
  const fakeStart = () => {
    started = true;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "task", { ...d, contextPolicy: TEST_CONTEXT_POLICY }, 1, {
    start: fakeStart as never,
    root,
    signals: () => ({ occupancy: 0.1, turns: 5, ageMs: 0, idleMs: 0 }),
  });
  await tick();
  expect(started).toBe(false);
  release();
  await tick();
  expect(started).toBe(true);
});

test("a todo dispatch armed at a safe checkpoint ends as a continuation, with no extra handoff turn", async () => {
  const { root, folder } = gitProject();
  const { d, replies } = makeDeps();
  d.ledger.recordModelWindow("claude-opus-5-5", 1_000_000);
  let handedOff = false;
  let steer: RunHandlers["contextSteer"];
  let finish!: (r: RunResult) => void;
  const fakeStart = (_o: Order, h: RunHandlers) => {
    steer = h.contextSteer;
    h.onUsage?.("claude-opus-5-5", { input_tokens: 820_000 }); // 82% ≥ checkpoint 0.8
    h.onToolUse?.("c1", "Bash", { command: "git commit -m 'phase 2'" });
    h.onToolResult?.("c1", false);
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done: new Promise<RunResult>((r) => (finish = r)) };
  };
  let end: { continuation?: string; ok: boolean } | undefined;
  await dispatchToProject("eticket-v3", "build all phases", { ...d, contextPolicy: TEST_CONTEXT_POLICY }, 1, {
    start: fakeStart as never,
    root,
    signals: () => ({ occupancy: 0.82, turns: 5, ageMs: 0, idleMs: 0 }),
    handoff: (async () => void (handedOff = true)) as never,
    hooks: { onEnd: (e) => void (end = e) },
  });
  await tick();
  expect(steer?.("Edit", { file_path: join(folder, "a.txt") })).toContain("Neo context checkpoint");
  writeFileSync(join(folder, "HANDOFF.md"), "## Goal\nall phases\n## Next steps\n1. phase 3\n");
  finish(finished("s1"));
  await tick();
  expect(handedOff).toBe(false);
  expect(end).toMatchObject({ ok: true, continuation: continuationBrief("build all phases") });
  expect(d.ledger.listContextEvents({ folder }).find((e) => e.verdict === "handoff")).toMatchObject({ boundary: "checkpoint", reason: "heavy" });
  expect(replies.some((r) => r.text.includes("safe checkpoint"))).toBe(true);
});

test("a dispatch with no continuation path (not from the todo queue) is never steered", async () => {
  const { root, folder } = gitProject();
  const { d } = makeDeps();
  d.ledger.recordModelWindow("claude-opus-5-5", 1_000_000);
  let steer: RunHandlers["contextSteer"] = () => "unset";
  const fakeStart = (_o: Order, h: RunHandlers) => {
    steer = h.contextSteer;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "task", { ...d, contextPolicy: TEST_CONTEXT_POLICY }, 1, { start: fakeStart as never, root });
  await tick();
  expect(steer).toBeUndefined();
  void folder;
});

test("a fresh dispatch after a handoff starts from the note, inline", async () => {
  const { root, folder } = gitProject();
  const { d } = makeDeps();
  writeFileSync(join(folder, "HANDOFF.md"), "## Goal\nthe cart\n");
  const handoffId = d.ledger.recordContextEvent(folder, "handoff", 0.7, 1, { reason: "above-sweet-spot" });
  let task = "";
  const fakeStart = (o: Order) => {
    task = o.task;
    return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
  };
  await dispatchToProject("eticket-v3", "carry on", { ...d, contextPolicy: TEST_CONTEXT_POLICY }, 1, { start: fakeStart as never, root });
  await tick();
  expect(task).toContain("the cart");
  expect(task).toContain("carry on");
  expect(d.ledger.listContextEvents({ folder })[0]).toMatchObject({ verdict: "resumed", detail: { handoffId } });
});
