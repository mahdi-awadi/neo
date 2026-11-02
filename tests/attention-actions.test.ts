// P4 Task 4.6 (ADR-0018, spec §7): /attention, the one-tap actions and the per-kind brief templates.
import { test, expect } from "bun:test";
import { basename } from "node:path";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { reconcile, listOpen, type AttentionDraft } from "../src/engine/attention";
import { applyAttentionAction, renderAttention } from "../src/engine/attention-actions";
import { ATTENTION_BRIEFS, attentionBrief } from "../src/engine/attention-briefs";
import { ENGINE_KINDS } from "../src/engine/producers/engine";
import { RESTART_KINDS } from "../src/engine/producers/restart";
import { SKILLIFY_KINDS } from "../src/engine/producers/skillify";
import { GITHUB_KINDS } from "../src/engine/producers/github";
import { GIT_KINDS } from "../src/engine/producers/git";
import { DIRTY_KINDS } from "../src/engine/todo-queue";
import type { TodoQueue } from "../src/engine/todo-queue";
import { handleCommand } from "../src/engine/commands";
import { openTrustStore } from "../src/engine/trust";

const H = 3_600_000;
const draft = (over: Partial<AttentionDraft> = {}): AttentionDraft => ({
  project: "gold", folder: "/home/gold", source: "engine", kind: "queue_paused", key: "/home/gold", title: "todo queue paused 7h: #3 failed", severity: "normal", ...over,
});

function fakeQueue(ledger: Ledger, refuse = false) {
  const submitted: string[] = [];
  const q = {
    launcher: () => ({ deps: {} as never, replyChat: 1 }),
    submit: async (p: { project: string; brief: string; workClass: "interactive"; cause?: { msgId: number; threadId: number } }) => {
      submitted.push(p.brief);
      if (refuse) return "held: the interactive reserve";
      const t = ledger.addTodo({ project: basename(p.project), folder: p.project, brief: p.brief, workClass: p.workClass, createdBy: "operator", cause: p.cause }, 1000);
      return `queued #${t.id}`;
    },
    retry: (id: number) => {
      ledger.updateTodo(id, { status: "queued", attempts: 0 });
      return `↻ #${id} re-queued`;
    },
  } as unknown as TodoQueue;
  return { q, submitted };
}

function rig(refuse = false) {
  const ledger = openLedger(":memory:");
  const trace = createTrace({ ledger, registry: createRegistry() });
  const { q, submitted } = fakeQueue(ledger, refuse);
  return { ledger, trace, submitted, deps: { ledger, todo: q, trace, snoozeMs: 24 * H } };
}

test("every kind a producer raises has a brief template (facts, link, done-when)", () => {
  // ADR-0059: every kind a producer raises has a brief — GitHub and git too, so → todo never answers
  // "no brief template".
  for (const kind of [...ENGINE_KINDS, ...RESTART_KINDS, ...DIRTY_KINDS, ...SKILLIFY_KINDS, ...GITHUB_KINDS, ...GIT_KINDS]) expect(ATTENTION_BRIEFS[kind]).toBeDefined();
  const b = attentionBrief({ kind: "dirty", title: "3 uncommitted files after todo #4", detail: "files: a.ts", url: "https://x", project: "gold" })!;
  expect(b).toContain("3 uncommitted files after todo #4");
  expect(b).toContain("Facts: files: a.ts");
  expect(b).toContain("Link: https://x");
  expect(b).toContain("Done when:");
});

test("→ todo queues the brief once in its own attention thread; a second tap shows the todo", async () => {
  const r = rig();
  const [id] = reconcile(r.ledger, "engine", "gold", [draft()], 100).opened;
  const a = await applyAttentionAction(r.deps, id!, "todo", 200);
  expect(a.ok).toBe(true);
  const row = r.ledger.attentionById(id!)!;
  expect(a.text).toBe(`queued as todo #${row.todoId}`);
  const todo = r.ledger.todoById(row.todoId!)!;
  expect(todo).toMatchObject({ folder: "/home/gold", createdBy: "operator", workClass: "interactive" });
  expect(r.ledger.threadById(todo.cause!.threadId)).toMatchObject({ origin: "attention" });
  const b = await applyAttentionAction(r.deps, id!, "todo", 300);
  expect(b.text).toContain(`already todo #${row.todoId}`);
  expect(r.submitted).toHaveLength(1);
});

test("→ todo that the queue refuses links nothing; snooze hides the item for a day; dismiss closes it", async () => {
  const r = rig(true);
  const [id] = reconcile(r.ledger, "engine", "gold", [draft()], 100).opened;
  expect(await applyAttentionAction(r.deps, id!, "todo", 200)).toEqual({ ok: false, text: "held: the interactive reserve" });
  expect(r.ledger.attentionById(id!)!.todoId).toBeUndefined();
  await applyAttentionAction(r.deps, id!, "snooze", 1000);
  expect(listOpen(r.ledger, { now: 1000 + 23 * H })).toEqual([]);
  expect(listOpen(r.ledger, { now: 1000 + 25 * H }).map((x) => x.id)).toEqual([id!]);
  expect((await applyAttentionAction(r.deps, id!, "dismiss", 2000)).ok).toBe(true);
  expect((await applyAttentionAction(r.deps, id!, "snooze", 3000)).text).toContain("already resolved");
  expect((await applyAttentionAction(r.deps, 999, "dismiss", 3000)).ok).toBe(false);
});

test("renderAttention: grouped by project, severity first, bounded lines, buttons for the first items, console link", () => {
  const l = openLedger(":memory:");
  reconcile(l, "engine", "gold", [draft({ key: "a", title: "gold normal" }), draft({ key: "b", kind: "approval_stuck", title: "gold high", severity: "high" })], 100);
  reconcile(l, "engine", "acme", [draft({ project: "acme", folder: "/home/acme", key: "c", title: "acme normal" })], 100);
  const r = renderAttention(l, { now: 200, maxLines: 30, maxButtons: 2, consoleUrl: "https://neo.example/" });
  // ADR-0059: each line is [badge] plain title.
  expect(r.text.split("\n")).toEqual(["⚠ attention: 3 open", "gold:", "  🔴 #2 [Stuck approval] gold high", "  🟡 #1 [Paused queue] gold normal", "acme:", "  🟡 #3 [Paused queue] acme normal", "https://neo.example/"]);
  expect(r.buttons.map((b) => b.id)).toEqual([2, 1]);
  const short = renderAttention(l, { now: 200, maxLines: 3, maxButtons: 10 });
  expect(short.text.split("\n")).toEqual(["⚠ attention: 3 open", "gold:", "  🔴 #2 [Stuck approval] gold high", "… +2 more"]);
  expect(renderAttention(l, { project: "zzz", now: 200, maxLines: 30, maxButtons: 10 }).text).toBe("✓ nothing needs attention in zzz");
});

test("/attention [project] answers with the list and its one-tap items", () => {
  const ledger = openLedger(":memory:");
  reconcile(ledger, "engine", "gold", [draft()], 100);
  const deps = { registry: createRegistry(), ledger, trust: openTrustStore(":memory:"), now: () => 200 };
  const r = handleCommand("/attention gold", 1, deps)!;
  expect(r.text).toContain("#1 [Paused queue] #3 failed"); // ADR-0059: badge + plain title (the pause reason)
  expect(r.attention?.map((a) => [a.id, a.actions])).toEqual([[1, ["todo", "snooze", "dismiss"]]]);
  expect(handleCommand("/attention", 1, deps)!.text).toContain("gold:");
});

test("an item that comes back can be queued again; a failed todo can be retried; a live one is not doubled", async () => {
  const r = rig();
  const [id] = reconcile(r.ledger, "engine", "gold", [draft()], 100).opened;
  await applyAttentionAction(r.deps, id!, "todo", 200);
  const first = r.ledger.attentionById(id!)!.todoId!;
  expect((await applyAttentionAction(r.deps, id!, "todo", 250)).text).toContain(`already todo #${first} (queued)`);
  r.ledger.updateTodo(first, { status: "failed", endedAt: 300 });
  // ADR-0027: a failed linked todo is re-run as the SAME row, never copied
  expect((await applyAttentionAction(r.deps, id!, "todo", 310)).text).toBe(`↻ #${first} re-queued`);
  const second = r.ledger.attentionById(id!)!.todoId!;
  expect(second).toBe(first);
  expect(r.ledger.todoById(first)?.status).toBe("queued");
  r.ledger.updateTodo(second, { status: "done", endedAt: 400 });
  reconcile(r.ledger, "engine", "gold", [], 500); // resolved
  reconcile(r.ledger, "engine", "gold", [draft()], 600); // back: the same row reopens, its old todo is not its todo
  expect(r.ledger.attentionById(id!)!.todoId).toBeUndefined();
  expect((await applyAttentionAction(r.deps, id!, "todo", 700)).ok).toBe(true);
  expect(r.submitted).toHaveLength(2); // the retry re-used the row: two briefs, not three
});

test("a → todo whose queue throws answers with the failure, never throws", async () => {
  const r = rig();
  const [id] = reconcile(r.ledger, "engine", "gold", [draft()], 100).opened;
  const broken = { ...r.deps, todo: { launcher: () => ({ deps: {} as never, replyChat: 1 }), submit: async () => { throw new Error("ledger is locked"); } } as unknown as TodoQueue };
  const a = await applyAttentionAction(broken, id!, "todo", 200);
  expect(a.ok).toBe(false);
  expect(a.text).toContain("ledger is locked");
});

test("renderAttention keeps every item to one bounded line (a multi-line, long title never breaks the list)", () => {
  const l = openLedger(":memory:");
  reconcile(l, "engine", "gold", [draft({ kind: "decision_stale", key: "d1", title: `decision open 2d: ${"x".repeat(500)}\nsecond line\nthird` })], 100);
  const lines = renderAttention(l, { now: 200, maxLines: 30, maxButtons: 10 }).text.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[2]!.length).toBeLessThan(160);
});

test("a double tap where the todo is done at once (delivered into an open session) still makes one todo", async () => {
  const r = rig();
  const [id] = reconcile(r.ledger, "engine", "gold", [draft()], 100).opened;
  await applyAttentionAction(r.deps, id!, "todo", 200);
  r.ledger.updateTodo(r.ledger.attentionById(id!)!.todoId!, { status: "done", endedAt: 201 });
  expect((await applyAttentionAction(r.deps, id!, "todo", 202)).text).toContain("(done)");
  expect(r.submitted).toHaveLength(1);
});


test("ADR-0059: a brief is filled from the item's facts; an old row's facts come from its key and title", () => {
  const stored = attentionBrief({ kind: "stale_branch", key: "feat/x", title: "t", project: "adminli", facts: { branch: "feat/x", days: 26, base: "main" } })!;
  expect(stored).toContain("Branch feat/x has had no commit for 26 days and is not merged into main.");
  expect(stored).not.toContain("?");
  // The live row #321 had no facts: they come from its title.
  const old = attentionBrief({ kind: "stale_branch", key: "feat/multi-project-ui", title: "feat/multi-project-ui: no commit for 26 days, not merged into main", project: "adminli" })!;
  expect(old).toContain("Branch feat/multi-project-ui has had no commit for 26 days and is not merged into main.");
  const pr = attentionBrief({ kind: "pr_open", key: "31", title: "PR #31: chore(deps)(deps): bump expo-localization from 57.0.1 to 58.0.5", project: "adminli", url: "https://github.com/x/y/pull/31" })!;
  expect(pr).toContain("Review PR #31");
  expect(pr).toContain("merge it when CI is green");
  expect(pr).toContain("Link: https://github.com/x/y/pull/31");
  // A fact the item lacks reads "?" rather than a raw placeholder.
  expect(attentionBrief({ kind: "unpushed", key: "b", title: "weird", project: "p" })!).not.toContain("{");
});
test("ADR-0059: → todo on a PR or a stale branch queues its brief (before: \"no brief template\")", async () => {
  const r = rig();
  const [pr, branch] = reconcile(r.ledger, "github", "adminli", [
    draft({ project: "adminli", folder: "/home/adminli", source: "github", kind: "pr_open", key: "31", title: "PR #31: chore(deps)(deps): bump expo-localization from 57.0.1 to 58.0.5", url: "https://github.com/x/adminli/pull/31", facts: { pr: 31, prTitle: "chore(deps)(deps): bump expo-localization from 57.0.1 to 58.0.5", draft: 0 } }),
    draft({ project: "adminli", folder: "/home/adminli", source: "github", kind: "stale_branch", key: "feat/multi-project-ui", title: "feat/multi-project-ui: no commit for 26 days, not merged into main" }),
  ], 100).opened;
  for (const id of [pr!, branch!]) expect((await applyAttentionAction(r.deps, id, "todo", 200)).ok).toBe(true);
  expect(r.submitted[0]).toContain("Review PR #31");
  expect(r.submitted[1]).toContain("Branch feat/multi-project-ui has had no commit for 26 days");
});

test("ADR-0059: Telegram's /attention line is [badge] plain title, from the EN catalogue", () => {
  const r = rig();
  reconcile(r.ledger, "git", "adminli", [draft({ project: "adminli", folder: "/home/adminli", source: "git", kind: "stale_branch", key: "feat/x", title: "feat/x: no commit for 26 days, not merged into main" })], 100);
  reconcile(r.ledger, "github", "adminli", [draft({ project: "adminli", folder: "/home/adminli", source: "github", kind: "pr_open", key: "31", title: "PR #31: chore(deps)(deps): bump next from 15.5.15 to 16.4.3" })], 100);
  const { text } = renderAttention(r.ledger, { now: 200, maxLines: 20, maxButtons: 5 });
  expect(text).toContain("[Stale branch] feat/x");
  expect(text).toContain("[Dependency update PR] next 15.5.15 → 16.4.3");
  expect(text).not.toContain("(deps)(deps)");
});
