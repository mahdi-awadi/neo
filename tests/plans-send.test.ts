// Task 2.2 (ADR-0019, spec §10): the engine sends every plan once, tracks its status.
import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger, type Ledger } from "../src/engine/ledger";
import {
  applyPlanAction,
  headSha,
  offerPlanFile,
  onRunEndPlans,
  planActions,
  readPlansCfg,
  renderPlans,
  DEFAULT_PLANS_CFG,
  type PlanDeps,
  type PostPlan,
} from "../src/engine/plans";
import { handleCommand } from "../src/engine/commands";
import { createRegistry } from "../src/engine/registry";
import { openTrustStore } from "../src/engine/trust";
import type { Trace } from "../src/engine/trace";
import { startLoop, startScheduledLoop, type LoopDef } from "../src/engine/loops";
import type { RunResult } from "../src/engine/session-runner";
import type { TodoQueue } from "../src/engine/todo-queue";
import { sendProjectFile, type DispatchDeps } from "../src/engine/dispatch";

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-plans-send-"));
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x");
  sh(dir, "add", "."); sh(dir, "commit", "-qm", "init");
  return dir;
}
const put = (dir: string, rel: string, body: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

const PLAN = "docs/superpowers/plans/fare.md";
const BODY = "# Fare list port\n- [ ] one\n- [ ] two\n";
const cause = { msgId: 7, threadId: 7 };
const fakeTrace = (): Trace & { lines: unknown[]; binds: unknown[] } => {
  const lines: unknown[] = [];
  const binds: unknown[] = [];
  return {
    lines,
    binds,
    ref: () => "m4g2",
    outbound: (p: unknown) => (lines.push(p), 99),
    bindChannel: (...a: unknown[]) => void binds.push(a),
    refreshThread: () => {},
  } as unknown as Trace & { lines: unknown[]; binds: unknown[] };
};

function rig(over: Partial<PlanDeps> = {}) {
  const ledger = openLedger(":memory:");
  const posts: Array<{ rec: Parameters<PostPlan>[0]; path: string; caption: string }> = [];
  const postPlan: PostPlan = async (rec, path, caption) => {
    posts.push({ rec, path, caption });
    return { chatId: -100, messageId: 500 + posts.length };
  };
  const trace = fakeTrace();
  const deps: PlanDeps = { ledger, cfg: DEFAULT_PLANS_CFG, postPlan, trace, ...over };
  return { ledger, posts, deps, trace };
}

/** A todo queue that records submits and creates the todo the way the real queue does. */
function fakeTodo(ledger: Ledger, opts: { refuse?: boolean } = {}) {
  const submitted: Array<Parameters<TodoQueue["submit"]>[0]> = [];
  const todo = {
    submit: async (p: Parameters<TodoQueue["submit"]>[0]) => {
      submitted.push(p);
      if (opts.refuse) return "refused: the engine is reloading";
      const t = ledger.addTodo({ project: p.project, folder: p.project, brief: p.brief, workClass: p.workClass, createdBy: "operator", cause: p.cause, planId: p.planId });
      return `→ dispatching (todo #${t.id})`;
    },
    launcher: () => ({ deps: {} as DispatchDeps, replyChat: 42 }),
  } as unknown as TodoQueue;
  return { todo, submitted };
}

test("run end with a new plan: posted once with its caption and state, a decision opened with its buttons, status sent", async () => {
  const dir = repo();
  const { ledger, posts, deps, trace } = rig();
  const start = headSha(dir);
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, startSha: start, cause, chatId: 42 });
  expect(posts).toHaveLength(1);
  // The run is over, so nobody builds it: the card waits for Approve & build (ADR-0036).
  expect(posts[0]!.caption).toBe("📄 plan · gold · Fare list port · thread m4g2\n⏸ waiting for your approval");
  expect(posts[0]!.rec.actions).toEqual(["approve", "changes", "drop"]);
  expect(posts[0]!.path).toBe(join(dir, PLAN));
  const plan = ledger.planByPath(dir, PLAN)!;
  expect(plan.status).toBe("sent");
  expect(posts[0]!.rec).toMatchObject({ planId: plan.id, status: "sent" });
  const dec = ledger.decisionById(plan.decisionId!)!;
  expect(dec).toMatchObject({ status: "open", chatId: 42, options: ["Approve & build", "Changes", "Drop"], decisionMessageId: 501, project: "gold", folder: dir });
  expect(dec.cause).toEqual(cause);
  expect(plan).toMatchObject({ gate: "approval", cardChatId: -100, cardMessageId: 501 });
  // The send is a `plan` line of its thread, bound to the posted card.
  expect(trace.lines).toEqual([expect.objectContaining({ kind: "plan", cause, project: "gold" })]);
  expect(trace.binds).toEqual([[99, -100, 501]]);
  // A second run end with the same content sends nothing.
  await onRunEndPlans(deps, { project: "gold", folder: dir, startSha: start, cause, chatId: 42 });
  expect(posts).toHaveLength(1);
});

test("a worker's own send_file of a plan goes through the registry: then run end sends nothing more", async () => {
  const dir = repo();
  const { posts, deps } = rig();
  const start = headSha(dir);
  put(dir, PLAN, BODY);
  expect(await offerPlanFile(deps, { project: "gold", folder: dir, path: PLAN, cause, chatId: 42 })).toEqual({ handled: true, text: `sent plan ${PLAN}` });
  expect(await offerPlanFile(deps, { project: "gold", folder: dir, path: PLAN, cause, chatId: 42 })).toEqual({
    handled: true,
    text: `already sent: ${PLAN} — this version reached the operator`,
  });
  await onRunEndPlans(deps, { project: "gold", folder: dir, startSha: start, cause, chatId: 42 });
  expect(posts).toHaveLength(1);
  // Not a plan path → not handled here (the caller sends it as a plain file).
  put(dir, "notes.md", "# n");
  expect(await offerPlanFile(deps, { project: "gold", folder: dir, path: "notes.md", chatId: 42 })).toEqual({ handled: false });
});

test("a changed plan is sent again as v2 and the old card's decision is closed", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  const firstDecision = ledger.planByPath(dir, PLAN)!.decisionId!;
  put(dir, PLAN, BODY + "- [ ] three\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  expect(posts.map((p) => p.caption.split("\n")[0])).toEqual(["📄 plan · gold · Fare list port · thread m4g2", "📄 plan · gold · Fare list port · v2 · thread m4g2"]);
  // ADR-0053: superseded with the reason (never a silent dismiss), so its thread stops waiting on it.
  expect(ledger.decisionById(firstDecision)).toMatchObject({ status: "superseded", answer: "replaced by plan card v2" });
  expect(ledger.planByPath(dir, PLAN)!.decisionId).not.toBe(firstDecision);
});

test("ADR-0053 B2: a todo parked on the old card now waits on the new card", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  const first = ledger.planByPath(dir, PLAN)!.decisionId!;
  const todo = ledger.addTodo({ project: "gold", folder: dir, brief: "continue", workClass: "interactive", createdBy: "operator" }, 1);
  ledger.updateTodo(todo.id, { status: "waiting", waitingOn: first });
  put(dir, PLAN, BODY + "- [ ] three\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  const second = ledger.planByPath(dir, PLAN)!.decisionId!;
  expect(ledger.todoById(todo.id)).toMatchObject({ status: "waiting", waitingOn: second });
});

test("no cause → the caption has no thread; no poster or send off → registered as draft, never sent", async () => {
  const dir = repo();
  const a = rig({ trace: undefined });
  put(dir, PLAN, BODY);
  await onRunEndPlans(a.deps, { project: "gold", folder: dir, chatId: 42 });
  expect(a.posts[0]!.caption.split("\n")[0]).toBe("📄 plan · gold · Fare list port");
  const b = rig({ postPlan: undefined });
  await onRunEndPlans(b.deps, { project: "gold", folder: dir, chatId: 42 });
  expect(b.ledger.planByPath(dir, PLAN)).toMatchObject({ status: "draft" });
  expect(b.ledger.listOpenDecisions()).toEqual([]);
  const c = rig({ cfg: { ...DEFAULT_PLANS_CFG, send: false } });
  await onRunEndPlans(c.deps, { project: "gold", folder: dir, chatId: 42 });
  expect(c.posts).toEqual([]);
  expect(c.ledger.planByPath(dir, PLAN)).toMatchObject({ status: "draft" });
});

test("a plan over plans.maxBytes is skipped and logged; a failed post leaves it unsent for the next run end", async () => {
  const dir = repo();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const big = rig({ cfg: { ...DEFAULT_PLANS_CFG, maxBytes: 10 } });
    put(dir, PLAN, BODY);
    await onRunEndPlans(big.deps, { project: "gold", folder: dir, chatId: 42 });
    expect(big.posts).toEqual([]);
    expect(big.ledger.planByPath(dir, PLAN)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
  let calls = 0;
  const flaky = rig({ postPlan: async () => (++calls === 1 ? undefined : { chatId: 1, messageId: 2 }) });
  await onRunEndPlans(flaky.deps, { project: "gold", folder: dir, chatId: 42 });
  expect(flaky.ledger.planByPath(dir, PLAN)).toMatchObject({ status: "draft" });
  expect(flaky.ledger.listOpenDecisions()).toEqual([]);
  await onRunEndPlans(flaky.deps, { project: "gold", folder: dir, chatId: 42 });
  expect(flaky.ledger.planByPath(dir, PLAN)).toMatchObject({ status: "sent" });
  expect(calls).toBe(2);
});

test("Execute twice → one todo; the second tap says it is already executing", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  const plan = ledger.planByPath(dir, PLAN)!;
  const { todo, submitted } = fakeTodo(ledger);
  const first = await applyPlanAction({ ...deps, todo }, plan.id, "execute");
  expect(first.ok).toBe(true);
  expect(first.text).toContain("#1");
  const second = await applyPlanAction({ ...deps, todo }, plan.id, "execute");
  expect(second).toEqual({ ok: false, text: "already building as #1" });
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ project: dir, planId: plan.id, workClass: "interactive", cause: { threadId: 7 } });
  expect(submitted[0]!.brief).toContain(PLAN);
  expect(ledger.planById(plan.id)).toMatchObject({ status: "executing", todoId: 1 });
  expect(ledger.decisionById(plan.decisionId!)).toMatchObject({ status: "answered", answer: "Execute" });
});

test("a refused Execute creates no todo and keeps the plan's status", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const plan = ledger.planByPath(dir, PLAN)!;
  const { todo } = fakeTodo(ledger, { refuse: true });
  expect(await applyPlanAction({ ...deps, todo }, plan.id, "execute")).toEqual({ ok: false, text: "refused: the engine is reloading" });
  expect(ledger.planById(plan.id)).toMatchObject({ status: "sent" });
  expect(ledger.planById(plan.id)!.todoId).toBeUndefined();
  expect(await applyPlanAction(deps, plan.id, "execute")).toEqual({ ok: false, text: "the todo queue is unavailable — Execute needs it" });
});

test("todo ends ok → still executing; all steps checked at a run end → done", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const plan = ledger.planByPath(dir, PLAN)!;
  const { todo } = fakeTodo(ledger);
  await applyPlanAction({ ...deps, todo }, plan.id, "execute");
  ledger.updateTodo(1, { status: "done", endedAt: 5 });
  expect(ledger.planById(plan.id)!.status).toBe("executing");
  put(dir, PLAN, "# Fare list port\n- [x] one\n- [ ] two\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(ledger.planById(plan.id)!.status).toBe("executing");
  put(dir, PLAN, "# Fare list port\n- [x] one\n- [x] two\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(ledger.planById(plan.id)).toMatchObject({ status: "done", stepsDone: 2 });
});

test("Approve & build with no worker held is an Execute; Done and Drop move the status; finished plans refuse more actions", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  put(dir, "plans/b.md", "# B");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const a = ledger.planByPath(dir, PLAN)!;
  const b = ledger.planByPath(dir, "plans/b.md")!;
  // No worker is held on it: Approve & build queues the build through ADR-0034's Execute.
  expect(await applyPlanAction(deps, a.id, "approve", undefined, { canResume: true })).toEqual({ ok: false, text: "the todo queue is unavailable — Execute needs it" });
  const { todo } = fakeTodo(ledger);
  expect(await applyPlanAction({ ...deps, todo }, a.id, "approve")).toMatchObject({ ok: true, text: expect.stringContaining("as todo #1") });
  expect(ledger.planById(a.id)).toMatchObject({ status: "executing", todoId: 1 });
  expect(await applyPlanAction({ ...deps, todo }, a.id, "approve")).toEqual({ ok: false, text: "already building as #1" });
  // Done is for a plan being built; the API cannot skip the buttons' rules.
  expect(await applyPlanAction(deps, b.id, "done")).toEqual({ ok: false, text: "a plan that is awaiting cannot be marked done" });
  expect(await applyPlanAction(deps, a.id, "done")).toEqual({ ok: true, text: "Marked done" });
  expect(ledger.planById(a.id)!.status).toBe("done");
  expect(await applyPlanAction(deps, a.id, "drop")).toEqual({ ok: false, text: "this plan is already done" });
  expect(await applyPlanAction(deps, b.id, "drop")).toEqual({ ok: true, text: "Dropped" });
  expect(ledger.planById(b.id)!.status).toBe("abandoned");
  expect(ledger.decisionById(b.decisionId!)).toMatchObject({ status: "answered", answer: "Drop" });
  expect(await applyPlanAction(deps, 999, "approve")).toEqual({ ok: false, text: "no plan #999" });
});

test("planActions: the buttons a plan offers in each status", () => {
  // ADR-0036: one primary button, Approve & build; a small plan being built offers only Stop.
  expect(planActions({ status: "sent", gate: "approval" })).toEqual(["approve", "changes", "drop"]);
  expect(planActions({ status: "sent" })).toEqual(["approve", "changes", "drop"]); // sent before ADR-0036
  expect(planActions({ status: "sent", gate: "info" })).toEqual(["stop"]);
  expect(planActions({ status: "draft" })).toEqual(["approve", "drop"]);
  expect(planActions({ status: "approved" })).toEqual(["approve", "drop"]);
  expect(planActions({ status: "executing" })).toEqual(["done", "drop"]);
  expect(planActions({ status: "done" })).toEqual([]);
  expect(planActions({ status: "abandoned" })).toEqual([]);
});

test("/plans lists plans with status, steps and thread ref; filters by project", async () => {
  const dir = repo();
  const { ledger, deps, trace } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  ledger.upsertPlan({ ...ledger.planByPath(dir, PLAN)!, id: undefined, folder: "/other", path: "plans/x.md", project: "waselni", title: "OTA", status: "draft", threadId: undefined, decisionId: undefined });
  const all = renderPlans(ledger, trace);
  expect(all).toContain(`#1 · awaiting · 0/2 · gold · Fare list port · m4g2\n  ${PLAN}`);
  expect(all).toMatch(/#\d+ · draft · 0\/2 · waselni · OTA\n  plans\/x.md/);
  expect(renderPlans(ledger, trace, "waselni")).not.toContain("gold");
  expect(renderPlans(ledger, trace, "nope")).toBe("No plans for nope yet.");
  const cmd = handleCommand("/plans gold", 1, { registry: createRegistry(), ledger, trust: openTrustStore(":memory:"), trace })!;
  expect(cmd.text).toContain("Fare list port");
  expect(cmd.text).not.toContain("OTA");
});

test("send_file (sendProjectFile): a plan path becomes a plan card, once per version; other files stay plain files", async () => {
  const dir = repo();
  const { posts, deps } = rig();
  put(dir, PLAN, BODY);
  put(dir, "out/report.pdf", "%PDF");
  const plain: string[] = [];
  const fileDeps = { sendFile: (_c: number, p: string) => void plain.push(p) };
  const plan = { deps, run: { project: "gold", folder: dir, cause, chatId: 42 } };
  expect(await sendProjectFile(fileDeps, 42, dir, PLAN, "see plan", undefined, plan)).toBe(`sent plan ${PLAN}`);
  expect(await sendProjectFile(fileDeps, 42, dir, join(dir, PLAN), undefined, undefined, plan)).toBe(`already sent: ${PLAN} — this version reached the operator`);
  expect(await sendProjectFile(fileDeps, 42, dir, "out/report.pdf", undefined, undefined, plan)).toBe("sent out/report.pdf");
  expect(posts).toHaveLength(1);
  expect(plain).toEqual([join(dir, "out/report.pdf")].map((p) => realpathSync(p)));
  // Confinement still comes first: a plan path outside the folder is refused, never registered.
  expect(await sendProjectFile(fileDeps, 42, dir, "../x/docs/superpowers/plans/a.md", undefined, undefined, plan)).toContain("refused");
});

test("a loop fire is a run: manual and scheduled loops send the plans they wrote", async () => {
  for (const kind of ["manual", "scheduled"] as const) {
    const dir = repo();
    const { posts, deps } = rig({ trace: undefined });
    const loop: LoopDef = { name: "planner", usage: "/loop planner", summary: "s", folder: dir, prompt: "p", goal: { kind: "manual" } as never, trigger: { kind: "manual" }, bounds: { maxIterations: 1 } };
    let n = 0;
    const run = async (): Promise<RunResult> => {
      put(dir, PLAN, BODY);
      return { ok: true, sessionId: "s", summary: "", costUsd: 0 };
    };
    const check = async () => ({ met: n++ > 0, detail: "" });
    if (kind === "manual") await startLoop(loop, 42, { reply: () => {}, run, check, plans: deps });
    else await startScheduledLoop(loop, { reply: () => {}, chatId: 42, run, check, plans: deps });
    expect(posts.map((p) => p.caption.split("\n")[0])).toEqual([`📄 plan · ${basename(dir)} · Fare list port`]);
  }
});

test("run ends that overlap (turn end, the runner's final turn end, run end) post one card and open one decision", async () => {
  const dir = repo();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const posts: string[] = [];
  const { ledger, deps } = rig({
    postPlan: async (_rec, _path, caption) => {
      posts.push(caption);
      await gate;
      return { chatId: 1, messageId: posts.length };
    },
  });
  put(dir, PLAN, BODY);
  const run = { project: "gold", folder: dir, cause, chatId: 42 };
  const all = Promise.all([onRunEndPlans(deps, run), onRunEndPlans(deps, run), offerPlanFile(deps, { ...run, path: PLAN }), onRunEndPlans(deps, run)]);
  await Bun.sleep(10);
  release();
  const [, , offered] = await all;
  expect(posts).toHaveLength(1);
  expect(ledger.listOpenDecisions()).toHaveLength(1);
  expect(ledger.planByPath(dir, PLAN)).toMatchObject({ version: 1, status: "sent" });
  // The worker's send_file during the in-flight post is told so — not sent again as a plain file.
  expect(offered).toEqual({ handled: true, text: `already sent: ${PLAN} — this version reached the operator` });
});

test("send_file of a plan whose card cannot be posted now is not sent as a plain file (the run end retries)", async () => {
  const dir = repo();
  const { deps } = rig({ postPlan: async () => undefined });
  put(dir, PLAN, BODY);
  expect(await offerPlanFile(deps, { project: "gold", folder: dir, path: PLAN, chatId: 42 })).toEqual({
    handled: true,
    text: `could not post the plan card for ${PLAN} now — the engine sends it at the end of this run`,
  });
});

test("a done or dropped plan is never sent again when its file changes; send_file then sends a plain file", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  await applyPlanAction(deps, ledger.planByPath(dir, PLAN)!.id, "drop");
  put(dir, PLAN, BODY + "- [ ] more\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toHaveLength(1);
  expect(ledger.listOpenDecisions()).toEqual([]);
  expect(await offerPlanFile(deps, { project: "gold", folder: dir, path: PLAN, chatId: 42 })).toEqual({ handled: false });
});

test("Execute writes only status and todo: changes made while submit ran are kept", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const plan = ledger.planByPath(dir, PLAN)!;
  const todo = {
    submit: async (p: Parameters<TodoQueue["submit"]>[0]) => {
      const t = ledger.addTodo({ project: p.project, folder: p.project, brief: p.brief, workClass: p.workClass, createdBy: "operator", planId: p.planId });
      // Something else moved the plan meanwhile (a run end registered a new version).
      ledger.upsertPlan({ ...ledger.planById(plan.id)!, sha256: "newer", stepsDone: 1, version: 2 });
      return `→ (todo #${t.id})`;
    },
    launcher: () => ({ deps: {} as DispatchDeps, replyChat: 42 }),
  } as unknown as TodoQueue;
  await applyPlanAction({ ...deps, todo }, plan.id, "execute");
  expect(ledger.planById(plan.id)).toMatchObject({ status: "executing", todoId: 1, sha256: "newer", stepsDone: 1, version: 2 });
});

// ── P2 phase review fixes ──────────────────────────────────────────────────────────────────

test("ticking checkboxes is progress, not a new version: no card while executing or approved; a real edit is v2", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const plan = ledger.planByPath(dir, PLAN)!;
  await applyPlanAction(deps, plan.id, "approve");
  put(dir, PLAN, "# Fare list port\n- [x] one\n- [ ] two\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toHaveLength(1);
  const { todo } = fakeTodo(ledger);
  await applyPlanAction({ ...deps, todo }, plan.id, "execute");
  put(dir, PLAN, "# Fare list port\n- [X] one\n- [x] two\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toHaveLength(1);
  expect(ledger.planById(plan.id)).toMatchObject({ status: "done", stepsDone: 2 });
  expect(ledger.listOpenDecisions()).toEqual([]);
  // A real edit of an approved plan is a new version to review.
  const b = repo();
  const r = rig();
  put(b, PLAN, BODY);
  await onRunEndPlans(r.deps, { project: "gold", folder: b, chatId: 42 });
  r.ledger.upsertPlan({ ...r.ledger.planByPath(b, PLAN)!, status: "approved" }); // a row approved before ADR-0036
  put(b, PLAN, BODY + "- [ ] a new step\n");
  await onRunEndPlans(r.deps, { project: "gold", folder: b, chatId: 42 });
  expect(r.posts.map((p) => p.caption.split("\n")[0])).toEqual(["📄 plan · gold · Fare list port", "📄 plan · gold · Fare list port · v2"]);
});

test("one run end posts at most plans.maxPerRun cards; the last names how many more wait in /plans", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig({ trace: undefined, cfg: { ...DEFAULT_PLANS_CFG, maxPerRun: 2 } });
  for (const n of ["a", "b", "c", "d"]) put(dir, `plans/${n}.md`, `# ${n.toUpperCase()}`);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts.map((p) => p.caption.split("\n")[0])).toEqual(["📄 plan · gold · A", "📄 plan · gold · B · +2 more: /plans"]);
  expect(ledger.planByPath(dir, "plans/c.md")).toMatchObject({ status: "draft" });
  expect(ledger.listOpenDecisions()).toHaveLength(2);
});

test("a tap on an older version's card is refused; the newest card's tap works", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  put(dir, PLAN, BODY + "- [ ] three\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts.map((p) => p.rec.version)).toEqual([1, 2]);
  const id = ledger.planByPath(dir, PLAN)!.id;
  const { todo } = fakeTodo(ledger);
  expect(await applyPlanAction({ ...deps, todo }, id, "approve", 1)).toEqual({ ok: false, text: "this card is v1 — the newest is v2; use that card" });
  expect(await applyPlanAction({ ...deps, todo }, id, "approve", 2)).toMatchObject({ ok: true, text: expect.stringContaining("as todo #1") });
});

test("a loop fire whose run throws still sends the plans it wrote", async () => {
  const dir = repo();
  const { posts, deps } = rig({ trace: undefined });
  const loop: LoopDef = { name: "planner", usage: "/loop planner", summary: "s", folder: dir, prompt: "p", goal: { kind: "manual" } as never, trigger: { kind: "manual" }, bounds: { maxIterations: 1 } };
  let n = 0;
  const run = async (): Promise<RunResult> => {
    put(dir, PLAN, BODY);
    throw new Error("worker crashed");
  };
  await expect(startScheduledLoop(loop, { reply: () => {}, chatId: 42, run, check: async () => ({ met: n++ > 0, detail: "" }), plans: deps })).rejects.toThrow("worker crashed");
  expect(posts).toHaveLength(1);
});

test("readPlansCfg keeps each well-typed field and falls back for the rest", () => {
  expect(readPlansCfg(undefined)).toEqual(DEFAULT_PLANS_CFG);
  expect(readPlansCfg({ paths: "docs/*.md", send: "yes", maxBytes: -1, executeBrief: 7, maxPerRun: 0 })).toEqual(DEFAULT_PLANS_CFG);
  expect(readPlansCfg({ paths: ["x/**/*.md"], send: false, maxBytes: 10, executeBrief: "go {path}", maxPerRun: 5 })).toEqual({
    paths: ["x/**/*.md"],
    send: false,
    maxBytes: 10,
    executeBrief: "go {path}",
    maxPerRun: 5,
    gatedStepPatterns: DEFAULT_PLANS_CFG.gatedStepPatterns,
    activeWindowMinutes: DEFAULT_PLANS_CFG.activeWindowMinutes,
    approval: DEFAULT_PLANS_CFG.approval,
  });
});

// ── P2 re-review fixes ─────────────────────────────────────────────────────────────────────

test("content changed since the newest card (not yet sent): approve and execute are refused on every surface", async () => {
  const dir = repo();
  let fail = false;
  const { ledger, deps } = rig({ postPlan: async () => (fail ? undefined : { chatId: 1, messageId: 2 }) });
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  fail = true;
  put(dir, PLAN, BODY + "- [ ] a step nobody reviewed\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const plan = ledger.planByPath(dir, PLAN)!;
  expect(plan.version).toBe(1);
  const refused = { ok: false, text: "the plan changed after its newest card (v1) — wait for the new card, or see /plans" };
  expect(await applyPlanAction(deps, plan.id, "approve", 1)).toEqual(refused);
  expect(await applyPlanAction(deps, plan.id, "approve")).toEqual(refused);
  const { todo, submitted } = fakeTodo(ledger);
  expect(await applyPlanAction({ ...deps, todo }, plan.id, "execute", 1)).toEqual(refused);
  expect(submitted).toEqual([]);
  // Drop is always allowed: it acts on no content.
  expect(await applyPlanAction(deps, plan.id, "drop", 1)).toEqual({ ok: true, text: "Dropped" });
});

test("ticking steps of a sent plan keeps it sent and updates its step count", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  put(dir, PLAN, "# Fare list port\n- [x] one\n- [ ] two\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toHaveLength(1);
  expect(ledger.planByPath(dir, PLAN)).toMatchObject({ status: "sent", stepsDone: 1, stepsTotal: 2 });
});

test("the '+N more' note rides on the last card that really lands", async () => {
  const dir = repo();
  const landed: string[] = [];
  const { deps } = rig({
    trace: undefined,
    cfg: { ...DEFAULT_PLANS_CFG, maxPerRun: 2 },
    postPlan: async (_rec, _path, caption) => {
      if (caption.includes("· B")) return undefined;
      landed.push(caption);
      return { chatId: 1, messageId: landed.length };
    },
  });
  for (const n of ["a", "b", "c", "d"]) put(dir, `plans/${n}.md`, `# ${n.toUpperCase()}`);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  // B's post failed, so B and D both still wait.
  expect(landed.map((c) => c.split("\n")[0])).toEqual(["📄 plan · gold · A", "📄 plan · gold · C · +2 more: /plans"]);
});

test("readPlansCfg refuses brace globs (git pathspecs cannot read them)", () => {
  expect(readPlansCfg({ paths: ["docs/{plans,specs}/**/*.md"] }).paths).toEqual(DEFAULT_PLANS_CFG.paths);
});

// ── P2 final-check follow-ups ──────────────────────────────────────────────────────────────

test("the '+N more' count includes plans whose post failed earlier in the same run end", async () => {
  const dir = repo();
  const landed: string[] = [];
  const { deps } = rig({
    trace: undefined,
    cfg: { ...DEFAULT_PLANS_CFG, maxPerRun: 3 },
    postPlan: async (_rec, _path, caption) => {
      if (caption.includes("· C")) return undefined;
      landed.push(caption);
      return { chatId: 1, messageId: landed.length };
    },
  });
  for (const n of ["a", "b", "c", "d", "e"]) put(dir, `plans/${n}.md`, `# ${n.toUpperCase()}`);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(landed.map((c) => c.split("\n")[0])).toEqual(["📄 plan · gold · A", "📄 plan · gold · B", "📄 plan · gold · D · +2 more: /plans"]);
});

test("with sending turned off after a card, approve and execute are not blocked by an unsent edit", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const off = { ...deps, cfg: { ...DEFAULT_PLANS_CFG, send: false } };
  put(dir, PLAN, BODY + "- [ ] more\n");
  await onRunEndPlans(off, { project: "gold", folder: dir, chatId: 42 });
  const { todo } = fakeTodo(ledger);
  expect(await applyPlanAction({ ...off, todo }, ledger.planByPath(dir, PLAN)!.id, "approve")).toMatchObject({ ok: true, text: expect.stringContaining("as todo #1") });
});

test("every plan write moves updatedAt, so /plans stays newest first", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  put(dir, "plans/b.md", "# B");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const a = ledger.planByPath(dir, PLAN)!;
  const old = ledger.upsertPlan({ ...a, updatedAt: 1 }).updatedAt;
  expect(old).toBeGreaterThan(1);
  await Bun.sleep(5);
  await applyPlanAction(deps, a.id, "drop");
  expect(ledger.planById(a.id)!.updatedAt).toBeGreaterThan(old);
  expect(ledger.listPlans()[0]!.id).toBe(a.id);
});

// ── ADR-0035: a plan first seen finished is recorded done, never sent as a card ──────────────

const DONE_BODY = "# Sub-users\n- [x] one\n- [x] two\n";

test("a plan first seen with every step ticked: recorded done, no card, no decision, no file", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, DONE_BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  expect(posts).toEqual([]);
  expect(ledger.listOpenDecisions()).toEqual([]);
  const plan = ledger.planByPath(dir, PLAN)!;
  expect(plan).toMatchObject({ status: "done", stepsDone: 2, stepsTotal: 2, version: 0 });
  expect(plan.sentSha256).toBeUndefined();
  expect(planActions(plan)).toEqual([]);
  expect(ledger.listEvents({ kind: "plan_seen_done" }).map((e) => e.data)).toEqual([expect.objectContaining({ planId: plan.id, path: PLAN, done: 2, total: 2, gated: 0 })]);
  expect(renderPlans(ledger, undefined)).toContain(`#${plan.id} · done · 2/2 · gold · Sub-users`);
  // A later run end with the same file sends nothing either.
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  expect(posts).toEqual([]);
});

test("a plan first seen with only operator-gated steps left is done (ADR-0034's judge)", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, "# Sub-users\n- [x] build it\n- [ ] push to origin (operator)\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toEqual([]);
  expect(ledger.planByPath(dir, PLAN)).toMatchObject({ status: "done", stepsDone: 1, stepsTotal: 2 });
});

test("a plan with no steps, or with a step left, is sent as before", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, "# Notes only\nno checkboxes\n");
  put(dir, "docs/superpowers/plans/b.md", "# B\n- [x] one\n- [ ] two\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toHaveLength(2);
  expect(ledger.planByPath(dir, PLAN)!.status).toBe("sent");
});

test("a spec whose plans are all done is done with them; a spec with an open plan, or none, is sent", async () => {
  const SPEC = "docs/superpowers/specs/sub-users-design.md";
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, SPEC, "# Sub-users design\nThe design.\n");
  put(dir, PLAN, `# Sub-users plan\nSpec: ${SPEC}\n- [x] one\n- [x] two\n`);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toEqual([]);
  expect(ledger.planByPath(dir, SPEC)!.status).toBe("done");
  expect(ledger.listEvents({ kind: "plan_seen_done" }).map((e) => e.data)).toContainEqual(expect.objectContaining({ path: SPEC, done: 2, total: 2 }));
  // Open plan → the spec is sent.
  const b = repo();
  const r = rig();
  put(b, SPEC, "# Sub-users design\n");
  put(b, PLAN, `# Sub-users plan\nSpec: ${SPEC}\n- [x] one\n- [ ] two\n`);
  await onRunEndPlans(r.deps, { project: "gold", folder: b, chatId: 42 });
  expect(r.posts).toHaveLength(2);
  // No plan yet → the spec is sent.
  const c = repo();
  const s = rig();
  put(c, SPEC, "# Sub-users design\n");
  await onRunEndPlans(s.deps, { project: "gold", folder: c, chatId: 42 });
  expect(s.posts).toHaveLength(1);
});

test("a plan recorded done at first sight that gains an unticked step is sent normally", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, DONE_BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toEqual([]);
  put(dir, PLAN, DONE_BODY + "- [ ] three\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts.map((p) => p.caption.split("\n")[0])).toEqual(["📄 plan · gold · Sub-users"]);
  expect(posts[0]!.rec.status).toBe("sent");
  expect(ledger.planByPath(dir, PLAN)).toMatchObject({ status: "sent", version: 1, stepsDone: 2, stepsTotal: 3 });
  expect(ledger.listOpenDecisions()).toHaveLength(1);
});

test("an operator-done plan (it was executed) stays done when its file gains a step", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const plan = ledger.planByPath(dir, PLAN)!;
  const { todo } = fakeTodo(ledger);
  await applyPlanAction({ ...deps, todo }, plan.id, "execute");
  await applyPlanAction(deps, plan.id, "done");
  put(dir, PLAN, BODY + "- [ ] more\n");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  expect(posts).toHaveLength(1);
  expect(ledger.planById(plan.id)!.status).toBe("done");
});

test("send_file of a plan first seen finished: not sent, the worker is told it is already done", async () => {
  const dir = repo();
  const { ledger, posts, deps } = rig();
  put(dir, PLAN, DONE_BODY);
  const text = `already done: ${PLAN} — 2/2 steps ticked; recorded as done, not sent to the operator`;
  expect(await offerPlanFile(deps, { project: "gold", folder: dir, path: PLAN, chatId: 42 })).toEqual({ handled: true, text });
  expect(await offerPlanFile(deps, { project: "gold", folder: dir, path: PLAN, chatId: 42 })).toEqual({ handled: true, text });
  expect(posts).toEqual([]);
  expect(ledger.planByPath(dir, PLAN)!.status).toBe("done");
  expect(ledger.listEvents({ kind: "plan_seen_done" })).toHaveLength(1);
});
