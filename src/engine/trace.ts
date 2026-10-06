// The cause seam (ADR-0015): the one module that owns message ids, threads and refs. Frontends call
// inbound() for every operator line, the pipeline calls outbound() for every Neo line, and engine-
// started work calls root(). Thread choice is deterministic (spec §4.1) — no time window, no text
// matching. Thread state is derived by refreshThread() only (spec §5). Contained: nothing here
// throws for an unknown reply target or a pruned thread.
import type { Cause, Ledger, MessageKind, ThreadArtifacts, ThreadOrigin, ThreadRow } from "./ledger";
import type { Priority } from "./priority";
import type { Registry } from "./registry";
import { faults } from "./fault";
import { deriveThreadState } from "./thread-state";
import { todoTitle } from "./todo-title";

export type { Cause };

/** The system chat that owns engine-started roots (no operator chat exists for them). */
export const ENGINE_CHAT_ID = 0;

const TREE_LIMIT = 200;
const EMPTY = { orders: [], todos: [], decisions: [], toolActions: 0 };

/** A thread and what it produced (spec §4.4). `thread` is undefined when its row is gone: retention
 *  pruned it (`pruned: true`), or the message never had a thread. `truncated`: more messages exist than `limit`. */
export interface TraceTree extends ThreadArtifacts {
  thread: ThreadRow | undefined;
  pruned: boolean;
  /** The thread's messages, oldest first, the newest `limit` of them. */
  messages: Array<ReturnType<Ledger["messagesInThread"]>[number]>;
  truncated: boolean;
}

export interface Trace {
  /** An operator line arrives. Picks its thread (§4.1), writes the row, returns its cause. */
  inbound(p: {
    chatId: number; text: string; surface: "telegram" | "web"; channelMsgId?: number;
    replyTo?: { chatId: number; channelMsgId: number };
    /** The web composer opened inside a thread. */
    threadId?: number;
  }): Cause;
  /** A Neo line goes out. Writes the row under `cause` (none: a line nobody caused), returns its id. */
  outbound(p: {
    chatId: number; text: string; cause?: Cause; kind?: MessageKind;
    project?: string; folder?: string; orderId?: string; priority?: Priority;
  }): number;
  /** The channel posted an outbound row; remember its Telegram id (reply → thread). */
  bindChannel(msgId: number, chatId: number, channelMsgId: number): void;
  /** Engine-started work (loop fire, attention todo, ingress) gets its own root. */
  root(p: { origin: ThreadOrigin; title: string; project?: string; folder?: string }): Cause;
  /** Compact ref: base36 of the id with an 'm' prefix — `m4f2`. Parse accepts `m4f2`, `#m4f2`, `4f2`. */
  ref(msgId: number): string;
  parseRef(s: string): number | undefined;
  /** Everything a message (or its thread) produced, oldest first. Bounded. */
  tree(msgId: number, opts?: { limit?: number }): TraceTree;
  /** Re-derive and store a thread's state from its linked facts. Idempotent; a no-op for a pruned thread. */
  refreshThread(threadId: number): void;
}

/** The ref a line carries (spec §4.3): acks, a turn's first reply and result-like lines; never progress. */
export function refSuffix(kind: MessageKind, firstOfTurn: boolean, ref: string, mode: "auto" | "off"): string {
  if (mode === "off") return "";
  const show =
    kind === "ack" || kind === "result" || kind === "decision" || kind === "alert" || kind === "digest" || kind === "plan" ||
    (kind === "text" && firstOfTurn);
  return show ? ` · \`${ref}\`` : "";
}

export function createTrace(deps: { ledger: Ledger; registry: Registry; now?: () => number }): Trace {
  const { ledger, registry } = deps;
  const now = deps.now ?? Date.now;

  function refreshThread(threadId: number): void {
    const thread = ledger.threadById(threadId);
    if (!thread) return; // pruned: artifacts keep the ids, nothing to update
    const facts = ledger.threadFacts(threadId);
    const inThread = registry.list().filter((s) => registry.causeOf(s.id)?.threadId === threadId);
    const state = deriveThreadState({
      openDecisions: facts.openDecisions,
      pendingApprovals: inThread.filter((s) => s.blockedOn?.kind === "approval").length,
      activeWork: facts.activeTodos + inThread.length,
      lastEnd: facts.lastEnd,
      closedByOperator: facts.closedByOperator,
    });
    if (state !== thread.state) ledger.setThreadState(threadId, state, now());
  }

  function newThread(rootMsgId: number, origin: ThreadOrigin, title: string, at: number, project?: string, folder?: string): void {
    ledger.setMessageThread(rootMsgId, rootMsgId);
    ledger.insertThread({ id: rootMsgId, origin, title, state: "done", createdAt: at, project, folder });
  }

  /** A line joined a thread: mark it the newest and re-derive the state. Best-effort (ADR-0010): the
   *  line is already written, so a fault here is reported, never thrown at the operator's line. */
  function bookkeep(component: string, line: Cause, at: number): void {
    faults.guard(component, () => {
      ledger.touchThread(line.threadId, line.msgId, at);
      refreshThread(line.threadId);
    }, { msgId: line.msgId, threadId: line.threadId });
  }

  /** Rule 1: the thread (and message) a Telegram reply target belongs to, if we know it. */
  function replyTarget(r: { chatId: number; channelMsgId: number }): { threadId: number; msgId?: number } | undefined {
    const m = ledger.messageByChannel(r.chatId, r.channelMsgId);
    if (m?.threadId !== undefined) return { threadId: m.threadId, msgId: m.id };
    const c = ledger.routeCause(r.chatId, r.channelMsgId);
    return c ? { threadId: c.threadId, msgId: c.msgId } : undefined;
  }

  return {
    inbound(p) {
      const at = now();
      const target = (p.replyTo && replyTarget(p.replyTo)) || undefined;
      const web = p.threadId !== undefined && ledger.threadById(p.threadId) ? p.threadId : undefined;
      const joined = target && ledger.threadById(target.threadId) ? target : web !== undefined ? { threadId: web } : undefined;
      // The row and (for a new thread) its thread land together: a crash never leaves a message
      // pointing at a thread that does not exist. This part is the must-have — a throw here is the caller's.
      const cause = ledger.transaction((): Cause => {
        const msgId = ledger.insertMessage({
          chatId: p.chatId, role: "user", content: p.text, at, surface: p.surface, channelMsgId: p.channelMsgId, kind: "text",
          threadId: joined?.threadId, causeId: joined && "msgId" in joined ? joined.msgId : undefined,
        });
        if (joined) return { msgId, threadId: joined.threadId };
        newThread(msgId, "operator", todoTitle(p.text), at);
        return { msgId, threadId: msgId };
      });
      bookkeep("trace.inbound", cause, at);
      return cause;
    },
    outbound(p) {
      const at = now();
      const msgId = ledger.insertMessage({
        chatId: p.chatId, role: "assistant", content: p.text, at, surface: "engine", kind: p.kind ?? "text",
        threadId: p.cause?.threadId, causeId: p.cause?.msgId,
        project: p.project, folder: p.folder, orderId: p.orderId, priority: p.priority,
      });
      if (p.cause) bookkeep("trace.outbound", { msgId, threadId: p.cause.threadId }, at);
      return msgId;
    },
    bindChannel(msgId, chatId, channelMsgId) {
      ledger.setChannelMsg(msgId, chatId, channelMsgId);
    },
    root(p) {
      const at = now();
      const msgId = ledger.transaction(() => {
        const id = ledger.insertMessage({
          chatId: ENGINE_CHAT_ID, role: "assistant", content: p.title, at, surface: "engine", kind: "notice",
          project: p.project, folder: p.folder,
        });
        newThread(id, p.origin, todoTitle(p.title), at, p.project, p.folder);
        return id;
      });
      bookkeep("trace.root", { msgId, threadId: msgId }, at);
      return { msgId, threadId: msgId };
    },
    ref: (msgId) => `m${msgId.toString(36)}`,
    parseRef(s) {
      const m = /^(#?m|#)?([0-9a-z]+)$/.exec(s.trim().toLowerCase());
      if (!m) return undefined;
      // A bare word ("hello") is not a ref: without an m/# marker it must hold a digit.
      if (!m[1] && !/\d/.test(m[2]!)) return undefined;
      const n = parseInt(m[2]!, 36);
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    },
    tree(msgId, opts) {
      const limit = opts?.limit ?? TREE_LIMIT;
      const threadId = ledger.messageById(msgId)?.threadId;
      if (threadId === undefined) return { thread: undefined, pruned: false, messages: [], truncated: false, ...EMPTY };
      const thread = ledger.threadById(threadId);
      // The newest page, shown oldest first; one extra row tells us whether more exist.
      const page = ledger.messagesInThread(threadId, { limit: limit + 1 });
      return {
        thread,
        pruned: thread === undefined,
        messages: page.slice(0, limit).reverse(),
        truncated: page.length > limit,
        ...ledger.threadArtifacts(threadId, limit),
      };
    },
    refreshThread,
  };
}
