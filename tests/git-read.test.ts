// P5 Task 5.1 (spec §7): git-read is the process boundary for git and gh reads — bounded, never throws.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitRead, uncommittedFrom } from "../src/engine/git-read";
import { exec } from "../src/engine/update-sys";

test("exec: a command past its timeout is killed and says so; a missing binary is a result, not a throw", async () => {
  const slow = await exec(["sleep", "5"], { timeoutMs: 100 });
  expect(slow.code).toBe(124);
  expect(slow.err).toContain("timed out");
  const missing = await exec(["no-such-binary-xyz"], { timeoutMs: 1000 });
  expect(missing.code).toBe(127);
  const env = await exec(["sh", "-c", "printf %s \"$NEO_T\""], { timeoutMs: 1000, env: { NEO_T: "set" } });
  expect(env.out).toBe("set");
});

test("createGitRead: git runs in the folder with no prompts or pager; a failure is ok:false with stderr", async () => {
  const calls: Array<{ cmd: string[]; cwd?: string; env?: Record<string, string> }> = [];
  const fake = async (cmd: string[], o: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}) => {
    calls.push({ cmd, cwd: o.cwd, env: o.env });
    return cmd.includes("bad") ? { code: 1, out: "", err: "fatal: bad revision" } : cmd.includes("slow") ? { code: 124, out: "", err: "[timed out]" } : { code: 0, out: "ok\n", err: "" };
  };
  const g = createGitRead({ timeoutMs: 20_000, exec: fake });
  expect(await g.git("/home/gold", ["status"])).toEqual({ ok: true, out: "ok\n" });
  expect(calls[0]).toMatchObject({ cmd: ["git", "-C", "/home/gold", "status"], env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GH_PAGER: "", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  expect(await g.git("/home/gold", ["log", "bad"])).toEqual({ ok: false, out: "", err: "fatal: bad revision" });
  expect(await g.gh("/home/gold", ["pr", "list", "slow"])).toEqual({ ok: false, out: "", err: "timeout" });
  expect(calls.at(-1)).toMatchObject({ cmd: ["gh", "pr", "list", "slow"], cwd: "/home/gold" });
});

test("createGitRead against a real repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-gitread-"));
  try {
    const g = createGitRead({ timeoutMs: 5_000 });
    expect((await g.git(dir, ["init", "-q"])).ok).toBe(true);
    expect((await g.git(dir, ["rev-parse", "--is-inside-work-tree"])).out.trim()).toBe("true");
    expect((await g.git(join(dir, "nope"), ["status"])).ok).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncommittedFrom: porcelain paths, renames to their new name, the folder's own HANDOFF.md left out", () => {
  const out = " M src/a.ts\n?? notes/HANDOFF.md\nR  old.ts -> new.ts\n?? sub/HANDOFF.md\n";
  expect(uncommittedFrom(out, "sub/")).toEqual(["src/a.ts", "notes/HANDOFF.md", "new.ts"]);
});
