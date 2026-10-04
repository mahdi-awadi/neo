import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import {
  createUpdater,
  breakingLines,
  compareVersions,
  notesBetween,
  type ExecResult,
  type ItemResult,
  type RunContext,
  type UpdateSource,
  type UpdateSys,
  type UpdatesCfg,
  type McpLaunch,
} from "../src/engine/updater";
import { sdkSource } from "../src/engine/update-sdk";
import { DEFAULT_UPDATES } from "../src/config";

const CFG: UpdatesCfg = {
  ...DEFAULT_UPDATES,
  enabled: true,
  everyMs: 24 * 3_600_000,
  autoApply: { sdk: true, plugins: true, mcp: true },
  holdBreaking: true,
  retryDeferredMs: 15 * 60_000,
};

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  autoApply: true,
  holdBreaking: true,
  busy: false,
  force: false,
  lastResult: () => undefined,
  ...over,
});

/** A scripted UpdateSys: `exec` answers from handlers matched on the joined command line. */
export function fakeSys(opts: {
  exec?: Array<[RegExp, (cmd: string[], cwd?: string) => Partial<ExecResult>]>;
  urls?: Record<string, string>;
  files?: Record<string, string>;
  probe?: (l: McpLaunch) => { ok: boolean; tools: number; error?: string };
} = {}) {
  const calls: Array<{ cmd: string; cwd?: string }> = [];
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const probes: McpLaunch[] = [];
  const sys: UpdateSys = {
    async exec(cmd, o) {
      const line = cmd.join(" ");
      calls.push({ cmd: line, cwd: o?.cwd });
      const h = opts.exec?.find(([re]) => re.test(line));
      const r = h ? h[1](cmd, o?.cwd) : {};
      return { code: r.code ?? 0, out: r.out ?? "", err: r.err ?? "" };
    },
    async fetchText(url) {
      return opts.urls?.[url];
    },
    async download(url, dest) {
      if (!(url in (opts.urls ?? {}))) return false;
      files[dest] = opts.urls![url];
      return true;
    },
    sha256: (p) => (p in files ? `sha-of-${files[p]}` : undefined),
    readFile: (p) => files[p],
    writeFile: (p, t) => void (files[p] = t),
    exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    copyFile: (a, b) => void (files[b] = files[a]),
    rename: (a, b) => {
      files[b] = files[a];
      delete files[a];
    },
    listDir: (p) => [...new Set(Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]))],
    async probeMcp(l) {
      probes.push(l);
      return opts.probe ? opts.probe(l) : { ok: true, tools: 3 };
    },
  };
  return { sys, calls, files, probes };
}

// --- release notes ---------------------------------------------------------------------------------

test("versions compare numerically, and notes are taken from the sections between two versions", () => {
  expect(compareVersions("0.3.289", "0.3.86")).toBe(1);
  expect(compareVersions("v1.2.0", "1.2")).toBe(0);
  const cl = "# Changelog\n\n## 0.3.289\n- Removed the `x` option\n\n## 0.3.288\n- Fixed a thing when y was removed\n\n## 0.3.287\n- old\n";
  expect(notesBetween(cl, "0.3.287", "0.3.289")).toEqual(["- Removed the `x` option", "- Fixed a thing when y was removed"]);
  expect(breakingLines(notesBetween(cl, "0.3.287", "0.3.289"))).toEqual(["Removed the `x` option"]);
  expect(breakingLines(["the index format moves (one rebuild, below)", "BREAKING CHANGE: tool output"])).toHaveLength(2);
});

// --- the orchestrator ------------------------------------------------------------------------------

function source(category: ItemResult["category"], results: ItemResult[] | ((c: RunContext) => ItemResult[] | Promise<ItemResult[]>), rolled?: ItemResult[]): UpdateSource {
  return {
    category,
    run: async (c) => (typeof results === "function" ? results(c) : results),
    rollback: async (last) => {
      rolled?.push(last);
      return { category, id: last.id, outcome: "rolled_back", from: last.to, to: last.from };
    },
  };
}

test("due: first run is due, then not until the interval passes; deferred items retry once idle", async () => {
  const ledger = openLedger(":memory:");
  let t = 1_000_000;
  let busy = false;
  const u = createUpdater({
    ledger,
    sources: [source("plugins", () => [{ category: "plugins", id: "p", outcome: busy ? "deferred" : "up_to_date" }])],
    cfg: () => CFG,
    busy: () => busy,
    report: () => {},
    now: () => t,
  });
  expect(u.due(t)).toBe(true);
  busy = true;
  await u.run({ trigger: "schedule" });
  t += 60_000;
  expect(u.due(t)).toBe(false); // still busy
  busy = false;
  expect(u.due(t)).toBe(false); // retry window not yet passed
  t += CFG.retryDeferredMs;
  expect(u.due(t)).toBe(true);
  await u.run({ trigger: "schedule" });
  t += CFG.retryDeferredMs * 2;
  expect(u.due(t)).toBe(false); // nothing deferred now: wait for the full interval
  t += CFG.everyMs;
  expect(u.due(t)).toBe(true);
  expect(createUpdater({ ledger, sources: [], cfg: () => ({ ...CFG, enabled: false }), busy: () => false, report: () => {} }).due(t)).toBe(false);
});

test("a run records every result and the run in the ledger, and sends the operator ONE report", async () => {
  const ledger = openLedger(":memory:");
  const reports: string[] = [];
  const u = createUpdater({
    ledger,
    sources: [
      source("sdk", [{ category: "sdk", id: "@anthropic-ai/claude-agent-sdk", outcome: "merged", from: "0.3.286", to: "0.3.289", restartNeeded: true }]),
      source("plugins", [
        { category: "plugins", id: "superpowers@x", outcome: "applied", from: "6.4.1", to: "6.5.0" },
        { category: "plugins", id: "telegram@x", outcome: "up_to_date", from: "0.0.7" },
      ]),
      source("mcp", () => {
        throw new Error("docker is down");
      }),
    ],
    cfg: () => CFG,
    busy: () => false,
    report: (t) => void reports.push(t),
  });
  const text = await u.run({ trigger: "manual" });
  expect(reports).toHaveLength(1);
  expect(text).toContain("0.3.286 → 0.3.289");
  expect(text).toContain("Restart needed for: @anthropic-ai/claude-agent-sdk");
  expect(text).toContain("superpowers@x 6.4.1 → 6.5.0");
  expect(text).toContain("docker is down"); // one category failing never stops the others
  expect(text).not.toContain("telegram@x"); // quiet items are counted, not listed
  expect(ledger.listEvents({ kind: "update_result" })).toHaveLength(4);
  expect(ledger.listEvents({ kind: "update_run" })).toHaveLength(1);
  expect(u.status()).toContain("telegram@x 0.0.7 [up_to_date]");
});

test("runs are single-flight: a second run while one is in progress does nothing", async () => {
  const ledger = openLedger(":memory:");
  let release!: () => void;
  let calls = 0;
  const u = createUpdater({
    ledger,
    sources: [
      source("plugins", async () => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return [];
      }),
    ],
    cfg: () => CFG,
    busy: () => false,
    report: () => {},
  });
  const first = u.run({ trigger: "manual" });
  expect(u.running()).toBe(true);
  expect(await u.run({ trigger: "manual" })).toBeUndefined();
  expect(u.due(Date.now())).toBe(false);
  release();
  await first;
  expect(calls).toBe(1);
});

test("the context per category: auto-apply switch, force for /updates apply, busy flag", async () => {
  const ledger = openLedger(":memory:");
  const seen: RunContext[] = [];
  const u = createUpdater({
    ledger,
    sources: [source("sdk", (c) => (seen.push(c), [])), source("mcp", (c) => (seen.push(c), []))],
    cfg: () => ({ ...CFG, autoApply: { sdk: false, plugins: true, mcp: true } }),
    busy: () => true,
    report: () => {},
  });
  await u.run({ trigger: "schedule" });
  expect(seen[0]).toMatchObject({ autoApply: false, holdBreaking: true, busy: true, force: false });
  expect(seen[1].autoApply).toBe(true);
  seen.length = 0;
  await u.run({ trigger: "manual", only: "x", force: true });
  expect(seen[0]).toMatchObject({ autoApply: true, holdBreaking: false, only: "x", force: true });
});

test("rollback uses the item's last applied result; unknown items and busy sessions are refused", async () => {
  const ledger = openLedger(":memory:");
  const rolled: ItemResult[] = [];
  let busy = false;
  const u = createUpdater({
    ledger,
    sources: [source("plugins", [{ category: "plugins", id: "superpowers@x", outcome: "applied", from: "6.4.1", to: "6.5.0", undo: { installPath: "/old" } }], rolled)],
    cfg: () => CFG,
    busy: () => busy,
    report: () => {},
  });
  await u.run({ trigger: "manual" });
  expect(await u.rollback("nope")).toContain("No applied update");
  busy = true;
  expect(await u.rollback("superpowers@x")).toContain("session is running");
  busy = false;
  expect(await u.rollback("superpowers@x")).toContain("6.5.0 → 6.4.1");
  expect(rolled[0].undo).toEqual({ installPath: "/old" });
});

// --- sdk -------------------------------------------------------------------------------------------

const REPO = "/home/neo";
const PKG = "@anthropic-ai/claude-agent-sdk";
const pkgJson = (v: string) => JSON.stringify({ dependencies: { [PKG]: v } });

function sdkSys(o: { latest: string; testsPass?: boolean; changelog?: string; masterWorktree?: string }) {
  const wt = `${REPO}-wt-sdk-${o.latest}`;
  return fakeSys({
    urls: {
      [`https://registry.npmjs.org/${PKG}/latest`]: JSON.stringify({ version: o.latest }),
      "https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md": o.changelog ?? `## ${o.latest}\n- Fixed a thing\n## 0.3.286\n- old`,
    },
    exec: [
      [/^git show master:package.json/, () => ({ out: pkgJson("0.3.286") })],
      [/^git worktree list --porcelain/, () => ({ out: `worktree ${REPO}\nHEAD abc\nbranch refs/heads/fix/x\n` + (o.masterWorktree ? `\nworktree ${o.masterWorktree}\nHEAD def\nbranch refs/heads/master\n` : "") })],
      [/^bun test/, () => (o.testsPass === false ? { code: 1, out: "(fail) a test\n 900 pass\n 1 fail" } : { out: " 930 pass\n 0 fail" })],
      [/^grep -rhoE/, (_c, cwd) => ({ out: cwd === wt ? "claude-opus-5-5\nclaude-opus-6\nclaude-opus-5-5\n" : "claude-opus-5-5\n" })],
      [/^git status --porcelain/, () => ({ out: "" })],
    ],
  });
}

test("sdk: nothing newer → up_to_date and no git work", async () => {
  const { sys, calls } = sdkSys({ latest: "0.3.286" });
  const [r] = await sdkSource({ sys, repo: REPO, baseBranch: "master" }).run(ctx());
  expect(r).toMatchObject({ outcome: "up_to_date", from: "0.3.286" });
  expect(calls.some((c) => c.cmd.startsWith("git worktree add"))).toBe(false);
});

test("sdk: newer + green → bumped on a branch in its own worktree, fast-forwarded into master, restart needed", async () => {
  const { sys, calls } = sdkSys({ latest: "0.3.289" });
  const [r] = await sdkSource({ sys, repo: REPO, baseBranch: "master" }).run(ctx());
  const wt = `${REPO}-wt-sdk-0.3.289`;
  expect(r).toMatchObject({ outcome: "merged", from: "0.3.286", to: "0.3.289", restartNeeded: true });
  expect(r.detail).toContain("claude-opus-6"); // the new model ids the bundle names
  const cmds = calls.map((c) => `${c.cwd ?? ""}$ ${c.cmd}`);
  expect(cmds).toContain(`${REPO}$ git worktree add -b chore/agent-sdk-0.3.289 ${wt} master`);
  expect(cmds).toContain(`${wt}$ bun add --exact ${PKG}@0.3.289`);
  expect(cmds).toContain(`${wt}$ bunx tsc --noEmit`);
  expect(cmds).toContain(`${wt}$ bun test`);
  expect(cmds.some((c) => c.startsWith(`${wt}$ git commit`))).toBe(true);
  expect(cmds).toContain(`${REPO}$ git fetch . chore/agent-sdk-0.3.289:master`); // master not checked out → ff the ref
  expect(cmds).toContain(`${REPO}$ git worktree remove --force ${wt}`);
  // never installs into the live checkout
  expect(calls.some((c) => c.cmd.startsWith("bun add") && c.cwd === REPO)).toBe(false);
});

test("sdk: master checked out in a clean worktree → fast-forward merge there", async () => {
  const { sys, calls } = sdkSys({ latest: "0.3.289", masterWorktree: "/home/neo-wt-master" });
  const [r] = await sdkSource({ sys, repo: REPO, baseBranch: "master" }).run(ctx());
  expect(r.outcome).toBe("merged");
  expect(calls.some((c) => c.cwd === "/home/neo-wt-master" && c.cmd === "git merge --ff-only chore/agent-sdk-0.3.289")).toBe(true);
});

test("sdk: red tests → not merged, output reported, worktree and branch removed", async () => {
  const { sys, calls } = sdkSys({ latest: "0.3.289", testsPass: false });
  const [r] = await sdkSource({ sys, repo: REPO, baseBranch: "master" }).run(ctx());
  expect(r.outcome).toBe("failed");
  expect(r.to).toBe("0.3.289");
  expect(r.detail).toContain("1 fail");
  expect(calls.some((c) => c.cmd.includes(":master") || c.cmd.startsWith("git merge"))).toBe(false);
  expect(calls.some((c) => c.cmd === "git branch -D chore/agent-sdk-0.3.289")).toBe(true);
});

test("sdk: a version that already failed is skipped; breaking notes hold it; auto-apply off reports it", async () => {
  const failed = (id: string): ItemResult | undefined => (id === PKG ? { category: "sdk", id, outcome: "failed", to: "0.3.289" } : undefined);
  let s = sdkSys({ latest: "0.3.289" });
  expect((await sdkSource({ sys: s.sys, repo: REPO, baseBranch: "master" }).run(ctx({ lastResult: failed })))[0].outcome).toBe("skipped");

  s = sdkSys({ latest: "0.3.289", changelog: "## 0.3.289\n- Removed the `foo` option\n## 0.3.286\n" });
  const [held] = await sdkSource({ sys: s.sys, repo: REPO, baseBranch: "master" }).run(ctx());
  expect(held.outcome).toBe("held");
  expect(held.breaking).toEqual(["Removed the `foo` option"]);
  expect(s.calls.some((c) => c.cmd.startsWith("git worktree add"))).toBe(false);

  s = sdkSys({ latest: "0.3.289" });
  expect((await sdkSource({ sys: s.sys, repo: REPO, baseBranch: "master" }).run(ctx({ autoApply: false })))[0].outcome).toBe("available");
});

test("sdk: rollback bumps back to the previous version through the same green-gated path", async () => {
  const { sys, calls } = sdkSys({ latest: "0.3.289" });
  const s = sdkSource({ sys, repo: REPO, baseBranch: "master" });
  calls.length = 0;
  const r = await s.rollback({ category: "sdk", id: PKG, outcome: "merged", from: "0.3.280", to: "0.3.289" });
  expect(r.outcome).toBe("merged");
  expect(r.to).toBe("0.3.280");
  expect(calls.some((c) => c.cmd === `bun add --exact ${PKG}@0.3.280`)).toBe(true);
});

// --- plugins ---------------------------------------------------------------------------------------

import { pluginsSource } from "../src/engine/update-plugins";

const PFILE = "/root/.claude/plugins/installed_plugins.json";
const CACHE = "/root/.claude/plugins/cache/mkt/superpowers";
const entry = (v: string) => ({ scope: "user", installPath: `${CACHE}/${v}`, version: v, installedAt: "t0", lastUpdated: "t0", gitCommitSha: `sha${v}` });

function pluginSys(o: { updateTo?: string; validateOk?: boolean; notes?: string; enabled?: boolean; pretty?: boolean } = {}) {
  const installed = () => ({ version: 2, plugins: { "superpowers@mkt": [entry("6.4.1")] } });
  const env = fakeSys({
    files: {
      [PFILE]: JSON.stringify(installed()),
      [`${CACHE}/6.4.1/.claude-plugin/plugin.json`]: "{}",
    },
    exec: [
      [/^claude plugin list --json/, () => ({ out: JSON.stringify([
        { id: "superpowers@mkt", version: "6.4.1", scope: "user", enabled: o.enabled ?? true, installPath: `${CACHE}/6.4.1`, hooks: ["start"] },
        { id: "off@mkt", version: "1.0.0", scope: "user", enabled: false, installPath: "/x" },
      ], null, o.pretty ? 2 : undefined) })],
      [/^claude plugin marketplace update/, () => ({ out: "ok" })],
      [/^claude plugin update superpowers@mkt --json/, () => {
        if (!o.updateTo) return { out: JSON.stringify({ outcome: "ok", updateOutcome: "up_to_date", oldVersion: "6.4.1", newVersion: "6.4.1" }) };
        // the CLI rewrites the registry entry and keeps the old folder
        env.files[PFILE] = JSON.stringify({ version: 2, plugins: { "superpowers@mkt": [entry(o.updateTo)] } });
        env.files[`${CACHE}/${o.updateTo}/.claude-plugin/plugin.json`] = "{}";
        if (o.notes) env.files[`${CACHE}/${o.updateTo}/RELEASE-NOTES.md`] = o.notes;
        return { out: `progress…\n${JSON.stringify({ outcome: "ok", updateOutcome: "updated", oldVersion: "6.4.1", newVersion: o.updateTo })}` };
      }],
      [/^claude plugin validate/, () => (o.validateOk === false ? { code: 1, out: JSON.stringify({ success: false, manifest: { errors: ["bad manifest"] } }) } : { out: JSON.stringify({ success: true }) })],
      [/^claude plugin details/, () => ({ out: "superpowers 6.5.0" })],
    ],
  });
  return env;
}
const pluginEntry = (files: Record<string, string>) => (JSON.parse(files[PFILE]) as { plugins: Record<string, Array<{ version: string }>> }).plugins["superpowers@mkt"][0];

test("plugins: a session mid-task defers every enabled plugin; nothing is touched", async () => {
  const { sys, calls } = pluginSys({ updateTo: "6.5.0" });
  const rs = await pluginsSource({ sys, pluginsFile: PFILE }).run(ctx({ busy: true }));
  expect(rs).toEqual([{ category: "plugins", id: "superpowers@mkt", outcome: "deferred", from: "6.4.1", detail: "a session is running — applied when the engine is idle" }]);
  expect(calls.some((c) => c.cmd.startsWith("claude plugin update"))).toBe(false);
});

test("plugins: only enabled plugins are updated; up to date stays quiet", async () => {
  const { sys, calls } = pluginSys();
  const rs = await pluginsSource({ sys, pluginsFile: PFILE }).run(ctx());
  expect(rs).toEqual([{ category: "plugins", id: "superpowers@mkt", outcome: "up_to_date", from: "6.4.1" }]);
  expect(calls.some((c) => c.cmd.includes("off@mkt"))).toBe(false);
  expect(calls[1].cmd).toBe("claude plugin marketplace update"); // catalogs refreshed first
});

test("plugins: the CLI's pretty-printed list parses whole — a lone JSON scalar line inside it is not the answer", async () => {
  const { sys } = pluginSys({ pretty: true });
  const rs = await pluginsSource({ sys, pluginsFile: PFILE }).run(ctx());
  expect(rs).toEqual([{ category: "plugins", id: "superpowers@mkt", outcome: "up_to_date", from: "6.4.1" }]);
});

test("plugins: an update that verifies is applied, with what a rollback needs", async () => {
  const { sys, files } = pluginSys({ updateTo: "6.5.0" });
  const [r] = await pluginsSource({ sys, pluginsFile: PFILE }).run(ctx());
  expect(r).toMatchObject({ outcome: "applied", from: "6.4.1", to: "6.5.0" });
  expect(r.detail).toContain("new sessions");
  expect((r.undo as { entry: { version: string } }).entry.version).toBe("6.4.1");
  expect(pluginEntry(files).version).toBe("6.5.0");
});

test("plugins: a failed verification restores the old entry at once", async () => {
  const { sys, files } = pluginSys({ updateTo: "6.5.0", validateOk: false });
  const [r] = await pluginsSource({ sys, pluginsFile: PFILE }).run(ctx());
  expect(r.outcome).toBe("rolled_back");
  expect(r.detail).toContain("bad manifest");
  expect(pluginEntry(files).version).toBe("6.4.1");
});

test("plugins: breaking release notes hold the update (old entry restored); force applies it", async () => {
  const notes = "# Notes\n## v6.5.0 (2026-10-01)\n- **Breaking:** skills renamed\n## v6.4.1\n- old";
  let env = pluginSys({ updateTo: "6.5.0", notes });
  const [held] = await pluginsSource({ sys: env.sys, pluginsFile: PFILE }).run(ctx());
  expect(held.outcome).toBe("held");
  expect(held.breaking?.[0]).toContain("Breaking");
  expect(pluginEntry(env.files).version).toBe("6.4.1");

  env = pluginSys({ updateTo: "6.5.0", notes });
  const [forced] = await pluginsSource({ sys: env.sys, pluginsFile: PFILE }).run(ctx({ holdBreaking: false, force: true, only: "superpowers@mkt" }));
  expect(forced.outcome).toBe("applied");
  expect(forced.breaking?.[0]).toContain("Breaking");
});

test("plugins: rollback restores the recorded entry when its folder still exists", async () => {
  const { sys, files } = pluginSys({ updateTo: "6.5.0" });
  const src = pluginsSource({ sys, pluginsFile: PFILE });
  const [applied] = await src.run(ctx());
  const r = await src.rollback(applied);
  expect(r).toMatchObject({ outcome: "rolled_back", from: "6.5.0", to: "6.4.1" });
  expect(pluginEntry(files).version).toBe("6.4.1");
});

// --- mcp -------------------------------------------------------------------------------------------

import { mcpSource, classifyServer } from "../src/engine/update-mcp";

const CBM = "/root/.local/bin/codebase-memory-mcp";
const CBM_REPO = "DeusData/codebase-memory-mcp";
const CBM_ASSET = "codebase-memory-mcp-ui-linux-amd64-portable.tar.gz";

test("mcp: every configured server is classified — remote, floating, pinned elsewhere, managed, local", () => {
  const opts = { npmGlobals: { "playwright-mcp": "@playwright/mcp" }, codebaseMemoryBin: CBM };
  expect(classifyServer({ type: "http", url: "https://x.dev/mcp" }, opts)).toMatchObject({ kind: "remote", id: "remote:x.dev" });
  expect(classifyServer({ command: "npx", args: ["-y", "chrome-devtools-mcp", "--browserUrl", "u"] }, opts)).toMatchObject({ kind: "npx-floating", id: "npx:chrome-devtools-mcp" });
  expect(classifyServer({ command: "npx", args: ["@playwright/mcp@latest", "--headless"] }, opts)).toMatchObject({ kind: "npx-floating", id: "npx:@playwright/mcp" });
  expect(classifyServer({ command: "npx", args: ["@upstash/context7-mcp@3.2.4"] }, opts)).toMatchObject({ kind: "npx-pinned", id: "npx:@upstash/context7-mcp", version: "3.2.4" });
  expect(classifyServer({ command: "docker", args: ["run", "-i", "--rm", "--network", "net", "-e", "A=b", "mcp/redis"] }, opts)).toMatchObject({ kind: "docker", id: "docker:mcp/redis", image: "mcp/redis" });
  expect(classifyServer({ command: "docker", args: ["run", "-i", "--rm", "mcp/redis:1.2"] }, opts)).toMatchObject({ kind: "docker-pinned", id: "docker:mcp/redis:1.2" });
  expect(classifyServer({ command: "playwright-mcp", args: ["--headless"] }, opts)).toMatchObject({ kind: "npm-global", id: "npm:@playwright/mcp", pkg: "@playwright/mcp" });
  expect(classifyServer({ command: CBM, args: [] }, opts)).toMatchObject({ kind: "codebase-memory", id: "codebase-memory-mcp" });
  expect(classifyServer({ command: "/home/x/grpcmcp", args: [] }, opts)).toMatchObject({ kind: "local", id: "cmd:/home/x/grpcmcp" });
});

function mcpEnv(o: { dockerNewId?: string; probeOk?: boolean; cbmLatest?: string; cbmNotes?: string; pwLatest?: string } = {}) {
  let dockerId = "sha256:aaaaaaaaaaaaaaaa";
  let pwVersion = "0.0.80";
  const claudeJson = {
    mcpServers: {
      stitch: { type: "http", url: "https://stitch.googleapis.com/mcp" },
      chrome: { command: "npx", args: ["-y", "chrome-devtools-mcp"] },
    },
    projects: { "/home/eticket-v3": { mcpServers: { redis: { command: "docker", args: ["run", "-i", "--rm", "mcp/redis"] } } } },
  };
  const env = fakeSys({
    files: {
      "/root/.claude.json": JSON.stringify(claudeJson),
      "/home/waselni/.mcp.json": JSON.stringify({ mcpServers: { context7: { command: "npx", args: ["@upstash/context7-mcp@3.2.4"] } } }),
      "/home/eticket-v3/.mcp.json": JSON.stringify({ mcpServers: { redis: { command: "docker", args: ["run", "-i", "--rm", "mcp/redis"] } } }),
      [CBM]: "old-binary",
    },
    urls: {
      "https://registry.npmjs.org/@upstash/context7-mcp/latest": JSON.stringify({ version: "4.1.1" }),
      "https://registry.npmjs.org/@playwright/mcp/latest": JSON.stringify({ version: o.pwLatest ?? "0.0.80" }),
      [`https://api.github.com/repos/${CBM_REPO}/releases?per_page=30`]: JSON.stringify([
        { tag_name: `v${o.cbmLatest ?? "0.8.1"}`, body: o.cbmNotes ?? "- faster", draft: false, prerelease: false },
        { tag_name: "v0.8.1", body: "- old", draft: false, prerelease: false },
      ]),
      [`https://github.com/${CBM_REPO}/releases/download/v${o.cbmLatest}/${CBM_ASSET}`]: "tarball",
      [`https://github.com/${CBM_REPO}/releases/download/v${o.cbmLatest}/checksums.txt`]: `sha-of-tarball  ${CBM_ASSET}\nzzz  other`,
    },
    exec: [
      [/^docker image inspect/, () => ({ out: `${dockerId}\n` })],
      [/^docker pull mcp\/redis/, () => ((dockerId = o.dockerNewId ?? dockerId), { out: "pulled" })],
      [/^docker tag/, (cmd) => ((dockerId = cmd[2]), {})],
      [/^npm ls -g @playwright\/mcp --json/, () => ({ out: JSON.stringify({ dependencies: { "@playwright/mcp": { version: pwVersion } } }) })],
      [/^npm i -g @playwright\/mcp@/, (cmd) => ((pwVersion = cmd[3].split("@").pop()!), {})],
      [/--version$/, () => ({ out: "codebase-memory-mcp 0.8.1" })],
      [/^find /, (cmd) => ({ out: `${cmd[1]}/codebase-memory-mcp\n` })],
    ],
    probe: () => (o.probeOk === false ? { ok: false, tools: 0, error: "no tools/list reply" } : { ok: true, tools: 7 }),
  });
  const src = mcpSource({
    sys: env.sys,
    claudeJson: "/root/.claude.json",
    workRoot: "/home",
    builtins: [{ name: "playwright", command: "playwright-mcp", args: ["--headless", "--isolated"] }, { name: "codebase-memory", command: CBM, args: [] }],
    npmGlobals: { "playwright-mcp": "@playwright/mcp" },
    codebaseMemory: { bin: CBM, repo: CBM_REPO, asset: CBM_ASSET },
    verifyTimeoutMs: 1000,
  });
  return { ...env, src, dockerId: () => dockerId, pwVersion: () => pwVersion };
}
const byId = (rs: ItemResult[], id: string) => rs.find((r) => r.id === id);

test("mcp: remote and floating servers are reported, pins in another project are report-only, duplicates collapse", async () => {
  const { src, files } = mcpEnv();
  files["/home/waselni"] = "dir";
  const rs = await src.run(ctx());
  expect(byId(rs, "remote:stitch.googleapis.com")?.outcome).toBe("floating");
  expect(byId(rs, "npx:chrome-devtools-mcp")?.outcome).toBe("floating");
  expect(byId(rs, "npx:@upstash/context7-mcp")).toMatchObject({ outcome: "report_only", from: "3.2.4", to: "4.1.1" });
  expect(byId(rs, "npx:@upstash/context7-mcp")?.detail).toContain("/home/waselni/.mcp.json");
  expect(rs.filter((r) => r.id === "docker:mcp/redis")).toHaveLength(1);
  expect(byId(rs, "codebase-memory-mcp")?.outcome).toBe("up_to_date");
});

test("mcp: a docker image whose pull brings a new id is verified by starting the server; a failed probe re-tags the old image", async () => {
  let env = mcpEnv({ dockerNewId: "sha256:bbbbbbbbbbbbbbbb" });
  let r = byId(await env.src.run(ctx()), "docker:mcp/redis")!;
  expect(r).toMatchObject({ outcome: "applied", from: "aaaaaaaaaaaa", to: "bbbbbbbbbbbb" });
  expect(env.probes.some((p) => p.command === "docker" && p.args.includes("mcp/redis"))).toBe(true);

  env = mcpEnv({ dockerNewId: "sha256:bbbbbbbbbbbbbbbb", probeOk: false });
  r = byId(await env.src.run(ctx()), "docker:mcp/redis")!;
  expect(r.outcome).toBe("rolled_back");
  expect(env.dockerId()).toBe("sha256:aaaaaaaaaaaaaaaa");
});

test("mcp: the playwright-mcp global is bumped to the exact latest and verified; rollback reinstalls the old one", async () => {
  const env = mcpEnv({ pwLatest: "0.0.83" });
  const r = byId(await env.src.run(ctx()), "npm:@playwright/mcp")!;
  expect(r).toMatchObject({ outcome: "applied", from: "0.0.80", to: "0.0.83" });
  expect(env.pwVersion()).toBe("0.0.83");
  const back = await env.src.rollback(r);
  expect(back.outcome).toBe("rolled_back");
  expect(env.pwVersion()).toBe("0.0.80");
});

test("mcp: codebase-memory release notes that flag a breaking change hold it; force downloads, checks the sum and swaps with a backup", async () => {
  let env = mcpEnv({ cbmLatest: "0.11.0", cbmNotes: "The index format moves (one rebuild, below)." });
  let r = byId(await env.src.run(ctx()), "codebase-memory-mcp")!;
  expect(r.outcome).toBe("held");
  expect(r.breaking?.[0]).toContain("rebuild");
  expect(env.files[CBM]).toBe("old-binary");

  env = mcpEnv({ cbmLatest: "0.11.0", cbmNotes: "rebuild" });
  // after the swap the new binary reports the new version
  const exec = env.sys.exec;
  env.sys.exec = async (cmd, o) => (cmd.join(" ").endsWith("--version") && env.files[CBM] !== "old-binary" ? { code: 0, out: "codebase-memory-mcp 0.11.0", err: "" } : exec(cmd, o));
  r = byId(await env.src.run(ctx({ holdBreaking: false, force: true, only: "codebase-memory-mcp" })), "codebase-memory-mcp")!;
  expect(r).toMatchObject({ outcome: "applied", from: "0.8.1", to: "0.11.0" });
  expect(env.files[`${CBM}.bak`]).toBe("old-binary");
});

test("mcp: a session mid-task defers what would be applied; nothing is pulled or installed", async () => {
  const env = mcpEnv({ dockerNewId: "sha256:bbbbbbbbbbbbbbbb", pwLatest: "0.0.83" });
  const rs = await env.src.run(ctx({ busy: true }));
  expect(byId(rs, "npm:@playwright/mcp")?.outcome).toBe("deferred");
  expect(byId(rs, "docker:mcp/redis")?.outcome).toBe("deferred");
  expect(env.calls.some((c) => c.cmd.startsWith("docker pull") || c.cmd.startsWith("npm i -g"))).toBe(false);
});

// --- the engine wiring (update-engine.ts): what the daemon and a direct run both build -----------

import { createEngineUpdater, registryBusy } from "../src/engine/update-engine";
import { createRegistry } from "../src/engine/registry";
import { DEFAULT_UPDATES as DEFAULTS } from "../src/config";

const PW_LS = JSON.stringify({ dependencies: { "@playwright/mcp": { version: "0.0.80" } } });
const PW_LATEST = "https://registry.npmjs.org/@playwright/mcp/latest";

test("engine updater: Neo's own MCP servers are always checked — playwright from its global, codebase-memory from its bin", async () => {
  const s = fakeSys({
    exec: [[/npm ls -g @playwright\/mcp/, () => ({ out: PW_LS })], [/--version/, () => ({ out: "codebase-memory-mcp 0.8.1" })]],
    urls: { [PW_LATEST]: JSON.stringify({ version: "0.0.80" }) },
  });
  const reports: string[] = [];
  const u = createEngineUpdater({
    cfg: () => ({ updates: DEFAULTS, workRoot: "/work", codebaseMemoryBin: "/bin/cbm" }),
    ledger: openLedger(":memory:"),
    busy: () => false,
    report: (t) => void reports.push(t),
    repo: "/repo",
    home: "/root",
    sys: s.sys,
  });
  await u.run({ trigger: "manual", only: "mcp" });
  expect(u.status()).toContain("npm:@playwright/mcp 0.0.80 [up_to_date]");
  expect(u.status()).toContain("codebase-memory-mcp");
  expect(reports.length).toBe(1);
});

test("engine updater: a running session defers what would replace files; the busy flag comes from the registry", async () => {
  const s = fakeSys({
    exec: [[/npm ls -g @playwright\/mcp/, () => ({ out: PW_LS })]],
    urls: { [PW_LATEST]: JSON.stringify({ version: "0.0.83" }) },
  });
  const reg = createRegistry();
  expect(registryBusy(reg)).toBe(false);
  const sess = reg.add({ id: "o1", source: "neo", folder: "/work/app", task: "t", chatId: 1, createdAt: 1 });
  expect(registryBusy(reg)).toBe(true);
  reg.setStatus(sess.id, "idle");
  expect(registryBusy(reg)).toBe(false);
  const u = createEngineUpdater({
    cfg: () => ({ updates: DEFAULTS, workRoot: "/work", codebaseMemoryBin: "" }),
    ledger: openLedger(":memory:"),
    busy: () => true,
    report: () => {},
    repo: "/repo",
    home: "/root",
    sys: s.sys,
  });
  await u.run({ trigger: "schedule", only: "npm:@playwright/mcp" });
  expect(u.status()).toContain("[deferred]");
  expect(s.calls.some((c) => c.cmd.startsWith("npm i -g"))).toBe(false);
});

test("a scheduled run stays silent when nothing is new since the last run; a manual run always reports", async () => {
  const ledger = openLedger(":memory:");
  const reports: string[] = [];
  const held: ItemResult = { category: "mcp", id: "codebase-memory-mcp", outcome: "held", from: "0.8.1", to: "0.11.0" };
  let results: ItemResult[] = [held, { category: "sdk", id: "sdk", outcome: "up_to_date", from: "1" }];
  const u = createUpdater({
    ledger,
    sources: [source("mcp", () => results)],
    cfg: () => CFG,
    busy: () => false,
    report: (t) => void reports.push(t),
  });
  await u.run({ trigger: "schedule" });
  expect(reports).toHaveLength(1); // first sighting of the hold is news
  await u.run({ trigger: "schedule" });
  expect(reports).toHaveLength(1); // the same hold again is not
  await u.run({ trigger: "manual" });
  expect(reports).toHaveLength(2); // the operator asked
  results = [{ ...held, to: "0.12.0" }];
  await u.run({ trigger: "schedule" });
  expect(reports).toHaveLength(3); // a newer held version is news again
});

test("only=<category> runs just that category's source", async () => {
  const ran: string[] = [];
  const mk = (c: ItemResult["category"]) => source(c, () => (ran.push(c), []));
  const u = createUpdater({ ledger: openLedger(":memory:"), sources: [mk("sdk"), mk("plugins"), mk("mcp")], cfg: () => CFG, busy: () => false, report: () => {} });
  await u.run({ trigger: "manual", only: "mcp" });
  expect(ran).toEqual(["mcp"]);
  await u.run({ trigger: "manual", only: "npm:@playwright/mcp" }); // an item id: every source looks for it
  expect(ran).toEqual(["mcp", "sdk", "plugins", "mcp"]);
});
