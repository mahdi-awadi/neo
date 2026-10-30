// The task history's customer firewall (ADR-0066 Decision 7, spec "Sources"): the verdict for one source
// row, decided on facts the ledger reads (an order's lineage, a thread's origin) and failing closed. An
// order is excluded when it or any ancestor (by `parent_order_id`, up to the lineage depth) is on
// CUSTOMER_CHAT, has a source other than `neo`, or sits on an `ingress` thread — and when the chain has a
// missing order, a missing thread or goes on past the depth. Other rows follow their order and are also
// excluded on their own ingress thread or CUSTOMER_CHAT. A row the rules cannot place is excluded and
// counted. Pure over its inputs; this module (and all of src/engine/history/) never imports the inbox.
import { CUSTOMER_CHAT } from "../chats";
import type { LineageNode, OrderLineage, ThreadOrigin } from "../ledger";

/** Why a row is not indexed. Counted per rule in the `history_firewall_skip` event. */
export type FirewallRule =
  | "customer_chat" | "not_neo_source" | "ingress_thread" | "missing_thread" | "ancestor_excluded"
  | "missing_order" | "missing_parent" | "too_deep" | "unclassified" | "unknown_table";

/** `wait`: the row cannot be placed yet (a todo with no order and no thread) — not indexed, not counted. */
export type Verdict = { verdict: "ok" } | { verdict: "wait" } | { verdict: "excluded"; rule: FirewallRule };

/** What the firewall reads. `threadOrigin` gives undefined for a thread with no row. */
export interface FirewallLookups {
  lineage(orderId: string): OrderLineage | undefined;
  threadOrigin(threadId: number): ThreadOrigin | undefined;
}

/** The facts that place a non-order row: its own chat, its own thread and the order it belongs to. */
export interface Anchors {
  chatId?: number;
  threadId?: number;
  orderId?: string;
}

const OK: Verdict = { verdict: "ok" };
const excluded = (rule: FirewallRule): Verdict => ({ verdict: "excluded", rule });

/** The rule one lineage node breaks by itself, if any. */
function nodeRule(n: LineageNode): FirewallRule | undefined {
  if (n.chatId === CUSTOMER_CHAT) return "customer_chat";
  if (n.source !== "neo") return "not_neo_source";
  if (n.threadId !== undefined) {
    if (n.threadOrigin === undefined) return "missing_thread";
    if (n.threadOrigin === "ingress") return "ingress_thread";
  }
  return undefined;
}

/** An order's verdict from its lineage (itself first). No lineage, or no row for the order, is
 *  `missing_order`; an ancestor that breaks a rule is `ancestor_excluded`. */
export function orderVerdict(l: OrderLineage | undefined): Verdict {
  if (!l || l.chain.length === 0 || l.missing === l.orderId) return excluded("missing_order");
  for (const [i, n] of l.chain.entries()) {
    const rule = nodeRule(n);
    if (rule) return excluded(i === 0 ? rule : "ancestor_excluded");
  }
  if (l.missing !== undefined) return excluded("missing_parent");
  if (l.tooDeep || !l.complete) return excluded("too_deep");
  return OK;
}

/** A row's verdict from its anchors. Its own CUSTOMER_CHAT and its own thread are checked first, then its
 *  order. With neither an order nor a thread, the row takes `unanchored`: `ok` (an operator line), `wait`
 *  (a todo not placed yet) or `unclassified` (excluded). */
export function anchoredVerdict(a: Anchors, look: FirewallLookups, unanchored: "ok" | "wait" | "unclassified"): Verdict {
  if (a.chatId === CUSTOMER_CHAT) return excluded("customer_chat");
  if (a.threadId !== undefined) {
    const origin = look.threadOrigin(a.threadId);
    if (origin === undefined) return excluded("missing_thread");
    if (origin === "ingress") return excluded("ingress_thread");
  }
  if (a.orderId !== undefined) return orderVerdict(look.lineage(a.orderId));
  if (a.threadId !== undefined) return OK;
  if (unanchored === "ok") return OK;
  if (unanchored === "wait") return { verdict: "wait" };
  return excluded("unclassified");
}

/** Per-rule counts of excluded rows, for the `history_firewall_skip` event. */
export type FirewallCounts = Partial<Record<FirewallRule, number>>;

export function countRule(counts: FirewallCounts, rule: FirewallRule): void {
  counts[rule] = (counts[rule] ?? 0) + 1;
}
