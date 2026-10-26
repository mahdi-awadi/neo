// Which open decisions of a thread no longer need an answer (ADR-0038, ADR-0053). Pure and
// deterministic: the ledger reads the facts (`decisionSettleFacts`), trace.refreshThread applies the
// result (`supersedeDecision` / `expireDecision`) before it derives the thread state. No AI decides.

import { basename } from "node:path";
import type { Ledger, PlanStatus } from "./ledger";

/** Config `decisionSettle` (docs/CONFIG.md). */
export interface DecisionSettleCfg {
  /** Supersede a thread's stale decisions before deriving its state. Default true. */
  enabled: boolean;
  /** A question expires this many days after it was asked, once its work moved on (ADR-0053). 0 = never. */
  expireAfterDays: number;
  /** Regexes (case-insensitive) for irreversible, prod, money and auth questions: these never expire. */
  keepPatterns: string[];
}

/** Questions about actions that cannot be undone, or that touch prod, money or access (ADR-0053). */
export const DEFAULT_KEEP_PATTERNS: readonly string[] = [
  "\\b(prod|production|live|release|releases|deploy|deploys|deployment|rollback|hotfix)\\b",
  "\\bmigrat(e|es|ed|ion|ions)\\b",
  "\\b(delete|deletes|deletion|purge|truncate|drop|wipe|reset|force[- ]push)\\b",
  "\\b(auth|authentication|authorization|login|passwords?|permissions?|secrets?|credentials?|keys?|tokens?)\\b",
  "\\b(payments?|finance|financial|money|wallets?|invoices?|refunds?|billing|balances?|prices?|charges?)\\b",
  "\\b(dns|domains?|certificates?|customers?|send|email|whatsapp|sms)\\b",
];

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
  /** The operator's own chat lines in the thread (`ref` names one in the reason): typed on Telegram
   *  or the web, never an answer to one of the thread's decisions nor an approval verdict. */
  operatorMessages: Array<{ ref: string; at: number }>;
  /** When, and in which folder, each order or todo of the thread ended `done`. */
  doneEnds: Array<{ at: number; folder: string }>;
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
  const isPlanCard = (id: string) => f.planOf[id] !== undefined || f.replaced?.[id] !== undefined;
  // "Answered in chat" applies only to the thread's one live question: a chat line next to a batch
  // (Q1 … Q7) cannot say which question it answers, so a batch is never closed by it.
  const live = f.open.filter((d) => !parked.has(d.id) && !isPlanCard(d.id));
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
    const said = d.folder && live.length === 1 ? f.operatorMessages.filter((m) => m.at > d.createdAt).sort((a, b) => a.at - b.at)[0] : undefined;
    // The work the question was about must finish: a done end in the decision's own project folder.
    if (said && f.doneEnds.some((e) => e.at > said.at && e.folder === d.folder)) {
      out.push({ id: d.id, reason: `answered in chat (${said.ref}); the thread's work then finished` });
      continue;
    }
    const why = expiry(d, f, opts);
    if (why) out.push({ id: d.id, reason: why, expired: true });
  }
  return out;
}

/** Close what `staleDecisions` found, the one way (ADR-0053): expired or superseded, the reason kept,
 *  a parked todo moved to the newer card or cancelled. Returns the todos cancelled. */
export function applyStale(ledger: Pick<Ledger, "supersedeDecision" | "expireDecision">, stale: StaleDecision[], at: number): number[] {
  const cancelled: number[] = [];
  for (const s of stale) {
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
