// The diff lint (W1.7): findings, never denials, about what a diff did to the things that verify it.
import { test, expect } from "bun:test";
import { lintDiff, lintLine, parseDiff, TEST_PATH } from "../src/engine/diff-lint";

const file = (oldPath: string, newPath: string, body: string) =>
  `diff --git a/${oldPath || newPath} b/${newPath || oldPath}\n--- ${oldPath ? "a/" + oldPath : "/dev/null"}\n+++ ${newPath ? "b/" + newPath : "/dev/null"}\n@@ -1,3 +1,3 @@\n${body}`;

test("TEST_PATH recognises the stacks' test files and nothing else", () => {
  for (const p of ["tests/a.test.ts", "src/x.spec.tsx", "pkg/y_test.go", "tests/test_z.py", "app/__tests__/c.js", "e2e/login.ts", "spec/models/u_spec.rb"]) expect(TEST_PATH.test(p)).toBe(true);
  for (const p of ["src/a.ts", "src/testing-utils.ts", "docs/tests.md", "contest/x.ts"]) expect(TEST_PATH.test(p)).toBe(false);
});

test("a deleted test file is one finding; its assertions are not counted twice", () => {
  const d = file("tests/a.test.ts", "", "-test('x', () => {\n-  expect(1).toBe(1);\n-});");
  expect(lintDiff(d)).toEqual([{ kind: "test_file_deleted", path: "tests/a.test.ts", detail: "3 lines" }]);
});

test("removed assertions are net of the ones added back (an edited assertion is not a removal)", () => {
  const edited = file("tests/a.test.ts", "tests/a.test.ts", "-  expect(a).toBe(1);\n+  expect(a).toBe(2);");
  expect(lintDiff(edited)).toEqual([]);
  const removed = file("tests/a.test.ts", "tests/a.test.ts", "-  expect(a).toBe(1);\n-  expect(b).toBe(2);\n+  // later");
  expect(lintDiff(removed)).toEqual([{ kind: "assertion_removed", path: "tests/a.test.ts", detail: "2 fewer assertions" }]);
  const go = file("pkg/y_test.go", "pkg/y_test.go", "-\tif got != want { t.Fatalf(\"x\") }");
  expect(lintDiff(go)[0]?.kind).toBe("assertion_removed");
});

test("skipped and focused tests are findings in test files; hook bypasses and silenced errors anywhere", () => {
  const d =
    file("tests/a.test.ts", "tests/a.test.ts", "+test.skip('flaky', () => {});\n+it.only('this one', () => {});") +
    "\n" +
    file("src/x.ts", "src/x.ts", "+// @ts-ignore\n+const y = run('git commit --no-verify');") +
    "\n" +
    file("tests/b.test.ts", "tests/b.test.ts", "+// @ts-ignore in a test is the test's business");
  const kinds = lintDiff(d).map((f) => `${f.kind}:${f.path}`);
  expect(kinds).toEqual(["test_skipped:tests/a.test.ts", "test_focused:tests/a.test.ts", "hooks_bypassed:src/x.ts", "error_silenced:src/x.ts"]);
});

test("a changed policy file is named, with the frozen policy's list as the source of truth", () => {
  const d = file("package.json", "package.json", '-    "test": "bun test"\n+    "test": "exit 0"');
  expect(lintDiff(d, ["package.json", ".neo/checks.json"])).toEqual([{ kind: "policy_changed", path: "package.json", detail: "a verification policy file changed in this run" }]);
  expect(lintDiff(d, [])).toEqual([]);
});

test("parseDiff strips a/ b/ prefixes and handles renames and /dev/null", () => {
  const files = parseDiff(file("old.ts", "new.ts", "-a\n+b") + "\n" + file("", "fresh.ts", "+x"));
  expect(files.map((f) => [f.oldPath, f.newPath, f.deleted])).toEqual([["old.ts", "new.ts", false], ["", "fresh.ts", false]]);
  expect(lintDiff("")).toEqual([]);
  expect(lintDiff("not a diff at all")).toEqual([]);
});

test("lintLine summarises and caps", () => {
  const f = lintDiff(file("tests/a.test.ts", "tests/a.test.ts", "-expect(1).toBe(1);\n+test.skip('x');\n+it.only('y');\n+run('--no-verify')"));
  expect(lintLine(f)).toBe("lint: 4 findings — assertions removed in tests/a.test.ts; test skipped in tests/a.test.ts; test focused (.only) in tests/a.test.ts (+1 more)");
  expect(lintLine([])).toBe("");
});
