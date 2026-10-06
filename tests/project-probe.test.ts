// P6 Task 6.3 (spec §9, AC6.2, AC6.3): the deployed-version probe and the health probe — optional per
// project, run in the scan step, bounded by github.callTimeoutMs. Local Bun.serve on port 0 only.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createGitRead, type GitRead } from "../src/engine/git-read";
import { runScan, type ScanDeps } from "../src/engine/producers/scan";
import { readAttentionCfg } from "../src/engine/producers/engine";
import { DEFAULT_DEPLOYED_VERSION_PATH, probeDeploy, shaAt, type DeployMeta, type Fetcher } from "../src/engine/producers/probe";
import { projectView, renderProject, type ProbeMeta } from "../src/engine/project-view";
import type { ProjectCfg } from "../src/engine/producers/git";

const made: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterAll(() => {
  servers.forEach((s) => s.stop(true));
  made.forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const git = (dir: string, ...a: string[]) => spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...a], { encoding: "utf8" });
const NOW = 10_000_000;

/** A repo `gold` on `main` with three commits; returns the sha of each. */
function repo(): { work: string; dir: string; shas: string[] } {
  const work = mkdtempSync(join(tmpdir(), "neo-probe-"));
  made.push(work);
  const dir = join(work, "gold");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  const shas: string[] = [];
  for (const f of ["a", "b", "c"]) {
    writeFileSync(join(dir, f), f);
    git(dir, "add", f);
    git(dir, "commit", "-q", "-m", f);
    shas.push(git(dir, "rev-parse", "HEAD").stdout.trim());
  }
  return { work, dir, shas };
}

/** A local server answering each path from `routes` (status + body); port 0 = an ephemeral port. */
function serve(routes: Record<string, { status?: number; body: string }>): string {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const r = routes[new URL(req.url).pathname];
      return r ? new Response(r.body, { status: r.status ?? 200, headers: { "content-type": "application/json" } }) : new Response("no", { status: 404 });
    },
  });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

/** A URL nothing listens on: a server started, then stopped. */
function deadUrl(): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const url = `http://127.0.0.1:${s.port}/version`;
  s.stop(true);
  return url;
}

/** Real git; gh says "no GitHub remote". `calls` records every git argument list. */
function reader(calls: string[][] = []): GitRead {
  const real = createGitRead({ timeoutMs: 10_000 });
  return {
    git: (f, a) => (calls.push(a), real.git(f, a)),
    gh: async () => ({ ok: false, out: "", err: "none of the git remotes configured for this repository point to a known GitHub host" }),
  };
}

function scanDeps(work: string, dir: string, projects: Record<string, ProjectCfg>, over: Partial<ScanDeps> = {}): ScanDeps {
  const ledger = openLedger(":memory:");
  ledger.recordOrder({ id: crypto.randomUUID(), source: "neo", folder: dir, task: "t", chatId: 1, createdAt: 1 });
  return { ledger, registry: createRegistry(), read: reader(), workRoot: work, neoFolder: join(work, "neo"), attention: readAttentionCfg(undefined), projects, now: () => NOW, probeTimeoutMs: 5_000, ...over };
}

const viewOf = (d: ScanDeps) => projectView({ ledger: d.ledger, registry: d.registry, read: reader(), projects: d.projects, neoFolder: d.neoFolder }, "gold", NOW);
const deployMeta = (d: ScanDeps) => d.ledger.getMeta("deploy:gold")?.value as DeployMeta | undefined;
const probeMeta = (d: ScanDeps) => d.ledger.getMeta("probe:gold")?.value as ProbeMeta | undefined;

test("deployed version { version: <sha> } → undeployed = the commits after it on the deploy branch; the view and Telegram show it", async () => {
  const { work, dir, shas } = repo();
  const url = serve({ "/version": { body: JSON.stringify({ version: shas[0] }) } });
  const d = scanDeps(work, dir, { gold: { deployedVersionUrl: `${url}/version`, deployedVersionPath: "version", deployBranch: "main" } });
  await runScan(d);
  expect(deployMeta(d)).toMatchObject({ at: NOW, branch: "main", sha: shas[0], undeployed: 2 });
  expect(deployMeta(d)?.error).toBeUndefined();
  const v = (await viewOf(d))!;
  expect(v.git.undeployed).toBe(2);
  expect(v.git.deployBranch).toBe("main");
  expect(v.git.deployedSha).toBe(shas[0]!.slice(0, 7));
  expect(renderProject(v, NOW, { maxLines: 40 })).toContain(`deploy: 2 commits not deployed (main @ ${shas[0]!.slice(0, 7)} live)`);
});

test("a nested path (build.sha); deployBranch unset → the git producer's branch (here the checked-out main)", async () => {
  const { work, dir, shas } = repo();
  const url = serve({ "/v": { body: JSON.stringify({ build: { sha: shas[1]!.slice(0, 10).toUpperCase() } }) } });
  const d = scanDeps(work, dir, { gold: { deployedVersionUrl: `${url}/v`, deployedVersionPath: "build.sha" } });
  await runScan(d);
  expect(deployMeta(d)).toMatchObject({ branch: "main", sha: shas[1], undeployed: 1 });
});

test("deployedVersionPath unset → the default path", async () => {
  expect(DEFAULT_DEPLOYED_VERSION_PATH).toBe("version");
  const { work, dir, shas } = repo();
  const url = serve({ "/v": { body: JSON.stringify({ version: shas[2] }) } });
  const d = scanDeps(work, dir, { gold: { deployedVersionUrl: `${url}/v` } });
  await runScan(d);
  expect(deployMeta(d)).toMatchObject({ undeployed: 0 });
  expect((await viewOf(d))!.git.undeployed).toBe(0);
});

test("URL down → undeployed absent + the error in meta; the view names it, never guesses", async () => {
  const { work, dir } = repo();
  const d = scanDeps(work, dir, { gold: { deployedVersionUrl: deadUrl() } });
  await runScan(d);
  const m = deployMeta(d)!;
  expect(m.undeployed).toBeUndefined();
  expect(m.error).toBeTruthy();
  const v = (await viewOf(d))!;
  expect("undeployed" in v.git).toBe(false);
  expect(v.git.deployError).toBe(m.error);
  expect(renderProject(v, NOW, { maxLines: 40 })).toContain("deploy: could not read the deployed version");
});

test("a non-2xx answer, bad JSON and a missing path → absent + error", async () => {
  const { work, dir } = repo();
  const url = serve({ "/500": { status: 500, body: "{}" }, "/bad": { body: "not json{" }, "/miss": { body: JSON.stringify({ other: "abc1234" }) } });
  for (const [p, want] of [["/500", /HTTP 500/], ["/bad", /JSON/i], ["/miss", /no value at "version"/]] as const) {
    const d = scanDeps(work, dir, { gold: { deployedVersionUrl: `${url}${p}` } });
    await runScan(d);
    expect(deployMeta(d)?.undeployed).toBeUndefined();
    expect(deployMeta(d)?.error).toMatch(want);
  }
});

test("a non-hex value is refused before it reaches git (no option injection)", async () => {
  const { work, dir } = repo();
  const evil = "--output=/tmp/pwned";
  const url = serve({ "/v": { body: JSON.stringify({ version: evil }) }, "/short": { body: JSON.stringify({ version: "abc12" }) } });
  for (const p of ["/v", "/short"]) {
    const calls: string[][] = [];
    const d = scanDeps(work, dir, { gold: { deployedVersionUrl: `${url}${p}` } }, { read: reader(calls) });
    await runScan(d);
    expect(deployMeta(d)?.undeployed).toBeUndefined();
    expect(deployMeta(d)?.error).toMatch(/not a commit sha/);
    expect(calls.some((a) => a.some((x) => x.includes(evil) || x.includes("abc12")))).toBe(false);
  }
});

test("a sha unknown to the repo → absent + error", async () => {
  const { work, dir } = repo();
  const url = serve({ "/v": { body: JSON.stringify({ version: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }) } });
  const d = scanDeps(work, dir, { gold: { deployedVersionUrl: `${url}/v` } });
  await runScan(d);
  expect(deployMeta(d)?.undeployed).toBeUndefined();
  expect(deployMeta(d)?.error).toMatch(/not in this repo/);
});

test("a deploy branch that does not exist → absent + error", async () => {
  const { work, dir, shas } = repo();
  const url = serve({ "/v": { body: JSON.stringify({ version: shas[0] }) } });
  const d = scanDeps(work, dir, { gold: { deployedVersionUrl: `${url}/v`, deployBranch: "prod" } });
  await runScan(d);
  expect(deployMeta(d)?.undeployed).toBeUndefined();
  expect(deployMeta(d)?.error).toMatch(/prod/);
});

test("healthUrl 500 → probe ok:false → health down; 200 → ok", async () => {
  const { work, dir } = repo();
  const url = serve({ "/down": { status: 500, body: "x" }, "/up": { body: "ok" } });
  const down = scanDeps(work, dir, { gold: { healthUrl: `${url}/down` } });
  await runScan(down);
  expect(probeMeta(down)).toMatchObject({ at: NOW, ok: false });
  expect(probeMeta(down)?.error).toMatch(/HTTP 500/);
  expect((await viewOf(down))!.health).toBe("down");

  const up = scanDeps(work, dir, { gold: { healthUrl: `${url}/up` } });
  await runScan(up);
  expect(probeMeta(up)).toEqual({ at: NOW, ok: true });
  expect((await viewOf(up))!.health).not.toBe("down");
});

test("no config → no fetch at all and no meta row (and a row left from an old config is removed)", async () => {
  const { work, dir } = repo();
  let fetched = 0;
  const fetch: Fetcher = async () => (fetched++, new Response("{}"));
  const d = scanDeps(work, dir, { gold: {} }, { fetch });
  d.ledger.setMeta("probe:gold", { at: 1, ok: false }, 1);
  d.ledger.setMeta("deploy:gold", { at: 1, undeployed: 3 }, 1);
  await runScan(d);
  expect(fetched).toBe(0);
  expect(d.ledger.getMeta("probe:gold")).toBeUndefined();
  expect(d.ledger.getMeta("deploy:gold")).toBeUndefined();
  const v = (await viewOf(d))!;
  expect("undeployed" in v.git).toBe(false);
  expect(renderProject(v, NOW, { maxLines: 40 })).not.toContain("deploy:");
});

test("never throws: a fetch that throws → both probes record the error, the scan still finishes", async () => {
  const { work, dir } = repo();
  const fetch: Fetcher = async () => {
    throw new Error("boom");
  };
  const d = scanDeps(work, dir, { gold: { healthUrl: "http://127.0.0.1:1/h", deployedVersionUrl: "http://127.0.0.1:1/v" } }, { fetch });
  await runScan(d);
  expect(probeMeta(d)).toMatchObject({ ok: false, error: "boom" });
  expect(deployMeta(d)).toMatchObject({ error: "boom" });
  expect(d.ledger.getMeta("gh:gold")).toBeDefined();
});

test("the call is bounded: a server slower than the timeout → error, no wait past it", async () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => (await Bun.sleep(2_000), new Response("{}")) });
  servers.push(s);
  const { dir } = repo();
  const t0 = Date.now();
  const m = await probeDeploy({ read: reader(), folder: dir, cfg: { deployedVersionUrl: `http://127.0.0.1:${s.port}/v` }, branch: "main", timeoutMs: 100, now: NOW });
  expect(Date.now() - t0).toBeLessThan(1_500);
  expect(m.error).toMatch(/timeout/);
  expect(m.undeployed).toBeUndefined();
});

test("shaAt walks a dot path; anything else is undefined", () => {
  expect(shaAt({ a: { b: "x" } }, "a.b")).toBe("x");
  expect(shaAt({ a: [{ b: "y" }] }, "a.0.b")).toBe("y");
  expect(shaAt({ a: 1 }, "a.b")).toBeUndefined();
  expect(shaAt(null, "a")).toBeUndefined();
  expect(shaAt({ a: "x" }, "")).toBeUndefined();
});
