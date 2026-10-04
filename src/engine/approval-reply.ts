// Pending Allow/Deny approvals, answerable by a button OR by typing (2026-07-25 issue 4).
//
// An escalation parks the worker inside canUseTool until the approval promise settles, so the SDK
// reads no input meanwhile. A typed "yes" used to be queued as a follow-up the parked worker could
// never read, and the approval never resolved. Now a typed message is checked against the chat's
// pending approvals first. Deterministic word matching, no AI.

export type ApprovalDecision = "allow" | "deny";

const ALLOW = new Set(["yes", "y", "yep", "yeah", "yup", "ok", "okay", "allow", "allowed", "approve", "approved", "go", "go ahead", "do it", "sure", "👍", "✅"]);
const DENY = new Set(["no", "n", "nope", "nah", "deny", "denied", "reject", "stop", "dont", "don't", "do not", "cancel", "👎", "❌", "⛔"]);

/** Map a short typed answer to a decision, or undefined when it isn't a clear yes/no. A short
 *  answer may carry a polite tail ("yes please", "no thanks"); anything longer is a message. */
export function parseApprovalReply(text: string): ApprovalDecision | undefined {
  const t = text.trim().toLowerCase().replace(/[.!,]+$/u, "").replace(/\s+/g, " ");
  if (!t) return undefined;
  if (ALLOW.has(t)) return "allow";
  if (DENY.has(t)) return "deny";
  const words = t.split(" ");
  if (words.length > 3) return undefined;
  const head = words[0]!.replace(/[.!,]+$/u, "");
  const tail = words.slice(1).join(" ");
  const polite = new Set(["please", "thanks", "thank you", "go ahead", "do it", "it", "that"]);
  if (!polite.has(tail)) return undefined;
  if (ALLOW.has(head)) return "allow";
  if (DENY.has(head)) return "deny";
  return undefined;
}

export interface PendingApproval {
  token: string;
  chatId: number;
  reason: string;
  /** The Telegram message carrying the Allow/Deny buttons, once sent. */
  messageId?: number;
  resolve: (decision: ApprovalDecision) => void;
}

export interface PendingApprovals {
  add(chatId: number, reason: string, resolve: (d: ApprovalDecision) => void): string;
  setMessageId(token: string, messageId: number): void;
  /** Remove and return a pending approval (the caller resolves it). */
  take(token: string): PendingApproval | undefined;
  /** Pending approvals for a chat, oldest first. */
  forChat(chatId: number): PendingApproval[];
}

export function createPendingApprovals(): PendingApprovals {
  const pending = new Map<string, PendingApproval>(); // insertion order = oldest first
  return {
    add(chatId, reason, resolve) {
      const token = crypto.randomUUID();
      pending.set(token, { token, chatId, reason, resolve });
      return token;
    },
    setMessageId(token, messageId) {
      const p = pending.get(token);
      if (p) p.messageId = messageId;
    },
    take(token) {
      const p = pending.get(token);
      pending.delete(token);
      return p;
    },
    forChat: (chatId) => [...pending.values()].filter((p) => p.chatId === chatId),
  };
}

export type TypedApprovalResult =
  /** The message answered an approval (already resolved). */
  | { kind: "answered"; approval: PendingApproval; decision: ApprovalDecision }
  /** It was aimed at an approval but isn't answerable as-is — say this and don't route it. */
  | { kind: "remind"; text: string }
  /** Not an approval answer — route it normally; show `reminder` if an approval is still waiting. */
  | { kind: "pass"; reminder?: string };

const short = (s: string) => (s.length > 120 ? s.slice(0, 117) + "…" : s);

/** Decide whether a typed message answers one of the chat's pending approvals, and resolve it if so. */
export function answerTypedApproval(
  store: PendingApprovals,
  input: { chatId: number; text: string; replyToMessageId?: number },
): TypedApprovalResult {
  const open = store.forChat(input.chatId);
  if (open.length === 0) return { kind: "pass" };
  const decision = parseApprovalReply(input.text);
  const settle = (p: PendingApproval, d: ApprovalDecision): TypedApprovalResult => {
    store.take(p.token);
    p.resolve(d);
    return { kind: "answered", approval: p, decision: d };
  };

  // A quote-reply to the approval prompt itself is unambiguous about WHICH approval.
  const target = input.replyToMessageId !== undefined ? open.find((p) => p.messageId === input.replyToMessageId) : undefined;
  if (target) {
    if (decision) return settle(target, decision);
    return { kind: "remind", text: `That approval needs a yes or no (or tap Allow/Deny): ${short(target.reason)}` };
  }

  if (decision && input.replyToMessageId === undefined) {
    if (open.length === 1) return settle(open[0]!, decision);
    return {
      kind: "remind",
      text: `${open.length} approvals are waiting — reply "${input.text.trim()}" to the one you mean, or tap its button.`,
    };
  }

  const waiting = open[0]!;
  return {
    kind: "pass",
    reminder: `⚠️ Still waiting on your Allow/Deny${open.length > 1 ? ` (${open.length} pending)` : ""}: ${short(waiting.reason)} — reply yes or no.`,
  };
}
