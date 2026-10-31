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
import { DEFAULT_SIZES_CFG, PLAN_WAITS_TEXT, operatorUpLine, plannerDenyText, sideStopSteer, type SizeUp } from "../src/engine/order-size";

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
  const spy = spyOn(commitFinishModule, "readRunBaseline");
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

// Fail closed (Task 8 review): a quick or standard brief never runs without its guard.
import * as sizeGuardModule from "../src/engine/size-guard";
import { configureFaults, createFaultReporter } from "../src/engine/fault";

test("(a) the guard cannot be made: the order runs BIG — the big preamble, no small rules — and the fault is reported", async () => {
  const { root } = project();
  const faultsSeen: string[] = [];
  configureFaults(createFaultReporter({ log: (l) => void faultsSeen.push(l) }, { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false, maxHandoffsPerHour: 0 }));
  const spy = spyOn(sizeGuardModule, "createSizeGuard").mockImplementation(() => {
    throw new Error("boom in the guard");
  });
  try {
    const { d, replies } = makeDeps();
    const forced: string[] = [];
    const { ctl, start } = drivenStart();
    await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick", hooks: { onSizeForced: (why) => void forced.push(why) } });
    await settle();
    expect(ctl.order!.task).toBe(briefWithProjectDocs("fix it"));
    expect(ctl.h!.contextSteer?.("Agent", { subagent_type: "planner", prompt: "x" })).toBeUndefined();
    expect(forced).toEqual([expect.stringContaining("guard")]);
    expect(d.ledger.listEvents({ kind: "size_forced" })[0]!.data).toMatchObject({ project: "proj", from: "quick", to: "big" });
    expect(faultsSeen.some((l) => l.includes("dispatch.sizeGuard") && l.includes("boom in the guard"))).toBe(true);
    // Its result is not clamped as quick.
    ctl.resolve!(good("a\nb\nc\nd\ne"));
    await settle(60);
    expect(replies.find((r) => r.text.startsWith("proj finished:"))!.text).toBe("proj finished: a\nb\nc\nd\ne");
  } finally {
    spy.mockRestore();
    configureFaults(createFaultReporter({ log: (l) => console.error(l) }, { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false, maxHandoffsPerHour: 0 }));
  }
});

test("(b) a quick brief delivered into an already-live session goes out with the BIG preamble and is recorded big", async () => {
  const { root, dir } = project();
  const { d, replies } = makeDeps();
  const live = d.registry.add({ id: "d1", source: "neo", folder: dir, task: "x", chatId: -2, createdAt: 0 }, 0);
  d.registry.setStatus(live.id, "running");
  const followUps: string[] = [];
  d.registry.attachControl(live.id, { followUp: (t: string) => void followUps.push(t), queued: () => 0, active: () => false, interrupt: async () => {} });
  const forced: string[] = [];
  const launched: string[] = [];
  await dispatchToProject("proj", "fix it", d, 1, {
    start: (() => {
      throw new Error("must not start a second run");
    }) as never,
    root,
    size: "quick",
    hooks: { onSizeForced: (why) => void forced.push(why), onLaunched: (_o, mode) => void launched.push(mode) },
  });
  expect(followUps).toEqual([briefWithProjectDocs("fix it")]);
  expect(launched).toEqual(["delivered"]);
  expect(forced).toEqual([expect.stringContaining("live session")]);
  expect(d.ledger.listEvents({ kind: "size_forced" })[0]!.data).toMatchObject({ from: "quick", to: "big" });
  expect(replies.some((r) => r.text === "→ dispatching to proj [big]: fix it")).toBe(true);
});

test("a big brief delivered into a live session is not 'forced' (it is big already)", async () => {
  const { root, dir } = project();
  const { d } = makeDeps();
  const live = d.registry.add({ id: "d1", source: "neo", folder: dir, task: "x", chatId: -2, createdAt: 0 }, 0);
  d.registry.setStatus(live.id, "running");
  d.registry.attachControl(live.id, { followUp: () => {}, queued: () => 0, active: () => false, interrupt: async () => {} });
  const forced: string[] = [];
  await dispatchToProject("proj", "build it", d, 1, { root, size: "big", hooks: { onSizeForced: (why) => void forced.push(why) } });
  expect(forced).toEqual([]);
  expect(d.ledger.listEvents({ kind: "size_forced" })).toHaveLength(0);
});

// ── Review fixes (ADR-0072 as built) ─────────────────────────────────────────────────────────────────

test("review: a side lane that shares the main folder measures nothing — the main lane's edits never move it up", async () => {
  for (const kind of ["ops", "read-only", "test"] as const) {
    const { root, dir } = project();
    const { d } = makeDeps();
    const ends: TodoEnd[] = [];
    const { ctl, start } = drivenStart();
    await dispatchToProject("proj", "check it", d, 1, { start: start as never, root, size: "quick", lane: { kind, todoId: 5 }, hooks: { onEnd: (e) => void ends.push(e) } });
    await settle();
    // The main lane writes six files in the same folder while the side lane runs.
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, `main${i}.ts`), "x\n");
    // A commit in the side lane is judged on its own estimate, not on git's view of the shared folder.
    expect(call(ctl.h!, "c1", "Bash", { command: "git commit -m x" }), kind).toBeUndefined();
    ctl.resolve!(good());
    await settle(60);
    expect(ends[0]!.size, kind).toMatchObject({ size: "quick", requeue: false });
    expect(ends[0]!.size!.late).toBeUndefined();
    expect(d.ledger.listEvents({ kind: "size_up" }), kind).toHaveLength(0);
    expect(d.ledger.listEvents({ kind: "size_measure_failed" }), kind).toHaveLength(0);
  }
});

test("review: a git that cannot read the repository at the start fails closed — the order runs big, size_measure_failed recorded", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-dsz-broken-"));
  const dir = join(root, "proj");
  mkdirSync(join(dir, ".git"), { recursive: true }); // a repository git cannot read
  const { d } = makeDeps();
  const forced: string[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick", hooks: { onSizeForced: (why) => void forced.push(why) } });
  await settle();
  expect(ctl.order!.task).toBe(briefWithProjectDocs("fix it"));
  expect(forced).toEqual([expect.stringContaining("could not read git")]);
  expect(d.ledger.listEvents({ kind: "size_measure_failed" })[0]!.data).toMatchObject({ project: "proj", size: "quick" });
  // A folder outside git is no failure: it stays quick, on estimates.
  const plainRoot = mkdtempSync(join(tmpdir(), "neo-dsz-plain-"));
  mkdirSync(join(plainRoot, "proj"));
  const p = makeDeps();
  const s2 = drivenStart();
  await dispatchToProject("proj", "fix it", p.d, 1, { start: s2.start as never, root: plainRoot, size: "quick" });
  await settle();
  expect(s2.ctl.order!.task).toBe(briefForSize("quick", "fix it"));
  expect(p.d.ledger.listEvents({ kind: "size_measure_failed" })).toHaveLength(0);
});

test("review: the worker SDK is read once — a config flip mid-dispatch never gives a quick preamble with no guard", async () => {
  const { root } = project();
  let flipped = false;
  const providers = { get ownWork() { return flipped ? "codex" : "claude"; }, customerWork: "gemini" };
  const { d } = makeDeps({ providers: providers as never, reply: () => void (flipped = true) });
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick" });
  await settle();
  expect(flipped).toBe(true);
  expect(ctl.order!.task).toBe(briefForSize("quick", "fix it"));
  expect(ctl.h!.contextSteer?.("Agent", { subagent_type: "planner", prompt: "x" })).toBe(plannerDenyText("quick"));
});

test("review: a big run is measured at its end for the record, with no opinion and no plan-gate change", async () => {
  const { root, dir } = project();
  const { d } = makeDeps({ commitFinish: { ...DEFAULT_COMMIT_FINISH_CFG, enabled: false } });
  const ends: TodoEnd[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "build it", d, 1, { start: start as never, root, size: "big", hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  expect(ctl.h!.contextSteer?.("Agent", { subagent_type: "planner", prompt: "x" })).toBeUndefined();
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `b${i}.ts`), "x\n");
  ctl.resolve!(good());
  await settle(60);
  expect(d.ledger.listEvents({ kind: "size_measured" })[0]!.data).toMatchObject({ project: "proj", size: "big", files: 3 });
  expect(ends[0]!.size).toMatchObject({ size: "big", requeue: false });
  expect(d.ledger.listEvents({ kind: "size_up" })).toHaveLength(0);
  expect(d.ledger.listEvents({ kind: "size_forced" })).toHaveLength(0);
});

test("review (AC 13): a run moved to big that ends with its plan waiting says so in its result", async () => {
  const { root, dir } = project();
  const { d, replies } = makeDeps();
  const ends: TodoEnd[] = [];
  const { ctl, start } = drivenStart();
  await dispatchToProject("proj", "fix it", d, 1, { start: start as never, root, size: "quick", hooks: { onEnd: (e) => void ends.push(e) } });
  await settle();
  call(ctl.h!, "t1", "Write", { file_path: join(dir, "src/auth/token.ts"), content: "x\n" });
  mkdirSync(join(dir, "docs/superpowers/plans"), { recursive: true });
  ctl.h!.onToolUse?.("p1", "Write", { file_path: join(dir, PLAN), content: SMALL_PLAN });
  writeFileSync(join(dir, PLAN), SMALL_PLAN);
  ctl.h!.onToolResult?.("p1", false);
  await settle();
  ctl.resolve!(good("wrote the plan"));
  await settle(80);
  expect(ends[0]!.size).toMatchObject({ size: "big", requeue: false, planWaits: true });
  expect(ends[0]!.summary).toContain(PLAN_WAITS_TEXT);
  expect(replies.find((r) => r.text.startsWith("proj finished:"))!.text).toContain(PLAN_WAITS_TEXT);
});
