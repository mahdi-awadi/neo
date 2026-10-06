// P5 Task 5.2 (spec §7): the scan — which repos, both producers per project, the meta row, errors.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createGitRead, type GitRead } from "../src/engine/git-read";
import { listOpen, raise } from "../src/engine/attention";
import { runScan, trackedRepos, type ScanDeps } from "../src/engine/producers/scan";
import { readAttentionCfg } from "../src/engine/producers/engine";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (dir: string, ...a: string[]) => spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...a], { encoding: "utf8" });

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "neo-scan-"));
  made.push(r);
  return r;
}
function repo(at: string, name: string): string {
  const dir = join(at, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}
const order = (folder: string) => ({ id: crypto.randomUUID(), source: "neo" as const, folder, task: "t", chatId: 1, createdAt: 1 });

/** Real git; gh answers "no GitHub remote" unless overridden. */
function reader(gh?: GitRead["gh"]): GitRead {
  const real = createGitRead({ timeoutMs: 10_000 });
  return { git: real.git, gh: gh ?? (async () => ({ ok: false, out: "", err: "none of the git remotes configured for this repository point to a known GitHub host" })) };
}

function deps(work: string, over: Partial<ScanDeps> = {}): ScanDeps {
  const ledger = openLedger(":memory:");
  return { ledger, registry: createRegistry(), read: reader(), workRoot: work, neoFolder: join(work, "neo"), attention: readAttentionCfg(undefined), projects: {}, now: () => 10_000_000, ...over };
}

test("trackedRepos: repo roots the ledger has seen under workRoot, plus Neo; not sub-folders, linked worktrees or missing folders", async () => {
  const w = root();
  const gold = repo(w, "gold");
  const neo = repo(w, "neo");
  mkdirSync(join(gold, "sub"));
  git(gold, "worktree", "add", "-q", "-b", "feat/x", join(w, "gold-x"));
  const d = deps(w);
  for (const f of [gold, join(gold, "sub"), join(w, "gold-x"), join(w, "gone"), "/elsewhere/repo"]) d.ledger.recordOrder(order(f));
  expect((await trackedRepos(d)).sort()).toEqual([gold, neo].sort());
});

test("runScan: git items per project, the todo's high dirty item resolves once the folder is clean, a meta row per project", async () => {
  const w = root();
  const gold = repo(w, "gold");
  const d = deps(w);
  d.ledger.recordOrder(order(gold));
  raise(d.ledger, { project: "gold", folder: gold, source: "git", kind: "dirty", key: gold, severity: "high", title: "3 uncommitted files after todo #1" }, 1);
  writeFileSync(join(gold, "wip.txt"), "wip");
  await runScan(d);
  expect(listOpen(d.ledger, { now: 10_000_000 }).map((r) => [r.kind, r.severity])).toEqual([["dirty", "high"]]); // stays high
  git(gold, "add", "wip.txt");
  git(gold, "commit", "-q", "-m", "wip");
  await runScan(d);
  expect(listOpen(d.ledger, { now: 10_000_000 })).toEqual([]);
  expect(d.ledger.getMeta("gh:gold")?.value).toMatchObject({ lastScanAt: 10_000_000, github: false });
});

test("a gh failure changes no GitHub items, keeps the last good time, and records one github_scan_error per project per hour", async () => {
  const w = root();
  const gold = repo(w, "gold");
  let clock = 10_000_000;
  let down = false;
  const gh: GitRead["gh"] = async (_f, args) => {
    if (down) return { ok: false, out: "", err: "error connecting to api.github.com" };
    if (args[0] === "repo") return { ok: true, out: JSON.stringify({ nameWithOwner: "acme/gold", url: "u" }) };
    if (args[0] === "pr" && !args.includes("--search")) return { ok: true, out: JSON.stringify([{ number: 12, title: "Fees", url: "p12" }]) };
    return { ok: true, out: "[]" };
  };
  const d = deps(w, { read: reader(gh), now: () => clock });
  d.ledger.recordOrder(order(gold));
  await runScan(d);
  expect(listOpen(d.ledger, { now: clock }).map((r) => r.kind)).toEqual(["pr_open"]);
  down = true;
  clock += 60_000;
  await runScan(d);
  clock += 60_000;
  await runScan(d);
  expect(listOpen(d.ledger, { now: clock }).map((r) => r.kind)).toEqual(["pr_open"]); // nothing resolved
  expect(d.ledger.getMeta("gh:gold")?.value).toMatchObject({ lastGoodAt: 10_000_000, error: "error connecting to api.github.com" });
  expect(d.ledger.listEvents({ kind: "github_scan_error" })).toHaveLength(1);
});

test("a tracked repo that was deleted has its git and GitHub items resolved", async () => {
  const w = root();
  const gold = repo(w, "gold");
  const d = deps(w);
  d.ledger.recordOrder(order(gold));
  writeFileSync(join(gold, "wip.txt"), "wip");
  await runScan(d);
  expect(listOpen(d.ledger, { now: 10_000_000 }).map((r) => r.kind)).toEqual(["dirty"]);
  rmSync(gold, { recursive: true, force: true });
  await runScan(d);
  expect(listOpen(d.ledger, { now: 10_000_000 })).toEqual([]);
});
