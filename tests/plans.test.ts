import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { changedPlanFiles, registerPlan, countSteps, DEFAULT_PLAN_PATHS } from "../src/engine/plans";

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-plans-"));
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

test("a committed new plan since the start sha is found; files outside the globs are not", () => {
  const dir = repo();
  const start = sh(dir, "rev-parse", "HEAD");
  put(dir, "docs/superpowers/plans/a.md", "# A");
  put(dir, "src/notes.md", "# N");
  sh(dir, "add", "."); sh(dir, "commit", "-qm", "plan");
  expect(changedPlanFiles(dir, start, DEFAULT_PLAN_PATHS)).toEqual(["docs/superpowers/plans/a.md"]);
});

test("untracked and modified-uncommitted plans are found; unchanged ones are not", () => {
  const dir = repo();
  put(dir, "specs/old.md", "# old");
  sh(dir, "add", "."); sh(dir, "commit", "-qm", "old");
  const start = sh(dir, "rev-parse", "HEAD");
  put(dir, "plans/new.md", "# new");
  expect(changedPlanFiles(dir, start, DEFAULT_PLAN_PATHS)).toEqual(["plans/new.md"]);
  put(dir, "specs/old.md", "# old edited");
  expect(changedPlanFiles(dir, start, DEFAULT_PLAN_PATHS).sort()).toEqual(["plans/new.md", "specs/old.md"]);
});

test("no sinceSha → only working-tree changes", () => {
  const dir = repo();
  put(dir, "plans/c.md", "# c");
  sh(dir, "add", "."); sh(dir, "commit", "-qm", "c");
  expect(changedPlanFiles(dir, undefined, DEFAULT_PLAN_PATHS)).toEqual([]);
  put(dir, "plans/u.md", "# u");
  expect(changedPlanFiles(dir, undefined, DEFAULT_PLAN_PATHS)).toEqual(["plans/u.md"]);
});

test("not a git repo or a git failure → [] and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-nogit-"));
  expect(changedPlanFiles(dir, "abc", DEFAULT_PLAN_PATHS)).toEqual([]);
  expect(changedPlanFiles(dir, "abc", DEFAULT_PLAN_PATHS, () => { throw new Error("boom"); })).toEqual([]);
  expect(changedPlanFiles(dir, "abc", DEFAULT_PLAN_PATHS, () => undefined)).toEqual([]);
});

test("registerPlan: same content is not a new version; changed content is", () => {
  const led = openLedger(":memory:");
  const p = { project: "neo", folder: "/f", path: "docs/superpowers/plans/a.md", content: "# Title\n- [ ] one\n- [x] two\n" };
  const first = registerPlan(led, p);
  expect(first.isNewVersion).toBe(true);
  expect(first.plan).toMatchObject({ title: "Title", status: "draft", stepsTotal: 2, stepsDone: 1 });
  const again = registerPlan(led, p);
  expect(again.isNewVersion).toBe(false);
  expect(again.plan.id).toBe(first.plan.id);
  const changed = registerPlan(led, { ...p, content: "# Title\n- [ ] one\n- [ ] two\n- [ ] three\n" });
  expect(changed.isNewVersion).toBe(true);
  expect(changed.plan).toMatchObject({ id: first.plan.id, stepsTotal: 3, stepsDone: 0 });
  expect(led.listPlans().length).toBe(1);
});

test("a new version resets sent to draft but an approved plan keeps its status", () => {
  const led = openLedger(":memory:");
  const p = { project: "neo", folder: "/f", path: "plans/a.md", content: "# A" };
  const { plan } = registerPlan(led, p);
  led.upsertPlan({ ...plan, status: "sent", sentAt: 5 });
  expect(registerPlan(led, { ...p, content: "# A2" }).plan.status).toBe("draft");
  led.upsertPlan({ ...led.planByPath("/f", "plans/a.md")!, status: "approved" });
  const r = registerPlan(led, { ...p, content: "# A3\n- [ ] x" });
  expect(r.plan).toMatchObject({ status: "approved", stepsTotal: 1 });
  expect(r.isNewVersion).toBe(true);
});

test("registerPlan stores the cause and order", () => {
  const led = openLedger(":memory:");
  const { plan } = registerPlan(led, { project: "neo", folder: "/f", path: "plans/a.md", content: "# A", cause: { msgId: 3, threadId: 9 }, orderId: "o1" });
  expect(plan).toMatchObject({ threadId: 9, orderId: "o1" });
  expect(led.planById(plan.id)?.path).toBe("plans/a.md");
});

test("countSteps ignores fenced blocks", () => {
  const md = "# T\n- [ ] a\n- [x] b\n```md\n- [ ] no\n- [x] no\n```\n  - [X] c\n* [ ] d\n";
  expect(countSteps(md)).toEqual({ total: 4, done: 2 });
});

test("title is the first # heading, else the filename", () => {
  const led = openLedger(":memory:");
  const a = registerPlan(led, { project: "p", folder: "/f", path: "plans/x.md", content: "intro\n## sub\n# Real\n" });
  expect(a.plan.title).toBe("Real");
  const b = registerPlan(led, { project: "p", folder: "/f", path: "plans/my-plan.md", content: "no heading" });
  expect(b.plan.title).toBe("my-plan.md");
  const c = registerPlan(led, { project: "p", folder: "/f", path: "plans/z.md", content: "```\n# fenced\n```\n" });
  expect(c.plan.title).toBe("z.md");
});

test("listPlans is bounded and filters by project", () => {
  const led = openLedger(":memory:");
  for (let i = 0; i < 5; i++) registerPlan(led, { project: i % 2 ? "a" : "b", folder: "/f", path: `plans/${i}.md`, content: `# ${i}` });
  expect(led.listPlans("a").length).toBe(2);
  expect(led.listPlans(undefined, 3).length).toBe(3);
});
