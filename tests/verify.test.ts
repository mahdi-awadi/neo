// The gate (W1.4): frozen checks run for one revision in a clean worktree; evidence is bound to it.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CHECKS_FILE, freezePolicy, resolveChecks } from "../src/engine/checks";
import { headOf } from "../src/engine/git-read";
import { DEFAULT_VERIFY_CFG, readVerifyCfg, runGate, type VerifyCfg } from "../src/engine/verify";

const sh = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

function repo(checks: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-gate-")) + "/proj";
  mkdirSync(join(dir, ".neo"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, CHECKS_FILE), JSON.stringify({ checks }));
  writeFileSync(join(dir, "ok.txt"), "ok\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}
const cfg = (root: string, over: Partial<VerifyCfg> = {}): VerifyCfg => ({ ...DEFAULT_VERIFY_CFG, worktreeRoot: root, ...over });
const root = () => mkdtempSync(join(tmpdir(), "neo-gate-root-"));

test("a passing policy passes in a clean worktree that is removed after, with evidence per check", async () => {
  const dir = repo([["sh", "-c", "test -f ok.txt && echo fine"], ["true"]]);
  const policy = freezePolicy(dir, resolveChecks(dir));
  const wtRoot = root();
  const g = await runGate({ folder: dir, policy, headSha: headOf(dir)!, cfg: cfg(wtRoot) });
  expect(g).toMatchObject({ ran: true, declared: 2, passed: 2, failed: [], stale: false, dirty: [], policyChanged: [] });
  expect(g.error).toBeUndefined();
  expect(g.evidence.map((e) => [e.cmd, e.exit])).toEqual([["sh -c test -f ok.txt && echo fine", 0], ["true", 0]]);
  expect(g.evidence[0]!.tail).toBe("fine");
  expect(readdirSync(wtRoot)).toEqual([]); // the worktree is gone
  expect(sh(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
});

test("the gate verifies the COMMIT: a file edited but uncommitted in the project is absent from the worktree, and the tree is reported dirty", async () => {
  const dir = repo([["sh", "-c", "test -f new.txt"]]);
  const policy = freezePolicy(dir, resolveChecks(dir));
  writeFileSync(join(dir, "new.txt"), "x"); // the worker forgot to commit
  const g = await runGate({ folder: dir, policy, headSha: headOf(dir)!, cfg: cfg(root()) });
  expect(g.failed).toHaveLength(1);
  expect(g.dirty).toEqual(["new.txt"]);
});

test("a failing check is evidence with its tail; a check that could not start is a failure too; the policy change is named", async () => {
  const dir = repo([["sh", "-c", "echo boom >&2; exit 2"], ["/nonexistent/neo-check"]]);
  const policy = freezePolicy(dir, resolveChecks(dir));
  writeFileSync(join(dir, CHECKS_FILE), JSON.stringify({ checks: [["true"]] })); // the worker weakens the policy mid-run
  const g = await runGate({ folder: dir, policy, headSha: headOf(dir)!, cfg: cfg(root()) });
  expect(g.ran).toBe(true);
  expect(g.declared).toBe(2); // the FROZEN policy ran, not the weakened one
  expect(g.failed.map((f) => f.exit)).toEqual([2, 127]);
  expect(g.failed[0]!.tail).toContain("boom");
  expect(g.failed[1]!.tail).toContain("could not start");
  expect(g.policyChanged).toEqual([CHECKS_FILE]);
  expect(g.dirty).toEqual([CHECKS_FILE]);
});

test("HEAD that is not the expected revision is stale, before and after the run", async () => {
  const dir = repo([["true"]]);
  const policy = freezePolicy(dir, resolveChecks(dir));
  const before = headOf(dir)!;
  writeFileSync(join(dir, "ok.txt"), "changed\n");
  sh(dir, "commit", "-qam", "more");
  const g = await runGate({ folder: dir, policy, headSha: before, cfg: cfg(root()) });
  expect(g).toMatchObject({ ran: false, stale: true });
  const moved = await runGate({ folder: dir, policy, headSha: headOf(dir)!, cfg: cfg(root()) }, {
    // the project commits while the gate runs: the evidence is for another revision
    run: async (cmd, opts) => {
      const { runCommand } = await import("../src/engine/run-command");
      const r = await runCommand(cmd, opts);
      if (cmd[0] === "true") { writeFileSync(join(dir, "ok.txt"), "again\n"); sh(dir, "commit", "-qam", "during"); }
      return r;
    },
  });
  expect(moved.stale).toBe(true);
});

test("no checks declared → nothing runs, no worktree; a non-repo is an error; the total time bound stops the rest", async () => {
  const dir = repo([]);
  const none = await runGate({ folder: dir, policy: freezePolicy(dir, resolveChecks(dir)), headSha: headOf(dir)!, cfg: cfg(root()) });
  expect(none).toMatchObject({ ran: false, declared: 0 });
  expect(none.error).toBeUndefined();
  const plain = mkdtempSync(join(tmpdir(), "neo-plain-"));
  const notRepo = await runGate({ folder: plain, policy: freezePolicy(plain, resolveChecks(plain)), headSha: "abc", cfg: cfg(root()) });
  expect(notRepo.error).toContain("not a git repository");
  const slow = repo([["sleep", "2"], ["true"]]);
  const g = await runGate({ folder: slow, policy: freezePolicy(slow, resolveChecks(slow)), headSha: headOf(slow)!, cfg: cfg(root(), { maxTotalMs: 300, checkTimeoutMs: 300 }) });
  expect(g.failed.map((f) => f.exit)).toEqual([124, 124]);
  expect(g.evidence[1]!.tail).toContain("total time");
});

test("the child env carries NEO_VERIFY and CI, and the scrub removes an engine key", async () => {
  const dir = repo([["sh", "-c", 'echo "$NEO_VERIFY $CI ${NEO_GATE_SECRET:-absent}"']]);
  process.env.NEO_GATE_SECRET = "leak";
  try {
    const scrub = { engineKeys: new Set(["NEO_GATE_SECRET"]), relayKeys: new Set<string>(), inherit: new Set<string>(), mode: "strip" as const };
    const g = await runGate({ folder: dir, policy: freezePolicy(dir, resolveChecks(dir)), headSha: headOf(dir)!, cfg: cfg(root()) }, { scrub });
    expect(g.evidence[0]!.tail).toBe("1 1 absent");
  } finally {
    delete process.env.NEO_GATE_SECRET;
  }
});

test("readVerifyCfg keeps defaults for bad values and accepts good ones", () => {
  expect(readVerifyCfg(undefined)).toEqual(DEFAULT_VERIFY_CFG);
  expect(readVerifyCfg({ enabled: "no", worktreeRoot: "relative", maxTotalMs: 0 })).toEqual(DEFAULT_VERIFY_CFG);
  expect(readVerifyCfg({ enabled: false, requireReport: true, worktreeRoot: "/x" })).toMatchObject({ enabled: false, requireReport: true, worktreeRoot: "/x" });
  expect(existsSync("/x")).toBe(false); // reading config creates nothing
});
