// Bridge a governor escalation (a risky tool the worker needs the operator to Allow/Deny) into the
// pending-decisions queue. An escalation IS a blocking decision today — it just wasn't tracked, so
// an escalation the operator never answered left no trace. Recording it means it shows in
// /decisions + the secretary digest, and survives a daemon restart (the in-memory Allow/Deny
// resolver is lost on restart, but the row stays OPEN — no silent loss). Pure + AI-free; the
// Telegram frontend calls these so the wiring stays thin and unit-testable without a Bot.
import type { Ledger } from "./ledger";

export interface EscalationContext {
  /** The escalation reason the governor produced (e.g. "risky shell command: rm -rf ..."). */
  reason: string;
  /** The project the escalation came from, when known (bookkeeping / digest grouping). */
  project?: string;
  folder?: string;
  /** The chat the escalation was raised in. */
  chatId?: number;
}

/** Record a governor escalation as a tracked DECISION and return its id (stored against the
 *  Allow/Deny token so a button press can resolve it). */
export function openEscalationDecision(ledger: Pick<Ledger, "openDecision">, ctx: EscalationContext): string {
  return ledger.openDecision({
    kind: "decision",
    question: ctx.reason,
    project: ctx.project,
    folder: ctx.folder,
    chatId: ctx.chatId,
  });
}

/** Close the escalation's decision row when the operator taps Allow/Deny — the answer is the
 *  verdict itself, so /decisions + the digest stop counting it. */
export function resolveEscalationDecision(
  ledger: Pick<Ledger, "resolveDecision">,
  id: string,
  decision: "allow" | "deny",
  at?: number,
): void {
  ledger.resolveDecision(id, decision, at);
}
