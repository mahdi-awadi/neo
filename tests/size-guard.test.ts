// ADR-0072: the upgrade guard — deny, move up, plan first (spec §5.1, §5.3, §5.4; AC 8–11 and 23). Fake files
// and git through the seams; the real `walkBash`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { configureFaults, createFaultReporter } from "../src/engine/fault";
import { createSizeGuard, touchOf, type GuardFiles, type SizeGuardOpts } from "../src/engine/size-guard";
import {
  DEFAULT_SIZES_CFG,
  GUARD_ERROR_TEXT,
  JUST_FIX_TEXT,
  measureFailedText,
  plannerDenyText,
  type OrderSize,
  type SizeUp,
} from "../src/engine/order-size";
import { DEFAULT_PLAN_PATHS } from "../src/engine/plans";

const FOLDER = "/nonexistent-neo-size/repo";
const abs = (rel: string) => join(FOLDER, rel);

let reported: Array<Record<string, unknown>> = [];
beforeEach(() => {
  reported = [];
  configureFaults(
    createFaultReporter(
      { log: () => {}, record: (d) => void reported.push(d) },
      { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false, maxHandoffsPerHour: 0 },
    ),
  );
});
afterEach(() => {
  configureFaults(createFaultReporter({ log: (l) => console.error(l) }, { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false, maxHandoffsPerHour: 0 }));
});

/** Fake files: folder-relative path → text. */
function fakeFiles(init: Record<string, string> = {}): GuardFiles & { set(rel: string, text: string): void } {
  const m = new Map(Object.entries(init).map(([k, v]) => [abs(k), v]));
  return {
    exists: (p) => m.has(p),
    read: (p) => m.get(p),
    set: (rel, text) => void m.set(abs(rel), text),
  };
}

/** Fake git: the diff and the untracked list the test sets; `fail` makes every read fail. */
function fakeGit() {
  const state = { diff: "", others: "", fail: false, calls: 0 };
  const run = (_folder: string, args: string[]): string | undefined => {
    state.calls++;
    if (state.fail) return undefined;
    if (args[0] === "rev-parse") return "\n";
    if (args[0] === "check-ignore") return undefined;
    if (args[0] === "diff") return state.diff;
    if (args[0] === "ls-files") return state.others;
    return undefined;
  };
  return { state, run };
}
/** A numstat -z diff of `n` changed files of 1 line each. */
const numstat = (n: number, dir = "src") => Array.from({ length: n }, (_, i) => `1\t0\t${dir}/m${i}.ts\0`).join("");

function guard(size: OrderSize, over: Partial<SizeGuardOpts> = {}) {
  const ups: SizeUp[] = [];
  let approved = false;
  const g = fakeGit();
  const files = (over.files as ReturnType<typeof fakeFiles>) ?? fakeFiles();
  const sg = createSizeGuard({
    size,
    folder: FOLDER,
    project: "p",
    cfg: DEFAULT_SIZES_CFG,
    planPaths: DEFAULT_PLAN_PATHS,
    baseline: { root: FOLDER, own: () => true },
    startSha: "abc",
    planApproved: () => approved,
    onUp: (up) => void ups.push(up),
    now: () => 1000,
    git: g.run,
    files,
    ...over,
  });
  return { sg, ups, git: g.state, files, approve: () => void (approved = true) };
}

let ids = 0;
/** One call through the steer; when it is let through, it runs (ok) and its result comes back. */
function call(sg: ReturnType<typeof createSizeGuard>, tool: string, input: unknown, failed = false): string | undefined {
  const denied = sg.steer(tool, input);
  if (denied !== undefined) return denied;
  const id = `t${++ids}`;
  sg.onToolUse(id, tool, input);
  sg.onToolResult(id, failed);
  return undefined;
}
const write = (path: string, content = "x\n") => ({ file_path: abs(path), content });

// ── touchOf ──────────────────────────────────────────────────────────────────────────────────────────

test("touchOf: Write (new and existing, multiset lines), Edit (replace_all), MultiEdit, NotebookEdit", () => {
  const files = fakeFiles({ "src/old.ts": "a\nb\nc\n", "src/many.ts": "x\ny\n--\nx\ny\n--\nx\ny\n" });
  const o = { folder: FOLDER, files };
  expect(touchOf("Write", write("src/new.ts", "1\n2\n"), o).paths).toEqual([{ path: "src/new.ts", lines: 2, created: true }]);
  expect(touchOf("Write", write("src/old.ts", "a\nc\nb\nd\n"), o).paths).toEqual([{ path: "src/old.ts", lines: 1, created: false }]);
  expect(touchOf("Write", write("src/old.ts", "a\nz\n"), o).paths[0]!.lines).toBe(3); // b, c out; z in
  const edit = { file_path: abs("src/many.ts"), old_string: "x\ny", new_string: "x\nz" };
  expect(touchOf("Edit", edit, o).paths).toEqual([{ path: "src/many.ts", lines: 2, created: false }]);
  expect(touchOf("Edit", { ...edit, replace_all: true }, o).paths[0]!.lines).toBe(6);
  const multi = { file_path: abs("src/old.ts"), edits: [{ old_string: "a", new_string: "a2" }, { old_string: "b", new_string: "b\nb2" }] };
  expect(touchOf("MultiEdit", multi, o).paths).toEqual([{ path: "src/old.ts", lines: 3, created: false }]);
  expect(touchOf("NotebookEdit", { notebook_path: abs("n.ipynb"), new_source: "a\nb" }, o).paths).toEqual([{ path: "n.ipynb", lines: 2, created: true }]);
  // A path outside the run's folder is not the project's change.
  expect(touchOf("Write", { file_path: "/tmp/elsewhere.ts", content: "x" }, o).paths).toEqual([]);
});

test("touchOf: Bash writes — redirect, sed -i, git rm, cp; outside paths dropped", () => {
  const files = fakeFiles({ "a.ts": "a", "b.ts": "b", "old.ts": "o" });
  const o = { folder: FOLDER, files };
  const paths = (cmd: string) => touchOf("Bash", { command: cmd }, o).paths.map((p) => [p.path, p.created]);
  expect(paths("echo hi > out.txt 2>&1")).toEqual([["out.txt", true]]);
  expect(paths("sed -i 's/a/b/' a.ts b.ts")).toEqual([["a.ts", false], ["b.ts", false]]);
  expect(paths("git rm -q old.ts")).toEqual([["old.ts", false]]);
  expect(paths("git mv a.ts c.ts")).toEqual([["a.ts", false], ["c.ts", true]]);
  expect(paths("cp a.ts dst.ts")).toEqual([["dst.ts", true]]);
  expect(paths("cd src && echo x > y.ts")).toEqual([["src/y.ts", true]]);
  expect(paths("echo x > /tmp/elsewhere; ls > /dev/null")).toEqual([]);
  expect(touchOf("Bash", { command: "echo hi > out.txt" }, o).paths[0]!.lines).toBe(0);
});

test("touchOf: command heads after sudo/env/VAR=; commit points; the planner", () => {
  const o = { folder: FOLDER, files: fakeFiles() };
  const t = (cmd: string) => touchOf("Bash", { command: cmd }, o);
  expect(t("sudo env FOO=1 kubectl apply -f k8s/x.yaml --wait").commands).toEqual(["kubectl apply -f k8s/x.yaml"]);
  expect(t("X=1 ssh prod-1 && ls").commands).toEqual(["ssh prod-1", "ls"]);
  for (const c of ["git commit -m x", `git -C ${FOLDER} commit -qm x`, "git merge dev", "git cherry-pick abc", "git revert HEAD", "git rebase main", "git am p.patch"]) {
    expect(t(c).commit).toBe(true);
  }
  for (const c of ["git status", "git log -1", "echo git commit", "git add ."]) expect(t(c).commit).toBe(false);
  expect(touchOf("Agent", { subagent_type: "planner", prompt: "p" }, o).planner).toBe(true);
  expect(touchOf("Task", { subagent_type: "planner", prompt: "p" }, o).planner).toBe(true);
  expect(touchOf("Agent", { subagent_type: "Explore", prompt: "p" }, o).planner).toBe(false);
  expect(touchOf("Read", { file_path: abs("a.ts") }, o)).toEqual({ paths: [], commands: [], commit: false, planner: false });
});

// ── the limits (AC 8) ────────────────────────────────────────────────────────────────────────────────

test("quick: the sixth file is denied once with upSteer; size standard; onUp once; the same call then runs", () => {
  const { sg, ups } = guard("quick");
  for (let i = 0; i < 5; i++) expect(call(sg, "Write", write(`src/f${i}.ts`))).toBeUndefined();
  const sixth = write("src/f5.ts");
  const denied = sg.steer("Write", sixth);
  expect(denied).toStartWith("Not run: Neo moved this order up from QUICK to STANDARD — it changes 6 files (a quick order allows 5).");
  expect(sg.size()).toBe("standard");
  expect(ups).toEqual([{ from: "quick", to: "standard", rule: "files", value: 6, max: 5, at: 1000 }]);
  expect(call(sg, "Write", sixth)).toBeUndefined();
  expect(ups).toHaveLength(1);
});

test("a failed call adds nothing; a write outside the folder adds nothing", () => {
  const { sg } = guard("quick");
  for (let i = 0; i < 5; i++) expect(call(sg, "Write", write(`src/f${i}.ts`), true)).toBeUndefined();
  for (let i = 0; i < 5; i++) expect(call(sg, "Write", { file_path: `/tmp/out${i}.ts`, content: "x" })).toBeUndefined();
  for (let i = 0; i < 5; i++) expect(call(sg, "Write", write(`src/g${i}.ts`))).toBeUndefined();
  expect(sg.size()).toBe("quick");
});

test("standard → big at 21 files, and big then plans first", () => {
  const { sg, ups } = guard("standard");
  for (let i = 0; i < 20; i++) expect(call(sg, "Write", write(`src/f${i}.ts`))).toBeUndefined();
  expect(sg.steer("Write", write("src/f20.ts"))).toStartWith("STOP — Neo moved this order up from STANDARD to BIG — it changes 21 files (a standard order allows 20).");
  expect(sg.size()).toBe("big");
  expect(sg.planFirst()).toBe(true);
  expect(ups[0]).toMatchObject({ from: "standard", to: "big", rule: "files" });
});

// ── the rules and plan first (AC 7, 10, 11) ─────────────────────────────────────────────────────────

test("a touch of auth → big: denied, then plan first until the plan is approved", () => {
  const { sg, ups, approve } = guard("quick");
  const edit = { file_path: abs("services/identity-service/auth/token.go"), old_string: "a", new_string: "b" };
  expect(sg.steer("Edit", edit)).toStartWith("STOP — Neo moved this order up from QUICK to BIG — it touches auth: services/identity-service/auth/token.go.");
  expect(sg.size()).toBe("big");
  expect(ups).toHaveLength(1);
  expect(sg.planFirst()).toBe(true);
  const allowed: Array<[string, unknown]> = [
    ["Read", { file_path: abs("a.ts") }],
    ["Grep", { pattern: "x" }],
    ["TodoWrite", { todos: [] }],
    ["mcp__neo__ask_operator", { question: "q" }],
    ["mcp__codebase-memory__search_code", { q: "x" }],
    ["Agent", { subagent_type: "planner", prompt: "write the plan" }],
    ["Task", { subagent_type: "general-purpose", prompt: "look" }],
    ["Write", write("docs/superpowers/plans/x.md", "# plan\n")],
    ["Edit", { file_path: abs("docs/superpowers/plans/x.md"), old_string: "a", new_string: "b" }],
  ];
  for (const [tool, input] of allowed) expect(sg.steer(tool, input)).toBeUndefined();
  const stop = sg.steer("Edit", { file_path: abs("src/a.ts"), old_string: "a", new_string: "b" });
  expect(stop).toStartWith("STOP — this order is BIG now (it touches auth: services/identity-service/auth/token.go).");
  expect(sg.steer("Bash", { command: "ls" })).toBe(stop);
  expect(sg.steer("Bash", { command: "cat > docs/plan.md <<EOF\nx\nEOF" })).toBe(stop);
  expect(sg.steer("WebFetch", { url: "https://x" })).toBe(stop);
  approve();
  expect(sg.steer("Edit", edit)).toBeUndefined();
  expect(sg.steer("Bash", { command: "ls" })).toBeUndefined();
  expect(sg.planFirst()).toBe(false);
  expect(ups).toHaveLength(1);
});

test("a deploy command moves a standard order to big", () => {
  const { sg, ups } = guard("standard");
  expect(sg.steer("Bash", { command: "kubectl apply -f k8s" })).toContain("it runs deploy tooling: `kubectl apply -f k8s`");
  expect(ups[0]).toMatchObject({ from: "standard", to: "big", rule: "deploy", command: "kubectl apply -f k8s" });
});

test("quick: the planner is denied; a new plan, spec or ADR file is denied; an existing plan file may be edited", () => {
  const files = fakeFiles({ "docs/superpowers/plans/old.md": "# old\n" });
  const { sg, ups } = guard("quick", { files });
  expect(sg.steer("Agent", { subagent_type: "planner", prompt: "p" })).toBe(plannerDenyText("quick"));
  expect(sg.steer("Write", write("docs/superpowers/plans/new.md"))).toBe(JUST_FIX_TEXT);
  expect(sg.steer("Write", write("docs/adr/0099-x.md"))).toBe(JUST_FIX_TEXT);
  expect(sg.steer("Bash", { command: "cat > docs/adr/0099-x.md <<EOF\n# x\nEOF" })).toBe(JUST_FIX_TEXT);
  expect(sg.steer("Edit", { file_path: abs("docs/superpowers/plans/old.md"), old_string: "old", new_string: "new" })).toBeUndefined();
  expect(sg.size()).toBe("quick");
  expect(ups).toHaveLength(0);
  expect(guard("standard").sg.steer("Agent", { subagent_type: "planner", prompt: "p" })).toBe(plannerDenyText("standard"));
});

// ── the commit measure (AC 9) ────────────────────────────────────────────────────────────────────────

test("at a commit point the guard measures with git: past the limits it moves up and denies the commit", () => {
  const { sg, ups, git } = guard("quick");
  git.diff = numstat(3);
  expect(sg.steer("Bash", { command: "git commit -qm fix" })).toBeUndefined();
  // `sed -i` on 6 files: the estimate saw no lines, the commit measure sees the files.
  git.diff = numstat(6);
  expect(sg.steer("Bash", { command: `git -C ${FOLDER} commit -qm fix` })).toStartWith("Not run: Neo moved this order up from QUICK to STANDARD — it changes 6 files");
  expect(sg.size()).toBe("standard");
  expect(ups).toHaveLength(1);
  // A rule hit found only by the measure (a migration made by a script) moves it to big.
  git.diff = numstat(2) + "4\t0\tmigrations/310_x.sql\0";
  expect(sg.steer("Bash", { command: "git merge feature" })).toStartWith("STOP — Neo moved this order up from QUICK to BIG — it touches migration: migrations/310_x.sql.");
});

test("a failed measure denies the commit with the measure-failed text and does not move the size", () => {
  const { sg, ups, git } = guard("quick");
  git.fail = true;
  expect(sg.steer("Bash", { command: "git cherry-pick abc" })).toBe(measureFailedText("git could not be read", "quick"));
  expect(sg.size()).toBe("quick");
  expect(ups).toHaveLength(0);
  // Not a commit point: no measure, no deny.
  expect(sg.steer("Bash", { command: "git status" })).toBeUndefined();
});

test("a folder outside git (no baseline) has no commit points: the estimates only", () => {
  const { sg, git } = guard("quick", { baseline: undefined, startSha: undefined });
  expect(sg.steer("Bash", { command: "git commit -m x" })).toBeUndefined();
  expect(git.calls).toBe(0);
});

// ── side lanes, raise, end ───────────────────────────────────────────────────────────────────────────

test("a side guard moved to big denies every later non-read call with sideStopSteer", () => {
  const { sg, ups } = guard("standard", { side: "code" });
  const stop = sg.steer("Write", write("src/payment/PaymentForm.tsx"));
  expect(stop).toStartWith("STOP — Neo moved this side-lane order up from STANDARD to BIG — it touches money");
  expect(ups).toHaveLength(1);
  expect(sg.planFirst()).toBe(false);
  expect(sg.steer("Edit", { file_path: abs("src/a.ts"), old_string: "a", new_string: "b" })).toBe(stop);
  expect(sg.steer("Write", write("docs/superpowers/plans/x.md"))).toBe(stop);
  expect(sg.steer("Bash", { command: "ls" })).toBe(stop);
  expect(sg.steer("Read", { file_path: abs("a.ts") })).toBeUndefined();
  expect(sg.steer("Grep", { pattern: "x" })).toBeUndefined();
});

test("raise moves the order without a deny; never down", () => {
  const { sg, ups } = guard("standard");
  sg.raise("quick", { rule: "plan" });
  expect(sg.size()).toBe("standard");
  sg.raise("big", { rule: "plan", path: "migration" });
  expect(sg.size()).toBe("big");
  expect(ups).toEqual([{ from: "standard", to: "big", rule: "plan", path: "migration", at: 1000 }]);
  expect(sg.planFirst()).toBe(false);
  expect(sg.steer("Edit", { file_path: abs("src/a.ts"), old_string: "a", new_string: "b" })).toBeUndefined();
  sg.raise("big", { rule: "plan" });
  expect(ups).toHaveLength(1);
});

test("a move twice keeps the size the order started at", () => {
  const { sg, ups } = guard("quick");
  for (let i = 0; i < 5; i++) call(sg, "Write", write(`src/f${i}.ts`));
  sg.steer("Write", write("src/f5.ts"));
  sg.steer("Write", write("src/auth/login.ts"));
  expect(ups.map((u) => [u.from, u.to, u.rule])).toEqual([["quick", "standard", "files"], ["quick", "big", "auth"]]);
});

test("end: plan first with no plan awaiting → requeue; with one → no requeue", () => {
  const a = guard("quick");
  a.sg.steer("Write", write("src/auth/login.ts"));
  expect(a.sg.end({ planAwaiting: false })).toMatchObject({ size: "big", requeue: true });
  const b = guard("quick");
  b.sg.steer("Write", write("src/auth/login.ts"));
  expect(b.sg.end({ planAwaiting: true })).toMatchObject({ size: "big", requeue: false });
  // Plan first ended by the approval: the run built; nothing runs again.
  const c = guard("quick");
  c.sg.steer("Write", write("src/auth/login.ts"));
  c.approve();
  c.sg.steer("Read", { file_path: abs("a.ts") });
  expect(c.sg.end({ planAwaiting: false }).requeue).toBe(false);
  // Approved with no call after it: nothing runs again either.
  const d = guard("quick");
  d.sg.steer("Write", write("src/auth/login.ts"));
  d.approve();
  expect(d.sg.end({ planAwaiting: false }).requeue).toBe(false);
});

test("end: a quick run whose final measure passes its limits records a late move", () => {
  const { sg, ups, git } = guard("quick");
  git.diff = numstat(7);
  const end = sg.end({ planAwaiting: false });
  expect(end.size).toBe("standard");
  expect(end.requeue).toBe(false);
  expect(end.measured?.files.size).toBe(7);
  expect(end.late).toEqual({ from: "quick", to: "standard", rule: "files", value: 7, max: 5, late: true, at: 1000 });
  expect(ups).toEqual([end.late!]);
  // Within its limits: measured, no move.
  const ok = guard("quick");
  ok.git.diff = numstat(2);
  const okEnd = ok.sg.end({ planAwaiting: false });
  expect(okEnd).toMatchObject({ size: "quick", requeue: false });
  expect(okEnd.late).toBeUndefined();
  expect(okEnd.measured?.files.size).toBe(2);
  // The measure failed: no measure, no move.
  const failed = guard("quick");
  failed.git.fail = true;
  expect(failed.sg.end({ planAwaiting: false })).toEqual({ size: "quick", requeue: false });
});

// ── safety (AC 23) and big ───────────────────────────────────────────────────────────────────────────

test("a guard whose internals throw denies the call with the internal-error text and reports one fault", () => {
  const files: GuardFiles = {
    exists: () => {
      throw new Error("injected");
    },
    read: () => undefined,
  };
  const { sg } = guard("quick", { files });
  let out: string | undefined;
  expect(() => (out = sg.steer("Write", write("src/a.ts")))).not.toThrow();
  expect(out).toBe(GUARD_ERROR_TEXT);
  expect(reported.filter((r) => r.component === "sizeGuard")).toHaveLength(1);
  // A throwing planApproved in plan first is closed too.
  const boom = guard("quick", { planApproved: () => { throw new Error("injected"); } });
  boom.sg.steer("Write", write("src/auth/login.ts"));
  expect(boom.sg.steer("Edit", { file_path: abs("src/a.ts"), old_string: "a", new_string: "b" })).toBe(GUARD_ERROR_TEXT);
  // onToolUse / onToolResult / end never throw either.
  expect(() => sg.onToolUse("x", "Write", write("src/b.ts"))).not.toThrow();
  expect(() => sg.onToolResult("x", false)).not.toThrow();
  expect(() => sg.end({ planAwaiting: false })).not.toThrow();
});

test("the steer has no allow path: it returns a deny text or undefined for every call", () => {
  const { sg } = guard("quick");
  for (const [tool, input] of [["Bash", { command: "git push origin dev" }], ["Read", {}], ["Write", null], ["Edit", 3], ["Bash", {}]] as const) {
    const r = sg.steer(tool, input);
    expect(r === undefined || typeof r === "string").toBe(true);
  }
});

test("a big guard has no opinion on any call (planner and plan files included); its end still measures", () => {
  const { sg, ups, git } = guard("big");
  git.diff = numstat(40);
  for (const [tool, input] of [
    ["Agent", { subagent_type: "planner", prompt: "p" }],
    ["Write", write("docs/superpowers/plans/new.md")],
    ["Edit", { file_path: abs("services/identity-service/auth/token.go"), old_string: "a", new_string: "b" }],
    ["Bash", { command: "git commit -m x" }],
    ["Bash", { command: "kubectl apply -f k8s" }],
  ] as const) {
    expect(sg.steer(tool, input)).toBeUndefined();
  }
  const end = sg.end({ planAwaiting: false });
  expect(end).toMatchObject({ size: "big", requeue: false });
  expect(end.measured?.files.size).toBe(40);
  expect(ups).toHaveLength(0);
});

// ── Review fixes (ADR-0072 as built) ─────────────────────────────────────────────────────────────────

test("review: touchOf looks past `docker compose exec|run <svc>` and package runners; psql -c gives its SQL", () => {
  const o = { folder: FOLDER, files: fakeFiles() };
  const t = (cmd: string) => touchOf("Bash", { command: cmd }, o).commands;
  expect(t("docker compose exec -T api goose up")).toEqual(["docker compose exec -T", "goose up"]);
  expect(t("docker compose run --rm -e DB=x api npm run migrate")).toEqual(["docker compose run --rm", "npm run migrate"]);
  expect(t("docker-compose exec db migrate -path x up")).toEqual(["docker-compose exec db migrate", "migrate -path x up"]);
  expect(t("docker exec -it eticket-db psql -U app -c 'ALTER TABLE t ADD c int'")).toEqual([
    "docker exec -it eticket-db",
    "psql -U app -c",
    "psql -c ALTER TABLE t ADD c int",
  ]);
  expect(t("psql -h localhost -d app --command='DROP TABLE x'")).toContain("psql -c DROP TABLE x");
  expect(t("pnpm --filter api exec prisma migrate dev")).toEqual(["pnpm --filter api exec", "prisma migrate dev"]);
  expect(t("ls -la")).toEqual(["ls -la"]);
});

test("review: a schema change run inside a container moves a quick order to big", () => {
  for (const command of ["docker compose exec -T api goose up", "docker compose exec db psql -U app -c 'CREATE TABLE x (id int)'", "pnpm --filter api exec prisma migrate dev"]) {
    const { sg } = guard("quick");
    expect(sg.steer("Bash", { command }), command).toStartWith("STOP — Neo moved this order up from QUICK to BIG");
  }
});

test("review: plan first lets the plan-writing skill, tool search and a background check's output run", () => {
  const { sg } = guard("quick");
  sg.steer("Write", write("src/auth/login.ts"));
  expect(sg.planFirst()).toBe(true);
  for (const [tool, input] of [
    ["Skill", { skill: "superpowers:writing-plans" }],
    ["ToolSearch", { query: "select:Monitor" }],
    ["BashOutput", { bash_id: "b1" }],
    ["TaskOutput", { task_id: "b1" }],
  ] as const) {
    expect(sg.steer(tool, input), tool).toBeUndefined();
  }
  expect(sg.steer("Bash", { command: "ls" })).toStartWith("STOP — this order is BIG now");
});

test("review: end says when a run moved to big ends with its plan waiting for Approve & build", () => {
  const a = guard("quick");
  a.sg.steer("Write", write("src/auth/login.ts"));
  expect(a.sg.end({ planAwaiting: true })).toMatchObject({ size: "big", requeue: false, planWaits: true });
  const b = guard("quick");
  b.sg.steer("Write", write("src/auth/login.ts"));
  expect(b.sg.end({ planAwaiting: false }).planWaits).toBeUndefined();
  // A run that started big has no move: its waiting plan is today's flow.
  const c = guard("big");
  expect(c.sg.end({ planAwaiting: true }).planWaits).toBeUndefined();
});
