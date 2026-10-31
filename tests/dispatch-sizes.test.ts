// ADR-0072: dispatch runs each order at its size — the size's preamble, the upgrade guard in the governor
// hook (after a held plan's STOP, before the context checkpoint), one line and one note for each move up, the
// plan watch per size, the guard's end on the todo's end, and a quick result clamped for the operator.
import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { briefForSize, briefWithProjectDocs, dispatchToProject, type DispatchDeps, type TodoEnd } from "../src/engine/dispatch";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";
import type { PostPlan } from "../src/engine/plans";
import { DEFAULT_COMMIT_FINISH_CFG } from "../src/engine/commit-finish";
import * as commitFinishModule from "../src/engine/commit-finish";
import { DEFAULT_SIZES_CFG, operatorUpLine, plannerDenyText, sideStopSteer, type SizeUp } from "../src/engine/order-size";

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** A root with one git project `proj`. */
function project(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "neo-dsz-"));
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
  const notes: Array<{ text: string; wake: boolean }> = [];
  const posts: string[] = [];
  const postPlan: PostPlan = async (_rec, path) => (posts.push(path), { chatId: -100, messageId: 500 + posts.length });
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, _p, priority) => void replies.push({ text, priority }),
    askApproval: async () => "deny",
    dispatcher: { deliver: (text, opts) => (notes.push({ text, wake: opts.wake }), true) },
    postPlan,
    ...over,
  };
  return { d, replies, notes, posts };
}

function drivenStart() {
  const ctl: { h?: RunHandlers; order?: Order; resolve?: (r: RunResult) => void } = {};
  const start = (o: Order, h: RunHandlers) => {
    ctl.order = o;
    ctl.h = h;
    return {
      followUp: () => {},
      queued: () => 0,
      active: () => false,
      interrupt: async () => {},
      close: () => {},
      closed: () => false,
      done: new Promise<RunResult>((res) => (ctl.resolve = res)),
    };
  };
  return { ctl, start };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const good = (summary = "done"): RunResult => ({ ok: true, sessionId: "s1", summary, costUsd: 0 });

/** One tool call through the hook and the stream, as the runner does it: the steer, then use and result. */
function call(h: RunHandlers, id: string, tool: string, input: Record<string, unknown>, ok = true): string | undefined {
  const denied = h.contextSteer?.(tool, input);
  if (denied) return denied;
  h.onToolUse?.(id, tool, input);
  h.onToolResult?.(id, !ok);
  return undefined;
}

const PLAN = "docs/superpowers/plans/x.md";
const BIG_PLAN = "# Wallet bars\n### Task 1: table\n- [ ] add the bars migration\n- [ ] charge the wallet\n";
const SMALL_PLAN = "# Rename a label\n- [ ] rename it\n- [ ] test it\n";

test("opts.size quick → the quick preamble and a [quick] start line; no size → big, as today", async () => {
  const { root } = project();
  const a = makeDeps();
  const s1 = drivenStart();
  await dispatchToProject("proj", "fix the picker", a.d, 1, { start: s1.start as never, root, size: "quick" });
  await settle();
  expect(s1.ctl.order!.task).toBe(briefForSize("quick", "fix the picker"));
  expect(a.replies.some((r) => r.text === "→ dispatching to proj [quick]: fix the picker")).toBe(true);

  const b = makeDeps();
  const s2 = drivenStart();
  await dispatchToProject("proj", "fix the picker", b.d, 1, { start: s2.start as never, root });
  await settle();
  expect(s2.ctl.order!.task).toBe(briefWithProjectDocs("fix the picker"));
  expect(b.replies.some((r) => r.text === "→ dispatching to proj: fix the picker")).toBe(true);
});

test("the guard steers a quick run: the planner is denied; a big run has no guard opinion", async () => {
  const { root } = project();
  const { d } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick" });
  await settle();
  expect(ctl.h!.contextSteer?.("Agent", { subagent_type: "planner", prompt: "x" })).toBe(plannerDenyText("quick"));

  const big = drivenStart();
  await dispatchToProject("proj", "build it", makeDeps().d, 1, { start: big.start as never, root, size: "big" });
  await settle();
  expect(big.ctl.h!.contextSteer?.("Agent", { subagent_type: "planner", prompt: "x" })).toBeUndefined();
});

test("a move up: size_up recorded, one operator line, a [size] note with wake false, hooks.onSizeUp; then a plan written gets gate approval", async () => {
  const { root, dir } = project();
  const { d, replies, notes } = makeDeps();
  const ups: SizeUp[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick", todoId: 812, hooks: { onSizeUp: (u) => void ups.push(u), onEnd: () => {} } });
  await settle();
  const denied = call(ctl.h!, "t1", "Write", { file_path: join(dir, "src/auth/token.ts"), content: "x\n" });
  expect(denied).toStartWith("STOP — Neo moved this order up from QUICK to BIG");
  expect(ups).toHaveLength(1);
  expect(ups[0]).toMatchObject({ from: "quick", to: "big", rule: "auth" });
  const ev = d.ledger.listEvents({ kind: "size_up" });
  expect(ev).toHaveLength(1);
  expect(ev[0]!.orderId).toBe(ctl.order!.id);
  expect(ev[0]!.data).toMatchObject({ project: "proj", from: "quick", to: "big", rule: "auth" });
  expect(replies.filter((r) => r.text.startsWith("↑ ")).map((r) => r.text)).toEqual([operatorUpLine({ project: "proj", todoId: 812, up: ups[0]! })]);
  await settle(); // the note goes out detached, like a spin alert
  const sizeNotes = notes.filter((n) => n.text.startsWith("[size]"));
  expect(sizeNotes).toHaveLength(1);
  expect(sizeNotes[0]).toMatchObject({ wake: false, text: expect.stringContaining("[size] proj #812 moved up quick → big: it touches auth") });
  // Plan first: the plan file runs; a small plan written now still waits for the operator (forceApproval).
  mkdirSync(join(dir, "docs/superpowers/plans"), { recursive: true });
  expect(ctl.h!.contextSteer?.("Write", { file_path: join(dir, PLAN), content: SMALL_PLAN })).toBeUndefined();
  ctl.h!.onToolUse?.("p1", "Write", { file_path: join(dir, PLAN), content: SMALL_PLAN });
  writeFileSync(join(dir, PLAN), SMALL_PLAN);
  ctl.h!.onToolResult?.("p1", false);
  await settle();
  expect(d.ledger.planByPath(dir, PLAN)).toMatchObject({ gate: "approval" });
  expect(ctl.h!.contextSteer?.("Bash", { command: "ls" })).toStartWith(`STOP — ${PLAN} is a big plan`);
});

test("a held plan's STOP comes before the guard; onHold in a standard run raises the size to big", async () => {
  const { root, dir } = project();
  const { d, replies } = makeDeps();
  const ups: SizeUp[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "add a filter", d, 1, { start: start as never, root, size: "standard", hooks: { onSizeUp: (u) => void ups.push(u) } });
  await settle();
  mkdirSync(join(dir, "docs/superpowers/plans"), { recursive: true });
  ctl.h!.onToolUse?.("p1", "Write", { file_path: join(dir, PLAN), content: BIG_PLAN });
  writeFileSync(join(dir, PLAN), BIG_PLAN);
  ctl.h!.onToolResult?.("p1", false);
  await settle();
  expect(ctl.h!.contextSteer?.("Agent", { subagent_type: "planner" })).toStartWith(`STOP — ${PLAN} is a big plan`);
  expect(ups).toEqual([expect.objectContaining({ from: "standard", to: "big", rule: "plan" })]);
  expect(d.ledger.listEvents({ kind: "size_up" })[0]!.data).toMatchObject({ rule: "plan" });
  expect(replies.some((r) => r.text.startsWith("↑ proj standard → big: its plan needs the operator's approval"))).toBe(true);
});

test("a quick run's plan watch never holds: an edited big plan is sent, not held", async () => {
  const { root, dir } = project();
  mkdirSync(join(dir, "docs/superpowers/plans"), { recursive: true });
  writeFileSync(join(dir, PLAN), SMALL_PLAN);
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "plan");
  const { d, posts } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick" });
  await settle();
  ctl.h!.onToolUse?.("e1", "Edit", { file_path: join(dir, PLAN), old_string: "x", new_string: "y" });
  writeFileSync(join(dir, PLAN), BIG_PLAN);
  ctl.h!.onToolResult?.("e1", false);
  await settle();
  expect(posts).toEqual([join(dir, PLAN)]);
  expect(d.ledger.planByPath(dir, PLAN)!.heldAt).toBeUndefined();
  expect(ctl.h!.contextSteer?.("Bash", { command: "ls" })).toBeUndefined();
});

test("the end: size_measured recorded; plan first with no plan of its own → TodoEnd.size.requeue", async () => {
  const { root, dir } = project();
  const { d } = makeDeps();
  const ends: TodoEnd[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick", hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  call(ctl.h!, "t1", "Write", { file_path: join(dir, "src/auth/token.ts"), content: "x\n" });
  ctl.resolve!(good("stopped for a plan"));
  await settle(60);
  expect(ends[0]!.size).toMatchObject({ size: "big", requeue: true });
  expect(d.ledger.listEvents({ kind: "size_measured" })[0]!.data).toMatchObject({ project: "proj", size: "big", files: 0, lines: 0 });
});

test("the end: a quick run whose final measure passes its limits records a late move", async () => {
  const { root, dir } = project();
  const { d, replies } = makeDeps();
  const ends: TodoEnd[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick", hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `f${i}.ts`), "x\n"); // made by Bash the estimate missed
  ctl.resolve!(good());
  await settle(60);
  expect(ends[0]!.size).toMatchObject({ size: "standard", requeue: false, late: expect.objectContaining({ from: "quick", to: "standard", rule: "files", late: true }) });
  expect(d.ledger.listEvents({ kind: "size_up" })[0]!.data).toMatchObject({ late: true });
  expect(replies.some((r) => r.text.includes("found after the run ended"))).toBe(true);
  expect(d.ledger.listEvents({ kind: "size_measured" })[0]!.data).toMatchObject({ size: "standard", files: 6 });
});

test("a quick result to the operator is clamped to 3 lines plus the thread pointer; the dispatcher report is full", async () => {
  const { root } = project();
  const trace = { ref: () => "m4f2", refreshThread: () => {} } as never;
  const { d, replies, notes } = makeDeps({ trace });
  const { ctl, start } = drivenStart();
  const cause = { msgId: 1, threadId: 9 };
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick", cause });
  await settle();
  const long = ["cause: x", "fix: y", "commit: z", "extra 4", "extra 5", "extra 6"].join("\n");
  ctl.resolve!(good(long));
  await settle(60);
  const line = replies.find((r) => r.text.startsWith("proj finished:"))!.text;
  expect(line).toBe("proj finished: cause: x\nfix: y\ncommit: z\n… (the full result is in thread m4f2)");
  expect(notes.find((n) => n.text.includes("[dispatch result"))!.text).toContain("extra 6");
});

test("a quick failure is never clamped", async () => {
  const { root } = project();
  const { d, replies } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick" });
  await settle();
  ctl.resolve!({ ok: false, sessionId: "s1", summary: "a\nb\nc\nd\ne", costUsd: 0 });
  await settle(60);
  expect(replies.find((r) => r.text.startsWith("proj: a"))!.text).toStartWith("proj: a\nb\nc\nd\ne");
});

test("a standard or big result is not clamped", async () => {
  const { root } = project();
  const { d, replies } = makeDeps();
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "standard" });
  await settle();
  ctl.resolve!(good("a\nb\nc\nd\ne"));
  await settle(60);
  expect(replies.find((r) => r.text.startsWith("proj finished:"))!.text).toBe("proj finished: a\nb\nc\nd\ne");
});

test("Codex own work: no guard (no steer at all) and the big preamble", async () => {
  const { root } = project();
  const { d } = makeDeps({ providers: { ownWork: "codex", customerWork: "gemini" } as never });
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick" });
  await settle();
  expect(ctl.h!.contextSteer).toBeUndefined();
  expect(ctl.order!.task).toBe(briefWithProjectDocs("fix it"));
});

test("sizes disabled: every order runs big, with no guard", async () => {
  const { root } = project();
  const { d } = makeDeps({ sizes: { ...DEFAULT_SIZES_CFG, enabled: false } });
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick" });
  await settle();
  expect(ctl.order!.task).toBe(briefWithProjectDocs("fix it"));
  expect(ctl.h!.contextSteer?.("Agent", { subagent_type: "planner" })).toBeUndefined();
});

test("a side lane gets its guard with `side`: a move to big stops it on every later non-read call", async () => {
  const { root, dir } = project();
  const { d, replies } = makeDeps();
  const ends: TodoEnd[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "make an admin", d, 1, { start: start as never, root, size: "quick", lane: { kind: "ops", todoId: 817 }, hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  const stop = call(ctl.h!, "t1", "Write", { file_path: join(dir, "src/auth/token.ts"), content: "x\n" })!;
  expect(stop).toStartWith("STOP — Neo moved this side-lane order up from QUICK to BIG");
  const up = d.ledger.listEvents({ kind: "size_up" })[0]!.data as unknown as SizeUp;
  expect(stop).toBe(sideStopSteer({ ...up, at: 0 }));
  expect(ctl.h!.contextSteer?.("Bash", { command: "ls" })).toBe(stop);
  expect(ctl.h!.contextSteer?.("Read", { file_path: join(dir, "a.ts") })).toBeUndefined();
  expect(replies.some((r) => r.text.startsWith("↑ proj-side-ops #817 quick → big") && r.text.endsWith("the side lane stops; the todo joins the main queue as big"))).toBe(true);
  ctl.resolve!(good());
  await settle(60);
  expect(ends[0]!.size).toMatchObject({ size: "big" });
});

test("one runBaseline for each run, shared by the commit finish and the guard", async () => {
  const { root } = project();
  const spy = spyOn(commitFinishModule, "runBaseline");
  try {
    const { d } = makeDeps({ commitFinish: DEFAULT_COMMIT_FINISH_CFG });
    const { start } = drivenStart();
    await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick" });
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
