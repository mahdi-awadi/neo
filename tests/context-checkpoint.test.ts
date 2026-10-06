// ADR-0014: a SAFE CHECKPOINT is the only mid-task moment the engine may hand a session off — work
// committed (a commit just succeeded, or the plan marked a step done) and a clean tree. The watch is
// fed raw stream facts and arms the governor-hook steer; the resume probe measures orientation.
import { test, expect } from "bun:test";
import { createCheckpointWatch, createResumeProbe, steerAllows } from "../src/engine/context-checkpoint";
import { checkpointSteer, type ContextPolicyCfg } from "../src/engine/context-policy";

const FOLDER = "/home/proj";
const CFG: ContextPolicyCfg = {
  sweetSpotPct: 0.4,
  checkpointPct: 0.6,
  emergencyPct: 0.9,
  handoffNoteMaxChars: 20_000,
  handoffOrientationMaxSteps: 70,
  maxTurns: 200,
  maxAgeMs: 604_800_000,
  handoffTimeoutMs: 180_000,
  staleResumePct: 0.35,
  cacheTtlFallbackMs: 3_600_000,
  cacheTtlMinObservations: 5,
};
const OPUS = "claude-opus-5-5";
const usage = (tokens: number) => ({ input_tokens: 2, cache_read_input_tokens: tokens - 2, cache_creation_input_tokens: 0 });

function watch(over: { uncommitted?: string[] | undefined; cfg?: Partial<ContextPolicyCfg>; windows?: Record<string, number> } = {}) {
  const armed: unknown[] = [];
  const w = createCheckpointWatch({
    folder: FOLDER,
    cfg: { ...CFG, ...over.cfg },
    windows: () => over.windows ?? { [OPUS]: 1_000_000 },
    now: () => 42,
    uncommitted: () => ("uncommitted" in over ? over.uncommitted : []),
    onArm: (a) => void armed.push(a),
  });
  return { w, armed };
}

function commit(w: ReturnType<typeof watch>["w"], id: string, isError = false) {
  w.onToolUse(id, "Bash", { command: 'git commit -m "phase 2"' });
  w.onToolResult(id, isError);
}

test("a successful commit at a heavy occupancy with a clean tree arms the checkpoint once", () => {
  const { w, armed } = watch();
  w.onUsage(OPUS, usage(650_000));
  commit(w, "c1");
  expect(w.armed()).toEqual({ at: 42, occupancy: 0.65, decision: { verdict: "handoff", reason: "heavy", band: "heavy" } });
  commit(w, "c2");
  expect(armed).toHaveLength(1);
});

test("no arming below the checkpoint line, on a dirty tree, outside git, on an unknown window, or on a failed commit", () => {
  const below = watch();
  below.w.onUsage(OPUS, usage(500_000));
  commit(below.w, "c");
  expect(below.w.armed()).toBeUndefined();

  for (const over of [{ uncommitted: ["src/a.ts"] }, { uncommitted: undefined }, { windows: {} }]) {
    const { w } = watch(over);
    w.onUsage(OPUS, usage(650_000));
    commit(w, "c");
    expect(w.armed()).toBeUndefined();
  }

  const failed = watch();
  failed.w.onUsage(OPUS, usage(650_000));
  commit(failed.w, "c", true);
  expect(failed.w.armed()).toBeUndefined();
});

test("a checkpointPct of 1 or more turns mid-task handoffs off", () => {
  const { w } = watch({ cfg: { checkpointPct: 1 } });
  w.onUsage(OPUS, usage(850_000));
  commit(w, "c");
  expect(w.armed()).toBeUndefined();
});

test("a completed plan step is a checkpoint, and the plan's growth projects the overflow", () => {
  const { w } = watch();
  const plan = (done: number) => ({ todos: Array.from({ length: 5 }, (_, i) => ({ content: `s${i}`, status: i < done ? "completed" : "pending", activeForm: "x" })) });
  w.onUsage(OPUS, usage(300_000));
  w.onToolUse("p1", "TodoWrite", plan(0)); // the plan's starting point: 30%, 0 of 5 done
  w.onUsage(OPUS, usage(450_000));
  w.onToolUse("p2", "TodoWrite", plan(1)); // 45% after one step → +15% per step × 4 left = 105%
  expect(w.armed()?.decision.reason).toBe("projected-overflow");
});

test("a plan step inside the sweet spot never arms, whatever the projection", () => {
  const { w } = watch();
  const plan = (done: number) => ({ todos: Array.from({ length: 10 }, (_, i) => ({ content: `s${i}`, status: i < done ? "completed" : "pending" })) });
  w.onUsage(OPUS, usage(50_000));
  w.onToolUse("p1", "TodoWrite", plan(0));
  w.onUsage(OPUS, usage(350_000));
  w.onToolUse("p2", "TodoWrite", plan(1));
  expect(w.armed()).toBeUndefined();
});

test("steerAllows: only what writing and committing the note needs", () => {
  const ok = (tool: string, input: unknown) => steerAllows(FOLDER, tool, input);
  expect(ok("Read", { file_path: "/home/proj/src/a.ts" })).toBe(true);
  expect(ok("Grep", { pattern: "x" })).toBe(true);
  expect(ok("Write", { file_path: "/home/proj/HANDOFF.md", content: "n" })).toBe(true);
  expect(ok("Edit", { file_path: "HANDOFF.md", old_string: "a", new_string: "b" })).toBe(true); // relative to the folder
  expect(ok("Write", { file_path: "/home/proj/src/a.ts", content: "x" })).toBe(false);
  expect(ok("Write", { file_path: "/home/proj/sub/HANDOFF.md", content: "x" })).toBe(false);
  expect(ok("Bash", { command: "git add HANDOFF.md && git commit -m 'handoff'" })).toBe(true);
  expect(ok("Bash", { command: "git status; git log -1" })).toBe(true);
  expect(ok("Bash", { command: "git commit -m x && rm -rf y" })).toBe(false);
  expect(ok("Bash", { command: "git commit -m $(rm -rf y)" })).toBe(false);
  expect(ok("Bash", { command: "npm test" })).toBe(false);
  expect(ok("Bash", { command: "git push" })).toBe(false);
  expect(ok("Bash", { command: "git status & rm -rf src" })).toBe(false); // a lone & runs both
  expect(ok("Bash", { command: "git log --output=src/a.ts" })).toBe(false); // log can write files
  expect(ok("Bash", { command: "git branch -D main" })).toBe(false); // branch can delete
  expect(ok("Bash", { command: "git rev-parse --abbrev-ref HEAD" })).toBe(true);
  expect(ok("mcp__neo__dispatch", {})).toBe(false);
  expect(ok("Task", { prompt: "go on" })).toBe(false);
});

test("an armed watch steers every other tool to the note; an unarmed one has no opinion", () => {
  const { w } = watch();
  expect(w.steer("Edit", { file_path: "/home/proj/a.ts" })).toBeUndefined();
  w.onUsage(OPUS, usage(650_000));
  commit(w, "c");
  expect(w.steer("Edit", { file_path: "/home/proj/a.ts" })).toBe(checkpointSteer(0.65));
  expect(w.steer("Write", { file_path: "/home/proj/HANDOFF.md" })).toBeUndefined();
  w.disarm();
  expect(w.steer("Edit", { file_path: "/home/proj/a.ts" })).toBeUndefined();
});

test("the resume probe counts model calls up to the first edit or commit, once", () => {
  const hits: unknown[] = [];
  const p = createResumeProbe((r) => void hits.push(r));
  p.onUsage();
  p.onToolUse("r", "Read", { file_path: "/x" });
  p.onUsage();
  expect(p.report()).toEqual({ productive: false, steps: 2 });
  p.onUsage();
  p.onToolUse("e", "Edit", { file_path: "/x" });
  p.onUsage();
  p.onToolUse("e2", "Edit", { file_path: "/y" });
  expect(hits).toEqual([{ productive: true, steps: 3 }]);
  expect(p.report()).toEqual({ productive: true, steps: 3 });
});

test("a commit is a productive action for the probe", () => {
  const p = createResumeProbe();
  p.onUsage();
  p.onToolUse("c", "Bash", { command: "git commit -am wip" });
  expect(p.report()).toEqual({ productive: true, steps: 1 });
});
