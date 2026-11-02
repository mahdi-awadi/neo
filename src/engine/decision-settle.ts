// Which open decisions of a thread no longer need an answer (ADR-0038, ADR-0053). Pure and
// deterministic: the ledger reads the facts (`decisionSettleFacts`), trace.refreshThread applies the
// result (`supersedeDecision` / `expireDecision`) before it derives the thread state. No AI decides.

import { basename } from "node:path";
import type { DecisionRow, Ledger, PlanStatus } from "./ledger";
import { reviewedPath } from "./plan-review";

/** Config `decisionSettle` (docs/CONFIG.md). */
export interface DecisionSettleCfg {
  /** Supersede a thread's stale decisions before deriving its state. Default true. */
  enabled: boolean;
  /** A question expires this many days after it was asked, once its work moved on (ADR-0053). 0 = never. */
  expireAfterDays: number;
  /** Regexes (case-insensitive) for irreversible, prod, money and auth questions: these never expire. */
  keepPatterns: string[];
}

/** Questions about an action that cannot be undone, or that touches prod, money, access or the outside
 *  world (ADR-0053). Matched on what the operator decides — the title, the questions and the button
 *  labels (`decisionText`) — never on the explanations, where such words appear in passing. */
export const DEFAULT_KEEP_PATTERNS: readonly string[] = [
  "\\b(prod|production|release|deploy|deploys|deployment|go-ahead|rollback|roll back|hotfix|downtime)\\b",
  "\\b(restart|reload|merge|merging|push|publish)\\b",
  "\\bmigrat(e|es|ed|ion|ions)\\b",
  "\\b(delete|purge|truncate|drop|wipe|destroy|rotate|rotation|force[- ]push)\\b",
  "\\b(credentials?|secrets?|tokens?|passwords?|admin login|api key)\\b",
  "\\b(payments?|pay|paid|refunds?|billing|charge|money|exchange rate)\\b",
  "\\b(dns|cname|sql|pii)\\b",
];

/** What the operator decides on a card, for the keep patterns: the question, the structured title and
 *  questions, and the button labels — not the context or the per-option explanations. */
export function decisionText(question: string, options?: string[], spec?: { title?: string; questions?: Array<{ question: string; options: string[] }> }): string {
  return [question, ...(options ?? []), ...(spec?.title ? [spec.title] : []), ...(spec?.questions ?? []).flatMap((q) => [q.question, ...q.options])].join(" | ");
}

export const DEFAULT_DECISION_SETTLE: DecisionSettleCfg = { enabled: true, expireAfterDays: 7, keepPatterns: [...DEFAULT_KEEP_PATTERNS] };

/** Parse the config value; a field with a bad value keeps its default. */
export function readDecisionSettleCfg(raw: unknown): DecisionSettleCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_DECISION_SETTLE;
  const days = r.expireAfterDays;
  const patterns = Array.isArray(r.keepPatterns) && r.keepPatterns.every((p) => typeof p === "string" && validRegex(p)) ? (r.keepPatterns as string[]) : undefined;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    expireAfterDays: typeof days === "number" && Number.isInteger(days) && days >= 0 ? days : d.expireAfterDays,
    keepPatterns: patterns ?? [...d.keepPatterns],
  };
}

function validRegex(p: string): boolean {
  try {
    new RegExp(p, "i");
    return true;
  } catch {
    return false;
  }
}

/** True when `text` names an irreversible, prod, money or access action (a keep pattern matches). */
export function keepsOpen(text: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => new RegExp(p, "i").test(text));
}

/** A decision the operator can still answer (tap, reply, typed answer): an open one, and an `expired`
 *  one — expiry only stops it counting as waiting; a late answer still resumes its project (ADR-0053). */
export function answerable(d: { status: string }): boolean {
  return d.status === "open" || d.status === "expired";
}

/** Why a decision may NOT be closed by a typed answer, else undefined (ADR-0054 review, ADR-0071) — the one
 *  rule the company's `decision` tool and the console's answer share. A governor approval (no order) is
 *  released only by its card's Allow/Deny, which unblocks the waiting tool call; an alert by its OK; a plan
 *  card follows its plan (approve or drop) — including an expired card whose plan row is gone. */
export function textAnswerRefusal(dec: Pick<DecisionRow, "id" | "orderId" | "kind" | "question">, ledger: Pick<Ledger, "decisionSettleFactsByIds">): "approval" | "alert" | "plan" | undefined {
  if (dec.kind === "alert") return "alert";
  const card = ledger.decisionSettleFactsByIds([dec.id]);
  if (card.planOf[dec.id] !== undefined || card.replaced?.[dec.id] !== undefined || reviewedPath(dec.question) !== undefined) return "plan";
  if (!dec.orderId) return "approval";
  return undefined;
}

/** One open decision, as the rules see it. */
export interface OpenDecisionFact {
  id: string;
  question: string;
  createdAt: number;
  /** The project folder it was raised for (when known). */
  folder?: string;
  /** The order that raised it; none for a governor escalation. */
  orderId?: string;
  /** Everything the operator reads on the card (question, options, spec), for the keep patterns.
   *  Absent → the question alone. */
  text?: string;
}

/** One thread's facts for settling its decisions. Times are ms; lists need no order. */
export interface SettleFacts {
  /** The thread's open decisions. */
  open: OpenDecisionFact[];
  /** Every decision of the thread, any status (a re-ask may already be answered). */
  asked: Array<{ id: string; question: string; createdAt: number }>;
  /** Decision id → the status of the plan whose CURRENT review decision it is. */
  planOf: Record<string, PlanStatus>;
  /** Decisions a `waiting` todo is parked on (ADR-0029). */
  parked: string[];
  /** An older card of a plan (ADR-0053): decision id → the plan's current card version and decision. */
  replaced?: Record<string, { version: number; currentId?: string }>;
  /** Plan cards whose plan is executing as another todo (Execute queued its build, ADR-0034). */
  planBuilding?: string[];
  /** Decision id → when its order ended, and when a later order in the same folder ended `done`. */
  ended?: Record<string, { endedAt: number; laterDoneAt?: number }>;
}

/** What one settle closes. `expired`: status `expired`, else `superseded`. `moveParkedTo`: a todo
 *  parked on this decision now waits on that one (the question moved to a newer card). */
export interface StaleDecision {
  id: string;
  reason: string;
  expired?: true;
  moveParkedTo?: string;
  /** The card's plan was built (cleanup evidence): mark the PLAN done too, so the card cannot come back
   *  (ADR-0054). Never set by the automatic rules: "a todo names the plan" is evidence a person checks. */
  planDone?: true;
}

/** One question asked twice: trimmed, whitespace collapsed, case-folded. */
export function sameQuestion(a: string, b: string): boolean {
  const n = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return n(a) === n(b);
}

/** A plan status that settles its review decision, and how the reason names it. */
const PLAN_SETTLED: Partial<Record<PlanStatus, string>> = { done: "done", abandoned: "dropped", executing: "executing" };

/** The open decisions to close, each with the reason kept in its answer. `opts.now` enables expiry. */
export function staleDecisions(f: SettleFacts, opts: { now?: number; expireAfterDays?: number; keepPatterns?: readonly string[] } = {}): StaleDecision[] {
  const parked = new Set(f.parked);
  const building = new Set(f.planBuilding ?? []);
  const out: StaleDecision[] = [];
  for (const d of f.open) {
    const replaced = f.replaced?.[d.id];
    if (replaced) {
      // The question moved to the plan's newer card: a todo parked here moves with it (ADR-0053).
      out.push({ id: d.id, reason: `replaced by plan card v${replaced.version}`, ...(replaced.currentId ? { moveParkedTo: replaced.currentId } : {}) });
      continue;
    }
    const plan = f.planOf[d.id];
    if (plan !== undefined) {
      // A plan card follows its plan only (ADR-0036): an awaiting plan still needs Approve & build.
      const settled = PLAN_SETTLED[plan];
      // A parked todo waits on this card. Done, dropped, or built as another todo: that wait is over.
      // Approve & build on a held plan (executing, no build todo) is answered by the frontend, which
      // resumes the parked worker — so that one is left to it.
      if (settled && (!parked.has(d.id) || plan !== "executing" || building.has(d.id))) out.push({ id: d.id, reason: `plan ${settled}` });
      continue;
    }
    if (parked.has(d.id)) continue;
    const again = f.asked.filter((x) => x.id !== d.id && x.createdAt > d.createdAt && sameQuestion(x.question, d.question)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (again) {
      out.push({ id: d.id, reason: `asked again as #${again.id.slice(0, 8)}` });
      continue;
    }
    // No "answered in chat" guess (ADR-0054): a chat answer is recorded by the dispatcher's `decision`
    // tool, which reads the operator's words; a text heuristic closed real questions (d83217cb).
    const why = expiry(d, f, opts);
    if (why) out.push({ id: d.id, reason: why, expired: true });
  }
  return out;
}

/** Close what `staleDecisions` found, the one way (ADR-0053): expired or superseded, the reason kept,
 *  a parked todo moved to the newer card or cancelled. Returns the todos cancelled. */
export function applyStale(ledger: Pick<Ledger, "supersedeDecision" | "expireDecision" | "markPlanDoneByCard">, stale: StaleDecision[], at: number): number[] {
  const cancelled: number[] = [];
  for (const s of stale) {
    if (s.planDone) ledger.markPlanDoneByCard(s.id, s.reason, at);
    if (s.expired) ledger.expireDecision(s.id, s.reason, at);
    else cancelled.push(...ledger.supersedeDecision(s.id, s.reason, at, s.moveParkedTo ? { moveParkedTo: s.moveParkedTo } : {}).todosCancelled);
  }
  return cancelled;
}

/** Why `d` expired (ADR-0053), else undefined: its order ended, later work in its folder ended done,
 *  it is older than `expireAfterDays`, and it is not an irreversible/prod question. */
function expiry(d: OpenDecisionFact, f: SettleFacts, opts: { now?: number; expireAfterDays?: number; keepPatterns?: readonly string[] }): string | undefined {
  const days = opts.expireAfterDays ?? 0;
  if (opts.now === undefined || days <= 0 || !d.orderId) return undefined;
  if (opts.now - d.createdAt < days * 86_400_000) return undefined;
  const e = f.ended?.[d.id];
  if (!e || e.laterDoneAt === undefined || e.laterDoneAt <= e.endedAt) return undefined;
  if (keepsOpen(d.text ?? d.question, opts.keepPatterns ?? DEFAULT_KEEP_PATTERNS)) return undefined;
  return `expired: its work ended and later work in ${d.folder ? basename(d.folder) : "its project"} finished`;
}
