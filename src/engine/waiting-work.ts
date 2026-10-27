/** Waiting work (ADR-0054): the one list of what holds work back — every open decision and every todo
 *  parked on one — each with an OWNER and a NEXT ACTION, so nothing waits silently. A thread is WAITING
 *  exactly while it holds a decision item; the Threads view and the Queue view both read this list.
 *  Plain reads, no AI, no git: the owner comes from the ledger and the waiting sweep's own judgements
 *  (meta `waitingSweep.judged`), so a web request never runs git. */
import { basename } from "node:path";
import type { Ledger } from "./ledger";
import { decisionText, keepsOpen } from "./decision-settle";
import { JUDGED_KEY, type Judged } from "./waiting-sweep";

/** Who moves it next: the operator (answer, approve), the waiting sweep (judge it against the repo),
 *  or the engine (a parked todo resumes by itself when its decision is answered). */
export type WaitingOwner = "operator" | "sweep" | "engine";

/** The next action, as a key the console translates. `ask` carries the words. */
export type WaitingNext = "answer" | "acknowledge" | "approve" | "judge" | "resumes";

export interface WaitingItem {
  kind: "decision" | "plan" | "parked_todo";
  /** The decision id, or `#<todo id>` for a parked todo. */
  id: string;
  /** The decision's (or todo's) OWN project — not its thread's (ADR-0054). */
  project?: string;
  threadId?: number;
  owner: WaitingOwner;
  next: WaitingNext;
  /** What the operator must decide or give: the sweep's one-line ask, else the question. */
  ask?: string;
  /** A parked todo: the first 8 characters of the decision it resumes on. */
  on?: string;
  /** When it started waiting (ms). */
  since: number;
  /** Matches `decisionSettle.keepPatterns`: prod, irreversible, money or access. */
  keep: boolean;
}

/** Every waiting item, oldest first. */
export function waitingWork(
  ledger: Pick<Ledger, "listOpenDecisions" | "planCardIds" | "listTodos" | "getMeta">,
  opts: { keepPatterns: readonly string[] },
): WaitingItem[] {
  const open = ledger.listOpenDecisions();
  const cards = ledger.planCardIds(open.map((d) => d.id));
  const raw = ledger.getMeta(JUDGED_KEY)?.value;
  const judged = (raw && typeof raw === "object" ? raw : {}) as Record<string, Judged>;
  const items: WaitingItem[] = [];
  const openIds = new Set<string>();
  for (const d of open) {
    openIds.add(d.id);
    const project = d.project ?? (d.folder ? basename(d.folder) : undefined);
    const keep = keepsOpen(decisionText(d.question, d.options, d.spec), opts.keepPatterns);
    const base = { id: d.id, ...(project ? { project } : {}), ...(d.cause ? { threadId: d.cause.threadId } : {}), since: d.createdAt, keep };
    if (cards.has(d.id)) {
      items.push({ ...base, kind: "plan", owner: "operator", next: "approve", ask: d.question });
      continue;
    }
    if (d.kind === "alert") {
      items.push({ ...base, kind: "decision", owner: "operator", next: "acknowledge", ask: d.question });
      continue;
    }
    const ask = judged[d.id]?.ask?.trim();
    // The sweep owns a question it can still judge against a repository: one in a project folder, not
    // yet judged, and not prod work (that one stays the operator's to answer, though the sweep may
    // still close it on evidence that it happened).
    const sweep = !ask && !keep && d.folder !== undefined;
    items.push({ ...base, kind: "decision", owner: sweep ? "sweep" : "operator", next: sweep ? "judge" : "answer", ask: ask || d.question });
  }
  for (const t of ledger.listTodos({ statuses: ["waiting"] })) {
    if (!t.waitingOn || !openIds.has(t.waitingOn)) continue; // an orphan: released at boot (releaseOrphans)
    items.push({
      kind: "parked_todo",
      id: `#${t.id}`,
      project: t.project,
      ...(t.cause ? { threadId: t.cause.threadId } : {}),
      owner: "engine",
      next: "resumes",
      on: t.waitingOn.slice(0, 8),
      since: t.createdAt,
      keep: false,
    });
  }
  return items.sort((a, b) => a.since - b.since);
}
