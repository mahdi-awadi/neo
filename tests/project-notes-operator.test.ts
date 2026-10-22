// Project notes on the operator's side (ADR-0043, AC13–AC17): the → todo brief and its cause, a
// note resolved by the todo made from it, the attention lines, and the trace chain.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { applyAttentionAction, renderAttention, renderDigest } from "../src/engine/attention-actions";
import { ATTENTION_BRIEFS, attentionBrief } from "../src/engine/attention-briefs";
import { createProjectNotes, DEFAULT_NOTES_CFG, NOTE_KINDS, noteAttentionKind } from "../src/engine/project-notes";
import type { TodoQueue } from "../src/engine/todo-queue";

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim();

function rig() {
  const root = mkdtempSync(join(tmpdir(), "neo-notes-op-"));
  for (const p of ["prod-ops", "eticket-v3"]) mkdirSync(join(root, p));
  const ledger = openLedger(":memory:");
  const trace = createTrace({ ledger, registry: createRegistry() });
  const notes = createProjectNotes({ ledger, cfg: DEFAULT_NOTES_CFG, workRoot: root, desksDir: join(root, "none"), trace });
  const submitted: Array<{ brief: string; cause?: { msgId: number; threadId: number } }> = [];
  const q = {
    launcher: () => ({ deps: {} as never, replyChat: 1 }),
    submit: async (p: { project: string; brief: string; workClass: "interactive"; cause?: { msgId: number; threadId: number } }) => {
      submitted.push({ brief: p.brief, cause: p.cause });
      const t = ledger.addTodo({ project: basename(p.project), folder: p.project, brief: p.brief, workClass: p.workClass, createdBy: "operator", cause: p.cause }, 1000);
      return `queued #${t.id}`;
    },
  } as unknown as TodoQueue;
  return { root, ledger, trace, notes, submitted, deps: { ledger, todo: q, trace, snoozeMs: 3_600_000 } };
}

const send = (r: ReturnType<typeof rig>, over: Record<string, unknown> = {}, cause?: { msgId: number; threadId: number }) =>
  r.notes.send(
    { project: "prod-ops", folder: join(r.root, "prod-ops"), chatId: 7, cause },
    { to: "eticket-v3", kind: "finding", severity: "high", ref: "D16", title: "stale pnr", body: "the facts", refs: ["docs/d16.md"], ...over } as never,
    1_000,
  ).id!;

// AC14 (3.1)
test("every note kind has a brief template, and the brief carries sender, facts, refs and how to resolve", () => {
  for (const k of NOTE_KINDS) expect(ATTENTION_BRIEFS[noteAttentionKind(k)]).toBeDefined();
  const r = rig();
  const id = send(r);
  const b = attentionBrief(r.ledger.attentionById(id)!)!;
  expect(b).toContain("prod-ops");
  expect(b).toContain("stale pnr");
  expect(b).toContain("Facts: the facts");
  expect(b).toContain("Refs: docs/d16.md");
  expect(b).toContain(`project_notes resolve`);
  expect(b).toContain(`id=${id}`);
  expect(b).not.toContain('{"body"'); // never the raw JSON
});

// AC14, AC17 (3.2)
test("→ todo on a note joins the sender's thread; /trace on it shows the note and the todo", async () => {
  const r = rig();
  const cause = r.trace.inbound({ chatId: 7, text: "check prod for booking failures", surface: "telegram" });
  const id = send(r, {}, cause);
  const a = await applyAttentionAction(r.deps, id, "todo", 2_000);
  expect(a.ok).toBe(true);
  expect(r.submitted[0]!.cause).toEqual(cause);
  const tree = r.trace.tree(cause.msgId);
  expect(JSON.stringify(tree)).toContain(`note #${id} → eticket-v3: stale pnr`);
  expect(tree.todos.map((t) => t.id)).toContain(r.ledger.attentionById(id)!.todoId!);
});

test("→ todo on a note with no cause roots its own attention thread, as before", async () => {
  const r = rig();
  const id = send(r);
  await applyAttentionAction(r.deps, id, "todo", 2_000);
  expect(r.ledger.threadById(r.submitted[0]!.cause!.threadId)).toMatchObject({ origin: "attention" });
});

// AC15 (3.3)
test("a todo made from a note that ends done resolves it fixed at the target's HEAD; a failed one leaves it open", async () => {
  const r = rig();
  const dir = join(r.root, "eticket-v3");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "fix");
  const head = git(dir, "rev-parse", "HEAD");
  const id = send(r);
  const other = send(r, { ref: "D17", title: "other" });
  await applyAttentionAction(r.deps, id, "todo", 2_000);
  await applyAttentionAction(r.deps, other, "todo", 2_000);
  const todo = r.ledger.todoById(r.ledger.attentionById(id)!.todoId!)!;
  const todo2 = r.ledger.todoById(r.ledger.attentionById(other)!.todoId!)!;
  await r.notes.onTodoEnd({ ...todo, status: "done" }, 3_000);
  await r.notes.onTodoEnd({ ...todo2, status: "failed" }, 3_000);
  expect(JSON.parse(r.ledger.attentionById(id)!.resolution!)).toMatchObject({ how: "fixed", todo: todo.id, commit: head });
  expect(r.ledger.attentionById(other)!.resolvedAt).toBeUndefined();
  expect(r.notes.list("prod-ops", { box: "from" }, 4_000).find((n) => n.id === id)?.state).toBe("fixed");
});

// AC13 (3.5)
test("attention lines name the sender of a note", () => {
  const r = rig();
  const id = send(r);
  expect(renderAttention(r.ledger, { now: 2_000, maxLines: 30, maxButtons: 5 }).text).toContain(`#${id} stale pnr — from prod-ops`);
  expect(renderDigest(r.ledger, { now: 2_000, prevIds: [], maxLines: 30 }).text).toContain(`#${id} stale pnr — from prod-ops`);
});

export type { Ledger };
