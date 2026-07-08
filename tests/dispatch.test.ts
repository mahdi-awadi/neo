import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProject, dispatchToProject, sendProjectFile, neoMcpServers, STITCH_MCP_URL, SUB_CHAT, type DispatchDeps } from "../src/engine/dispatch";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { Order } from "../src/types";
import { startOrder, type RunHandlers, type RunResult } from "../src/engine/session-runner";
import type { ContextPolicyCfg, ContextSignals } from "../src/engine/context-policy";

const TEST_CONTEXT_POLICY: ContextPolicyCfg = {
  handoffPct: 0.65,
  emergencyPct: 0.85,
  maxTurns: 200,
  maxAgeMs: 7 * 24 * 3600 * 1000,
  handoffTimeoutMs: 180_000,
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
  const replies: Array<{ text: string; project?: string }> = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, project) => void replies.push({ text, project }),
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
  const out = await dispatchToProject("eticket-v3", "task", d, 1, {
    start: (() => {
      throw new Error("must not start");
    }) as never,
    root,
  });
  expect(out).toContain("still busy");
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

test("background ceiling timeout interrupts the sub-run, names the ceiling, and records an error outcome", async () => {
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
    { ...d, dispatchTimeoutMs: 5, dispatchGraceMs: 5, reply: (_c, t) => void replies.push(t) },
    1,
    { start: fakeStart as never, root },
  );
  await new Promise((r) => setTimeout(r, 60));
  expect(interrupted).toBe(true);
  expect(replies.some((t) => t.includes("timed out") && t.includes("ceiling"))).toBe(true);
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
  // huge ceiling, tiny stall → only the stall limit can fire
  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, dispatchTimeoutMs: 60_000, dispatchStallMs: 10, dispatchGraceMs: 5, reply: (_c, t) => void replies.push(t) },
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
    { ...d, dispatchTimeoutMs: 60_000, dispatchStallMs: 20, dispatchGraceMs: 5 },
    1,
    { start: fakeStart as never, root },
  );
  // keep the worker "busy": activity every 5ms, well inside the 20ms stall window
  const beat = setInterval(() => handlers?.onActivity?.("Bash"), 5);
  await new Promise((r) => setTimeout(r, 100)); // 5× the stall window
  clearInterval(beat);
  expect(interrupted).toBe(false);
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
    { ...d, dispatchTimeoutMs: 60_000, dispatchStallMs: 10, dispatchGraceMs: 200, reply: (_c, t) => void replies.push(t) },
    1,
    { start: fakeStart as never, root },
  );
  await new Promise((r) => setTimeout(r, 120));
  expect(followUps.some((t) => t.toLowerCase().includes("commit") && t.toLowerCase().includes("wip"))).toBe(true);
  expect(interrupted).toBe(false); // wrapped up gracefully — never hard-aborted
  expect(replies.some((t) => t.includes("finished") && t.includes("committed green work"))).toBe(true);
});

test("a caller-requested timeoutMs is honoured but clamped to dispatchTimeoutMaxMs", async () => {
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
  // caller asks for a huge ceiling, but the hard max is 5ms → the ceiling still fires
  await dispatchToProject(
    "eticket-v3",
    "task",
    { ...d, dispatchTimeoutMs: 60_000, dispatchTimeoutMaxMs: 5, dispatchGraceMs: 5 },
    1,
    { start: fakeStart as never, root, timeoutMs: 3_600_000 },
  );
  await new Promise((r) => setTimeout(r, 60));
  expect(interrupted).toBe(true);
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
  // Regression (2026-07-08): 18 sequential dispatches to one project each hit dispatchTimeoutMs,
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
  const fast = { ...d, dispatchTimeoutMs: 5, dispatchGraceMs: 5 };
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

test("neoMcpServers attaches gitnexus + codebase-memory stdio servers when their bins are set (operator path)", () => {
  const { d } = makeDeps();
  const servers = neoMcpServers(d, 1, {
    dispatch: true,
    folder: "/home/neo/agent",
    gitnexusBin: "/usr/bin/gitnexus",
    codebaseMemoryBin: "/root/.local/bin/codebase-memory-mcp",
  });
  const gitnexus = servers.gitnexus as { type: string; command: string; args: string[] };
  expect(gitnexus.type).toBe("stdio");
  expect(gitnexus.command).toBe("/usr/bin/gitnexus");
  expect(gitnexus.args).toEqual(["mcp"]);
  const mem = servers["codebase-memory"] as { type: string; command: string; args: string[] };
  expect(mem.type).toBe("stdio");
  expect(mem.command).toBe("/root/.local/bin/codebase-memory-mcp");
  expect(mem.args).toEqual([]);
});

test("neoMcpServers OMITS gitnexus + codebase-memory on the customer path (bins unset)", () => {
  const { d } = makeDeps();
  // customer/ingress path passes no bins → never attached
  const servers = neoMcpServers(d, 1, { dispatch: true, folder: "/x" });
  expect(servers.gitnexus).toBeUndefined();
  expect(servers["codebase-memory"]).toBeUndefined();
  // empty string bin → skipped
  expect(neoMcpServers(d, 1, { dispatch: true, folder: "/x", gitnexusBin: "" }).gitnexus).toBeUndefined();
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
  expect(seen!.task).toBe("CRAFTED BRIEF for the project"); // exactly the brief, nothing else
  expect(seen!.chatId).toBe(-2); // SUB_CHAT — isolated from the operator's routing
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
  const fakeSignals = (): ContextSignals => ({ occupancy: 0.9, turns: 5, ageMs: 0 }); // >= emergencyPct → clear
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
  const fakeSignals = (): ContextSignals => ({ occupancy: 0.7, turns: 5, ageMs: 0 }); // >= handoffPct, < emergencyPct → handoff
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
  const fakeSignals = (): ContextSignals => ({ occupancy: 0.1, turns: 5, ageMs: 0 }); // well under handoffPct → keep
  await dispatchToProject("eticket-v3", "task", deps, 1, {
    start: fakeStart as never,
    now: () => 0,
    root,
    signals: fakeSignals,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(seenResume).toBe("fat-session-id");
});
