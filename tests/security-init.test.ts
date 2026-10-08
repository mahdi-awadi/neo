import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo } from "../tools/security/init";

const git = (repo: string, ...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]).stdout.toString().trim();
function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "neo-sec-init-"));
  Bun.spawnSync(["git", "init", "-q", r]);
  return r;
}
const noBaseline = { baseline: () => {} };

describe("security init", () => {
  test("a plain repo gets .githooks, core.hooksPath, config, gitignore and a baseline", () => {
    const r = repo();
    let baselined = "";
    const res = initRepo(r, { baseline: (x) => void (baselined = x) });
    expect(git(r, "config", "core.hooksPath")).toBe(".githooks");
    for (const h of ["pre-commit", "pre-push"]) {
      const body = readFileSync(join(r, ".githooks", h), "utf8");
      expect(body).toContain(h === "pre-commit" ? "scan.sh\" staged" : "scan.sh\" push");
      expect(Bun.spawnSync(["test", "-x", join(r, ".githooks", h)]).exitCode).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(r, ".security", "config.json"), "utf8"))).toEqual({ devUrls: [], images: [], testCmd: "" });
    expect(readFileSync(join(r, ".gitignore"), "utf8")).toContain(".security/reports/");
    expect(baselined).toBe(r);
    expect(res.hooks).toBe("githooks");
  });

  test("an existing .git/hooks hook is chained, never replaced, and a rerun does not chain to itself", () => {
    const r = repo();
    const old = join(r, ".git", "hooks", "pre-commit");
    writeFileSync(old, "#!/bin/sh\necho old-hook-ran\n");
    chmodSync(old, 0o755);
    initRepo(r, noBaseline);
    const first = readFileSync(join(r, ".githooks", "pre-commit"), "utf8");
    expect(first).toContain(".git/hooks/pre-commit");
    initRepo(r, noBaseline);
    expect(readFileSync(join(r, ".githooks", "pre-commit"), "utf8")).toBe(first);
    expect(first).not.toContain(".githooks/pre-commit\"");
    // Run it without the kit installed: the scan warns, the old hook still runs.
    const run = Bun.spawnSync(["bash", join(r, ".githooks", "pre-commit")], { cwd: r, env: { ...process.env, NEO_SECURITY_KIT: "/nonexistent" } });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("old-hook-ran");
  });

  test("a custom core.hooksPath is chained", () => {
    const r = repo();
    mkdirSync(join(r, "hooks"));
    writeFileSync(join(r, "hooks", "pre-push"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(r, "hooks", "pre-push"), 0o755);
    git(r, "config", "core.hooksPath", "hooks");
    initRepo(r, noBaseline);
    expect(git(r, "config", "core.hooksPath")).toBe(".githooks");
    expect(readFileSync(join(r, ".githooks", "pre-push"), "utf8")).toContain("hooks/pre-push");
  });

  test("husky: the scan goes into .husky/<hook> once, and core.hooksPath is left to husky", () => {
    const r = repo();
    mkdirSync(join(r, ".husky", "_"), { recursive: true });
    writeFileSync(join(r, ".husky", "pre-commit"), "bun run lint\n");
    git(r, "config", "core.hooksPath", ".husky/_");
    const res = initRepo(r, noBaseline);
    initRepo(r, noBaseline);
    expect(res.hooks).toBe("husky");
    expect(git(r, "config", "core.hooksPath")).toBe(".husky/_");
    const pc = readFileSync(join(r, ".husky", "pre-commit"), "utf8");
    expect(pc.startsWith("bun run lint\n")).toBe(true);
    expect(pc.match(/neo-security/g)).toHaveLength(1);
    expect(readFileSync(join(r, ".husky", "pre-push"), "utf8")).toContain("scan.sh\" push");
    expect(existsSync(join(r, ".githooks"))).toBe(false);
  });

  test("an existing config, baseline and gitignore line are kept", () => {
    const r = repo();
    mkdirSync(join(r, ".security"));
    writeFileSync(join(r, ".security", "config.json"), '{"devUrls":["https://dev.example"]}');
    writeFileSync(join(r, ".security", "baseline.json"), "{}");
    writeFileSync(join(r, ".gitignore"), "node_modules\n.security/reports/\n");
    let called = false;
    initRepo(r, { baseline: () => void (called = true) });
    expect(readFileSync(join(r, ".security", "config.json"), "utf8")).toBe('{"devUrls":["https://dev.example"]}');
    expect(called).toBe(false);
    expect(readFileSync(join(r, ".gitignore"), "utf8").match(/\.security\/reports\//g)).toHaveLength(1);
  });

  test("not a git repo: refused", () => {
    expect(() => initRepo(mkdtempSync(join(tmpdir(), "neo-sec-nogit-")), noBaseline)).toThrow(/git/);
  });
});
