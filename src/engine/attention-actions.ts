/** What the operator does with an attention item (ADR-0018, spec §7): `→ todo`, `snooze`, `dismiss` —
 *  one set of rules for the Telegram buttons, the console and `/attention`. `→ todo` builds the brief
 *  from the item's template, roots an `attention` thread, and queues it through the project's todo
 *  queue as the operator's own work; a second tap shows the existing todo, never a second one. */
import type { AttentionRow, Ledger } from "./ledger";
import type { TodoQueue } from "./todo-queue";
import { ENGINE_CHAT_ID, type Trace } from "./trace";
import { isDue } from "./trigger";
import { dismiss, listOpen, snooze } from "./attention";
import { attentionBrief } from "./attention-briefs";
import { todoTitle } from "./todo-title";
import { faults } from "./fault";
import { exec } from "./update-sys";
import type { ExecResult } from "./updater";
import type { Registry } from "./registry";

/** Bound on the worktree status read and remove. */
const REMOVE_TIMEOUT_MS = 30_000;
/** A remove that deletes ignored files needs a second tap within this window. */
const REMOVE_CONFIRM_MS = 5 * 60_000;
/** Ignored files named by name in the warning (git collapses an ignored folder to one line). */
const REMOVE_NAMED_MAX = 20;

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

/** A tap's answer. `drop`: the item's row has nothing left to do (snoozed, dismissed, removed, or
 *  already resolved elsewhere) — the frontend takes its buttons away. A refusal keeps them. */
export interface AttentionActionResult {
  ok: boolean;
  text: string;
  drop?: boolean;
}

export async function applyAttentionAction(deps: AttentionActionDeps, id: number, action: AttentionAction, now: number): Promise<AttentionActionResult> {
  const r = await apply(deps, id, action, now);
  return r.ok && action !== "todo" ? { ...r, drop: true } : r;
}

async function apply(deps: AttentionActionDeps, id: number, action: AttentionAction, now: number): Promise<AttentionActionResult> {
  const { ledger } = deps;
  const row = ledger.attentionById(id);
  if (!row) return { ok: false, text: `no attention item #${id}`, drop: true };
  if (row.resolvedAt !== undefined) return { ok: false, text: `#${id} is already resolved`, drop: true };
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
async function removeWorktree(deps: AttentionActionDeps, row: AttentionRow, now: number): Promise<AttentionActionResult> {
  const f = worktreeFacts(row);
  if (!f) return { ok: false, text: `#${row.id} is not a leftover worktree` };
  if (!attentionActions(row).includes("remove")) return { ok: false, text: `${f.path}: not pushed or merged, or not clean — → todo instead` };
  // Any session for it, idle too: a resume would land in a folder that no longer exists.
  const session = deps.registry?.findByFolder(f.path);
  if (session) return { ok: false, text: `in use by ${session.name}` };
  const run = deps.exec ?? exec;
  const status = await run(["git", "-C", f.path, "status", "--porcelain", "--ignored", "--untracked-files=normal"], { timeoutMs: REMOVE_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: "0" } });
  if (status.code !== 0) return { ok: false, text: `could not read ${f.path}: ${status.err.trim()}` };
  const lines = status.out.split("\n").filter(Boolean);
  if (lines.some((l) => !l.startsWith("!! "))) return { ok: false, text: `${f.path} has uncommitted changes now — → todo instead` };
  // git deletes ignored files (a .env, local data) without asking: name them, and remove only on a
  // second tap within REMOVE_CONFIRM_MS — consent to exactly what is lost.
  const ignored = lines.map((l) => l.slice(3)).sort();
  const key = `rmconfirm:${row.id}`;
  if (ignored.length) {
    const asked = deps.ledger.getMeta(key)?.value as { at: number; files?: string[] } | undefined;
    // The consent covers exactly the files named: one that appeared since asks again.
    const same = asked?.files !== undefined && asked.files.join("\0") === ignored.join("\0");
    if (!asked || !same || now - asked.at > REMOVE_CONFIRM_MS) {
      deps.ledger.setMeta(key, { at: now, files: ignored }, now);
      const shown = ignored.slice(0, REMOVE_NAMED_MAX).join(", ") + (ignored.length > REMOVE_NAMED_MAX ? ` (+${ignored.length - REMOVE_NAMED_MAX} more)` : "");
      return { ok: false, text: `tap remove again within ${REMOVE_CONFIRM_MS / 60_000} min to also delete the ignored files in ${f.path}: ${shown}` };
    }
  }
  const r = await run(["git", "-C", row.folder, "worktree", "remove", f.path], { timeoutMs: REMOVE_TIMEOUT_MS });
  if (r.code !== 0) return { ok: false, text: `git refused: ${r.err.trim()}` };
  deps.ledger.deleteMeta(key);
  deps.ledger.updateAttention(row.id, { resolvedAt: now });
  return { ok: true, text: `removed worktree ${f.path}` };
}

async function toTodo(deps: AttentionActionDeps, row: AttentionRow): Promise<AttentionActionResult> {
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

/** The daily digest (spec §7, AC5.5): per project the count by severity and its top `TOP_HIGH` high
 *  items (each with → todo), at most `maxLines` lines, then the console link; `result` priority (the
 *  Decisions group) only when something is high. Nothing new and nothing high → one line. Counts
 *  cover every open item. `prevIds`: the items open at the last digest. */
export function renderDigest(
  ledger: Ledger,
  o: { now: number; prevIds: number[]; consoleUrl?: string; maxLines: number },
): { text: string; priority: "result" | "progress"; buttons: Array<AttentionRow & { actions: AttentionAction[] }>; ids: number[] } {
  const rows = ledger.allOpenAttention(o.now);
  const ids = rows.map((r) => r.id);
  const prev = new Set(o.prevIds);
  const fresh = rows.filter((r) => !prev.has(r.id)).length;
  const high = rows.filter((r) => r.severity === "high").length;
  const priority = high > 0 ? "result" : "progress";
  if (!fresh && !high) return { text: `☀ attention today: ${rows.length} open, nothing new, nothing high — /attention`, priority, buttons: [], ids };
  const lines = [`☀ attention today: ${rows.length} open, ${high} high, ${fresh} new since the last digest`];
  const buttons: Array<AttentionRow & { actions: AttentionAction[] }> = [];
  const byProject = new Map<string, AttentionRow[]>();
  for (const r of rows) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]); // severity first
  let shownProjects = 0;
  for (const [project, items] of byProject) {
    const top = items.filter((x) => x.severity === "high").slice(0, TOP_HIGH);
    if (lines.length + 1 + top.length > o.maxLines) break; // one bounded message (Telegram: 4096)
    const count = (sev: AttentionRow["severity"]) => items.filter((r) => r.severity === sev).length;
    lines.push(`${project}: ${(["high", "normal", "low"] as const).filter((s) => count(s)).map((s) => `${count(s)} ${s}`).join(" · ")}`);
    for (const r of top) {
      lines.push(`  ${SEVERITY_ICON[r.severity]} #${r.id} ${todoTitle(r.title)}`);
      buttons.push({ ...r, actions: ["todo"] });
    }
    shownProjects++;
  }
  if (shownProjects < byProject.size) lines.push(`… +${byProject.size - shownProjects} more projects — /attention`);
  if (o.consoleUrl) lines.push(o.consoleUrl);
  return { text: lines.join("\n"), priority, buttons, ids };
}

/** High items shown per project in the digest. */
const TOP_HIGH = 3;

export interface DigestDeps {
  ledger: Ledger;
  trace?: Trace;
  /** Cron (server time), config attention.digestAt. */
  digestAt: string;
  consoleUrl?: string;
  /** The digest's line cap (config attention.listLines). */
  maxLines: number;
  /** Post the digest: `result` → the Decisions group, `progress` → the operator's DM. Returns the
   *  posted message, so a reply to it joins the digest's thread. */
  send(text: string, priority: "result" | "progress", buttons: Array<{ id: number; actions: AttentionAction[] }>): Promise<{ chatId: number; messageId: number } | void>;
}

/** The heartbeat's digest step: when `digestAt` is due (once per matching minute — the last send is
 *  kept in meta, so a restart in that minute does not send twice), roots an `attention` thread and
 *  sends the digest. Returns whether it sent. */
export async function runDigest(deps: DigestDeps, now: number): Promise<boolean> {
  const last = deps.ledger.getMeta("digest:last")?.value as { at: number; ids: number[] } | undefined;
  if (!isDue({ kind: "cron", expr: deps.digestAt }, last?.at, now)) return false;
  const d = renderDigest(deps.ledger, { now, prevIds: last?.ids ?? [], consoleUrl: deps.consoleUrl, maxLines: deps.maxLines });
  // Written before the send, so a restart or a retry never sends twice; a failed send loses that
  // day's digest (logged by the heartbeat), and /attention still shows everything.
  deps.ledger.setMeta("digest:last", { at: now, ids: d.ids }, now);
  const cause = deps.trace?.root({ origin: "attention", title: "daily attention digest" });
  const posted = await deps.send(d.text, d.priority, d.buttons.map((b) => ({ id: b.id, actions: b.actions })));
  // The line is filed under the chat it was posted in and bound to its message (like a plan card),
  // so a reply to the digest joins the digest's thread.
  if (deps.trace && cause) {
    const msgId = deps.trace.outbound({ chatId: posted ? posted.chatId : ENGINE_CHAT_ID, text: d.text, cause, kind: "digest" });
    if (posted) deps.trace.bindChannel(msgId, posted.chatId, posted.messageId);
  }
  return true;
}
