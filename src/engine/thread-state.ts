// Thread state (ADR-0016, spec §5): the one pure rule that turns a thread's linked facts into
// open | waiting | done | failed. Only trace.refreshThread() writes the result; nothing else decides.
import type { ThreadState } from "./ledger";

export type { ThreadState };

export function deriveThreadState(f: {
  /** decisions.status='open' in this thread. */
  openDecisions: number;
  /** Sessions in this thread blocked on an approval. */
  pendingApprovals: number;
  /** Todos queued|running plus sessions in-turn under this thread's cause. */
  activeWork: number;
  /** The newest ended order/todo in this thread. */
  lastEnd?: "ok" | "failed";
  closedByOperator: boolean;
}): ThreadState {
  if (f.closedByOperator) return "done";
  if (f.openDecisions > 0 || f.pendingApprovals > 0) return "waiting"; // waiting on the operator beats work
  if (f.activeWork > 0) return "open";
  return f.lastEnd === "failed" ? "failed" : "done";
}
