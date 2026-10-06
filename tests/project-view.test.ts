// P6 Task 6.1 (spec §9, AC6.1–AC6.4): one read model per project — what runs now, its queue, git and
// GitHub state, open decisions, plans, attention items, recent threads, restart-gated work, health.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { reconcile } from "../src/engine/attention";
import { createGitRead, type GitRead } from "../src/engine/git-read";
import { readProjectsCfg } from "../src/engine/producers/git";
import { projectView, projectSummary, projectHealth, type ProjectViewDeps } from "../src/engine/project-view";
import type { Order } from "../src/types";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (dir: string, ...a: string[]) => spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...a], { encoding: "utf8" });
const NOW = 10_000_000;

function order(folder: string, task = "fare list port"): Order {
  return { id: crypto.randomUUID(), source: "neo", folder, task, chatId: 0, createdAt: 1 };
}

/** A repo `gold`: main pushed once then 1 commit ahead of its upstream, branch dev one commit behind
 *  main, 1 untracked file, 1 linked worktree. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "neo-pv-"));
  made.push(root);
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", remote);
  const dir = join(root, "gold");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "-u", "origin", "main");
  writeFileSync(join(dir, "b.txt"), "b");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "-m", "fix fees");
  git(dir, "branch", "dev", "HEAD~1");
  git(dir, "worktree", "add", "-q", "-b", "feat/ota", join(root, "gold-ota"));
  writeFileSync(join(dir, "wip.txt"), "wip");
  return { root, dir };
}

function setup(o: { read?: GitRead; projects?: unknown } = {}) {
  const { root, dir } = repo();
  const neo = join(root, "neo");
  mkdirSync(neo);
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const deps: ProjectViewDeps = {
    ledger,
    registry,
    read: o.read ?? createGitRead({ timeoutMs: 10_000 }),
    projects: readProjectsCfg(o.projects ?? { gold: { driftPairs: [["main", "dev"]] } }),
    neoFolder: neo,
  };
  return { deps, ledger, registry, dir, neo, root };
}

const failing: GitRead = {
  git: async () => ({ ok: false, out: "", err: "boom" }),
  gh: async () => ({ ok: false, out: "", err: "boom" }),
};

test("now: the project's open session — its state, its line and the thread it works", async () => {
  const s = setup();
  const sess = s.registry.add(order(s.dir), NOW - 60_000);
  s.ledger.insertThread({ id: 77, origin: "operator", title: "fix the fare list", state: "waiting", createdAt: NOW - 1000, project: "gold", folder: s.dir });
  s.registry.deliver(sess.id, { msgId: 77, threadId: 77 });
  const v = (await projectView(s.deps, "gold", NOW))!;
  expect(v.name).toBe("gold");
  expect(v.folder).toBe(s.dir);
  expect(v.now?.state).toBeDefined();
  expect(typeof v.now?.line).toBe("string");
  expect(v.now?.thread).toMatchObject({ id: 77, ref: "m25", title: "fix the fare list", state: "waiting" });
});

test("no open session → now is null", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  expect((await projectView(s.deps, "gold", NOW))!.now).toBeNull();
});

test("queue: the project's running and queued todos, positions per queue; other projects' todos excluded", async () => {
  const s = setup();
  const add = (folder: string, brief: string) => s.ledger.addTodo({ project: basename(folder), folder, brief, workClass: "interactive", createdBy: "operator" }, NOW);
  const t1 = add(s.dir, "admin fees");
  add(s.dir, "ota server");
  add("/elsewhere/other", "not ours");
  s.ledger.updateTodo(t1.id, { status: "running", startedAt: NOW });
  const v = (await projectView(s.deps, "gold", NOW))!;
  expect(v.queue.map((t) => [t.title, t.status, t.position])).toEqual([
    ["admin fees", "running", 0],
    ["ota server", "queued", 1],
  ]);
});

test("git: branch, last commit, unpushed, dirty, drift, worktrees — read live", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  const g = (await projectView(s.deps, "gold", NOW))!.git;
  expect(g.error).toBeUndefined();
  expect(g.branch).toBe("main");
  expect(g.lastCommit).toMatch(/^[0-9a-f]{7,} fix fees$/);
  expect(typeof g.lastCommitAt).toBe("number");
  expect(g.unpushed).toBe(1);
  expect(g.dirty).toBe(1);
  expect(g.drift).toEqual({ from: "main", to: "dev", ahead: 1 });
  expect(g.worktrees).toBe(1);
});

test("git: no deployedVersionUrl → undeployed absent; no driftPairs → drift absent", async () => {
  const s = setup({ projects: {} });
  s.ledger.recordOrder(order(s.dir));
  const g = (await projectView(s.deps, "gold", NOW))!.git;
  expect("undeployed" in g).toBe(false);
  expect("drift" in g).toBe(false);
});

test("git: a failed read leaves the fields out and names the error; projectView never throws", async () => {
  const s = setup({ read: failing });
  s.ledger.recordOrder(order(s.dir));
  const g = (await projectView(s.deps, "gold", NOW))!.git;
  expect(g.branch).toBeUndefined();
  expect(g.unpushed).toBeUndefined();
  expect(g.dirty).toBeUndefined();
  expect(g.worktrees).toBeUndefined();
  expect(g.error).toContain("could not read");
  expect(g.error).toContain("branch");
  const throwing: GitRead = { git: async () => { throw new Error("spawn failed"); }, gh: async () => { throw new Error("x"); } };
  const t = setup({ read: throwing });
  t.ledger.recordOrder(order(t.dir));
  expect((await projectView(t.deps, "gold", NOW))!.git.error).toContain("could not read");
});

test("github: the counts of the gh:<project> scan meta, its last good scan and its error", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  expect((await projectView(s.deps, "gold", NOW))!.github).toEqual({ prs: 0, ciFailed: 0, issues: 0, alerts: 0 });
  s.ledger.setMeta(
    "gh:gold",
    { lastScanAt: 950, lastGoodAt: 900, github: true, error: "rate limited", counts: { pr_open: 1, pr_review_requested: 1, ci_failed: 1, issue_open: 4, dependabot: 1, secret_scanning: 1, unpushed: 3 } },
    950,
  );
  expect((await projectView(s.deps, "gold", NOW))!.github).toEqual({ prs: 2, ciFailed: 1, issues: 4, alerts: 2, scannedAt: 900, error: "rate limited" });
});

test("decisions: the project's open decisions with age and thread ref; others excluded", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  const id = s.ledger.openDecision({ kind: "decision", project: "gold", question: "ship fee change to prod?", cause: { msgId: 40, threadId: 36 } }, NOW - 3000);
  s.ledger.openDecision({ kind: "decision", project: "other", question: "not ours" }, NOW);
  expect((await projectView(s.deps, "gold", NOW))!.decisions).toEqual([{ id, question: "ship fee change to prod?", ageMs: 3000, ref: "m10" }]);
});

test("plans: title, status, steps and thread ref; a plan whose file was deleted keeps its status and reads 'file missing'", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  mkdirSync(join(s.dir, "docs/plans"), { recursive: true });
  writeFileSync(join(s.dir, "docs/plans/ota.md"), "# OTA server");
  const base = { project: "gold", folder: s.dir, sha256: "x" };
  const kept = s.ledger.upsertPlan({ ...base, path: "docs/plans/ota.md", title: "OTA server", status: "sent", stepsTotal: 3, stepsDone: 0 });
  const gone = s.ledger.upsertPlan({ ...base, path: "docs/plans/fare.md", title: "Fare list port", status: "executing", stepsTotal: 12, stepsDone: 7, threadId: 36 });
  const plans = (await projectView(s.deps, "gold", NOW))!.plans;
  const byId = new Map(plans.map((p) => [p.id, p]));
  expect(byId.get(gone.id)).toMatchObject({ title: "Fare list port", status: "executing", steps: "7/12", ref: "m10", fileMissing: true });
  expect(byId.get(gone.id)!.line).toContain("file missing");
  expect(byId.get(kept.id)!.fileMissing).toBeUndefined();
  expect(byId.get(kept.id)!.line).not.toContain("file missing");
});

test("attention: open items of the project, severity then age, each with its actions", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  const d = { project: "gold", folder: s.dir, source: "git" as const, title: "t" };
  reconcile(s.ledger, "git", "gold", [
    { ...d, kind: "unpushed", key: "main", severity: "normal", title: "main is 1 ahead" },
    { ...d, kind: "dirty", key: s.dir, severity: "high", title: "uncommitted" },
  ], NOW - 5000);
  reconcile(s.ledger, "git", "other", [{ ...d, project: "other", kind: "unpushed", key: "x", severity: "high" }], NOW);
  const a = (await projectView(s.deps, "gold", NOW))!.attention;
  expect(a.map((x) => [x.title, x.severity])).toEqual([["uncommitted", "high"], ["main is 1 ahead", "normal"]]);
  expect(a[0]!.actions).toEqual(["todo", "snooze", "dismiss"]);
  expect(a[0]!.ageMs).toBe(5000);
});

test("threads: the project's newest 10", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  for (let i = 1; i <= 12; i++) s.ledger.insertThread({ id: i, origin: "operator", title: `t${i}`, state: "done", createdAt: NOW - 1000 + i, project: "gold", folder: s.dir });
  s.ledger.insertThread({ id: 99, origin: "operator", title: "other", state: "done", createdAt: NOW, project: "other" });
  const t = (await projectView(s.deps, "gold", NOW))!.threads;
  expect(t.length).toBe(10);
  expect(t[0]).toMatchObject({ id: 12, title: "t12", ref: "mc" });
});

test("restartGated: set for Neo's own folder from the open restart items; absent for other projects", async () => {
  const s = setup();
  s.ledger.recordOrder(order(s.dir));
  s.ledger.recordOrder(order(s.neo));
  reconcile(s.ledger, "restart", "neo", [
    { project: "neo", folder: s.neo, source: "restart", kind: "restart_gated", key: "live-code", title: "live code differs from running code", detail: "abc fix", severity: "normal" },
  ], NOW);
  const neo = (await projectView(s.deps, "neo", NOW))!;
  expect(neo.restartGated).toEqual([{ key: "live-code", title: "live code differs from running code", detail: "abc fix" }]);
  expect("restartGated" in (await projectView(s.deps, "gold", NOW))!).toBe(false);
});

test("an unknown project → undefined; a known folder with no data → health unknown", async () => {
  const s = setup();
  expect(await projectView(s.deps, "ghost", NOW)).toBeUndefined();
  expect(projectSummary(s.deps, "ghost", NOW)).toBeUndefined();
  s.ledger.recordOrder(order(s.dir));
  expect((await projectView(s.deps, "gold", NOW))!.health).toBe("unknown");
});

test("health table (pure)", () => {
  const base = { healthUrl: undefined, probe: undefined, high: 0, hasData: true };
  expect(projectHealth(base)).toBe("ok");
  expect(projectHealth({ ...base, hasData: false })).toBe("unknown");
  expect(projectHealth({ ...base, high: 1 })).toBe("attention");
  expect(projectHealth({ ...base, healthUrl: "https://x", probe: { at: 1, ok: false }, high: 1 })).toBe("down");
  expect(projectHealth({ ...base, healthUrl: "https://x", probe: { at: 1, ok: true } })).toBe("ok");
  // A failed probe without a configured healthUrl is not "down" (the URL was removed since).
  expect(projectHealth({ ...base, probe: { at: 1, ok: false } })).toBe("ok");
  // A configured URL that was never probed: no verdict yet.
  expect(projectHealth({ ...base, healthUrl: "https://x" })).toBe("ok");
});

test("health in the view: down from the probe meta when healthUrl is configured; attention on a high item", async () => {
  const s = setup({ projects: { gold: { healthUrl: "https://gold.example/health" } } });
  s.ledger.recordOrder(order(s.dir));
  reconcile(s.ledger, "git", "gold", [{ project: "gold", folder: s.dir, source: "git", kind: "dirty", key: s.dir, title: "u", severity: "high" }], NOW);
  expect((await projectView(s.deps, "gold", NOW))!.health).toBe("attention");
  s.ledger.setMeta("probe:gold", { at: NOW, ok: false, error: "503" }, NOW);
  expect((await projectView(s.deps, "gold", NOW))!.health).toBe("down");
});

test("projectSummary: name, folder, state/line, queue count, open attention by severity, health — no git", () => {
  const s = setup();
  s.registry.add(order(s.dir), NOW - 1000);
  s.ledger.addTodo({ project: "gold", folder: s.dir, brief: "admin fees", workClass: "interactive", createdBy: "operator" }, NOW);
  const d = { project: "gold", folder: s.dir, source: "git" as const, title: "t" };
  reconcile(s.ledger, "git", "gold", [
    { ...d, kind: "dirty", key: "a", severity: "high" },
    { ...d, kind: "unpushed", key: "b", severity: "normal" },
    { ...d, kind: "unpushed", key: "c", severity: "normal" },
  ], NOW);
  const sum = projectSummary(s.deps, "gold", NOW)!;
  expect(sum).toMatchObject({ name: "gold", folder: s.dir, queue: 1, attention: { high: 1, normal: 2, low: 0 }, health: "attention" });
  expect(typeof sum.state).toBe("string");
  expect(typeof sum.line).toBe("string");
  expect("git" in sum).toBe(false);
});

test("readProjectsCfg keeps healthUrl, deployedVersionUrl, deployedVersionPath, deployBranch; drops malformed ones", () => {
  const cfg = readProjectsCfg({
    gold: { healthUrl: "https://h", deployedVersionUrl: "https://v", deployedVersionPath: "version", deployBranch: "main" },
    bad: { healthUrl: 3, deployedVersionPath: "", deployBranch: ["x"] },
  });
  expect(cfg.gold).toEqual({ healthUrl: "https://h", deployedVersionUrl: "https://v", deployedVersionPath: "version", deployBranch: "main" });
  expect(cfg.bad).toEqual({});
});
