// P6 Task 6.2 (spec §9, AC6.1/AC6.4): the project dashboard's surfaces — the project list, the
// Telegram renderer behind `/project` (`/p`), its buttons, and the company's `sessions` tool block —
// all read the one read model (project-view.ts).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { reconcile } from "../src/engine/attention";
import { handleCommand, telegramCommands, type CommandDeps } from "../src/engine/commands";
import { openTrustStore } from "../src/engine/trust";
import { knownProjects, projectSummaries, projectUrl, renderProject, summaryLine, type ProjectView } from "../src/engine/project-view";
import { sessionsReport } from "../src/engine/session-status";
import type { Order } from "../src/types";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const NOW = 10_000_000;

function order(folder: string): Order {
  return { id: crypto.randomUUID(), source: "neo", folder, task: "t", chatId: 0, createdAt: 1 };
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "neo-pd-"));
  made.push(root);
  const dir = (name: string) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const neo = dir("neo");
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  return { root, dir, neo, ledger, registry, deps: { ledger, registry, projects: {}, neoFolder: neo } };
}

const high = (project: string, folder: string, key: string) => ({ project, folder, source: "git" as const, kind: "dirty", key, title: `dirty ${key}`, severity: "high" as const });

test("knownProjects: Neo, open sessions, order folders still on disk and active todo folders — once each", () => {
  const w = world();
  const gold = w.dir("gold");
  w.ledger.recordOrder(order(gold));
  w.ledger.recordOrder(order(gold));
  w.ledger.recordOrder(order(join(w.root, "gone"))); // deleted folder: not a project any more
  w.registry.add(order(w.dir("silver")), NOW);
  w.ledger.addTodo({ project: "copper", folder: w.dir("copper"), brief: "b", workClass: "interactive", createdBy: "operator" }, NOW);
  expect(knownProjects(w.deps)).toEqual(["copper", "gold", "neo", "silver"]);
});

test("projectSummaries: health first (down, attention, ok, unknown), then name; bounded with the total", () => {
  const w = world();
  for (const n of ["a", "b", "c"]) w.ledger.recordOrder(order(w.dir(n)));
  reconcile(w.ledger, "git", "c", [high("c", join(w.root, "c"), "x")], NOW);
  w.ledger.addTodo({ project: "b", folder: join(w.root, "b"), brief: "b", workClass: "interactive", createdBy: "operator" }, NOW);
  const all = projectSummaries(w.deps, NOW, 100);
  expect(all.rows.map((r) => [r.name, r.health])).toEqual([["c", "attention"], ["b", "ok"], ["a", "unknown"], ["neo", "unknown"]]);
  expect(all.total).toBe(4);
  const page = projectSummaries(w.deps, NOW, 2);
  expect(page.rows.map((r) => r.name)).toEqual(["c", "b"]);
  expect(page.total).toBe(4);
});

test("summaryLine: name, health, state, queue and open attention by severity", () => {
  expect(summaryLine({ name: "gold", folder: "/g", state: "working", line: "x", queue: 2, attention: { high: 1, normal: 2, low: 0 }, health: "attention" })).toBe(
    "gold · 🟠 attention · working · queue 2 · attention 1 high, 2 normal",
  );
  expect(summaryLine({ name: "tin", folder: "/t", queue: 0, attention: { high: 0, normal: 0, low: 0 }, health: "unknown" })).toBe("tin · ⚪ unknown · no session · queue 0 · no attention");
});

function view(over: Partial<ProjectView> = {}): ProjectView {
  return {
    name: "gold",
    folder: "/home/gold",
    now: { state: "working", line: "working · Bash: bun test · up 12m", thread: { id: 9, ref: "m4g2", title: "fare list port", state: "waiting", updatedAt: NOW } },
    queue: [
      { id: 31, project: "gold", status: "running", position: 0, title: "fare list", createdAt: 1 },
      { id: 32, project: "gold", status: "queued", position: 1, title: "admin fees", createdAt: 1 },
      { id: 33, project: "gold", status: "queued", position: 2, title: "x", createdAt: 1 },
    ],
    git: { branch: "dev", lastCommit: "a1b2c3 fix fees", lastCommitAt: NOW - 2 * 3_600_000, unpushed: 3, dirty: 0, drift: { from: "dev", to: "main", ahead: 14 }, worktrees: 1 },
    github: { prs: 2, ciFailed: 1, issues: 4, alerts: 1, scannedAt: NOW - 60_000 },
    decisions: [{ id: "d1", question: "ship fee change to prod?", ageMs: 3 * 3_600_000, ref: "m4g7" }],
    plans: [{ id: 1, title: "Fare list port", status: "executing", steps: "7/12", ref: "m4g2", line: "Fare list port — executing 7/12" }],
    attention: [{ id: 5, source: "git", kind: "dirty", severity: "high", title: "CI failed on dev", ageMs: 1000, actions: ["todo", "snooze", "dismiss"] }],
    threads: [{ id: 9, ref: "m4g2", title: "fix the fare list", state: "waiting", updatedAt: NOW }],
    health: "attention",
    ...over,
  };
}

test("renderProject: the Telegram sketch — health, now, queue, git, github, decide, plans, attention", () => {
  const text = renderProject(view(), NOW, { maxLines: 30 });
  const lines = text.split("\n");
  expect(lines[0]).toBe("gold · 🟠 attention");
  expect(text).toContain("now: working · Bash: bun test · up 12m — fare list port · m4g2");
  expect(text).toContain("queue: #31 running, 2 queued");
  expect(text).toContain("git: dev a1b2c3 fix fees (2h) · 3 unpushed · dev→main +14 · 1 worktree");
  expect(text).toContain("github: 2 PRs · CI ❌ 1 · 4 issues · 1 alert");
  expect(text).toContain("decide: ship fee change to prod? (3h) · m4g7");
  expect(text).toContain("plans: Fare list port — executing 7/12 · m4g2");
  expect(text).toContain("attention: 1 open — 1 high");
  expect(text).not.toContain("deploy:"); // AC6.2: no deployedVersionUrl → no undeployed line
  expect(text).not.toContain("restart-gated");
});

test("renderProject: no upstream, a git error, a scan error, dirty files, undeployed and the empty parts", () => {
  const text = renderProject(
    view({
      now: null,
      queue: [],
      git: { branch: "feat/x", noUpstream: true, dirty: 2, undeployed: 4, error: "could not read: worktrees (timeout)" },
      github: { prs: 0, ciFailed: 0, issues: 0, alerts: 0, error: "gh: not logged in" },
      decisions: [],
      plans: [{ id: 2, title: "OTA", status: "sent", steps: "0/3", fileMissing: true, line: "OTA — sent 0/3 · file missing" }],
      attention: [],
    }),
    NOW,
    { maxLines: 30 },
  );
  expect(text).toContain("now: no session open");
  expect(text).toContain("queue: empty");
  expect(text).toContain("git: feat/x · no upstream · 2 uncommitted");
  expect(text).toContain("git error: could not read: worktrees (timeout)");
  expect(text).toContain("deploy: 4 commits not deployed");
  expect(text).toContain("github: never scanned · error: gh: not logged in");
  expect(text).toContain("OTA — sent 0/3 · file missing");
  expect(text).toContain("attention: nothing open");
  expect(text).not.toContain("decide:");
});

test("renderProject: Neo's restart-gated work (AC6.4)", () => {
  const text = renderProject(view({ name: "neo", restartGated: [{ key: "k", title: "3 commits after boot on master" }] }), NOW, { maxLines: 30 });
  expect(text).toContain("restart-gated: 3 commits after boot on master");
});

test("renderProject: bounded — at most maxLines lines, long titles cut, well under Telegram's 4096", () => {
  const long = "q".repeat(500);
  const v = view({
    decisions: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, question: long, ageMs: 1, ref: "m1" })),
    plans: Array.from({ length: 10 }, (_, i) => ({ id: i, title: long, status: "sent" as const, steps: "0/1", line: `${long} — sent 0/1` })),
    git: { branch: "dev", error: long },
  });
  const text = renderProject(v, NOW, { maxLines: 12 });
  expect(text.split("\n").length).toBeLessThanOrEqual(12);
  expect(text).toContain("more lines");
  expect(text.length).toBeLessThan(4096);
  expect(renderProject(v, NOW, { maxLines: 1000 }).length).toBeLessThan(4096 * 2); // every line is bounded
});

test("projectUrl: the console link opens the project's dashboard", () => {
  expect(projectUrl("https://neo.example/", "gold")).toBe("https://neo.example/#project=gold");
  expect(projectUrl("https://neo.example", "a b")).toBe("https://neo.example/#project=a%20b");
});

function cmdDeps(w: ReturnType<typeof world>, over: Partial<CommandDeps> = {}): CommandDeps {
  return { registry: w.registry, ledger: w.ledger, trust: openTrustStore(":memory:"), neoFolder: w.neo, now: () => NOW, cfg: { providers: { ownWork: "subscription", customerWork: "gemini" }, publicUrl: "https://neo.example" }, ...over };
}

test("/project <name>: the dashboard text and its buttons (attention count, threads, console)", async () => {
  const w = world();
  const gold = w.dir("gold");
  w.ledger.recordOrder(order(gold));
  reconcile(w.ledger, "git", "gold", [high("gold", gold, "a"), high("gold", gold, "b")], NOW);
  const r = handleCommand("/project gold", 1, cmdDeps(w))!;
  expect(r.later).toBeDefined();
  const done = await r.later!;
  expect(done.text.split("\n")[0]).toBe("gold · 🟠 attention");
  expect(done.text).toContain("git error:"); // not a repo: the failed read is named, never a crash
  expect(done.project).toEqual({ name: "gold", attention: 2, consoleUrl: "https://neo.example/#project=gold" });
  // the alias
  expect((await handleCommand("/p gold", 1, cmdDeps(w))!.later!).text.split("\n")[0]).toBe("gold · 🟠 attention");
});

test("/project with no name lists every project's one-line summary; an unknown name says so", async () => {
  const w = world();
  w.ledger.recordOrder(order(w.dir("gold")));
  const list = await handleCommand("/project", 1, cmdDeps(w))!.later!;
  expect(list.text).toContain("gold · ⚪ unknown · no session · queue 0 · no attention");
  expect(list.text).toContain("neo ·");
  expect(list.project).toBeUndefined();
  const ghost = await handleCommand("/project ghost", 1, cmdDeps(w))!.later!;
  expect(ghost.text).toBe('No project "ghost" — /project lists the projects the engine knows.');
  expect(ghost.project).toBeUndefined();
});

test("/project <name> threads: the project's newest threads with their refs", async () => {
  const w = world();
  const gold = w.dir("gold");
  w.ledger.recordOrder(order(gold));
  w.ledger.insertThread({ id: 77, origin: "operator", title: "fix the fare list", state: "waiting", createdAt: NOW - 3_600_000, project: "gold", folder: gold });
  const r = await handleCommand("/project gold threads", 1, cmdDeps(w))!.later!;
  expect(r.text).toContain("threads of gold");
  expect(r.text).toMatch(/\S+ waiting fix the fare list \(1h\)/);
  expect(r.text).toContain("/trace <ref>");
});

test("/project is in the Telegram command menu and in /help", () => {
  expect(telegramCommands().some((c) => c.command === "project")).toBe(true);
  const w = world();
  expect(handleCommand("/help", 1, cmdDeps(w))!.text).toContain("/project");
});

test("sessionsReport: the project block follows the session lines; the existing output stays", () => {
  const reg = createRegistry();
  const a = reg.add(order("/p/alpha"), 1);
  reg.attachControl(a.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false });
  const lines = ["alpha · 🟢 ok · idle · queue 0 · no attention", "gold · 🟠 attention · no session · queue 1 · attention 1 high"];
  const report = sessionsReport(reg, 1, undefined, { lines, total: 3 });
  expect(report).toContain("alpha · /p/alpha — ");
  expect(report).toContain("idle = healthy");
  expect(report).toContain("Projects (health · session · queue · open attention):\nalpha · 🟢 ok");
  expect(report).toContain("gold · 🟠 attention");
  expect(report).toContain("… +1 more");
  // With no project block the report is unchanged.
  expect(sessionsReport(reg, 1)).not.toContain("Projects (");
});

test("the company's sessions tool carries the project block (no new tool); the company itself is left out", async () => {
  const { neoMcpServers } = await import("../src/engine/dispatch");
  const { createMeter } = await import("../src/engine/budget");
  const w = world();
  const gold = w.dir("gold");
  w.ledger.recordOrder(order(gold));
  reconcile(w.ledger, "git", "gold", [high("gold", gold, "a")], NOW);
  const company = w.registry.add(order(w.dir("agent")), NOW);
  w.registry.setDefault(company.id);
  const servers = neoMcpServers(
    { ledger: w.ledger, registry: w.registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), reply: () => {}, askApproval: async () => "deny", neoFolder: w.neo },
    7,
    { dispatch: true, workClass: "interactive", folder: w.dir("agent") },
  );
  const neo = servers!.neo as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
  expect(Object.keys(neo.instance._registeredTools)).not.toContain("projects"); // no new tool
  const text = (await neo.instance._registeredTools.sessions!.handler({}, {})).content[0]!.text;
  expect(text).toContain("No projects are open right now"); // the existing output stays
  expect(text).toContain("Projects (health · session · queue · open attention):");
  expect(text).toContain("gold · 🟠 attention · no session · queue 0 · attention 1 high");
  expect(text).not.toMatch(/^agent ·/m);
});
