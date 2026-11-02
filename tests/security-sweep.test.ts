import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepRepos, staleRepos } from "../tools/security/sweep";

const HOUR = 3_600_000;
function tree() {
  const root = mkdtempSync(join(tmpdir(), "neo-sec-sweep-"));
  const repo = (name: string, nightlyAgeH?: number) => {
    const dir = join(root, name);
    mkdirSync(join(dir, ".security", "reports"), { recursive: true });
    writeFileSync(join(dir, ".security", "config.json"), "{}");
    if (nightlyAgeH !== undefined) {
      const f = join(dir, ".security", "reports", "nightly-20261008-030000.json");
      writeFileSync(f, "{}");
      const t = (Date.now() - nightlyAgeH * HOUR) / 1000;
      utimesSync(f, t, t);
    }
    return dir;
  };
  return { root, repo };
}

describe("security sweep", () => {
  test("finds the repos with the checks turned on, one level under each root", () => {
    const { root, repo } = tree();
    const a = repo("alpha");
    const b = repo("beta");
    mkdirSync(join(root, "plain")); // no .security/config.json: not swept
    mkdirSync(join(root, "node_modules", "x", ".security"), { recursive: true });
    expect(sweepRepos([root])).toEqual([a, b]);
  });

  test("a repo is stale without a nightly report younger than the limit", () => {
    const { root, repo } = tree();
    const fresh = repo("fresh", 2);
    const old = repo("old", 30);
    const never = repo("never");
    expect(staleRepos([fresh, old, never], 20 * HOUR)).toEqual([old, never]);
  });
});
