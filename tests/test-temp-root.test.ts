// The test temp root (ADR-0042): every temp folder a test run makes lives under one per-run folder,
// and the run removes that folder when it exits, so tests never leave folders in /tmp.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

test("a test's tmpdir() is the run's temp root, not the shared temp folder", () => {
  const root = tmpdir();
  expect(root).toBe(process.env.TMPDIR!);
  expect(root.split("/").pop()).toMatch(/^neo-test-/);
  expect(existsSync(root)).toBe(true);
});

test("a run removes its temp root, with every folder its tests leaked, when it exits", () => {
  const repo = dirname(import.meta.dir);
  const run = Bun.spawnSync(["bun", "test", "./tests/fixtures/test-temp-root.fixture.ts"], {
    cwd: repo,
    env: { ...process.env, TMPDIR: tmpdir() },
  });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode).toBe(0);
  const leaked = out.match(/LEAKED=(\S+)/)?.[1];
  expect(leaked).toBeDefined();
  const childRoot = dirname(leaked!);
  expect(dirname(childRoot)).toBe(tmpdir());
  expect(childRoot.split("/").pop()).toMatch(/^neo-test-/);
  expect(existsSync(leaked!)).toBe(false);
  expect(existsSync(childRoot)).toBe(false);
});

test("the fixture is not picked up by a bare `bun test`", () => {
  expect(join("fixtures", "test-temp-root.fixture.ts")).not.toMatch(/\.test\.ts$/);
});
