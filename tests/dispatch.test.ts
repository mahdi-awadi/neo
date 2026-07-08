import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProject, dispatchToProject, sendProjectFile, neoMcpServers, STITCH_MCP_URL, type DispatchDeps } from "../src/engine/dispatch";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { Order } from "../src/types";
import { startOrder, type RunHandlers, type RunResult } from "../src/engine/session-runner";

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

test("background timeout interrupts the sub-run and records an error outcome", async () => {
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
  await dispatchToProject("eticket-v3", "task", { ...d, dispatchTimeoutMs: 5, reply: (_c, t) => void replies.push(t) }, 1, {
    start: fakeStart as never,
    root,
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(interrupted).toBe(true);
  expect(replies.some((t) => t.includes("timed out"))).toBe(true);
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
