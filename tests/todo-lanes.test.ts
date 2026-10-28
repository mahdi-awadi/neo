// ADR-0057: the todo queue starts side todos in free side slots, beside the main lane.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { DispatchDeps } from "../src/engine/dispatch";
import type { RunDeps, RunResult } from "../src/engine/session-runner";
import { createTodoQueue } from "../src/engine/todo-queue";
import { canStartSide, DEFAULT_LANES_CFG, type LanesCfg } from "../src/engine/lanes";
import { listOpen } from "../src/engine/attention";

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const ok = (summary = "all green"): RunResult => ({ ok: true, sessionId: "s1", summary, costUsd: 0 });

function setup(over: { lanes?: Partial<LanesCfg>; deps?: Partial<DispatchDeps>; git?: boolean; uncommitted?: (f: string) => string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-tl-"));
  for (const p of ["eticket-v3", "waselni"]) mkdirSync(join(root, p));
  if (over.git) {
    const f = join(root, "eticket-v3");
    const g = (...a: string[]) => spawnSync("git", ["-C", f, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "dev");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(join(f, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  const replies: string[] = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const wtRoot = mkdtempSync(join(tmpdir(), "neo-tl-wt-"));
  const lanes: LanesCfg = { ...DEFAULT_LANES_CFG, worktreeRoot: wtRoot, ...over.lanes };
  const deps: DispatchDeps = {
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text) => void replies.push(text),
    askApproval: async () => "deny",
    workRoot: root,
    lanes,
    ...over.deps,
  };
  const runs: Array<{ task: string; folder: string; deps: RunDeps; finish: (r: RunResult) => void }> = [];
  const start = (order: { task: string; folder: string }, _h: unknown, d: RunDeps) => {
    let finish!: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => (finish = res));
    runs.push({ task: order.task, folder: order.folder, deps: d, finish });
    return { followUp: () => {}, queued: () => 0, active: () => true, closed: () => false, close: () => {}, interrupt: async () => {}, done };
  };
  const queue = createTodoQueue({ ledger, registry, onFailure: () => "continue", dispatchOpts: { start: start as never, now: () => 1_000 }, lanes: () => lanes, ...(over.uncommitted ? { uncommitted: over.uncommitted } : {}) });
  queue.setLauncher(() => ({ deps, replyChat: 1 }));
  const submit = (project: string, brief: string, lane?: "side" | "queue", kind?: "ops" | "test" | "read-only" | "code") =>
    queue.submit({ project, brief, workClass: "interactive", ...(lane ? { lane } : {}), ...(kind ? { kind } : {}) }, deps, 1);
  return { root, replies, ledger, registry, deps, queue, runs, submit, lanes };
}

test("canStartSide: off, provider, per-project cap, host cap and hold each say why", () => {
  const base = { sideRunning: 0, hostRunning: 1, codex: false, hold: undefined };
  expect(canStartSide(base, DEFAULT_LANES_CFG)).toEqual({ ok: true });
  expect(canStartSide(base, { ...DEFAULT_LANES_CFG, enabled: false })).toMatchObject({ queue: expect.stringContaining("off") });
  expect(canStartSide({ ...base, codex: true }, DEFAULT_LANES_CFG)).toMatchObject({ queue: expect.stringContaining("Codex") });
  expect(canStartSide({ ...base, sideRunning: 1 }, DEFAULT_LANES_CFG)).toMatchObject({ wait: expect.stringContaining("1 side lane") });
  expect(canStartSide({ ...base, hostRunning: 3 }, DEFAULT_LANES_CFG)).toMatchObject({ wait: expect.stringContaining("3 dispatch runs") });
  expect(canStartSide({ ...base, hold: "interactive reserve" }, DEFAULT_LANES_CFG)).toEqual({ wait: "interactive reserve" });
});

test("a side brief for a FREE project runs in the main lane, as today", async () => {
  const s = setup();
  await s.submit("eticket-v3", "check docker status", "side", "ops");
  await settle();
  const [t] = s.ledger.listTodos({});
  expect(t).toMatchObject({ status: "running", lane: "main" });
  expect(s.runs[0]!.deps.lane).toBeUndefined();
});

test("a side brief for a BUSY project starts now as a side lane; the main run goes on", async () => {
  const s = setup();
  await s.submit("eticket-v3", "build the big feature");
  await settle();
  const out = await s.submit("eticket-v3", "create a dev super-admin user", "side", "ops");
  await settle();
  expect(out).toContain("side lane (ops)");
  const side = s.ledger.listTodos({ lane: "side" })[0]!;
  expect(side).toMatchObject({ status: "running", laneKind: "ops" });
  expect(s.runs).toHaveLength(2);
  expect(s.runs[1]!.deps.lane).toMatchObject({ kind: "ops", todoId: side.id });
  expect(s.ledger.listTodos({ lane: "main", statuses: ["running"] })).toHaveLength(1);
});

test("per-project cap: the second side brief waits as a queued side todo and starts when the slot frees", async () => {
  const s = setup();
  await s.submit("eticket-v3", "build");
  await settle();
  await s.submit("eticket-v3", "run the CityNet API test", "side", "test");
  await settle();
  const out = await s.submit("eticket-v3", "check docker", "side", "ops");
  await settle();
  expect(out).toContain("side slot");
  expect(s.ledger.listTodos({ lane: "side", statuses: ["queued"] })).toHaveLength(1);
  expect(s.runs).toHaveLength(2);
  s.runs[1]!.finish(ok());
  await settle(60);
  expect(s.runs).toHaveLength(3); // the waiting side todo started — the main build is still running
  expect(s.ledger.listTodos({ lane: "side", statuses: ["running"] })).toHaveLength(1);
});

test("host cap: a side todo waits while the host runs maxDispatchesHost dispatches", async () => {
  const s = setup({ lanes: { maxDispatchesHost: 2 } });
  await s.submit("eticket-v3", "build A");
  await s.submit("waselni", "build B");
  await settle();
  const out = await s.submit("eticket-v3", "check docker", "side", "ops");
  await settle();
  expect(out).toContain("2 dispatch runs");
  expect(s.runs).toHaveLength(2);
  s.runs[1]!.finish(ok()); // waselni's build ends
  await settle(60);
  expect(s.runs).toHaveLength(3);
  expect(s.runs[2]!.deps.lane).toMatchObject({ kind: "ops" });
});

test("a running side lane never holds the main queue: the next main todo starts when the main one ends", async () => {
  const s = setup();
  await s.submit("eticket-v3", "build A");
  await settle();
  await s.submit("eticket-v3", "check docker", "side", "ops");
  await s.submit("eticket-v3", "build B");
  await settle();
  expect(s.runs).toHaveLength(2);
  s.runs[0]!.finish(ok()); // the main build A ends; the side lane still runs
  await settle(60);
  expect(s.runs).toHaveLength(3);
  expect(s.runs[2]!.task).toContain("build B");
  expect(s.runs[2]!.deps.lane).toBeUndefined();
});

test("lanes off, or the Codex SDK: a side brief is queued in the main lane and the reply says why", async () => {
  const off = setup({ lanes: { enabled: false } });
  await off.submit("eticket-v3", "build");
  await settle();
  expect(await off.submit("eticket-v3", "check docker", "side", "ops")).toContain("queued");
  expect(off.ledger.listTodos({ lane: "side" })).toHaveLength(0);
  const codex = setup({ deps: { providers: { ownWork: "codex" } as never } });
  await codex.submit("eticket-v3", "build");
  await settle();
  const out = await codex.submit("eticket-v3", "check docker", "side", "ops");
  expect(out).toContain("Codex");
  expect(codex.ledger.listTodos({ lane: "side" })).toHaveLength(0);
  expect(codex.ledger.listTodos({ lane: "main", statuses: ["queued"] })).toHaveLength(1);
});

test("a failed side todo keeps its lane and kind when it is retried, and runs as a side lane again", async () => {
  const s = setup();
  await s.submit("eticket-v3", "build");
  await settle();
  await s.submit("eticket-v3", "check docker", "side", "ops");
  await settle();
  s.runs[1]!.finish({ ok: false, sessionId: "", summary: "docker not reachable", costUsd: 0 });
  await settle(60);
  const t = s.ledger.listTodos({ lane: "side" })[0]!;
  expect(t).toMatchObject({ status: "failed", lane: "side", laneKind: "ops" });
  s.queue.retry(t.id);
  await s.queue.pump();
  await settle(60);
  expect(s.ledger.todoById(t.id)).toMatchObject({ status: "running", lane: "side" });
  expect(s.runs.at(-1)!.deps.lane).toMatchObject({ kind: "ops", todoId: t.id });
});

test("code lane end: commits queue a main-lane merge todo; the worktree is gone", async () => {
  const s = setup({ git: true });
  await s.submit("eticket-v3", "build");
  await settle();
  await s.submit("eticket-v3", "fix the typo in a.txt", "side", "code");
  await settle(60);
  const side = s.ledger.listTodos({ lane: "side" })[0]!;
  const wt = s.runs[1]!.folder;
  writeFileSync(join(wt, "a.txt"), "b\n");
  spawnSync("git", ["-C", wt, "commit", "-qam", "fix typo"]);
  s.runs[1]!.finish(ok());
  await settle(150);
  const merge = s.ledger.listTodos({ lane: "main", statuses: ["queued"] })[0];
  expect(merge?.brief).toContain(`side/${side.id}`);
  expect(merge?.brief).toContain("dev");
});

test("code lane end with uncommitted work: the worktree is kept and raised as a dirty item", async () => {
  const s = setup({ git: true });
  await s.submit("eticket-v3", "build");
  await settle();
  await s.submit("eticket-v3", "fix the typo", "side", "code");
  await settle(60);
  writeFileSync(join(s.runs[1]!.folder, "new.txt"), "x\n");
  s.runs[1]!.finish(ok());
  await settle(150);
  const dirty = listOpen(s.ledger, { now: 2_000 }).filter((i) => i.kind === "dirty");
  expect(dirty.some((i) => i.title.includes("side lane") && i.folder === s.runs[1]!.folder)).toBe(true);
});

test("the main lane's uncommitted-files check never runs for a shared-folder side lane", async () => {
  // The folder is dirty with the main build's work in progress; a side lane ending must not report it.
  const s = setup({ uncommitted: () => ["src/half-done.ts"] });
  await s.submit("eticket-v3", "build");
  await settle();
  await s.submit("eticket-v3", "check docker", "side", "ops");
  await settle();
  s.runs[1]!.finish(ok());
  await settle(60);
  expect(listOpen(s.ledger, { now: 2_000 }).filter((i) => i.kind === "dirty")).toHaveLength(0);
  expect(s.replies.some((r) => r.includes("uncommitted"))).toBe(false);
});

test("boot: recover sweeps the lane worktree root — a clean orphan goes, a dirty one is raised", async () => {
  const s = setup({ git: true });
  const { createLaneWorktree } = await import("../src/engine/lane-worktree");
  const folder = join(s.root, "eticket-v3");
  const clean = createLaneWorktree(folder, "70", s.lanes.worktreeRoot);
  const dirty = createLaneWorktree(folder, "71", s.lanes.worktreeRoot);
  if ("error" in clean || "error" in dirty) throw new Error("setup");
  writeFileSync(join(dirty.path, "wip.txt"), "x\n");
  s.queue.recover({ now: 2_000 });
  const { existsSync } = await import("node:fs");
  expect(existsSync(clean.path)).toBe(false);
  expect(existsSync(dirty.path)).toBe(true);
  expect(listOpen(s.ledger, { now: 2_000 }).some((i) => i.kind === "dirty" && i.folder === dirty.path)).toBe(true);
});

test("/todo and the todo tool list side lanes in their own group with kind; main positions skip them", async () => {
  const s = setup();
  await s.submit("eticket-v3", "build A");
  await settle();
  await s.submit("eticket-v3", "check docker", "side", "ops");
  await s.submit("eticket-v3", "run the API test", "side", "test");
  await s.submit("eticket-v3", "build B");
  await settle();
  const out = s.queue.list("eticket-v3");
  const [mainPart, sidePart] = out.split("Side lanes");
  expect(mainPart).toContain("1. #");
  expect(mainPart).toContain("build B");
  expect(mainPart).not.toContain("check docker");
  expect(sidePart).toMatch(/▷ #\d+ side·ops running \d+m — check docker/);
  expect(sidePart).toMatch(/▷ #\d+ side·test waits for a side slot — run the API test/);
});

test("the console's todos carry lane and kind; queue positions count the main lane only", async () => {
  const { activeTodos } = await import("../src/engine/dashboard");
  const s = setup();
  await s.submit("eticket-v3", "build A");
  await settle();
  await s.submit("eticket-v3", "check docker", "side", "ops");
  await s.submit("eticket-v3", "run the API test", "side", "test");
  await s.submit("eticket-v3", "build B");
  await settle();
  const rows = activeTodos(s.ledger);
  const side = rows.filter((r) => r.lane === "side");
  expect(side.map((r) => [r.kind, r.status, r.position])).toEqual([["ops", "running", 0], ["test", "queued", 0]]);
  expect(rows.find((r) => r.title.includes("build B"))).toMatchObject({ position: 1 });
  expect(rows.find((r) => r.title.includes("build A"))!.lane).toBeUndefined();
});
