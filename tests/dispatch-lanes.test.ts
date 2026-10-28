// ADR-0057: dispatch starts a side lane as its own fresh session beside the main one.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dispatchToProject, SIDE_CHAT, SUB_CHAT, type DispatchDeps, type TodoEnd } from "../src/engine/dispatch";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { RunResult, RunDeps } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function makeDeps(over: Partial<DispatchDeps> = {}) {
  const replies: string[] = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text) => void replies.push(text),
    askApproval: async () => "deny",
    ...over,
  };
  return { d, replies };
}
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** A start seam that records each run's order and deps; `finish(i)` ends run i. */
function recordingStart() {
  const runs: Array<{ order: Order; deps: RunDeps; finish: (r?: Partial<RunResult>) => void; followUps: string[] }> = [];
  const start = (order: Order, _h: unknown, deps: RunDeps) => {
    let finish!: (r?: Partial<RunResult>) => void;
    const done = new Promise<RunResult>((res) => (finish = (r) => res({ ok: true, sessionId: `s-${runs.length}`, summary: "done", costUsd: 0, ...r })));
    const followUps: string[] = [];
    runs.push({ order: { ...order }, deps, finish, followUps });
    return { followUp: (t: string) => void followUps.push(t), queued: () => 0, interrupt: async () => {}, close: () => {}, active: () => true, done };
  };
  return { runs, start };
}

/** A main session that is mid-turn in `folder`. */
function busyMain(d: DispatchDeps, folder: string) {
  const followUps: string[] = [];
  const s = d.registry.add({ id: "main", source: "neo", folder, task: "build", chatId: SUB_CHAT, createdAt: 0 }, 0);
  d.registry.attachControl(s.id, { followUp: (t: string) => void followUps.push(t), interrupt: async () => {}, queued: () => 0, active: () => true } as never);
  return { s, followUps };
}

test("a side dispatch to a busy folder starts its own session; the main run gets nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-dl-"));
  mkdirSync(join(root, "eticket-v3"));
  const folder = join(root, "eticket-v3");
  const { d } = makeDeps();
  d.ledger.recordOrder({ id: "old", source: "neo", folder, task: "x", chatId: SUB_CHAT, createdAt: 0 });
  d.ledger.recordSession?.("old", "sdk-main");
  const main = busyMain(d, folder);
  const { runs, start } = recordingStart();
  const out = await dispatchToProject("eticket-v3", "check docker status", d, 1, { start: start as never, root, lane: { kind: "ops", todoId: 41 } });
  await settle();
  expect(out).toContain("side lane (ops)");
  expect(main.followUps).toEqual([]); // nothing pushed into the main run
  expect(runs).toHaveLength(1);
  expect(runs[0]!.deps.lane).toEqual({ kind: "ops", projectFolder: folder, todoId: 41 });
  expect(runs[0]!.deps.resume).toBeUndefined(); // always fresh, never the main session
  expect(runs[0]!.order.task).toContain("SIDE LANE (ops)");
  expect(runs[0]!.order.chatId).toBe(SIDE_CHAT); // never the folder's resume point (SUB_CHAT)
  expect(d.registry.findByFolder(folder)?.id).toBe(main.s.id);
  expect(d.registry.sideLanes(folder).map((s) => s.name)).toEqual(["eticket-v3-side-ops"]);
  runs[0]!.finish();
  await settle();
  expect(d.registry.sideLanes(folder)).toEqual([]); // the side session closed with its run
});

test("a code side lane runs in its own worktree; its end reports the branch to the queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-dl-"));
  const folder = join(root, "proj");
  mkdirSync(folder);
  const g = (...a: string[]) => spawnSync("git", ["-C", folder, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "dev");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(folder, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  const wtRoot = mkdtempSync(join(tmpdir(), "neo-dl-wt-"));
  const { d } = makeDeps({ lanes: { enabled: true, maxSidePerProject: 1, maxDispatchesHost: 3, worktreeRoot: wtRoot, noLaneClassifier: "none" } });
  const ends: TodoEnd[] = [];
  const { runs, start } = recordingStart();
  await dispatchToProject("proj", "fix the typo in a.txt", d, 1, { start: start as never, root, lane: { kind: "code", todoId: 9 }, hooks: { onEnd: (e) => void ends.push(e) } });
  await settle(50);
  const wt = runs[0]!.order.folder;
  expect(wt).toBe(join(wtRoot, "proj-side-9"));
  expect(runs[0]!.deps.lane).toEqual({ kind: "code", projectFolder: folder, todoId: 9 });
  // The worker commits on its side branch.
  writeFileSync(join(wt, "a.txt"), "b\n");
  spawnSync("git", ["-C", wt, "commit", "-qam", "fix"]);
  runs[0]!.finish();
  await settle(100);
  expect(existsSync(wt)).toBe(false);
  expect(ends[0]?.lane).toMatchObject({ branch: "side/9", base: "dev", commits: 1, removed: true });
});

test("a code lane whose worktree cannot be made is refused, never run in the main folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-dl-"));
  mkdirSync(join(root, "plain")); // not a git repo
  const { d } = makeDeps();
  const refused: string[] = [];
  const { runs, start } = recordingStart();
  const out = await dispatchToProject("plain", "change x", d, 1, { start: start as never, root, lane: { kind: "code", todoId: 3 }, hooks: { onRefused: (r) => void refused.push(r) } });
  expect(runs).toHaveLength(0);
  expect(refused).toEqual(["lane_worktree"]);
  expect(out).toContain("worktree");
});

test("side lanes need the Claude governor hook: with the Codex SDK the side dispatch is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-dl-"));
  mkdirSync(join(root, "p"));
  const { d } = makeDeps({ providers: { ownWork: "codex" } as never });
  const refused: string[] = [];
  const { runs, start } = recordingStart();
  const out = await dispatchToProject("p", "check", d, 1, { start: start as never, root, lane: { kind: "ops" }, hooks: { onRefused: (r) => void refused.push(r) } });
  expect(runs).toHaveLength(0);
  expect(refused).toEqual(["lane_unsupported"]);
  expect(out).toContain("Codex");
});
