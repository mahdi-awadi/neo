// The diff lint (plan 2026-11-02 W1.7, ADR-0073): what a run's diff did to the things that verify it.
// Deleted test files, removed assertions, tests skipped or focused, hooks bypassed, type errors
// silenced, and verification-policy files changed are FINDINGS on the result line and the ledger,
// never a deny: TDD is the convention, workers write and edit tests, so the engine names what it
// sees and the operator (and the reviewer, W1.8) judge it. Pure over a unified diff; no git here.

export type LintKind =
  | "test_file_deleted"
  | "assertion_removed"
  | "test_skipped"
  | "test_focused"
  | "hooks_bypassed"
  | "error_silenced"
  | "policy_changed";

export interface LintFinding {
  kind: LintKind;
  /** The new path (or the old one for a deleted file). */
  path: string;
  /** One line of detail: the count, or the offending line, trimmed. */
  detail: string;
}

/** A test file by path: the usual names across the stacks Neo's projects use. */
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|_test\.py$|^test_.*\.py$|(^|\/)test_[^/]*\.py$|_spec\.rb$/;

const ASSERTION = /\b(expect|assert|assertEquals|assertEqual|assertTrue|assertThat|should|t\.Error|t\.Errorf|t\.Fatal|t\.Fatalf|require\.\w+|assert\.\w+)\s*\(/;
const SKIP = /\b(test|it|describe|suite)\.skip\s*\(|\bx(it|test|describe)\s*\(|\btest\.todo\s*\(|@pytest\.mark\.skip|\bt\.Skip\w*\s*\(|\bunittest\.skip/;
const ONLY = /\b(test|it|describe|suite)\.only\s*\(|\bf(it|test|describe)\s*\(/;
const NO_VERIFY = /--no-verify\b|\bSKIP_HOOKS\b|\bHUSKY=0\b/;
const SILENCED = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|#\s*noqa\b|#\s*type:\s*ignore|\/\/\s*nolint\b/;

const MAX_DIFF_CHARS = 2_000_000;

interface FileDiff {
  oldPath: string;
  newPath: string;
  deleted: boolean;
  removed: string[];
  added: string[];
}

/** Split a unified diff into files (`diff --git`, `---`, `+++` headers). Paths lose their a/ b/ prefixes. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  const text = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { oldPath: "", newPath: "", deleted: false, removed: [], added: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("--- ")) { cur.oldPath = strip(line.slice(4)); continue; }
    if (line.startsWith("+++ ")) { cur.newPath = strip(line.slice(4)); cur.deleted = cur.newPath === ""; continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) cur.added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) cur.removed.push(line.slice(1));
  }
  return files;
}

function strip(p: string): string {
  const t = p.trim().split("\t")[0]!;
  if (t === "/dev/null") return "";
  return t.replace(/^[ab]\//, "");
}

/** Lint a unified diff. `policyFiles`: the repo-relative files of the frozen verification policy. */
export function lintDiff(diff: string, policyFiles: readonly string[] = []): LintFinding[] {
  const out: LintFinding[] = [];
  const policy = new Set(policyFiles);
  for (const f of parseDiff(diff)) {
    const path = f.newPath || f.oldPath;
    const isTest = TEST_PATH.test(f.oldPath) || TEST_PATH.test(f.newPath);

    if (f.deleted && TEST_PATH.test(f.oldPath)) {
      out.push({ kind: "test_file_deleted", path: f.oldPath, detail: `${f.removed.length} lines` });
      continue; // its assertions are gone with it; one finding says so
    }

    if (isTest) {
      // Assertions that left the file and did not come back in any form (a moved or edited
      // assertion is not a removal: the added side carries one too).
      const removedAsserts = f.removed.filter((l) => ASSERTION.test(l)).length;
      const addedAsserts = f.added.filter((l) => ASSERTION.test(l)).length;
      if (removedAsserts > addedAsserts) out.push({ kind: "assertion_removed", path, detail: `${removedAsserts - addedAsserts} fewer assertion${removedAsserts - addedAsserts === 1 ? "" : "s"}` });
      const skipped = f.added.find((l) => SKIP.test(l));
      if (skipped) out.push({ kind: "test_skipped", path, detail: skipped.trim().slice(0, 120) });
      const only = f.added.find((l) => ONLY.test(l));
      if (only) out.push({ kind: "test_focused", path, detail: only.trim().slice(0, 120) });
    }

    const noVerify = f.added.find((l) => NO_VERIFY.test(l));
    if (noVerify) out.push({ kind: "hooks_bypassed", path, detail: noVerify.trim().slice(0, 120) });

    if (!isTest) {
      const silenced = f.added.filter((l) => SILENCED.test(l));
      if (silenced.length) out.push({ kind: "error_silenced", path, detail: silenced[0]!.trim().slice(0, 120) + (silenced.length > 1 ? ` (+${silenced.length - 1})` : "") });
    }

    if (policy.has(path) || policy.has(f.oldPath)) out.push({ kind: "policy_changed", path, detail: "a verification policy file changed in this run" });
  }
  return out;
}

const LABEL: Record<LintKind, string> = {
  test_file_deleted: "test file deleted",
  assertion_removed: "assertions removed",
  test_skipped: "test skipped",
  test_focused: "test focused (.only)",
  hooks_bypassed: "hooks bypassed",
  error_silenced: "error silenced",
  policy_changed: "policy file changed",
};

/** One line for a result: `lint: 2 findings — assertions removed in tests/a.test.ts; test skipped in tests/b.test.ts`. */
export function lintLine(findings: readonly LintFinding[], max = 3): string {
  if (findings.length === 0) return "";
  const parts = findings.slice(0, max).map((f) => `${LABEL[f.kind]} in ${f.path}`);
  const more = findings.length > max ? ` (+${findings.length - max} more)` : "";
  return `lint: ${findings.length} finding${findings.length === 1 ? "" : "s"} — ${parts.join("; ")}${more}`;
}
