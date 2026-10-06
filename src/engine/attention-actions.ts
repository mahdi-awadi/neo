/** What the operator does with an attention item (ADR-0018, spec §7): `→ todo`, `snooze`, `dismiss` —
 *  one set of rules for the Telegram buttons, the console and `/attention`. `→ todo` builds the brief
 *  from the item's template, roots an `attention` thread, and queues it through the project's todo
 *  queue as the operator's own work; a second tap shows the existing todo, never a second one. */
import type { AttentionRow, Ledger } from "./ledger";
import type { TodoQueue } from "./todo-queue";
import type { Trace } from "./trace";
import { dismiss, listOpen, snooze } from "./attention";
import { attentionBrief } from "./attention-briefs";

export type AttentionAction = "todo" | "snooze" | "dismiss";
const ACTIONS: AttentionAction[] = ["todo", "snooze", "dismiss"];
export const isAttentionAction = (s: string): s is AttentionAction => (ACTIONS as string[]).includes(s);

/** The button labels, in card order. */
export const ATTENTION_LABELS: Record<AttentionAction, string> = { todo: "→ todo", snooze: "snooze 1d", dismiss: "dismiss" };

export interface AttentionActionDeps {
  ledger: Ledger;
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
    case "todo":
      return toTodo(deps, row);
  }
}

async function toTodo(deps: AttentionActionDeps, row: AttentionRow): Promise<{ ok: boolean; text: string }> {
  const { ledger } = deps;
  const existing = row.todoId !== undefined ? ledger.todoById(row.todoId) : undefined;
  if (existing && existing.status !== "cancelled") return { ok: true, text: `already todo #${existing.id} (${existing.status})` };
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
      lines.push(`  ${SEVERITY_ICON[r.severity]} #${r.id} ${r.title}${r.todoId !== undefined ? ` → todo #${r.todoId}` : ""}`);
      shown++;
      if (buttons.length < o.maxButtons) buttons.push(r);
    }
  }
  if (shown < rows.length) lines.push(`… +${rows.length - shown} more`);
  if (o.consoleUrl) lines.push(o.consoleUrl);
  return { text: lines.join("\n"), buttons };
}
