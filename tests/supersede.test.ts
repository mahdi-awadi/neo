// ADR-0065: an open item made pointless by a newer one of the same kind and stem in the same project is
// resolved by the engine (dismissed, so it stays closed while still seen), with the reason recorded. No
// branch or PR is touched.
import { test, expect } from "bun:test";
import { openLedger, type AttentionDraft } from "../src/engine/ledger";
import { reconcile } from "../src/engine/attention";
import { compareVersions, stemOf, supersededBy } from "../src/engine/supersede";

const merge = (branch: string): AttentionDraft => ({
  project: "neo",
  folder: "/home/neo",
  source: "restart",
  kind: "restart_gated",
  key: `merge:${branch}`,
  title: `waiting to merge: ${branch} — chore(deps): pin`,
  severity: "normal",
  facts: { branch },
});

test("stem and version: a trailing version is split off; a name without one has none", () => {
  expect(stemOf("merge:chore/agent-sdk-0.3.312")).toEqual({ stem: "merge:chore/agent-sdk", version: [0, 3, 312] });
  expect(stemOf("dependabot/npm/expo-v58.0.5")).toEqual({ stem: "dependabot/npm/expo", version: [58, 0, 5] });
  expect(stemOf("feat/multi-project-ui")).toBeUndefined();
  expect(stemOf("release-2")).toEqual({ stem: "release", version: [2] });
  expect(compareVersions([0, 3, 10], [0, 3, 9])).toBeGreaterThan(0);
  expect(compareVersions([1, 0], [1, 0, 0])).toBe(0);
});

test("the agent-sdk series: only the newest stays open; each older one names it as the reason", () => {
  const led = openLedger(":memory:");
  const branches = ["chore/agent-sdk-0.3.303", "chore/agent-sdk-0.3.304", "chore/agent-sdk-0.3.306", "chore/agent-sdk-0.3.308", "chore/agent-sdk-0.3.312"];
  reconcile(led, "restart", "neo", branches.map(merge), 100);
  const rows = led.attentionRows("neo", "restart");
  const newest = rows.find((r) => r.key === "merge:chore/agent-sdk-0.3.312")!;
  expect(rows.filter((r) => r.resolvedAt === undefined).map((r) => r.key)).toEqual(["merge:chore/agent-sdk-0.3.312"]);
  for (const r of rows.filter((x) => x.id !== newest.id)) {
    expect(r.dismissed).toBe(true);
    expect(JSON.parse(r.resolution!)).toEqual({ how: "superseded", by: newest.id, key: newest.key, reason: `superseded by #${newest.id} (chore/agent-sdk-0.3.312)`, at: 100 });
  }
  // The next scan still sees the old branches: they stay closed, and nothing reopens.
  reconcile(led, "restart", "neo", branches.map(merge), 200);
  expect(led.attentionRows("neo", "restart").filter((r) => r.resolvedAt === undefined)).toHaveLength(1);
});

test("0.3.10 beats 0.3.9; a single item, a non-versioned branch and another project are untouched", () => {
  const led = openLedger(":memory:");
  reconcile(led, "restart", "neo", [merge("chore/x-0.3.9"), merge("chore/x-0.3.10"), merge("feat/lonely-1.2"), merge("feat/plain")], 100);
  reconcile(led, "restart", "gold", [{ ...merge("chore/x-0.3.8"), project: "gold", folder: "/home/gold" }], 100);
  const open = (p: string) => led.attentionRows(p, "restart").filter((r) => r.resolvedAt === undefined).map((r) => r.key).sort();
  expect(open("neo")).toEqual(["merge:chore/x-0.3.10", "merge:feat/lonely-1.2", "merge:feat/plain"]);
  expect(open("gold")).toEqual(["merge:chore/x-0.3.8"]);
});

test("supersededBy is pure: only open rows of the same project and kind count; an operator-dismissed newer one does not", () => {
  const row = (id: number, key: string, over: Record<string, unknown> = {}) =>
    ({ id, project: "p", folder: "/p", source: "git", kind: "stale_branch", key, title: key, severity: "normal", firstSeen: 1, lastSeen: 1, dismissed: false, ...over }) as never;
  expect(supersededBy([row(1, "chore/expo-57.0.1"), row(2, "chore/expo-58.0.5")])).toEqual([{ id: 1, by: 2 }]);
  expect(supersededBy([row(1, "chore/expo-57.0.1"), row(2, "chore/expo-58.0.5", { resolvedAt: 5, dismissed: true })])).toEqual([]);
  expect(supersededBy([row(1, "chore/expo-57.0.1"), row(2, "chore/expo-58.0.5", { kind: "unpushed" })])).toEqual([]);
  // An id-keyed kind is never superseded, whatever its key looks like.
  expect(supersededBy([row(1, "todo:901", { kind: "dirty" }), row(2, "todo:903", { kind: "dirty" })])).toEqual([]);
});

test("a series of dependency PRs for one package: the older target version is superseded", () => {
  const pr = (id: number, n: number, title: string) =>
    ({ id, project: "p", folder: "/p", source: "github", kind: "pr_open", key: String(n), title: `PR #${n}: ${title}`, severity: "normal", firstSeen: 1, lastSeen: 1, dismissed: false, facts: { pr: n, prTitle: title } }) as never;
  expect(supersededBy([pr(1, 30, "chore(deps): bump expo-localization from 57.0.1 to 58.0.4"), pr(2, 31, "chore(deps): bump expo-localization from 57.0.1 to 58.0.5"), pr(3, 32, "feat: refunds")])).toEqual([{ id: 1, by: 2 }]);
});
