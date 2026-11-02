// The bounded command runner (W0.4): the one way the engine runs a child process. Timeout, output
// cap, a scrubbed environment, and it never throws.
import { test, expect } from "bun:test";
import { DEFAULT_COMMANDS_CFG, readCommandsCfg, runCommand } from "../src/engine/run-command";

test("runCommand returns the exit code and both streams", async () => {
  const r = await runCommand(["sh", "-c", "echo out; echo err >&2; exit 3"], { cwd: process.cwd() });
  expect(r).toMatchObject({ exit: 3, stdout: "out\n", stderr: "err\n", timedOut: false, truncated: false });
  expect(r.spawnError).toBeUndefined();
  expect(r.durationMs).toBeGreaterThanOrEqual(0);
});

test("runCommand runs in the given cwd and overlays env", async () => {
  const r = await runCommand(["sh", "-c", "pwd; echo $NEO_RC_X"], { cwd: "/tmp", env: { NEO_RC_X: "overlay" } });
  expect(r.stdout).toBe("/tmp\noverlay\n");
});

test("a timed-out command returns promptly even when a grandchild still holds the pipe", async () => {
  // `sh -c 'sleep 5'` forks `sleep`, which inherits stdout. Killing sh alone used to leave the
  // pipe open, so the old runners waited the full 5 s for the orphan (the goal.test timeout).
  const t0 = Date.now();
  const r = await runCommand(["sh", "-c", "sleep 5; echo never"], { timeoutMs: 100, killGraceMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(r.exit).toBe(124);
  expect(r.stdout).not.toContain("never");
  expect(Date.now() - t0).toBeLessThan(3000);
});

test("output is capped per stream and marked truncated, and the process still finishes", async () => {
  const r = await runCommand(["sh", "-c", "yes | head -c 100000"], { maxOutputChars: 1000 });
  expect(r.exit).toBe(0);
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBeLessThanOrEqual(1000 + 60);
  expect(r.stdout).toContain("[output truncated at 1000 chars]");
});

test("a missing binary or cwd is a spawn error (exit 127), never a throw", async () => {
  const missingBin = await runCommand(["/nonexistent/neo-bin"]);
  expect(missingBin.exit).toBe(127);
  expect(missingBin.spawnError).toBeTruthy();
  const missingCwd = await runCommand(["sh", "-c", "true"], { cwd: "/home/definitely-does-not-exist-xyz" });
  expect(missingCwd.exit).toBe(127);
  expect(missingCwd.spawnError).toBeTruthy();
});

test("a scrub strips the engine's keys from the child's env; an overlay still wins", async () => {
  process.env.NEO_RC_SECRET = "leak";
  try {
    const scrub = { engineKeys: new Set(["NEO_RC_SECRET"]), relayKeys: new Set<string>(), inherit: new Set<string>(), mode: "strip" as const };
    const cmd = ["sh", "-c", 'echo "${NEO_RC_SECRET:-absent}"'];
    expect((await runCommand(cmd)).stdout).toBe("leak\n");
    expect((await runCommand(cmd, { scrub })).stdout).toBe("absent\n");
    expect((await runCommand(cmd, { scrub, env: { NEO_RC_SECRET: "mine" } })).stdout).toBe("mine\n");
  } finally {
    delete process.env.NEO_RC_SECRET;
  }
});

test("readCommandsCfg keeps defaults for missing or bad values", () => {
  expect(readCommandsCfg(undefined)).toEqual(DEFAULT_COMMANDS_CFG);
  expect(readCommandsCfg({ timeoutMs: -1, maxOutputChars: "x", killGraceMs: 0 })).toEqual(DEFAULT_COMMANDS_CFG);
  expect(readCommandsCfg({ timeoutMs: 1000, maxOutputChars: 50, killGraceMs: 10 })).toEqual({ timeoutMs: 1000, maxOutputChars: 50, killGraceMs: 10 });
});
