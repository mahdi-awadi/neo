/** "Needs you" (ADR-0065): what only the operator can move, in one list — the console's ATTENTION badge,
 *  its count and the "Pinned — needs you" strip all read it. An attention item is classed by its KIND in
 *  one table here, never by the severity its producer chose; a kind not in the table needs the operator
 *  (fail closed). The list joins the decisions waiting on the operator (ADR-0054 waiting work: plan cards,
 *  decision cards, alerts), failed todos, needs-you attention items and the operator's pins, minus what
 *  the operator unpinned. Plain reads over the ledger, no AI, no git. */
import type { AttentionRow, Ledger, PinState, TodoRow } from "./ledger";
import { waitingWork } from "./waiting-work";
import { explainAttention } from "./attention-explain";
import { todoLabel } from "./todo-title";

export type AttentionClass = "needs_you" | "housekeeping";

/** Every kind a producer raises, by class. A test keeps every producer's kind list in this table. */
const CLASS: Record<string, AttentionClass> = {
  // Only the operator can move these.
  thread_failed: "needs_you",
  approval_stuck: "needs_you",
  queue_paused: "needs_you",
  decision_stale: "needs_you",
  secret_scanning: "needs_you",
  code_scanning: "needs_you",
  note_question: "needs_you",
  history_off: "needs_you", // meaning search cannot start until the operator acts (ADR-0067)
  backup_failed: "needs_you",
  // An agent or the engine handles these; they never raise the badge.
  pr_open: "housekeeping",
  pr_review_requested: "housekeeping",
  issue_open: "housekeeping",
  dependabot: "housekeeping",
  ci_failed: "housekeeping", // an agent fixes it through → todo (operator, 2026-10-29)
  stale_branch: "housekeeping",
  unpushed: "housekeeping",
  no_upstream: "housekeeping",
  drift: "housekeeping",
  worktree: "housekeeping",
  dirty: "housekeeping",
  restart_gated: "housekeeping",
  dispatch_spinning: "housekeeping",
  ctx_window_suspect: "housekeeping",
  skillify_repeat: "housekeeping",
  thread_waiting: "housekeeping", // its decision is already a needs-you item
  note_fyi: "housekeeping",
  note_finding: "housekeeping",
  note_request: "housekeeping",
  history_degraded: "housekeeping", // a service down or slow: it may come back by itself
};

/** The kinds the table classes (the coverage test reads it). */
export const CLASSED_KINDS: ReadonlySet<string> = new Set(Object.keys(CLASS));

/** An attention item's class by its kind; an unknown kind needs the operator. */
export function attentionClass(kind: string): AttentionClass {
  return CLASS[kind] ?? "needs_you";
}

export type NeedsYouKind = "plan" | "decision" | "alert" | "todo" | "attention";
/** The strip's button: review a plan (read it, then approve or drop — never a blind one-tap approve,
 *  ADR-0071), answer a decision, acknowledge an alert, retry a failed todo, or open the item. Every one but
 *  retry opens the item itself, where its full text and its actions are. */
export type NeedsYouAction = "review" | "answer" | "acknowledge" | "retry" | "open";

export interface NeedsYouItem {
  /** The pin ref: `dec:<id>`, `todo:<id>` or `att:<id>`. */
  ref: string;
  kind: NeedsYouKind;
  action: NeedsYouAction;
  project?: string;
  /** One plain line: what it is and why it needs the operator. */
  why: string;
  since: number;
  /** True when the operator pinned it by hand. */
  pinned: boolean;
  threadId?: number;
  /** A plan card: the plan the Approve button acts on. */
  plan?: { id: number; version: number };
  todoId?: number;
  attentionId?: number;
  /** The open decision Open answers: the item's own (a decision or plan card), or the one a
   *  `decision_stale` reminder is about (ADR-0071). */
  decisionId?: string;
}

export interface NeedsYouDeps {
  ledger: Pick<Ledger, "listOpenDecisions" | "planCardIds" | "planByCard" | "listTodos" | "todoById" | "getMeta" | "allOpenAttention" | "attentionById" | "listPins" | "decisionById">;
  /** cfg.decisionSettle.keepPatterns. */
  keepPatterns: readonly string[];
}

const ACTIVE_TODO: ReadonlySet<TodoRow["status"]> = new Set(["queued", "running", "retry", "waiting", "failed"]);

/** The open decision a `decision_stale` reminder is about (its key is the decision id), else undefined. */
export function staleDecisionOf(r: Pick<AttentionRow, "kind" | "key">, ledger: Pick<Ledger, "decisionById">): string | undefined {
  if (r.kind !== "decision_stale") return undefined;
  return ledger.decisionById(r.key)?.status === "open" ? r.key : undefined;
}

function attentionItem(r: AttentionRow, pinned: boolean, ledger: Pick<Ledger, "decisionById">): NeedsYouItem {
  const decisionId = staleDecisionOf(r, ledger);
  return {
    ref: `att:${r.id}`,
    kind: "attention",
    action: decisionId ? "answer" : "open",
    ...(decisionId ? { decisionId } : {}),
    project: r.project,
    why: explainAttention(r).plain,
    since: r.firstSeen,
    pinned,
    attentionId: r.id,
  };
}

function todoItem(t: TodoRow, pinned: boolean): NeedsYouItem {
  return {
    ref: `todo:${t.id}`,
    kind: "todo",
    action: t.status === "failed" ? "retry" : "open",
    project: t.project,
    why: todoLabel(t),
    since: t.endedAt ?? t.createdAt,
    pinned,
    todoId: t.id,
    ...(t.cause ? { threadId: t.cause.threadId } : {}),
  };
}

/** Everything that needs the operator now, in a stable order: decisions (oldest first), failed todos,
 *  needs-you attention items, then manual pins. Snoozed items are out until their snooze ends. */
export function needsYou(d: NeedsYouDeps, now: number): NeedsYouItem[] {
  const pinRows = new Map(d.ledger.listPins().map((p) => [p.ref, p]));
  const pins = new Map([...pinRows].map(([ref, p]) => [ref, p.state]));
  const out: NeedsYouItem[] = [];
  const seen = new Set<string>();
  const add = (i: NeedsYouItem): void => {
    // A hide covers the occurrence it was made on: a todo that failed again since is back.
    const p = pinRows.get(i.ref);
    if (seen.has(i.ref) || (p?.state === "unpinned" && p.at >= i.since)) return;
    seen.add(i.ref);
    out.push(i);
  };
  // Every open decision is the operator's question, including one the sweep has not judged yet (it may
  // still close it on evidence); a parked todo moves by itself and is not theirs.
  for (const w of waitingWork(d.ledger, { keepPatterns: d.keepPatterns })) {
    if (w.kind === "parked_todo") continue;
    const kind: NeedsYouKind = w.kind === "plan" ? "plan" : w.next === "acknowledge" ? "alert" : "decision";
    const plan = kind === "plan" ? d.ledger.planByCard(w.id) : undefined;
    add({
      ref: `dec:${w.id}`,
      kind,
      action: kind === "plan" ? "review" : kind === "alert" ? "acknowledge" : "answer",
      decisionId: w.id,
      ...(w.project ? { project: w.project } : {}),
      why: w.ask ?? "",
      since: w.since,
      pinned: pins.get(`dec:${w.id}`) === "pinned",
      ...(w.threadId !== undefined ? { threadId: w.threadId } : {}),
      ...(plan ? { plan: { id: plan.id, version: plan.version } } : {}),
    });
  }
  for (const t of d.ledger.listTodos({ statuses: ["failed"] })) add(todoItem(t, pins.get(`todo:${t.id}`) === "pinned"));
  // A "decision open 24h" reminder stands in for its decision only while that decision is open and not
  // already listed (the operator hid it); beside its decision, or once it is answered, it is moot (ADR-0071).
  const moot = (r: AttentionRow): boolean => r.kind === "decision_stale" && (seen.has(`dec:${r.key}`) || !staleDecisionOf(r, d.ledger));
  for (const r of d.ledger.allOpenAttention(now)) {
    if (attentionClass(r.kind) === "needs_you" && !moot(r)) add(attentionItem(r, pins.get(`att:${r.id}`) === "pinned", d.ledger));
  }
  for (const [ref, state] of pins) {
    if (state !== "pinned" || seen.has(ref)) continue;
    const target = parseRef(ref);
    if (target?.type === "att") {
      const r = d.ledger.attentionById(target.id);
      if (r && r.resolvedAt === undefined && (r.snoozedUntil === undefined || r.snoozedUntil <= now) && !moot(r)) add(attentionItem(r, true, d.ledger));
    } else if (target?.type === "todo") {
      const t = d.ledger.todoById(target.id);
      if (t && ACTIVE_TODO.has(t.status)) add(todoItem(t, true));
    }
    // A pinned decision that is open is already listed; a closed one is gone.
  }
  return out;
}

const REF = /^(att|todo|dec):([A-Za-z0-9_-]{1,64})$/;

export function parseRef(ref: string): { type: "att" | "todo"; id: number } | { type: "dec"; id: string } | undefined {
  const m = REF.exec(ref);
  if (!m) return undefined;
  if (m[1] === "dec") return { type: "dec", id: m[2]! };
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { type: m[1] as "att" | "todo", id } : undefined;
}

/** Pin, unpin or clear (`null`) one item. Refused, with the reason, for a malformed ref or a target that
 *  is gone or closed — so the strip never holds a pin that cannot show. Clearing always works. */
export function pin(
  ledger: Pick<Ledger, "setPin" | "attentionById" | "todoById" | "decisionById">,
  ref: string,
  state: PinState | null,
  now: number,
): { ok: true; text: string } | { ok: false; error: string } {
  const target = parseRef(ref);
  if (!target) return { ok: false, error: "unknown item" };
  if (state !== null) {
    const open =
      target.type === "att"
        ? (() => {
            const r = ledger.attentionById(target.id);
            return !!r && r.resolvedAt === undefined;
          })()
        : target.type === "todo"
          ? (() => {
              const t = ledger.todoById(target.id);
              return !!t && ACTIVE_TODO.has(t.status);
            })()
          : ledger.decisionById(String(target.id))?.status === "open";
    if (!open) return { ok: false, error: "that item is closed or gone" };
  }
  ledger.setPin(ref, state, now);
  return { ok: true, text: state === "pinned" ? "pinned" : state === "unpinned" ? "unpinned" : "pin cleared" };
}
