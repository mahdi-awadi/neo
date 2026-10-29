// ADR-0065: "needs you" is classed by kind in code (unknown kinds fail closed to needs-you), and one read
// model — needsYou() — joins the operator-owned waiting work, failed todos, needs-you attention items and
// the operator's pins. The badge, its count and the pinned strip all read it.
import { test, expect } from "bun:test";
import { openLedger, type AttentionDraft } from "../src/engine/ledger";
import { DEFAULT_KEEP_PATTERNS } from "../src/engine/decision-settle";
import { GITHUB_KINDS } from "../src/engine/producers/github";
import { GIT_KINDS } from "../src/engine/producers/git";
import { ENGINE_KINDS } from "../src/engine/producers/engine";
import { RESTART_KINDS } from "../src/engine/producers/restart";
import { SKILLIFY_KINDS } from "../src/engine/producers/skillify";
import { attentionClass, CLASSED_KINDS, needsYou, pin } from "../src/engine/needs-you";
import { reconcile } from "../src/engine/attention";

const KEEP = DEFAULT_KEEP_PATTERNS;
const NOTE_KINDS = ["note_fyi", "note_finding", "note_request", "note_question"];

function item(over: Partial<AttentionDraft> & Pick<AttentionDraft, "kind" | "key">): AttentionDraft {
  return { project: "p", folder: "/home/p", source: "git", title: `${over.kind} ${over.key}`, severity: "high", ...over };
}

test("every kind a producer raises is classed in the table (a new kind must be classed)", () => {
  for (const k of [...GITHUB_KINDS, ...GIT_KINDS, ...ENGINE_KINDS, ...RESTART_KINDS, ...SKILLIFY_KINDS, ...NOTE_KINDS]) {
    expect(CLASSED_KINDS.has(k)).toBe(true);
  }
});

test("the class is the kind's, never the producer's severity; an unknown kind fails closed to needs-you", () => {
  for (const k of ["note_fyi", "note_finding", "note_request", "dirty", "ci_failed", "pr_open", "stale_branch", "restart_gated", "thread_waiting"]) {
    expect(attentionClass(k)).toBe("housekeeping");
  }
  for (const k of ["thread_failed", "approval_stuck", "queue_paused", "secret_scanning", "code_scanning", "note_question", "decision_stale"]) {
    expect(attentionClass(k)).toBe("needs_you");
  }
  expect(attentionClass("something_new")).toBe("needs_you");
});

test("the live mix (notes, dirty, ci_failed, PRs, stale branches, merge-waiting) needs nothing from the operator", () => {
  const led = openLedger(":memory:");
  led.insertAttention(item({ source: "note", kind: "note_fyi", key: "n1" }), 1);
  led.insertAttention(item({ kind: "dirty", key: "todo:903" }), 1);
  led.insertAttention(item({ source: "github", kind: "ci_failed", key: "main:ci" }), 1);
  led.insertAttention(item({ source: "github", kind: "pr_open", key: "31", severity: "normal" }), 1);
  led.insertAttention(item({ kind: "stale_branch", key: "feat/x", severity: "normal" }), 1);
  led.insertAttention(item({ source: "restart", kind: "restart_gated", key: "merge:chore/agent-sdk-0.3.312", severity: "normal" }), 1);
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 10)).toEqual([]);
});

test("a plan card, a decision, an alert, a failed todo and an unknown-kind item each need the operator", () => {
  const led = openLedger(":memory:");
  const card = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/p.md — P", folder: "/home/p", project: "p" }, 1);
  const plan = led.upsertPlan({ project: "p", folder: "/home/p", path: "docs/p.md", title: "P", sha256: "x", stepsTotal: 1, stepsDone: 0, status: "sent", gate: "approval", decisionId: card } as never);
  const dec = led.openDecision({ kind: "decision", question: "Which bank?", folder: "/home/q", project: "q" }, 2);
  const alert = led.openDecision({ kind: "alert", question: "Disk 95% full", project: "ops" }, 3);
  const t = led.addTodo({ project: "p", folder: "/home/p", brief: "Fix the wallet refund", workClass: "interactive", createdBy: "operator" }, 4);
  led.updateTodo(t.id, { status: "failed", endedAt: 5 });
  const att = led.insertAttention(item({ kind: "brand_new_kind", key: "k", title: "something new" }), 6);
  const got = needsYou({ ledger: led, keepPatterns: KEEP }, 10);
  expect(got.map((i) => [i.ref, i.kind, i.action])).toEqual([
    [`dec:${card}`, "plan", "approve"],
    [`dec:${dec}`, "decision", "answer"],
    [`dec:${alert}`, "alert", "acknowledge"],
    [`todo:${t.id}`, "todo", "retry"],
    [`att:${att}`, "attention", "open"],
  ]);
  expect(got[0]).toMatchObject({ project: "p", plan: { id: plan.id, version: plan.version }, why: "Plan waiting for your approval: docs/p.md — P" });
  expect(got[3]).toMatchObject({ project: "p", why: "Fix the wallet refund", todoId: t.id });
  expect(got.every((i) => i.pinned === false)).toBe(true);
});

test("a pin adds any open item; an unpin hides a needs-you item; clearing restores the default", () => {
  const led = openLedger(":memory:");
  const pr = led.insertAttention(item({ source: "github", kind: "pr_open", key: "31", severity: "normal", title: "PR #31: add refunds" }), 1);
  const failed = led.insertAttention(item({ source: "engine", kind: "thread_failed", key: "t9" }), 1);
  expect(pin(led, `att:${pr}`, "pinned", 2)).toMatchObject({ ok: true });
  expect(pin(led, `att:${failed}`, "unpinned", 3)).toMatchObject({ ok: true });
  let got = needsYou({ ledger: led, keepPatterns: KEEP }, 10);
  expect(got.map((i) => [i.ref, i.pinned])).toEqual([[`att:${pr}`, true]]);
  expect(pin(led, `att:${failed}`, null, 4)).toMatchObject({ ok: true });
  got = needsYou({ ledger: led, keepPatterns: KEEP }, 10);
  expect(got.map((i) => i.ref).sort()).toEqual([`att:${failed}`, `att:${pr}`].sort());
});

test("a pin on a resolved, unknown or malformed target is refused with a reason; a pinned item that resolves leaves", () => {
  const led = openLedger(":memory:");
  const a = led.insertAttention(item({ kind: "stale_branch", key: "feat/x" }), 1);
  led.updateAttention(a, { resolvedAt: 2 });
  expect(pin(led, `att:${a}`, "pinned", 3)).toMatchObject({ ok: false });
  expect(pin(led, "att:999", "pinned", 3)).toMatchObject({ ok: false });
  expect(pin(led, "todo:abc", "pinned", 3)).toMatchObject({ ok: false });
  expect(pin(led, "rm -rf", "pinned", 3)).toMatchObject({ ok: false });
  const b = led.insertAttention(item({ kind: "stale_branch", key: "feat/y" }), 1);
  pin(led, `att:${b}`, "pinned", 4);
  led.updateAttention(b, { resolvedAt: 5 });
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 10)).toEqual([]);
});

test("a pinned todo shows while it is active; a done one leaves; a retried failed todo leaves", () => {
  const led = openLedger(":memory:");
  const q = led.addTodo({ project: "p", folder: "/home/p", brief: "Write the docs", workClass: "interactive", createdBy: "operator" }, 1);
  pin(led, `todo:${q.id}`, "pinned", 2);
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 10).map((i) => [i.ref, i.action])).toEqual([[`todo:${q.id}`, "open"]]);
  led.updateTodo(q.id, { status: "done", endedAt: 3 });
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 10)).toEqual([]);
  const f = led.addTodo({ project: "p", folder: "/home/p", brief: "x", workClass: "interactive", createdBy: "operator" }, 4);
  led.updateTodo(f.id, { status: "failed", endedAt: 5 });
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 10)).toHaveLength(1);
  led.updateTodo(f.id, { status: "queued" });
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 10)).toEqual([]);
});

test("a snoozed needs-you item is off the list until its snooze ends", () => {
  const led = openLedger(":memory:");
  const a = led.insertAttention(item({ source: "engine", kind: "thread_failed", key: "t1" }), 1);
  led.updateAttention(a, { snoozedUntil: 100 });
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 50)).toEqual([]);
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 150)).toHaveLength(1);
});

// Review finding 1: a hide applies to the occurrence it was made on — a todo that fails again, or an item
// that resolves and comes back, returns to the list.
test("a hidden failed todo comes back when it fails again", () => {
  const led = openLedger(":memory:");
  const t = led.addTodo({ project: "p", folder: "/home/p", brief: "x", workClass: "interactive", createdBy: "operator" }, 1);
  led.updateTodo(t.id, { status: "failed", endedAt: 5 });
  pin(led, `todo:${t.id}`, "unpinned", 10);
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 11)).toEqual([]);
  led.updateTodo(t.id, { status: "failed", endedAt: 20 }); // retried, failed again
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 21).map((i) => i.ref)).toEqual([`todo:${t.id}`]);
});

test("a hidden needs-you item that resolves and comes back is on the list again", () => {
  const led = openLedger(":memory:");
  const draft = item({ source: "engine", kind: "thread_failed", key: "t1" });
  const [id] = reconcile(led, "engine", "p", [draft], 1).opened;
  pin(led, `att:${id}`, "unpinned", 2);
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 3)).toEqual([]);
  reconcile(led, "engine", "p", [], 4); // gone
  reconcile(led, "engine", "p", [draft], 5); // back: a new occurrence
  expect(needsYou({ ledger: led, keepPatterns: KEEP }, 6).map((i) => i.ref)).toEqual([`att:${id}`]);
});
