// ADR-0037: dispatch's commit finish — one follow-up into the same open run when it settles with its
// own changes uncommitted; the result keeps the first end and adds what the follow-up achieved.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dispatchToProject, type DispatchDeps } from "../src/engine/dispatch";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";
import { DEFAULT_COMMIT_FINISH_CFG, commitFinishInFlight } from "../src/engine/commit-finish";
import type { TodoEnd } from "../src/engine/dispatch";

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** A root with one git project `proj`. */
function project(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "neo-dcf-"));
  const dir = join(root, "proj");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "a\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return { root, dir };
}

function makeDeps(over: Partial<DispatchDeps> = {}) {
  const replies: Array<{ text: string; priority?: string }> = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, _p, priority) => void replies.push({ text, priority }),
    askApproval: async () => "deny",
    commitFinish: DEFAULT_COMMIT_FINISH_CFG,
    ...over,
  };
  return { d, replies };
}

function drivenStart() {
  const ctl: { h?: RunHandlers; closes: number; followUps: string[]; resolve?: (r: RunResult) => void } = { closes: 0, followUps: [] };
  const start = (_o: Order, h: RunHandlers) => {
    ctl.h = h;
    return {
      followUp: (t: string) => void ctl.followUps.push(t),
      queued: () => 0,
      active: () => false,
      interrupt: async () => {},
      close: () => void ctl.closes++,
      closed: () => false,
      done: new Promise<RunResult>((res) => (ctl.resolve = res)),
    };
  };
  return { ctl, start };
}
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const first: RunResult = { ok: true, sessionId: "s1", summary: "security review: no findings", costUsd: 0 };

test("AC1: a run that settles with its own changes gets ONE follow-up, the run stays open; the next settle closes it", async () => {
  const { root, dir } = project();
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "build it", d, 1, { start: start as never, root });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  expect(ctl.closes).toBe(0);
  expect(ctl.followUps).toHaveLength(1);
  expect(ctl.followUps[0]).toContain("Your run ended with uncommitted changes: b.ts");
  expect(commitFinishInFlight(dir)).toBe(true);
  expect(d.ledger.listEvents({ kind: "commit_finish_sent" })[0]?.data).toMatchObject({ files: ["b.ts"] });
  ctl.h!.onTurnComplete!({ ...first, summary: "committed" });
  ctl.h!.onSettled!();
  expect(ctl.closes).toBe(1);
  expect(ctl.followUps).toHaveLength(1); // never a second
  ctl.resolve!({ ...first, summary: "committed" });
  await settle();
  expect(commitFinishInFlight(dir)).toBe(false);
});

test("AC4: committed by the follow-up — the result keeps the first summary and adds the commit", async () => {
  const { root, dir } = project();
  const ends: TodoEnd[] = [];
  const { d, replies } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "build it", d, 1, { start: start as never, root, hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "feat: b");
  // The follow-up turn's own end — even a failed one — never replaces the run's first end.
  ctl.resolve!({ ok: false, sessionId: "s1", summary: "Committed b.ts", costUsd: 0, apiError: "overloaded" });
  await settle();
  expect(ends[0]).toMatchObject({ ok: true });
  expect(ends[0]!.failure).toBeUndefined();
  expect(ends[0]!.summary).toContain("security review: no findings");
  expect(ends[0]!.summary).toMatch(/committed by resume: [0-9a-f]{7,} feat: b/);
  const result = replies.find((r) => r.text.startsWith("proj finished:"));
  expect(result?.priority).toBe("result");
  expect(d.ledger.pendingDispatcherReports()[0]?.text ?? "").toContain("committed by resume:");
});

test("AC4: still uncommitted after the follow-up — said in the result, and an alert to the operator", async () => {
  const { root, dir } = project();
  const ends: TodoEnd[] = [];
  const { d, replies } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "build it", d, 1, { start: start as never, root, hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  ctl.resolve!({ ...first, summary: "b.ts is a scratch file, not committed" });
  await settle();
  expect(ends[0]).toMatchObject({ ok: true });
  expect(ends[0]!.summary).toContain("still uncommitted after one resume: b.ts");
  expect(replies.some((r) => r.priority === "alert" && r.text.includes("still uncommitted after one resume: b.ts"))).toBe(true);
});

test("AC2: a clean run closes at once; a pre-dirty untouched file is not the run's", async () => {
  const { root, dir } = project();
  writeFileSync(join(dir, "a.ts"), "operator's own edit\n");
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "look around", d, 1, { start: start as never, root });
  await settle();
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  expect(ctl.followUps).toHaveLength(0);
  expect(ctl.closes).toBe(1);
});

const drain = { on: false };
const skipCases: Array<[string, (d: DispatchDeps) => void, Partial<DispatchDeps>]> = [
  ["the config is off", () => {}, { commitFinish: { ...DEFAULT_COMMIT_FINISH_CFG, enabled: false } }],
  ["no commitFinish deps", () => {}, { commitFinish: undefined }],
  ["the engine started draining", () => void (drain.on = true), { lifecycle: { draining: () => drain.on } }],
  [
    "the session waits on the operator",
    (d) => {
      const s = d.registry.list().find((x) => x.status === "running")!;
      d.registry.noteBlocked(s.id, { kind: "decision", label: "plan approval", since: 0 });
    },
    {},
  ],
];
for (const [why, arrange, over] of skipCases) {
  test(`AC3: no follow-up when ${why}`, async () => {
    drain.on = false;
    const { root, dir } = project();
    const { d } = makeDeps(over);
    const { ctl, start } = drivenStart();
    await dispatchToProject("proj", "build it", d, 1, { start: start as never, root });
    await settle();
    writeFileSync(join(dir, "b.ts"), "built\n");
    arrange(d);
    ctl.h!.onTurnComplete!(first);
    ctl.h!.onSettled!();
    expect(ctl.followUps).toHaveLength(0);
    expect(ctl.closes).toBe(1);
  });
}

test("AC3: no follow-up after a turn that ended on an API error", async () => {
  const { root, dir } = project();
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  // No retries left: the API error gives up, and the run closes as it did before.
  await dispatchToProject("proj", "build it", { ...d, apiRetryLadderMs: [] }, 1, { start: start as never, root });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!({ ok: false, sessionId: "s", summary: "", costUsd: 0, apiError: "server_error" });
  ctl.h!.onSettled!();
  expect(ctl.followUps.filter((f) => f.includes("uncommitted"))).toHaveLength(0);
});

test("edge: a stall inside the follow-up keeps the finished task good; the result says still uncommitted", async () => {
  const { root, dir } = project();
  const ends: TodoEnd[] = [];
  const { d } = makeDeps({ dispatchStallMs: 40, dispatchGraceMs: 20, dispatchProgressMs: 0 });
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "build it", d, 1, { start: start as never, root, hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  // The follow-up hangs: no activity until the stall limit, the wrap-up and the grace run out.
  for (let i = 0; i < 40 && ends.length === 0; i++) await settle(10);
  expect(ctl.followUps.some((f) => f.includes("stall limit"))).toBe(true);
  expect(ends[0]).toMatchObject({ ok: true });
  expect(ends[0]!.failure).toBeUndefined();
  expect(ends[0]!.summary).toContain("still uncommitted after one resume: b.ts");
  expect(commitFinishInFlight(dir)).toBe(false);
});

test("AC6: the pipeline hands config commitFinish to every dispatch", async () => {
  const { dispatchDepsFrom } = await import("../src/engine/pipeline");
  const cfg = { enabled: false, ignore: ["x/**"], holdMaxMs: 1000 };
  const deps = dispatchDepsFrom({ cfg: { commitFinish: cfg } } as never);
  expect(deps.commitFinish).toEqual(cfg);
});

test("review: an API retry inside the follow-up re-sends the commit request, never the whole task", async () => {
  const { root, dir } = project();
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  let wake!: () => void;
  const sleep = () => new Promise<void>((r) => (wake = r));
  await dispatchToProject("proj", "build the whole feature", d, 1, { start: start as never, root, sleep, rand: () => 0.5 });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  expect(ctl.followUps).toHaveLength(1);
  ctl.h!.onTurnComplete!({ ok: false, sessionId: "s1", summary: "", costUsd: 0, apiError: "rate_limit" });
  ctl.h!.onSettled!();
  wake();
  await settle();
  expect(ctl.followUps).toHaveLength(2);
  expect(ctl.followUps[1]).toBe(ctl.followUps[0]!);
  ctl.resolve!(first);
  await settle();
});

test("review: an engine reload that starts inside the follow-up does not re-run the finished task", async () => {
  const { root, dir } = project();
  const ends: TodoEnd[] = [];
  const draining = { on: false };
  const { d } = makeDeps({ lifecycle: { draining: () => draining.on } });
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "build it", d, 1, { start: start as never, root, hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  draining.on = true;
  ctl.resolve!(first);
  await settle();
  expect(ends[0]).toMatchObject({ ok: true });
  expect(ends[0]!.failure).toBeUndefined();
  expect(ends[0]!.summary).toContain("still uncommitted after one resume: b.ts");
});

test("review: a context checkpoint that arms inside the follow-up neither blocks the commit nor re-queues the task", async () => {
  const { root, dir } = project();
  const ends: TodoEnd[] = [];
  const policy = {
    sweetSpotPct: 0.65, checkpointPct: 0.8, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70, emergencyPct: 0.85,
    maxTurns: 200, maxAgeMs: 7 * 24 * 3600 * 1000, handoffTimeoutMs: 180_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000,
    cacheTtlMinObservations: 5, windowTokensByModel: { m: 1000 },
  };
  const { d } = makeDeps({ contextPolicy: policy as never });
  const { ctl, start } = drivenStart();
  const signals = () => ({ occupancy: 0.1, turns: 1, ageMs: 0, lastActivityAt: 0 }) as never;
  await dispatchToProject("proj", "build it", d, 1, { start: start as never, root, signals, hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  writeFileSync(join(dir, "b.ts"), "built\n");
  ctl.h!.onTurnComplete!(first);
  ctl.h!.onSettled!();
  expect(ctl.followUps).toHaveLength(1);
  // The follow-up's checks fill the context past the checkpoint; its commit is a safe point (clean tree).
  ctl.h!.onUsage?.("m", { input_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 });
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "feat: b");
  ctl.h!.onToolUse?.("t1", "Bash", { command: "git commit -m 'feat: b'" });
  ctl.h!.onToolResult?.("t1", false);
  expect(ctl.h!.contextSteer?.("Write", { file_path: join(dir, "c.ts"), content: "" })).toBeUndefined();
  ctl.resolve!(first);
  await settle();
  expect(ends[0]).toMatchObject({ ok: true });
  expect(ends[0]!.continuation).toBeUndefined();
  expect(ends[0]!.failure).toBeUndefined();
  expect(ends[0]!.summary).toMatch(/committed by resume: [0-9a-f]{7,} feat: b/);
  expect(d.ledger.listEvents({ kind: "context_checkpoint_armed" })).toHaveLength(1); // it did arm
});
