// ADR-0034: an Execute is judged against the plan file, the repository and the design unit, so it
// never starts duplicate work.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { applyPlanAction, onRunEndPlans, readPlansCfg, DEFAULT_PLANS_CFG, type PlanDeps, type PostPlan } from "../src/engine/plans";
import { gatedStep, judgeExecute, repoOf } from "../src/engine/plan-execute";
import { createRegistry } from "../src/engine/registry";
import type { TodoQueue } from "../src/engine/todo-queue";
import type { DispatchDeps } from "../src/engine/dispatch";

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "neo-plan-exec-")));
  sh(dir, "init", "-q", "-b", "dev");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}
const put = (dir: string, rel: string, body: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const commit = (dir: string) => (sh(dir, "add", "."), sh(dir, "commit", "-qm", "c"));
/** A linked worktree of `main` on a new branch, under `<main>/.worktrees/<name>`. */
const worktree = (main: string, name: string) => {
  const wt = join(main, ".worktrees", name);
  sh(main, "worktree", "add", "-q", "-b", name, wt);
  return wt;
};

const PLAN = "docs/superpowers/plans/2026-10-11-phase-7.md";
const SPEC = "docs/superpowers/specs/2026-10-09-parity-design.md";
const OPEN = `# Phase 7\n\n**Spec:** \`${SPEC}\`\n\n- [x] one\n- [ ] two\n`;
const DONE = `# Phase 7\n\n**Spec:** \`${SPEC}\`\n\n- [x] one\n- [x] two\n`;
const GATED = `# Phase 7\n\n- [x] one\n- [ ] Ask the operator before you push to origin\n- [ ] Deploy to prod (operator)\n`;
const SPEC_BODY = "# Parity design\n\nNo checkboxes here.\n";

function rig() {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const postPlan: PostPlan = async () => ({ chatId: -100, messageId: 1 });
  const submitted: Array<Parameters<TodoQueue["submit"]>[0]> = [];
  const todo = {
    submit: async (p: Parameters<TodoQueue["submit"]>[0]) => {
      submitted.push(p);
      const t = ledger.addTodo({ project: p.project, folder: p.project, brief: p.brief, workClass: p.workClass, createdBy: "operator", cause: p.cause, planId: p.planId });
      return `→ dispatching (todo #${t.id})`;
    },
    launcher: () => ({ deps: {} as DispatchDeps, replyChat: 42 }),
  } as unknown as TodoQueue;
  const deps: PlanDeps = { ledger, cfg: DEFAULT_PLANS_CFG, postPlan, todo, registry };
  return { ledger, registry, deps, submitted };
}
/** Register (and send) the file from `folder`, as a run end there would. */
async function seen(deps: PlanDeps, folder: string, project: string) {
  await onRunEndPlans(deps, { project, folder, chatId: 42 });
}
const row = (ledger: Ledger, folder: string, path: string) => ledger.planByPath(folder, path)!;

test("gatedStep: steps a worker must not do alone match the configured patterns", () => {
  const cfg = DEFAULT_PLANS_CFG;
  expect(gatedStep("Ask the operator before you push", cfg)).toBe(true);
  expect(gatedStep("git push origin dev (operator approval)", cfg)).toBe(true);
  expect(gatedStep("Deploy to prod", cfg)).toBe(true);
  expect(gatedStep("Restart the daemon", cfg)).toBe(true);
  expect(gatedStep("Write the failing test for the parser", cfg)).toBe(false);
});

test("readPlansCfg: gate patterns and the active window are config; a bad regex keeps the default", () => {
  expect(readPlansCfg({ gatedStepPatterns: ["\\bship\\b"], activeWindowMinutes: 10 })).toMatchObject({ gatedStepPatterns: ["\\bship\\b"], activeWindowMinutes: 10 });
  expect(readPlansCfg({ gatedStepPatterns: ["(unclosed"], activeWindowMinutes: -3 })).toMatchObject({
    gatedStepPatterns: DEFAULT_PLANS_CFG.gatedStepPatterns,
    activeWindowMinutes: DEFAULT_PLANS_CFG.activeWindowMinutes,
  });
});

test("repoOf: a worktree and its main checkout are one repository; the main checkout is the first worktree", () => {
  const main = repo();
  const wt = worktree(main, "booking-timeline");
  expect(repoOf(wt).key).toBe(repoOf(main).key);
  expect(repoOf(wt).main).toBe(main);
  const lone = realpathSync(mkdtempSync(join(tmpdir(), "neo-not-repo-")));
  expect(repoOf(lone)).toEqual({ key: lone, main: lone });
});

test("AC1: every box ticked in the FILE (the row is stale) → done, nothing queued, the counts shown, Run anyway offered", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, PLAN, OPEN);
  await seen(deps, dir, "gold");
  put(dir, PLAN, DONE); // ticked by a session after the last run end: the row still says 1/2
  const r = await applyPlanAction(deps, row(ledger, dir, PLAN).id, "execute");
  expect(r.ok).toBe(false);
  expect(r.text).toContain("already done");
  expect(r.text).toContain("2/2");
  expect(r.offer).toBe("anyway");
  expect(submitted).toHaveLength(0);
  expect(row(ledger, dir, PLAN).status).toBe("sent");
});

test("AC1: only operator-gated boxes left → done, and the reply names how many are gated", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, PLAN, GATED);
  await seen(deps, dir, "gold");
  const r = await applyPlanAction(deps, row(ledger, dir, PLAN).id, "execute");
  expect(r.ok).toBe(false);
  expect(r.text).toContain("1/3");
  expect(r.text).toContain("2 operator-gated");
  expect(submitted).toHaveLength(0);
});

test("AC2: Run anyway skips only the done check", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, PLAN, DONE);
  await seen(deps, dir, "gold");
  const r = await applyPlanAction(deps, row(ledger, dir, PLAN).id, "anyway");
  expect(r.ok).toBe(true);
  expect(submitted).toHaveLength(1);
  expect(row(ledger, dir, PLAN)).toMatchObject({ status: "executing", todoId: 1 });
});

test("AC3: a todo queued for the plan in ANOTHER worktree of the same repo → busy, no second todo", async () => {
  const main = repo();
  put(main, PLAN, OPEN);
  commit(main);
  const wt = worktree(main, "booking-timeline");
  const { ledger, deps, submitted } = rig();
  put(main, PLAN, OPEN + "\nedited on dev\n");
  await seen(deps, main, "eticket-v3");
  put(wt, PLAN, OPEN + "\nedited in the worktree\n"); // the worktree sends its own card
  await seen(deps, wt, "booking-timeline");
  ledger.addTodo({ project: main, folder: main, brief: `Execute the plan at ${PLAN} task by task.`, workClass: "interactive", createdBy: "operator", planId: row(ledger, main, PLAN).id });
  const r = await applyPlanAction(deps, row(ledger, wt, PLAN).id, "execute");
  expect(r.ok).toBe(false);
  expect(r.text).toContain("already queued");
  expect(r.text).toContain("#1");
  expect(r.text).toContain(main);
  expect(submitted).toHaveLength(0);
  expect(row(ledger, wt, PLAN).status).toBe("sent"); // a refusal leaves the plan as it was
});

test("AC3: an active todo whose brief names the plan (no plan row) → busy", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, PLAN, OPEN);
  await seen(deps, dir, "eticket-v3");
  const t = ledger.addTodo({ project: dir, folder: dir, brief: `Build phase 7 from ${PLAN}`, workClass: "interactive", createdBy: "company" });
  ledger.updateTodo(t.id, { status: "running", startedAt: Date.now() });
  const r = await applyPlanAction(deps, row(ledger, dir, PLAN).id, "execute");
  expect(r.text).toContain("already running");
  expect(r.text).toContain(`#${t.id}`);
  expect(submitted).toHaveLength(0);
});

test("AC3: a finished todo for the plan is not busy (only active todos count)", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, PLAN, OPEN);
  await seen(deps, dir, "gold");
  const t = ledger.addTodo({ project: dir, folder: dir, brief: `Execute the plan at ${PLAN}`, workClass: "interactive", createdBy: "operator" });
  ledger.updateTodo(t.id, { status: "done", endedAt: 1 });
  expect((await applyPlanAction(deps, row(ledger, dir, PLAN).id, "execute")).ok).toBe(true);
  expect(submitted).toHaveLength(1);
});

test("AC3: a live session of the same repo executing the plan (named in its order) → busy, names the session", async () => {
  const main = repo();
  put(main, PLAN, OPEN);
  const { ledger, registry, deps, submitted } = rig();
  await seen(deps, main, "eticket-v3");
  const s = registry.add({ id: "o1", source: "neo", folder: main, task: `execute ${PLAN} on dev`, chatId: 1, createdAt: Date.now() }, Date.now());
  registry.setStatus(s.id, "running");
  const r = await applyPlanAction(deps, row(ledger, main, PLAN).id, "execute");
  expect(r.ok).toBe(false);
  expect(r.text).toContain(`session ${s.name}`);
  expect(submitted).toHaveLength(0);
});

test("AC3: a live session that ticked the file within the active window → busy; outside the window → not", async () => {
  const dir = repo();
  const { ledger, registry, deps } = rig();
  put(dir, PLAN, OPEN);
  await seen(deps, dir, "eticket-v3");
  const s = registry.add({ id: "o1", source: "neo", folder: dir, task: "work the agency backlog", chatId: 1, createdAt: Date.now() }, Date.now());
  registry.setStatus(s.id, "running");
  const plan = row(ledger, dir, PLAN); // 1/2 ticked, just updated
  const now = Date.now();
  expect(judgeExecute(deps, plan, { now })).toMatchObject({ kind: "busy" });
  expect(judgeExecute(deps, plan, { now: now + (DEFAULT_PLANS_CFG.activeWindowMinutes + 1) * 60_000 })).toMatchObject({ kind: "run" });
});

test("AC5: Execute from a worktree runs in the main checkout when the plan is there, and says so", async () => {
  const main = repo();
  put(main, PLAN, OPEN);
  commit(main);
  const wt = worktree(main, "booking-timeline");
  const { ledger, deps, submitted } = rig();
  put(wt, PLAN, OPEN + "\n"); // the worktree sent the plan last
  await seen(deps, wt, "booking-timeline");
  const r = await applyPlanAction(deps, row(ledger, wt, PLAN).id, "execute");
  expect(r.ok).toBe(true);
  expect(submitted[0]!.project).toBe(main);
  const target = row(ledger, main, PLAN); // registered for the folder that runs it
  expect(submitted[0]!.planId).toBe(target.id);
  expect(target).toMatchObject({ status: "executing", todoId: 1 });
  expect(row(ledger, wt, PLAN)).toMatchObject({ status: "executing", todoId: 1 });
  expect(r.text).toContain(main);
});

test("AC5: a plan that exists only on the worktree's branch runs in that worktree, and the reply says why", async () => {
  const main = repo();
  const wt = worktree(main, "booking-timeline");
  const { ledger, deps, submitted } = rig();
  put(wt, PLAN, OPEN);
  await seen(deps, wt, "booking-timeline");
  const r = await applyPlanAction(deps, row(ledger, wt, PLAN).id, "execute");
  expect(r.ok).toBe(true);
  expect(submitted[0]!.project).toBe(wt);
  expect(r.text).toContain(wt);
  expect(r.text).toContain("only");
});

test("AC6: Execute on a spec resolves to its one open plan", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, SPEC, SPEC_BODY);
  put(dir, PLAN, OPEN);
  await seen(deps, dir, "gold");
  const r = await applyPlanAction(deps, row(ledger, dir, SPEC).id, "execute");
  expect(r.ok).toBe(true);
  expect(submitted[0]!.brief).toContain(PLAN);
  expect(submitted[0]!.planId).toBe(row(ledger, dir, PLAN).id);
  expect(r.text).toContain(PLAN);
});

test("AC6: a spec whose plans are all done → done; one with several open plans → choose, nothing queued", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, SPEC, SPEC_BODY);
  put(dir, PLAN, DONE);
  await seen(deps, dir, "gold");
  const done = await applyPlanAction(deps, row(ledger, dir, SPEC).id, "execute");
  expect(done.text).toContain("already done");
  put(dir, PLAN, OPEN);
  put(dir, "docs/superpowers/plans/2026-10-12-phase-8.md", `# Phase 8\nSpec: ${SPEC}\n- [ ] a\n`);
  const choose = await applyPlanAction(deps, row(ledger, dir, SPEC).id, "execute");
  expect(choose.ok).toBe(false);
  expect(choose.text).toContain("2026-10-12-phase-8.md");
  expect(choose.text).toContain("2026-10-11-phase-7.md");
  expect(submitted).toHaveLength(0);
});

test("AC6: a spec with no plan runs itself; then Execute on the plan it later gets is busy (one unit)", async () => {
  const dir = repo();
  const { ledger, deps, submitted } = rig();
  put(dir, SPEC, SPEC_BODY);
  await seen(deps, dir, "gold");
  expect((await applyPlanAction(deps, row(ledger, dir, SPEC).id, "execute")).ok).toBe(true);
  expect(submitted[0]!.brief).toContain(SPEC);
  put(dir, PLAN, OPEN); // the spec's run writes the plan; its card arrives
  await seen(deps, dir, "gold");
  const r = await applyPlanAction(deps, row(ledger, dir, PLAN).id, "execute");
  expect(r.ok).toBe(false);
  expect(r.text).toContain("#1");
  expect(submitted).toHaveLength(1);
});

test("AC3: the engine's own row writes (a card send, a refused tap) are not 'ticked' — only the file's mtime is", async () => {
  const dir = repo();
  const { ledger, registry, deps } = rig();
  put(dir, PLAN, OPEN);
  const old = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(join(dir, PLAN), old, old); // the session last touched the plan two hours ago
  await seen(deps, dir, "eticket-v3"); // the row is written now
  const s = registry.add({ id: "o1", source: "neo", folder: dir, task: "work the agency backlog", chatId: 1, createdAt: Date.now() }, Date.now());
  registry.setStatus(s.id, "running");
  expect(judgeExecute(deps, row(ledger, dir, PLAN))).toMatchObject({ kind: "run" });
});
