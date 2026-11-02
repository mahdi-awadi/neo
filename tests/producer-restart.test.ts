// P4 Task 4.5 (spec §8.4): restart-gated work computed from git + the boot record, and /gated.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger, type BootRow } from "../src/engine/ledger";
import { restartDrafts, gatedText, bootFacts, type RestartDeps } from "../src/engine/producers/restart";
import { restartNeededSince } from "../src/engine/updater";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sh(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-restart-"));
  made.push(dir);
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  commit(dir, "a.txt", "feat: first");
  return dir;
}

function commit(dir: string, file: string, subject: string): void {
  writeFileSync(join(dir, file), subject);
  sh(dir, "add", file);
  sh(dir, "commit", "-q", "-m", subject);
}

function deps(dir: string, boot: BootRow | undefined, over: Partial<RestartDeps> = {}): RestartDeps {
  return { folder: dir, boot, branchPrefixes: ["fix/", "feat/", "chore/"], updates: [], ...over };
}

const bootOf = (dir: string, over: Partial<BootRow> = {}): BootRow => ({ at: 1000, ...bootFacts(dir)!, ...over });

test("nothing differs: no items, and /gated says the running build is HEAD", () => {
  const dir = repo();
  const boot = bootOf(dir);
  expect(restartDrafts(deps(dir, boot))).toEqual([]);
  expect(gatedText(deps(dir, boot))).toContain("running build = HEAD");
});

test("a commit after the boot sha → live code differs, with the commit list", () => {
  const dir = repo();
  const boot = bootOf(dir);
  commit(dir, "b.txt", "fix: the second");
  const [d] = restartDrafts(deps(dir, boot)) as Exclude<ReturnType<typeof restartDrafts>, "error">;
  expect(d).toMatchObject({ source: "restart", kind: "restart_gated", key: "live-code", project: dir.split("/").pop() });
  expect(d!.title).toContain("live code differs");
  expect(d!.detail).toContain("fix: the second");
  expect(gatedText(deps(dir, boot))).toContain("fix: the second");
});

test("an unmerged fix/ branch waits to merge; a merged one and an unrelated prefix do not", () => {
  const dir = repo();
  const boot = bootOf(dir);
  sh(dir, "checkout", "-q", "-b", "fix/x");
  commit(dir, "x.txt", "fix: x");
  sh(dir, "checkout", "-q", "-b", "backup/old");
  sh(dir, "checkout", "-q", "master");
  sh(dir, "checkout", "-q", "-b", "feat/merged");
  commit(dir, "m.txt", "feat: merged");
  sh(dir, "checkout", "-q", "master");
  sh(dir, "merge", "-q", "--ff-only", "feat/merged");
  const drafts = restartDrafts(deps(dir, boot)) as Exclude<ReturnType<typeof restartDrafts>, "error">;
  expect(drafts.map((d) => d.key).sort()).toEqual(["live-code", "merge:fix/x"]);
  expect(drafts.find((d) => d.key === "merge:fix/x")!.title).toBe("waiting to merge: fix/x — fix: x");
});

test("updater results that need a restart and a changed config.json are items too", () => {
  const dir = repo();
  const boot = bootOf(dir, { configHash: "aaa" });
  const drafts = restartDrafts(deps(dir, boot, { updates: [{ id: "@anthropic-ai/claude-agent-sdk", from: "0.3.289", to: "0.3.291" }], configHash: "bbb" }));
  expect((drafts as Array<{ key: string }>).map((d) => d.key)).toEqual(["update:@anthropic-ai/claude-agent-sdk", "config"]);
});

test("git that cannot be read, or no boot record, is an error (nothing resolves)", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "neo-norepo-"));
  made.push(notRepo);
  expect(restartDrafts(deps(notRepo, { at: 1, headSha: "abc", branch: "master" }))).toBe("error");
  expect(restartDrafts(deps(repo(), undefined))).toBe("error");
  expect(gatedText(deps(notRepo, undefined))).toContain("no boot record");
});

test("a reset below the running build is never \"running build = HEAD\"", () => {
  const dir = repo();
  commit(dir, "b.txt", "feat: second");
  const boot = bootOf(dir);
  sh(dir, "reset", "-q", "--hard", "HEAD~1");
  const [d] = restartDrafts(deps(dir, boot)) as Exclude<ReturnType<typeof restartDrafts>, "error">;
  expect(d).toMatchObject({ key: "live-code" });
  expect(d!.title).toContain("does not contain the running build");
  expect(gatedText(deps(dir, boot))).not.toContain("running build = HEAD");
});

test("a running build that is gone from history (rewritten) is an item, not an error", () => {
  const dir = repo();
  const [d] = restartDrafts(deps(dir, { at: 1, headSha: "0123456789abcdef0123456789abcdef01234567", branch: "master" })) as Exclude<ReturnType<typeof restartDrafts>, "error">;
  expect(d).toMatchObject({ key: "live-code" });
  expect(d!.title).toContain("no longer in the repo");
});

test("a detached checkout says so; waiting-to-merge is judged against the running branch", () => {
  const dir = repo();
  const boot = bootOf(dir);
  sh(dir, "checkout", "-q", "-b", "fix/y");
  commit(dir, "y.txt", "fix: y");
  sh(dir, "checkout", "-q", "--detach", "master");
  const drafts = restartDrafts(deps(dir, boot)) as Exclude<ReturnType<typeof restartDrafts>, "error">;
  expect(drafts.find((d) => d.key === "branch")!.title).toContain("detached at");
  expect(drafts.map((d) => d.key)).toContain("merge:fix/y");
});

test("ledger boots: the newest is the running build; only 100 are kept", () => {
  const l = openLedger(":memory:");
  for (let i = 1; i <= 105; i++) l.recordBoot({ at: i, headSha: `sha${i}`, branch: "master", configHash: "h" });
  expect(l.lastBoot()).toEqual({ at: 105, headSha: "sha105", branch: "master", configHash: "h" });
});

test("restartNeededSince: the latest result per item since the boot, only those that need a restart", () => {
  const l = openLedger(":memory:");
  l.recordEvent("update_result", { at: 50, data: { category: "sdk", id: "old", outcome: "applied", restartNeeded: true } });
  l.recordEvent("update_result", { at: 150, data: { category: "sdk", id: "sdk", outcome: "applied", from: "1", to: "2", restartNeeded: true } });
  l.recordEvent("update_result", { at: 160, data: { category: "plugins", id: "p", outcome: "applied" } });
  expect(restartNeededSince(l, 100)).toEqual([{ id: "sdk", from: "1", to: "2" }]);
  l.recordEvent("update_result", { at: 165, data: { category: "sdk", id: "sdk", outcome: "up_to_date", from: "2" } }); // the next run: pin == latest
  expect(restartNeededSince(l, 100)).toEqual([{ id: "sdk", from: "1", to: "2" }]); // still owed
  l.recordEvent("update_result", { at: 170, data: { category: "sdk", id: "sdk", outcome: "rolled_back" } }); // back to the running version
  expect(restartNeededSince(l, 100)).toEqual([]);
});

test("a daemon booted on a detached HEAD: merges are judged against the running commit", () => {
  const dir = repo();
  sh(dir, "checkout", "-q", "--detach");
  const boot = bootOf(dir); // branch "HEAD"
  sh(dir, "checkout", "-q", "-b", "fix/z", "master");
  commit(dir, "z.txt", "fix: z");
  sh(dir, "checkout", "-q", "--detach", boot.headSha);
  const drafts = restartDrafts(deps(dir, boot)) as Exclude<ReturnType<typeof restartDrafts>, "error">;
  expect(drafts.map((d) => d.key)).toEqual(["merge:fix/z"]);
});

// --- ADR-0054 D1: a fix is done only when it runs ------------------------------------------------
const DAY = 86_400_000;
const lastCommitAt = (dir: string, ref: string) => Number(sh(dir, "log", "-1", "--format=%ct", ref)) * 1000;

test("ADR-0054 D1: dev ahead of the running build gives ONE integration item naming its ADRs", () => {
  const dir = repo();
  const boot = bootOf(dir);
  sh(dir, "checkout", "-q", "-b", "dev");
  commit(dir, "b.txt", "fix(threads): every decision close re-derives its thread (ADR-0053)");
  commit(dir, "c.txt", "docs: notes");
  sh(dir, "checkout", "-q", "master");
  const now = lastCommitAt(dir, "dev");
  const items = restartDrafts(deps(dir, boot, { integrationBranch: "dev", maxUndeployedDays: 2, now })) as Array<{ key: string; title: string; detail?: string; severity: string }>;
  const dev = items.filter((x) => x.key === "integration");
  expect(dev).toHaveLength(1);
  expect(dev[0]).toMatchObject({ title: "2 commits on dev are not running (oldest 0 days)", severity: "normal" });
  expect(dev[0]!.detail).toContain("ADR-0053");
  expect(items.some((x) => x.key === "merge:dev")).toBe(false);
});

test("ADR-0054 D1: severity is high once the oldest unrun commit is older than maxUndeployedDays", () => {
  const dir = repo();
  const boot = bootOf(dir);
  sh(dir, "checkout", "-q", "-b", "dev");
  commit(dir, "b.txt", "fix: x");
  sh(dir, "checkout", "-q", "master");
  const now = lastCommitAt(dir, "dev") + 3 * DAY;
  const dev = (restartDrafts(deps(dir, boot, { integrationBranch: "dev", maxUndeployedDays: 2, now })) as Array<{ key: string; title: string; severity: string }>).find((x) => x.key === "integration");
  expect(dev).toMatchObject({ title: "1 commit on dev is not running (oldest 3 days)", severity: "high" });
});

test("ADR-0054 D1: a feature branch already merged into dev gives no merge item; an unmerged one still does", () => {
  const dir = repo();
  const boot = bootOf(dir);
  sh(dir, "checkout", "-q", "-b", "fix/merged");
  commit(dir, "m.txt", "fix: merged one");
  sh(dir, "checkout", "-q", "-b", "dev", "master");
  sh(dir, "merge", "-q", "--no-ff", "-m", "merge fix/merged", "fix/merged");
  sh(dir, "checkout", "-q", "-b", "fix/open", "master");
  commit(dir, "o.txt", "fix: still open");
  sh(dir, "checkout", "-q", "master");
  const keys = (restartDrafts(deps(dir, boot, { integrationBranch: "dev", now: Date.now() })) as Array<{ key: string }>).map((x) => x.key);
  expect(keys).not.toContain("merge:fix/merged");
  expect(keys).toContain("merge:fix/open");
  expect(keys).toContain("integration");
});

test("ADR-0054 D1: running ON the integration branch gives no integration item", () => {
  const dir = repo();
  sh(dir, "checkout", "-q", "-b", "dev");
  const boot = bootOf(dir);
  expect((restartDrafts(deps(dir, boot, { integrationBranch: "dev", now: Date.now() })) as Array<{ key: string }>).map((x) => x.key)).not.toContain("integration");
});

test("ADR-0054 D2: integrationGap is the one computation — the item, /list and the console read it", async () => {
  const { integrationGap } = await import("../src/engine/producers/restart");
  const dir = repo();
  const boot = bootOf(dir);
  expect(integrationGap(deps(dir, boot, { integrationBranch: "dev", now: Date.now() }))).toBeUndefined(); // no dev branch
  sh(dir, "checkout", "-q", "-b", "dev");
  commit(dir, "b.txt", "fix: a (ADR-0054)");
  sh(dir, "checkout", "-q", "master");
  const now = lastCommitAt(dir, "dev") + 3 * DAY;
  expect(integrationGap(deps(dir, boot, { integrationBranch: "dev", maxUndeployedDays: 2, now }))).toMatchObject({
    running: boot.headSha.slice(0, 7),
    branch: "master",
    integration: "dev",
    commits: 1,
    days: 3,
    high: true,
    adrs: ["ADR-0054"],
  });
});
