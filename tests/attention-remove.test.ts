// P5 Task 5.3 (spec §8.6, AC5.4): a clean leftover worktree whose branch is pushed or merged can be
// removed with one tap (`git worktree remove`, never --force); a dirty one only gets → todo.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { reconcile } from "../src/engine/attention";
import { applyAttentionAction, attentionActions } from "../src/engine/attention-actions";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (dir: string, ...a: string[]) => spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...a], { encoding: "utf8" });

function setup(facts: { dirty?: boolean; merged?: boolean; pushed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-rm-"));
  made.push(root);
  const dir = join(root, "gold");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  const wt = join(root, "gold-ota");
  git(dir, "worktree", "add", "-q", "-b", "feat/ota", wt);
  if (facts.dirty) writeFileSync(join(wt, "wip.txt"), "wip");
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const detail = JSON.stringify({ path: wt, branch: "feat/ota", dirty: facts.dirty ?? false, merged: facts.merged ?? true, pushed: facts.pushed ?? false });
  const [id] = reconcile(ledger, "git", "gold", [{ project: "gold", folder: dir, source: "git", kind: "worktree", key: wt, title: "worktree idle", detail, severity: "normal" }], 100).opened;
  return { ledger, registry, dir, wt, id: id!, deps: { ledger, registry, snoozeMs: 86_400_000 } };
}

test("Remove on a clean, merged worktree runs git worktree remove once and resolves the item", async () => {
  const s = setup();
  expect(attentionActions(s.ledger.attentionById(s.id)!)).toEqual(["remove", "todo", "snooze", "dismiss"]);
  const r = await applyAttentionAction(s.deps, s.id, "remove", 200);
  expect(r).toEqual({ ok: true, text: `removed worktree ${s.wt}` });
  expect(existsSync(s.wt)).toBe(false);
  expect(s.ledger.attentionById(s.id)!.resolvedAt).toBe(200);
  expect((await applyAttentionAction(s.deps, s.id, "remove", 300)).ok).toBe(false); // already resolved
});

test("a dirty worktree has no Remove button and a direct call refuses (checked live, not from the scan)", async () => {
  const s = setup({ dirty: true });
  expect(attentionActions(s.ledger.attentionById(s.id)!)).toEqual(["todo", "snooze", "dismiss"]);
  const clean = setup();
  writeFileSync(join(clean.wt, "late.txt"), "changed after the scan");
  const r = await applyAttentionAction(clean.deps, clean.id, "remove", 200);
  expect(r.ok).toBe(false);
  expect(r.text).toContain("uncommitted");
  expect(existsSync(clean.wt)).toBe(true);
});

test("a session running in the worktree refuses Remove; so does an unpushed, unmerged branch or another kind", async () => {
  const s = setup();
  const sess = s.registry.add({ id: "o1", source: "neo", folder: s.wt, task: "t", chatId: 1, createdAt: 0 }, 0);
  s.registry.setStatus(sess.id, "running");
  expect((await applyAttentionAction(s.deps, s.id, "remove", 200)).text).toBe(`in use by ${sess.name}`);
  const u = setup({ merged: false, pushed: false });
  expect(attentionActions(u.ledger.attentionById(u.id)!)).toEqual(["todo", "snooze", "dismiss"]);
  expect((await applyAttentionAction(u.deps, u.id, "remove", 200)).ok).toBe(false);
  const [other] = reconcile(s.ledger, "engine", "gold", [{ project: "gold", folder: s.dir, source: "engine", kind: "queue_paused", key: s.dir, title: "paused", severity: "normal" }], 100).opened;
  expect((await applyAttentionAction(s.deps, other!, "remove", 200)).ok).toBe(false);
});

test("ignored files (a .env) are named first; a second tap within the window deletes them with the worktree", async () => {
  const s = setup();
  writeFileSync(join(s.wt, ".gitignore"), ".env\n");
  git(s.wt, "add", ".gitignore");
  git(s.wt, "commit", "-q", "-m", "ignore env");
  git(s.dir, "merge", "-q", "--ff-only", "feat/ota");
  writeFileSync(join(s.wt, ".env"), "SECRET=1");
  const first = await applyAttentionAction(s.deps, s.id, "remove", 1_000);
  expect(first.ok).toBe(false);
  expect(first.text).toContain(".env");
  expect(existsSync(join(s.wt, ".env"))).toBe(true);
  const late = await applyAttentionAction(s.deps, s.id, "remove", 1_000 + 6 * 60_000); // window passed: asks again
  expect(late.ok).toBe(false);
  const second = await applyAttentionAction(s.deps, s.id, "remove", 1_000 + 6 * 60_000 + 10_000);
  expect(second.ok).toBe(true);
  expect(existsSync(s.wt)).toBe(false);
});

test("any session for the worktree (idle too) refuses remove — a resume would land in a deleted folder", async () => {
  const s = setup();
  const sess = s.registry.add({ id: "o2", source: "neo", folder: s.wt, task: "t", chatId: 1, createdAt: 0 }, 0);
  s.registry.setStatus(sess.id, "idle");
  expect((await applyAttentionAction(s.deps, s.id, "remove", 200)).text).toBe(`in use by ${sess.name}`);
});
