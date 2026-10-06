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

test("run end with a new plan: posted once with its caption, a decision opened with the five options, status sent", async () => {
  const dir = repo();
  const { ledger, posts, deps, trace } = rig();
  const start = headSha(dir);
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, startSha: start, cause, chatId: 42 });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.caption).toBe("📄 plan · gold · Fare list port · thread m4g2");
  expect(posts[0]!.path).toBe(join(dir, PLAN));
  const plan = ledger.planByPath(dir, PLAN)!;
  expect(plan.status).toBe("sent");
  expect(posts[0]!.rec).toMatchObject({ planId: plan.id, status: "sent" });
  const dec = ledger.decisionById(plan.decisionId!)!;
  expect(dec).toMatchObject({ status: "open", chatId: 42, options: ["Approve", "Changes", "Execute", "Done", "Drop"], decisionMessageId: 501, project: "gold", folder: dir });
  expect(dec.cause).toEqual(cause);
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
  expect(posts.map((p) => p.caption)).toEqual(["📄 plan · gold · Fare list port · thread m4g2", "📄 plan · gold · Fare list port · v2 · thread m4g2"]);
  expect(ledger.decisionById(firstDecision)!.status).toBe("dismissed");
  expect(ledger.planByPath(dir, PLAN)!.decisionId).not.toBe(firstDecision);
});

test("no cause → the caption has no thread; no poster or send off → registered as draft, never sent", async () => {
  const dir = repo();
  const a = rig({ trace: undefined });
  put(dir, PLAN, BODY);
  await onRunEndPlans(a.deps, { project: "gold", folder: dir, chatId: 42 });
  expect(a.posts[0]!.caption).toBe("📄 plan · gold · Fare list port");
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
  expect(second).toEqual({ ok: false, text: "already executing as #1" });
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

test("Approve, Done and Drop move the status; finished plans refuse more actions; unknown ids are reported", async () => {
  const dir = repo();
  const { ledger, deps } = rig();
  put(dir, PLAN, BODY);
  put(dir, "plans/b.md", "# B");
  await onRunEndPlans(deps, { project: "gold", folder: dir, chatId: 42 });
  const a = ledger.planByPath(dir, PLAN)!;
  const b = ledger.planByPath(dir, "plans/b.md")!;
  expect(await applyPlanAction(deps, a.id, "approve")).toEqual({ ok: true, text: "Approved" });
  expect(ledger.planById(a.id)!.status).toBe("approved");
  expect(ledger.decisionById(a.decisionId!)).toMatchObject({ status: "answered", answer: "Approve" });
  expect(await applyPlanAction(deps, a.id, "approve")).toEqual({ ok: false, text: "already approved" });
  expect(await applyPlanAction(deps, a.id, "done")).toEqual({ ok: true, text: "Marked done" });
  expect(ledger.planById(a.id)!.status).toBe("done");
  expect(await applyPlanAction(deps, a.id, "drop")).toEqual({ ok: false, text: "this plan is already done" });
  expect(await applyPlanAction(deps, b.id, "drop")).toEqual({ ok: true, text: "Dropped" });
  expect(ledger.planById(b.id)!.status).toBe("abandoned");
  expect(ledger.decisionById(b.decisionId!)).toMatchObject({ status: "answered", answer: "Drop" });
  expect(await applyPlanAction(deps, 999, "approve")).toEqual({ ok: false, text: "no plan #999" });
});

test("planActions: the buttons a plan offers in each status", () => {
  expect(planActions("sent")).toEqual(["approve", "changes", "execute", "drop"]);
  expect(planActions("draft")).toEqual(["approve", "changes", "execute", "drop"]);
  expect(planActions("approved")).toEqual(["execute", "drop"]);
  expect(planActions("executing")).toEqual(["done", "drop"]);
  expect(planActions("done")).toEqual([]);
  expect(planActions("abandoned")).toEqual([]);
});

test("/plans lists plans with status, steps and thread ref; filters by project", async () => {
  const dir = repo();
  const { ledger, deps, trace } = rig();
  put(dir, PLAN, BODY);
  await onRunEndPlans(deps, { project: "gold", folder: dir, cause, chatId: 42 });
  ledger.upsertPlan({ ...ledger.planByPath(dir, PLAN)!, id: undefined, folder: "/other", path: "plans/x.md", project: "waselni", title: "OTA", status: "draft", threadId: undefined, decisionId: undefined });
  const all = renderPlans(ledger, trace);
  expect(all).toContain(`#1 · sent · 0/2 · gold · Fare list port · m4g2\n  ${PLAN}`);
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
    expect(posts.map((p) => p.caption)).toEqual([`📄 plan · ${basename(dir)} · Fare list port`]);
  }
});
