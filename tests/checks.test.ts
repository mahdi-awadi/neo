// The verification policy (W1.2): resolved from the project, frozen with hashes, and compared later.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHECKS_FILE, checksLine, freezePolicy, policyChanges, resolveChecks } from "../src/engine/checks";

function project(checks?: unknown, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-checks-"));
  if (checks !== undefined) {
    mkdirSync(join(dir, ".neo"), { recursive: true });
    writeFileSync(join(dir, CHECKS_FILE), typeof checks === "string" ? checks : JSON.stringify(checks));
  }
  for (const [p, c] of Object.entries(extra)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

test("no declaration → no checks, no problems, and the line says so", () => {
  const r = resolveChecks(project());
  expect(r).toMatchObject({ checks: [], source: "none", problems: [], heldOut: false });
  expect(checksLine(r)).toBe("no checks declared");
});

test("a declaration is read, its dependencies listed (existing files only) and scripts it names become policy", () => {
  const dir = project(
    { checks: [["bun", "test"], ["sh", "scripts/check.sh"]], dependsOn: ["docs/rules.md", "missing.txt"], heldOut: true },
    { "package.json": "{}", "scripts/check.sh": "exit 0", "docs/rules.md": "r" },
  );
  const r = resolveChecks(dir);
  expect(r.checks).toEqual([["bun", "test"], ["sh", "scripts/check.sh"]]);
  expect(r.source).toBe("file");
  expect(r.dependencies).toEqual([".neo/checks.json", "docs/rules.md", "package.json", "scripts/check.sh"]);
  expect(r.problems).toEqual(['dependsOn entry "missing.txt" does not exist']);
  expect(r.heldOut).toBe(true);
  expect(checksLine(r)).toBe("2 checks (file): bun test · sh scripts/check.sh");
});

test("a bad declaration is reported, never treated as nothing declared", () => {
  expect(resolveChecks(project("{not json")).problems[0]).toContain("not valid JSON");
  const r = resolveChecks(project({ checks: [["ok"], [], ["", "x"], "bun test"] }));
  expect(r.checks).toEqual([["ok"]]);
  expect(r.problems).toHaveLength(3);
  const climb = resolveChecks(project({ checks: [["true"]], dependsOn: ["../outside"] }));
  expect(climb.problems[0]).toContain("repo-relative");
});

test("an override replaces the file and is marked as such", () => {
  const dir = project({ checks: [["bun", "test"]] });
  const r = resolveChecks(dir, [["make", "check"]]);
  expect(r).toMatchObject({ checks: [["make", "check"]], source: "override" });
});

test("the frozen hash changes when a check or a dependency changes, and policyChanges names the file", () => {
  const dir = project({ checks: [["bun", "test"]] }, { "package.json": '{"scripts":{"test":"bun test"}}' });
  const frozen = freezePolicy(dir, resolveChecks(dir), 1000);
  expect(frozen.hash).toHaveLength(64);
  expect(Object.keys(frozen.files).sort()).toEqual([".neo/checks.json", "package.json"]);
  expect(frozen.frozenAt).toBe(1000);
  expect(policyChanges(dir, frozen)).toEqual([]);

  writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"exit 0"}}'); // the classic weakening
  expect(policyChanges(dir, frozen)).toEqual(["package.json"]);
  expect(freezePolicy(dir, resolveChecks(dir)).hash).not.toBe(frozen.hash);

  rmSync(join(dir, "package.json"));
  expect(policyChanges(dir, frozen)).toEqual(["package.json"]); // deleted counts as changed
});

test("a checks file that appears during the run is a policy change", () => {
  const dir = project();
  const frozen = freezePolicy(dir, resolveChecks(dir));
  expect(frozen.checks).toEqual([]);
  mkdirSync(join(dir, ".neo"), { recursive: true });
  writeFileSync(join(dir, CHECKS_FILE), JSON.stringify({ checks: [["true"]] }));
  expect(policyChanges(dir, frozen)).toEqual([CHECKS_FILE]);
});
