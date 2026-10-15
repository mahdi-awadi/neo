// Which open decisions of a thread no longer need an answer (ADR-0038). Pure and deterministic: the
// ledger reads the facts (`decisionSettleFacts`), trace.refreshThread applies the result
// (`supersedeDecision`) before it derives the thread state. No AI decides anything here.

import type { PlanStatus } from "./ledger";

/** Config `decisionSettle` (docs/CONFIG.md). */
export interface DecisionSettleCfg {
  /** Supersede a thread's stale decisions before deriving its state. Default true. */
  enabled: boolean;
}

/** Parse the config value; a field with a bad type keeps its default. */
export function readDecisionSettleCfg(raw: unknown): DecisionSettleCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { enabled: typeof r.enabled === "boolean" ? r.enabled : true };
}

/** One thread's facts for settling its decisions. Times are ms; lists need no order. */
export interface SettleFacts {
  /** The thread's open decisions, with the project folder each one was raised for (when known). */
  open: Array<{ id: string; question: string; createdAt: number; folder?: string }>;
  /** Every decision of the thread, any status (a re-ask may already be answered). */
  asked: Array<{ id: string; question: string; createdAt: number }>;
  /** The operator's own chat lines in the thread (`ref` names one in the reason): typed on Telegram
   *  or the web, never an answer to one of the thread's decisions nor an approval verdict. */
  operatorMessages: Array<{ ref: string; at: number }>;
  /** When, and in which folder, each order or todo of the thread ended `done`. */
  doneEnds: Array<{ at: number; folder: string }>;
  /** Decision id → the status of the plan whose review decision it is. */
  planOf: Record<string, PlanStatus>;
  /** Decisions a `waiting` todo is parked on (ADR-0029) — never superseded. */
  parked: string[];
}

/** One question asked twice: trimmed, whitespace collapsed, case-folded. */
export function sameQuestion(a: string, b: string): boolean {
  const n = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return n(a) === n(b);
}

/** A plan status that settles its review decision, and how the reason names it. */
const PLAN_SETTLED: Partial<Record<PlanStatus, string>> = { done: "done", abandoned: "dropped", executing: "executing" };

/** The open decisions to supersede, each with the reason kept in its answer. */
export function staleDecisions(f: SettleFacts): Array<{ id: string; reason: string }> {
  const parked = new Set(f.parked);
  const out: Array<{ id: string; reason: string }> = [];
  // "Answered in chat" applies only to the thread's one live question: a chat line next to a batch
  // (Q1 … Q7) cannot say which question it answers, so a batch is never closed by it.
  const live = f.open.filter((d) => !parked.has(d.id) && f.planOf[d.id] === undefined);
  for (const d of f.open) {
    if (parked.has(d.id)) continue;
    const plan = f.planOf[d.id];
    if (plan !== undefined) {
      // A plan card follows its plan only (ADR-0036): an awaiting plan still needs Approve & build.
      const settled = PLAN_SETTLED[plan];
      if (settled) out.push({ id: d.id, reason: `plan ${settled}` });
      continue;
    }
    const again = f.asked.filter((x) => x.id !== d.id && x.createdAt > d.createdAt && sameQuestion(x.question, d.question)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (again) {
      out.push({ id: d.id, reason: `asked again as #${again.id.slice(0, 8)}` });
      continue;
    }
    if (live.length !== 1 || !d.folder) continue;
    const said = f.operatorMessages.filter((m) => m.at > d.createdAt).sort((a, b) => a.at - b.at)[0];
    // The work the question was about must finish: a done end in the decision's own project folder.
    if (said && f.doneEnds.some((e) => e.at > said.at && e.folder === d.folder)) {
      out.push({ id: d.id, reason: `answered in chat (${said.ref}); the thread's work then finished` });
    }
  }
  return out;
}
