// Bridge a governor escalation (a risky tool the worker needs the operator to Allow/Deny) into the
// pending-decisions queue. An escalation IS a blocking decision today — it just wasn't tracked, so
// an escalation the operator never answered left no trace. Recording it means it shows in
// /decisions + the secretary digest, and survives a daemon restart (the in-memory Allow/Deny
// resolver is lost on restart, but the row stays OPEN — no silent loss). Pure + AI-free; the
// Telegram frontend calls these so the wiring stays thin and unit-testable without a Bot.
import type { Ledger } from "./ledger";
import type { Priority } from "./priority";
import { humanAge } from "./liveness";

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

/** How long a pending approval may wait before the operator is reminded / it fails closed. */
export interface ApprovalPatience {
  /** Re-notify every this many ms while unanswered. 0 = never. */
  approvalRemindMs: number;
  /** Deny after this many ms unanswered. 0 = wait for the operator. */
  approvalTimeoutMs: number;
}

/** Wait for the operator's answer to an approval, but never silently forever (ADR-0012). While it
 *  is pending, remind the operator on the Decisions surface every `approvalRemindMs`; after
 *  `approvalTimeoutMs`, fail CLOSED (deny), alert the operator, record `approval_timeout`, and abort
 *  `ask`'s signal so the frontend drops its prompt. A rejecting `ask` still rejects (the
 *  canUseTool fail-safe owns that). The one wait every operator-facing escalation goes through. */
export function patientApproval(
  ask: (signal: AbortSignal) => Promise<"allow" | "deny">,
  reason: string,
  opts: {
    patience: ApprovalPatience;
    say: (text: string, priority: Priority) => void;
    record?: (kind: string, data: Record<string, unknown>) => void;
  },
): Promise<"allow" | "deny"> {
  const { approvalRemindMs, approvalTimeoutMs } = opts.patience;
  const started = Date.now();
  const abort = new AbortController();
  let remind: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (remind !== undefined) clearInterval(remind);
    if (timeout !== undefined) clearTimeout(timeout);
  };
  // Observer only: a failing channel must never break the wait itself.
  const say = (text: string, priority: Priority) => {
    try {
      opts.say(text, priority);
    } catch {
      /* observer only */
    }
  };
  return new Promise<"allow" | "deny">((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      stop();
      fn();
    };
    if (approvalRemindMs > 0) {
      remind = setInterval(() => {
        say(`⏳ still waiting for your approval (${humanAge(Date.now() - started)}): ${reason}`, "decision");
      }, approvalRemindMs);
    }
    if (approvalTimeoutMs > 0) {
      timeout = setTimeout(() => {
        finish(() => {
          try {
            opts.record?.("approval_timeout", { reason, waitedMs: Date.now() - started });
          } catch {
            /* observer only */
          }
          say(`⌛ no answer in ${humanAge(Date.now() - started)} — denied: ${reason}`, "alert");
          abort.abort();
          resolve("deny");
        });
      }, approvalTimeoutMs);
    }
    ask(abort.signal).then(
      (d) => finish(() => resolve(d)),
      (e) => finish(() => reject(e)),
    );
  });
}
