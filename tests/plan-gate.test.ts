// ADR-0036: a big plan waits for the operator's approval; a small one is sent for information.
import { test, expect } from "bun:test";
import { classifyPlan } from "../src/engine/plan-gate";
import { DEFAULT_PLANS_CFG, readPlansCfg } from "../src/engine/plans";

const cfg = DEFAULT_PLANS_CFG;
const tasks = (n: number, stepsEach = 1) =>
  Array.from({ length: n }, (_, i) => `### Task ${i + 1}: part ${i + 1}\n${Array.from({ length: stepsEach }, (_, j) => `- [ ] step ${j + 1}`).join("\n")}`).join("\n\n");

test("AC1: a short plan with no risky words is small", () => {
  expect(classifyPlan(`# Rename a label\n${tasks(2, 3)}\n`, cfg)).toEqual({ big: false, reasons: [] });
});

test("AC1: front matter `approval: required` makes it big; nothing can make it small", () => {
  expect(classifyPlan(`---\ntitle: x\napproval: required\n---\n# X\n- [ ] one\n`, cfg)).toEqual({ big: true, reasons: ["marked approval: required"] });
  expect(classifyPlan(`---\napproval: none\n---\n# X\n${tasks(9)}\n`, cfg).big).toBe(true);
});

test("AC1: more tasks or more steps than the config allows makes it big", () => {
  const max = cfg.approval.maxTasks;
  expect(classifyPlan(`# X\n${tasks(max)}\n`, cfg).big).toBe(false);
  expect(classifyPlan(`# X\n${tasks(max + 1)}\n`, cfg).reasons).toEqual([`${max + 1} tasks (over ${max})`]);
  const steps = cfg.approval.maxSteps + 1;
  expect(classifyPlan(`# X\n${Array.from({ length: steps }, (_, i) => `- [ ] s${i}`).join("\n")}\n`, cfg).reasons).toEqual([`${steps} steps (over ${cfg.approval.maxSteps})`]);
});

test("AC1: a risky word outside code fences and operator-gated steps makes it big, and names it", () => {
  expect(classifyPlan("# Wallet bars\n- [ ] add the bars table migration\n- [ ] charge the wallet\n", cfg)).toEqual({ big: true, reasons: ["touches: migration, wallet"] });
  // Inside a code fence or an operator-gated step it does not count.
  expect(classifyPlan("# X\n```sql\nDELETE FROM wallet;\n```\n- [ ] one\n- [ ] deploy to production (operator)\n", cfg)).toEqual({ big: false, reasons: [] });
});

test("readPlansCfg: approval knobs are config; a bad value keeps the default", () => {
  expect(readPlansCfg({ approval: { maxTasks: 2, maxSteps: 9, patterns: ["\\bkarat\\b"] } }).approval).toEqual({ maxTasks: 2, maxSteps: 9, patterns: ["\\bkarat\\b"] });
  expect(readPlansCfg({ approval: { maxTasks: "x", patterns: ["("] } }).approval).toEqual(DEFAULT_PLANS_CFG.approval);
  expect(readPlansCfg({}).approval).toEqual(DEFAULT_PLANS_CFG.approval);
});

// ── The watch: a big plan written mid-run holds its worker (AC3/AC4) ────────────────────────────
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { applyPlanAction, type PlanDeps, type PostPlan, type EditPlanCard } from "../src/engine/plans";
import { createPlanWatch } from "../src/engine/plan-watch";

const PLAN = "docs/superpowers/plans/bars.md";
const BIG = "# Wallet bars\n### Task 1: table\n- [ ] add the bars migration\n- [ ] charge the wallet\n";
const SMALL = "# Rename a label\n- [ ] rename it\n- [ ] test it\n";

function rig(o: { mayHold?: () => boolean; forceApproval?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "neo-plan-watch-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const ledger = openLedger(":memory:");
  const posts: Array<{ actions: string[]; caption: string }> = [];
  const postPlan: PostPlan = async (rec, _p, caption) => (posts.push({ actions: rec.actions, caption }), { chatId: -100, messageId: 500 + posts.length });
  const edits: Array<{ messageId: number; caption: string; actions: string[] }> = [];
  const editPlan: EditPlanCard = async (at, card) => (edits.push({ messageId: at.messageId, caption: card.caption, actions: card.actions }), true);
  const deps: PlanDeps = { ledger, cfg: DEFAULT_PLANS_CFG, postPlan, editPlan };
  const held: string[] = [];
  const run = { project: "gold", folder: dir, orderId: "o1", chatId: 42, ...(o.forceApproval ? { forceApproval: true } : {}) };
  const watch = createPlanWatch(deps, () => run, { onHold: (p) => held.push(p.path), ...(o.mayHold ? { mayHold: o.mayHold } : {}) });
  const write = async (rel: string, body: string, id = "t1") => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    watch.onToolUse(id, "Write", { file_path: join(dir, rel), content: body });
    writeFileSync(join(dir, rel), body);
    watch.onToolResult(id, false);
    await watch.settled();
  };
  return { dir, ledger, posts, edits, deps, watch, held, write };
}

test("AC3: a big plan written mid-run is sent at once and holds the worker until it is approved", async () => {
  const r = rig();
  await r.write(PLAN, BIG);
  expect(r.posts).toHaveLength(1);
  expect(r.posts[0]!.actions).toEqual(["approve", "changes", "drop"]);
  expect(r.posts[0]!.caption).toContain("⏸ waiting for your approval — touches: migration, wallet");
  const plan = r.ledger.planByPath(r.dir, PLAN)!;
  expect(plan.heldAt).toBeNumber();
  expect(plan.gate).toBe("approval");
  expect(r.held).toEqual([PLAN]);
  // The held plan's decision blocks the handoff (ADR-0029 parks on it), unlike a plain plan card.
  expect(r.ledger.openDecisionsForOrder("o1")).toEqual([expect.objectContaining({ id: plan.decisionId, plan: false })]);
  const stop = r.watch.steer("Bash", { command: "bun test" });
  expect(stop).toStartWith(`STOP — ${PLAN} is a big plan`);
  expect(r.watch.steer("Write", { file_path: join(r.dir, "src/x.ts") })).toBe(stop);
  expect(r.watch.steer("Agent", {})).toBe(stop);
  // Reads, Neo's tools and the plan itself stay open.
  expect(r.watch.steer("Read", { file_path: join(r.dir, "src/x.ts") })).toBeUndefined();
  expect(r.watch.steer("mcp__neo__send_file", { path: PLAN })).toBeUndefined();
  expect(r.watch.steer("Edit", { file_path: join(r.dir, PLAN) })).toBeUndefined();
  // Approve & build: the frontend resumes the held worker; the hold lifts.
  const res = await applyPlanAction(r.deps, plan.id, "approve", 1, { canResume: true });
  expect(res).toMatchObject({ ok: true, resume: { decisionId: plan.decisionId, answer: expect.stringContaining(`Approved by the operator. Execute the plan at ${PLAN}`) } });
  expect(r.ledger.planById(plan.id)).toMatchObject({ status: "executing" });
  expect(r.ledger.planById(plan.id)!.heldAt).toBeUndefined(); // a later version is a plain review again
  expect(r.edits.at(-1)).toMatchObject({ messageId: 501, actions: ["done", "drop"], caption: expect.stringContaining("🔨 building") });
  expect(r.watch.steer("Bash", { command: "bun test" })).toBeUndefined();
});

test("held() names the plan a worker is held on, and is empty once that plan no longer awaits the operator", async () => {
  const r = rig();
  expect(r.watch.held()).toBeUndefined();
  await r.write(PLAN, BIG);
  expect(r.watch.held()).toBe(PLAN);
  const plan = r.ledger.planByPath(r.dir, PLAN)!;
  await applyPlanAction(r.deps, plan.id, "drop", 1);
  expect(r.watch.held()).toBeUndefined();
});

test("AC4: a small plan is sent for information (Stop only) and the worker goes on", async () => {
  const r = rig();
  await r.write(PLAN, SMALL);
  expect(r.posts.map((p) => p.actions)).toEqual([["stop"]]);
  expect(r.posts[0]!.caption).toContain("ℹ️ small change — the worker is building it");
  expect(r.ledger.planByPath(r.dir, PLAN)).toMatchObject({ gate: "info", status: "sent" });
  expect(r.ledger.planByPath(r.dir, PLAN)!.decisionId).toBeUndefined(); // nothing to remind
  expect(r.held).toEqual([]);
  expect(r.watch.steer("Bash", { command: "bun test" })).toBeUndefined();
});

test("a failed write, a non-plan file or a finished plan holds nothing", async () => {
  const r = rig();
  r.watch.onToolUse("t9", "Write", { file_path: join(r.dir, PLAN) });
  r.watch.onToolResult("t9", true);
  await r.write("src/a.ts", "x");
  await r.write(PLAN, "# Wallet bars\n- [x] add the bars migration\n");
  expect(r.posts).toEqual([]);
  expect(r.watch.steer("Bash", { command: "ls" })).toBeUndefined();
});

test("a held plan revised into a small one releases the worker; its new card is information", async () => {
  const r = rig();
  await r.write(PLAN, BIG);
  await r.write(PLAN, SMALL, "t2");
  expect(r.watch.steer("Bash", { command: "ls" })).toBeUndefined();
  expect(r.ledger.planByPath(r.dir, PLAN)!.heldAt).toBeUndefined();
  expect(r.posts.map((p) => p.actions)).toEqual([["approve", "changes", "drop"], ["stop"]]);
  // The first card says it was replaced, and loses its buttons.
  expect(r.edits).toEqual([expect.objectContaining({ messageId: 501, actions: [], caption: expect.stringContaining("↪ superseded by v2") })]);
});

// ── Cards follow the plan (AC2, AC6, AC8) ────────────────────────────────────────────────────────
import { onRunEndPlans } from "../src/engine/plans";
import type { Registry } from "../src/engine/registry";

const commit = (dir: string) => {
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"], { cwd: dir });
  return spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
};

test("AC8: a small plan the worker finished in its run: the card becomes done · <commit>, no buttons", async () => {
  const r = rig();
  writeFileSync(join(r.dir, "README.md"), "x");
  commit(r.dir);
  const startSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: r.dir, encoding: "utf8" }).stdout.trim();
  await r.write(PLAN, SMALL);
  writeFileSync(join(r.dir, PLAN), SMALL.replaceAll("[ ]", "[x]"));
  const sha = commit(r.dir); // the worker committed its work: the run end sees it since the run's start
  await onRunEndPlans(r.deps, { project: "gold", folder: r.dir, startSha, chatId: 42 });
  expect(r.ledger.planByPath(r.dir, PLAN)).toMatchObject({ status: "done", doneSha: sha });
  expect(r.edits).toEqual([{ messageId: 501, actions: [], caption: expect.stringContaining(`✅ done · ${sha} · 2/2 steps`) }]);
  expect(r.posts).toHaveLength(1); // edited in place, never a second card
  expect(r.ledger.listEvents({ kind: "plan_done" })).toHaveLength(1);
});

test("AC8: a small plan the run left unfinished waits for Approve & build: the card is redrawn and a review opens", async () => {
  const r = rig();
  await r.write(PLAN, SMALL);
  await onRunEndPlans(r.deps, { project: "gold", folder: r.dir, chatId: 42 });
  const plan = r.ledger.planByPath(r.dir, PLAN)!;
  expect(plan).toMatchObject({ gate: "approval", status: "sent" });
  expect(r.ledger.decisionById(plan.decisionId!)).toMatchObject({ status: "open", decisionMessageId: 501 });
  expect(r.edits).toEqual([{ messageId: 501, actions: ["approve", "changes", "drop"], caption: expect.stringContaining("⏸ waiting for your approval") }]);
});

test("AC6: Stop drops a small plan and interrupts the project's live session", async () => {
  const r = rig();
  await r.write(PLAN, SMALL);
  let interrupted = 0;
  const registry = { findByFolder: () => ({ id: "s1", name: "gold", status: "running" }), getControl: () => ({ interrupt: async () => void interrupted++ }) } as unknown as Registry;
  const plan = r.ledger.planByPath(r.dir, PLAN)!;
  expect(await applyPlanAction({ ...r.deps, registry }, plan.id, "stop", 1)).toEqual({ ok: true, text: "Stopped — gold interrupted" });
  expect(interrupted).toBe(1);
  expect(r.ledger.planById(plan.id)!.status).toBe("abandoned");
  expect(r.edits.at(-1)).toMatchObject({ actions: [], caption: expect.stringContaining("✖ dropped") });
  // Approve & build is not what a small plan being built offers.
  await r.write("docs/superpowers/plans/b.md", SMALL, "t3");
  expect(await applyPlanAction(r.deps, r.ledger.planByPath(r.dir, "docs/superpowers/plans/b.md")!.id, "approve")).toEqual({ ok: false, text: "the worker is building it — Stop cancels it" });
});

test("AC2: a big plan that names a spec the operator approved is information — one approval per design unit", async () => {
  const r = rig();
  const SPEC = "docs/superpowers/specs/bars-design.md";
  await r.write(SPEC, "# Bars design\nWallet bars, with a migration.\n");
  expect(r.ledger.planByPath(r.dir, SPEC)!.gate).toBe("approval");
  r.ledger.upsertPlan({ ...r.ledger.planByPath(r.dir, SPEC)!, status: "executing" }); // approved & building
  await r.write(PLAN, `${BIG}\nSpec: ${SPEC}\n`, "t2");
  expect(r.ledger.planByPath(r.dir, PLAN)!.gate).toBe("info");
  expect(r.watch.steer("Bash", { command: "ls" })).toBeUndefined();
});

// ── Review fixes ─────────────────────────────────────────────────────────────────────────────────

test("a turn end that lands while a small plan's card is still posting: the card is redrawn to wait, with a review", async () => {
  const r = rig();
  let release!: () => void;
  const slow = new Promise<void>((res) => (release = res));
  const postPlan: PostPlan = async (rec, _p, caption) => {
    await slow;
    r.posts.push({ actions: rec.actions, caption });
    return { chatId: -100, messageId: 777 };
  };
  const deps = { ...r.deps, postPlan };
  const watch = createPlanWatch(deps, () => ({ project: "gold", folder: r.dir, orderId: "o1", chatId: 42 }));
  mkdirSync(join(r.dir, PLAN, ".."), { recursive: true });
  watch.onToolUse("w1", "Write", { file_path: join(r.dir, PLAN) });
  writeFileSync(join(r.dir, PLAN), SMALL);
  watch.onToolResult("w1", false); // the info card starts posting…
  await onRunEndPlans(deps, { project: "gold", folder: r.dir, orderId: "o1", chatId: 42 }); // …and the turn ends meanwhile
  release();
  await watch.settled();
  const plan = r.ledger.planByPath(r.dir, PLAN)!;
  expect(r.posts.map((p) => p.actions)).toEqual([["stop"]]); // posted as it was then
  expect(plan).toMatchObject({ gate: "approval", status: "sent", cardMessageId: 777 });
  expect(r.ledger.decisionById(plan.decisionId!)).toMatchObject({ status: "open", decisionMessageId: 777 });
  expect(r.edits.at(-1)).toMatchObject({ messageId: 777, actions: ["approve", "changes", "drop"] });
});

test("a big plan whose card cannot be posted does not hold the worker", async () => {
  const r = rig();
  const deps = { ...r.deps, postPlan: (async () => undefined) as PostPlan };
  const watch = createPlanWatch(deps, () => ({ project: "gold", folder: r.dir, orderId: "o1", chatId: 42 }));
  mkdirSync(join(r.dir, PLAN, ".."), { recursive: true });
  watch.onToolUse("w1", "Write", { file_path: join(r.dir, PLAN) });
  writeFileSync(join(r.dir, PLAN), BIG);
  watch.onToolResult("w1", false);
  await watch.settled();
  expect(watch.steer("Bash", { command: "ls" })).toBeUndefined();
  expect(r.ledger.planByPath(r.dir, PLAN)!.heldAt).toBeUndefined();
  expect(r.ledger.listEvents({ kind: "plan_hold_released" })).toHaveLength(1);
});

// ── Order sizes (ADR-0072, AC 12): a quick run never holds; a run moved to big gates every plan ───

test("mayHold false: a big plan written mid-run is registered and sent, and nothing holds the worker", async () => {
  const r = rig({ mayHold: () => false });
  await r.write(PLAN, BIG);
  expect(r.posts).toHaveLength(1);
  expect(r.ledger.planByPath(r.dir, PLAN)).toMatchObject({ gate: "approval" });
  expect(r.ledger.planByPath(r.dir, PLAN)!.heldAt).toBeUndefined();
  expect(r.held).toEqual([]);
  expect(r.watch.held()).toBeUndefined();
  expect(r.watch.steer("Bash", { command: "bun test" })).toBeUndefined();
  expect(r.ledger.listEvents({ kind: "plan_held" })).toHaveLength(0);
});

test("forceApproval: a small plan gets gate approval and holds the worker", async () => {
  const r = rig({ forceApproval: true });
  await r.write(PLAN, SMALL);
  expect(r.ledger.planByPath(r.dir, PLAN)).toMatchObject({ gate: "approval" });
  expect(r.posts[0]!.actions).toEqual(["approve", "changes", "drop"]);
  expect(r.held).toEqual([PLAN]);
  expect(r.watch.steer("Bash", { command: "ls" })).toStartWith(`STOP — ${PLAN}`);
});

test("plans() lists the plans the watch registered; approvedHeld() is true once a held plan is approved", async () => {
  const r = rig();
  expect(r.watch.plans()).toEqual([]);
  expect(r.watch.approvedHeld()).toBe(false);
  await r.write("docs/superpowers/plans/a.md", SMALL, "t0");
  await r.write(PLAN, BIG);
  const plan = r.ledger.planByPath(r.dir, PLAN)!;
  expect(r.watch.plans()).toEqual([r.ledger.planByPath(r.dir, "docs/superpowers/plans/a.md")!.id, plan.id]);
  expect(r.watch.approvedHeld()).toBe(false);
  await applyPlanAction(r.deps, plan.id, "approve", 1, { canResume: true });
  expect(r.ledger.planById(plan.id)!.status).toBe("executing");
  expect(r.watch.approvedHeld()).toBe(true);
});

test("approvedHeld() stays false when the held plan is dropped", async () => {
  const r = rig();
  await r.write(PLAN, BIG);
  await applyPlanAction(r.deps, r.ledger.planByPath(r.dir, PLAN)!.id, "drop", 1);
  expect(r.watch.approvedHeld()).toBe(false);
});
