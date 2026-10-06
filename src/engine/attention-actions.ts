/** What the operator does with an attention item (ADR-0018, spec §7): `→ todo`, `snooze`, `dismiss` —
 *  one set of rules for the Telegram buttons, the console and `/attention`. `→ todo` builds the brief
 *  from the item's template, roots an `attention` thread, and queues it through the project's todo
 *  queue as the operator's own work; a second tap shows the existing todo, never a second one. */
import type { AttentionRow, Ledger } from "./ledger";
import type { TodoQueue } from "./todo-queue";
import type { Trace } from "./trace";
import { dismiss, listOpen, snooze } from "./attention";
import { attentionBrief } from "./attention-briefs";
import { todoTitle } from "./todo-title";
import { faults } from "./fault";
import { exec } from "./update-sys";
import type { ExecResult } from "./updater";
import type { Registry } from "./registry";

/** Bound on the worktree status read and remove. */
const REMOVE_TIMEOUT_MS = 30_000;

export type AttentionAction = "remove" | "todo" | "snooze" | "dismiss";
const ACTIONS: AttentionAction[] = ["remove", "todo", "snooze", "dismiss"];
export const isAttentionAction = (s: string): s is AttentionAction => (ACTIONS as string[]).includes(s);

/** The Telegram button labels (engine text, like the plan buttons); snooze names its configured hours. */
export function attentionLabel(action: AttentionAction, snoozeHours: number): string {
  return action === "todo" ? "→ todo" : action === "snooze" ? `snooze ${snoozeHours}h` : action === "remove" ? "remove" : "dismiss";
}

/** What a leftover worktree item knows (the git scan's facts, spec §8.6). */
interface WorktreeFacts {
  path: string;
  dirty: boolean | null;
  merged: boolean | null;
  pushed: boolean | null;
}
const worktreeFacts = (row: Pick<AttentionRow, "kind" | "detail">): WorktreeFacts | undefined => {
  if (row.kind !== "worktree" || !row.detail) return undefined;
  try {
    const f = JSON.parse(row.detail) as WorktreeFacts;
    return typeof f.path === "string" ? f : undefined;
  } catch {
    return undefined;
  }
};

/** The buttons an item offers, in order: a clean leftover worktree whose branch is pushed or merged
 *  can be removed; every item can become a todo, be snoozed or dismissed. */
export function attentionActions(row: Pick<AttentionRow, "kind" | "detail">): AttentionAction[] {
  const f = worktreeFacts(row);
  const removable = !!f && f.dirty === false && (f.merged === true || f.pushed === true);
  return removable ? ["remove", "todo", "snooze", "dismiss"] : ["todo", "snooze", "dismiss"];
}

export interface AttentionActionDeps {
  ledger: Ledger;
  /** Who works where: a worktree a session runs in is never removed. */
  registry?: Registry;
  /** The bounded process runner (the worktree remove). Default: update-sys exec. */
  exec?: (cmd: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;
  todo?: TodoQueue;
  trace?: Trace;
  /** How long `snooze` hides an item (config attention.snoozeHours). */
  snoozeMs: number;
}

/** Items whose `→ todo` is being queued right now: a second tap meanwhile is refused, not doubled. */
const queueing = new Set<number>();

export async function applyAttentionAction(deps: AttentionActionDeps, id: number, action: AttentionAction, now: number): Promise<{ ok: boolean; text: string }> {
  const { ledger } = deps;
  const row = ledger.attentionById(id);
  if (!row) return { ok: false, text: `no attention item #${id}` };
  if (row.resolvedAt !== undefined) return { ok: false, text: `#${id} is already resolved` };
  switch (action) {
    case "snooze":
      snooze(ledger, id, now + deps.snoozeMs);
      return { ok: true, text: `#${id} snoozed for ${Math.round(deps.snoozeMs / 3_600_000)}h` };
    case "dismiss":
      dismiss(ledger, id, now);
      return { ok: true, text: `#${id} dismissed — it comes back only if it goes away and returns` };
    case "remove":
      try {
        return await removeWorktree(deps, row, now);
      } catch (e) {
        faults.report("attention.removeWorktree", e, { id });
        return { ok: false, text: `remove failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    case "todo":
      // Contained (ADR-0010): a fault in the trace or the queue is the tap's answer, never a throw.
      try {
        return await toTodo(deps, row);
      } catch (e) {
        faults.report("attention.toTodo", e, { id });
        return { ok: false, text: `→ todo failed: ${e instanceof Error ? e.message : String(e)}` };
      }
  }
}

/** Remove a leftover worktree (AC5.4): only a clean one (checked live, not from the scan) whose
 *  branch is pushed or merged, and never one a session runs in. `git worktree remove` without
 *  --force, so git itself refuses anything it would lose. The item resolves. */
async function removeWorktree(deps: AttentionActionDeps, row: AttentionRow, now: number): Promise<{ ok: boolean; text: string }> {
  const f = worktreeFacts(row);
  if (!f) return { ok: false, text: `#${row.id} is not a leftover worktree` };
  if (!attentionActions(row).includes("remove")) return { ok: false, text: `${f.path}: not pushed or merged, or not clean — → todo instead` };
  const session = deps.registry?.findByFolder(f.path);
  if (session?.status === "running") return { ok: false, text: `in use by ${session.name}` };
  const run = deps.exec ?? exec;
  const status = await run(["git", "-C", f.path, "status", "--porcelain", "--untracked-files=all"], { timeoutMs: REMOVE_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: "0" } });
  if (status.code !== 0) return { ok: false, text: `could not read ${f.path}: ${status.err.trim()}` };
  if (status.out.trim()) return { ok: false, text: `${f.path} has uncommitted changes now — → todo instead` };
  const r = await run(["git", "-C", row.folder, "worktree", "remove", f.path], { timeoutMs: REMOVE_TIMEOUT_MS });
  if (r.code !== 0) return { ok: false, text: `git refused: ${r.err.trim()}` };
  deps.ledger.updateAttention(row.id, { resolvedAt: now });
  return { ok: true, text: `removed worktree ${f.path}` };
}

async function toTodo(deps: AttentionActionDeps, row: AttentionRow): Promise<{ ok: boolean; text: string }> {
  const { ledger } = deps;
  // The linked todo is THE todo unless it failed or was cancelled — even "done": a brief delivered into
  // an open session is done at once while the item is still open. A returning item has no link (reopen).
  const existing = row.todoId !== undefined ? ledger.todoById(row.todoId) : undefined;
  if (existing && existing.status !== "failed" && existing.status !== "cancelled") return { ok: true, text: `already todo #${existing.id} (${existing.status})` };
  const launcher = deps.todo?.launcher();
  if (!deps.todo || !launcher || !deps.trace) return { ok: false, text: "the todo queue is unavailable — → todo needs it" };
  const brief = attentionBrief(row);
  if (!brief) return { ok: false, text: `no brief template for ${row.kind}` };
  if (queueing.has(row.id)) return { ok: false, text: `#${row.id} is being queued` };
  queueing.add(row.id);
  try {
    // Its own thread (origin attention), so /trace and the console show what the tap started.
    const cause = deps.trace.root({ origin: "attention", title: row.title, project: row.project, folder: row.folder });
    const text = await deps.todo.submit({ project: row.folder, brief, workClass: "interactive", cause }, launcher.deps, launcher.replyChat);
    const todo = ledger.threadArtifacts(cause.threadId, 5).todos[0];
    if (!todo || todo.status === "cancelled") return { ok: false, text }; // refused or held: nothing runs
    ledger.updateAttention(row.id, { todoId: todo.id });
    return { ok: true, text: `queued as todo #${todo.id}` };
  } finally {
    queueing.delete(row.id);
  }
}

const SEVERITY_ICON: Record<AttentionRow["severity"], string> = { high: "🔴", normal: "🟡", low: "⚪" };

/** `/attention [project]`: open items grouped by project (the project with the most severe item
 *  first), severity first inside, at most `maxLines` lines, then the console link. `buttons`: the
 *  items that get one-tap buttons (the first `maxButtons` shown). */
export function renderAttention(
  ledger: Ledger,
  o: { project?: string; now: number; maxLines: number; maxButtons: number; consoleUrl?: string },
): { text: string; buttons: AttentionRow[] } {
  const rows = listOpen(ledger, { project: o.project, now: o.now });
  if (!rows.length) return { text: o.project ? `✓ nothing needs attention in ${o.project}` : "✓ nothing needs attention", buttons: [] };
  const byProject = new Map<string, AttentionRow[]>();
  for (const r of rows) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]); // rows come severity first
  const lines = [`⚠ attention: ${rows.length} open${o.project ? ` in ${o.project}` : ""}`];
  const buttons: AttentionRow[] = [];
  let shown = 0;
  for (const [project, items] of byProject) {
    if (lines.length >= o.maxLines) break;
    lines.push(`${project}:`);
    for (const r of items) {
      if (lines.length >= o.maxLines) break;
      // One bounded line per item: a title may hold a long, multi-line question (the brief keeps it all).
      lines.push(`  ${SEVERITY_ICON[r.severity]} #${r.id} ${todoTitle(r.title)}${r.todoId !== undefined ? ` → todo #${r.todoId}` : ""}`);
      shown++;
      if (buttons.length < o.maxButtons) buttons.push(r);
    }
  }
  if (shown < rows.length) lines.push(`… +${rows.length - shown} more`);
  if (o.consoleUrl) lines.push(o.consoleUrl);
  return { text: lines.join("\n"), buttons };
}
