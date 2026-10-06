// P4 Task 4.1 (ADR-0018, spec §7): one table, one reconcile for every producer.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { reconcile, reconcileAll, snooze, dismiss, listOpen, type AttentionDraft } from "../src/engine/attention";

const draft = (over: Partial<AttentionDraft> = {}): AttentionDraft => ({
  project: "gold",
  folder: "/home/gold",
  source: "git",
  kind: "unpushed",
  key: "dev",
  title: "dev is 2 commits ahead of origin/dev",
  severity: "normal",
  ...over,
});

test("a new draft opens an item; the same draft again only moves last_seen", () => {
  const l = openLedger(":memory:");
  const a = reconcile(l, "git", "gold", [draft()], 100);
  expect(a.opened).toHaveLength(1);
  expect(a.resolved).toEqual([]);
  const b = reconcile(l, "git", "gold", [draft({ title: "dev is 3 commits ahead of origin/dev" })], 200);
  expect(b).toEqual({ opened: [], resolved: [] });
  const [row] = listOpen(l, { now: 200 });
  expect(row).toMatchObject({ id: a.opened[0], firstSeen: 100, lastSeen: 200, title: "dev is 3 commits ahead of origin/dev", source: "git", kind: "unpushed", key: "dev" });
});

test("a draft that is gone resolves its item; when it comes back the same row reopens", () => {
  const l = openLedger(":memory:");
  const [id] = reconcile(l, "git", "gold", [draft()], 100).opened;
  expect(reconcile(l, "git", "gold", [], 200)).toEqual({ opened: [], resolved: [id!] });
  expect(listOpen(l, { now: 200 })).toEqual([]);
  expect(reconcile(l, "git", "gold", [draft()], 300)).toEqual({ opened: [id!], resolved: [] });
  expect(listOpen(l, { now: 300 })[0]).toMatchObject({ id, firstSeen: 100, lastSeen: 300 });
});

test("'error' (the producer could not read) changes nothing", () => {
  const l = openLedger(":memory:");
  reconcile(l, "github", "gold", [draft({ source: "github", kind: "ci_failed", key: "main" })], 100);
  expect(reconcile(l, "github", "gold", "error", 200)).toEqual({ opened: [], resolved: [] });
  expect(listOpen(l, { now: 200 })).toHaveLength(1);
});

test("two producers for the same project never resolve each other's items", () => {
  const l = openLedger(":memory:");
  reconcile(l, "git", "gold", [draft()], 100);
  reconcile(l, "engine", "gold", [draft({ source: "engine", kind: "thread_failed", key: "m4" })], 100);
  expect(reconcile(l, "engine", "gold", [], 200).resolved).toHaveLength(1);
  expect(listOpen(l, { now: 200 }).map((r) => r.kind)).toEqual(["unpushed"]);
  // Another project's run of the same producer leaves gold alone.
  reconcile(l, "git", "waselni", [], 300);
  expect(listOpen(l, { now: 300 }).map((r) => r.project)).toEqual(["gold"]);
});

test("a snoozed item is hidden until its time; listOpen is severity first, then newest", () => {
  const l = openLedger(":memory:");
  const { opened } = reconcile(l, "engine", "gold", [
    draft({ source: "engine", kind: "thread_waiting", key: "m1", severity: "normal" }),
    draft({ source: "engine", kind: "approval_stuck", key: "a1", severity: "high" }),
    draft({ source: "engine", kind: "decision_stale", key: "d1", severity: "low" }),
  ], 100);
  expect(listOpen(l, { now: 100 }).map((r) => r.severity)).toEqual(["high", "normal", "low"]);
  snooze(l, opened[0]!, 500);
  expect(listOpen(l, { now: 400 }).map((r) => r.key)).toEqual(["a1", "d1"]);
  expect(listOpen(l, { now: 500 }).map((r) => r.key)).toEqual(["a1", "m1", "d1"]);
  expect(listOpen(l, { now: 500, project: "waselni" })).toEqual([]);
});

test("dismiss resolves by the operator: not reopened while the key stays, reopened after it goes and comes back", () => {
  const l = openLedger(":memory:");
  const [id] = reconcile(l, "git", "gold", [draft()], 100).opened;
  dismiss(l, id!, 150);
  expect(listOpen(l, { now: 150 })).toEqual([]);
  expect(reconcile(l, "git", "gold", [draft()], 200)).toEqual({ opened: [], resolved: [] });
  expect(listOpen(l, { now: 200 })).toEqual([]);
  reconcile(l, "git", "gold", [], 300); // the key disappeared
  expect(reconcile(l, "git", "gold", [draft()], 400)).toEqual({ opened: [id!], resolved: [] });
});

test("listOpen is bounded", () => {
  const l = openLedger(":memory:");
  reconcile(l, "git", "gold", Array.from({ length: 150 }, (_, i) => draft({ key: `b${i}` })), 100);
  expect(listOpen(l, { now: 100 })).toHaveLength(100);
  expect(listOpen(l, { now: 100, limit: 5 })).toHaveLength(5);
});

test("reconcileAll: one producer's drafts across projects; a project whose items all went away is resolved too", () => {
  const l = openLedger(":memory:");
  const a = reconcileAll(l, "engine", [draft({ source: "engine", kind: "queue_paused", key: "/home/gold" }), draft({ project: "acme", folder: "/home/acme", source: "engine", kind: "queue_paused", key: "/home/acme" })], 100);
  expect(a.opened).toHaveLength(2);
  const b = reconcileAll(l, "engine", [draft({ source: "engine", kind: "queue_paused", key: "/home/gold" })], 200);
  expect(b).toEqual({ opened: [], resolved: [a.opened[1]!] });
  // Another source's items in the same project are never touched.
  reconcile(l, "git", "acme", [draft({ project: "acme", folder: "/home/acme" })], 200);
  expect(reconcileAll(l, "engine", [], 300).resolved).toEqual([a.opened[0]!]);
  expect(listOpen(l, { now: 300 }).map((r) => r.source)).toEqual(["git"]);
  expect(reconcileAll(l, "engine", "error", 400)).toEqual({ opened: [], resolved: [] });
});
