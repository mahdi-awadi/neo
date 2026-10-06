// The cause seam (ADR-0015): the one module that owns message ids, threads and refs. Frontends call
// inbound() for every operator line, the pipeline calls outbound() for every Neo line, and engine-
// started work calls root(). Thread choice is deterministic (spec §4.1) — no time window, no text
// matching. Thread state is derived by refreshThread() only (spec §5). Contained: nothing here
// throws for an unknown reply target or a pruned thread.
import type { Cause, Ledger, MessageKind, ThreadArtifacts, ThreadOrigin, ThreadRow, ThreadState } from "./ledger";
import type { Priority } from "./priority";
import type { Registry } from "./registry";
import { faults } from "./fault";
import { deriveThreadState } from "./thread-state";
import { todoTitle } from "./todo-title";

export type { Cause };

/** The system chat that owns engine-started roots (no operator chat exists for them). A reserved id of
 *  its own: 0 is the web console, -1 the default, -2 SUB_CHAT, -3 CUSTOMER_CHAT. */
export const ENGINE_CHAT_ID = -4;

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
  /** A Neo line goes out. Writes the row under `cause` (none: a line nobody caused), returns its id.
   *  `role: "user"` files an operator reply that is not a new message (an approval verdict). */
  outbound(p: {
    chatId: number; text: string; cause?: Cause; kind?: MessageKind; role?: "assistant" | "user";
    /** When the line was written (default: the trace's clock). */
    at?: number;
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
  /** Hear every thread whose state changed or that a new line joined (the console moves its row live, ADR-0017). Returns the
   *  unsubscribe. A listener that throws is reported; the refresh is never affected. */
  onThreadChange(listener: (c: ThreadChange) => void): () => void;
}

/** One thread state change, as the console's `thread` event carries it. */
export interface ThreadChange {
  id: number;
  state: ThreadState;
  project?: string;
  title: string;
  updatedAt: number;
}

/** The ref a line carries (spec §4.3): acks, a turn's first reply and result-like lines; never progress. */
export function refSuffix(kind: MessageKind, firstOfTurn: boolean, ref: string, mode: "auto" | "off"): string {
  if (mode === "off") return "";
  const show =
    kind === "ack" || kind === "result" || kind === "decision" || kind === "alert" || kind === "digest" || kind === "plan" ||
    (kind === "text" && firstOfTurn);
  return show ? ` · \`${ref}\`` : "";
}

/** /trace shows every child up to this many; over it, the head and tail below and a console link (spec §4.4). */
const RENDER_ALL_MAX = 40;
const RENDER_HEAD = 10;
const RENDER_TAIL = 25;

/** Where the console serves a thread's full tree (GET /api/trace/:ref), under the configured base URL. */
export function traceUrl(consoleUrl: string, ref: string): string {
  return `${consoleUrl.replace(/\/+$/, "")}/api/trace/${ref}`;
}

/**
 * A thread tree as /trace text (spec §4.4): the root line, its state and project, then every child
 * (messages, orders, todos, decisions) in time order with its ref, kind and status. Over 40 children
 * it shows the first 10, "… N more …", the last 25 and a link to the console. A pruned thread says so
 * and lists what still exists. Pure.
 */
export function renderTrace(tree: TraceTree, ref: (id: number) => string, opts: { consoleUrl?: string } = {}): string {
  const rootId = tree.thread?.id;
  const children: Array<{ at: number; line: string }> = [
    ...tree.messages
      .filter((m) => m.id !== rootId)
      .map((m) => ({ at: m.at, line: `${ref(m.id)} · ${m.kind} · ${m.role === "user" ? "you: " : ""}${todoTitle(m.content)}` })),
    ...tree.orders.map((o) => ({ at: o.createdAt, line: `${o.id.slice(0, 8)} · order · ${o.status ?? "running"} · ${o.folder}` })),
    ...tree.todos.map((t) => ({ at: t.createdAt, line: `#${t.id} · todo · ${t.status} · ${todoTitle(t.brief)}` })),
    ...tree.decisions.map((d) => ({ at: d.createdAt, line: `${d.id.slice(0, 8)} · ${d.kind} · ${d.status} · ${todoTitle(d.question)}` })),
  ].sort((a, b) => a.at - b.at); // stable: equal times keep their kind order

  const head = tree.thread
    ? [`🧵 ${ref(tree.thread.id)} · ${tree.thread.title}`, `${tree.thread.state} · ${tree.thread.project ?? "no project"} · ${tree.thread.origin}`]
    : [tree.pruned ? "🧵 thread pruned — what still exists:" : "🧵 no thread"];
  const body =
    children.length <= RENDER_ALL_MAX
      ? children.map((c) => c.line)
      : [
          ...children.slice(0, RENDER_HEAD).map((c) => c.line),
          `… ${children.length - RENDER_HEAD - RENDER_TAIL} more …`,
          ...children.slice(-RENDER_TAIL).map((c) => c.line),
        ];
  if (tree.pruned && children.length === 0) body.push("(nothing left)");
  const tail: string[] = [];
  if (tree.toolActions > 0) tail.push(`tool actions: ${tree.toolActions}`);
  if (tree.truncated) tail.push("(only the newest messages are listed)");
  if (tree.thread && (children.length > RENDER_ALL_MAX || tree.truncated)) tail.push(`full thread: ${traceUrl(opts.consoleUrl ?? "", ref(tree.thread.id))}`);
  return [...head, ...body, ...tail].join("\n");
}

/** A message's compact ref: base36 of its id with an `m` prefix (`m4f2`) — the one encoding. */
export const msgRef = (msgId: number): string => `m${msgId.toString(36)}`;

export function createTrace(deps: {
  ledger: Ledger;
  registry: Registry;
  now?: () => number;
  /** The company's folder: its own lines never name a thread's project (spec §3.2). */
  companyFolder?: string;
}): Trace {
  const { ledger, registry } = deps;
  const now = deps.now ?? Date.now;

  /** `touchedAt`: a line just joined the thread — tell the listeners even when the state holds, so
   *  the console moves the row to the top. */
  function refreshThread(threadId: number, touchedAt?: number): void {
    const thread = ledger.threadById(threadId);
    if (!thread) return; // pruned: artifacts keep the ids, nothing to update
    const facts = ledger.threadFacts(threadId);
    // A session works this thread while a cause of the thread is delivered to it and not yet answered.
    const inThread = registry.list().filter((s) => registry.pendingCauses(s.id).some((c) => c.threadId === threadId));
    const state = deriveThreadState({
      openDecisions: facts.openDecisions,
      pendingApprovals: inThread.filter((s) => s.blockedOn?.kind === "approval").length,
      activeWork: facts.activeTodos + inThread.length,
      lastEnd: facts.lastEnd,
      closedByOperator: facts.closedByOperator,
    });
    let at: number;
    if (state !== thread.state) {
      at = now();
      ledger.setThreadState(threadId, state, at);
    } else if (touchedAt !== undefined) at = thread.updatedAt;
    else return;
    const change: ThreadChange = { id: threadId, state, ...(thread.project !== undefined ? { project: thread.project } : {}), title: thread.title, updatedAt: at };
    for (const l of threadListeners) faults.guard("trace.threadListener", () => l(change), { threadId });
  }
  const threadListeners = new Set<(c: ThreadChange) => void>();

  function newThread(rootMsgId: number, origin: ThreadOrigin, title: string, at: number, project?: string, folder?: string): void {
    ledger.setMessageThread(rootMsgId, rootMsgId);
    ledger.insertThread({ id: rootMsgId, origin, title, state: "done", createdAt: at, project, folder });
  }

  /** A line joined a thread: mark it the newest and re-derive the state. Best-effort (ADR-0010): the
   *  line is already written, so a fault here is reported, never thrown at the operator's line. */
  function bookkeep(component: string, line: Cause, at: number, learn?: { project: string; folder: string }): void {
    faults.guard(component, () => {
      ledger.touchThread(line.threadId, line.msgId, at, learn);
      refreshThread(line.threadId, at);
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
      const at = p.at ?? now();
      const msgId = ledger.insertMessage({
        chatId: p.chatId, role: p.role ?? "assistant", content: p.text, at, surface: "engine", kind: p.kind ?? "text",
        threadId: p.cause?.threadId, causeId: p.cause?.msgId,
        project: p.project, folder: p.folder, orderId: p.orderId, priority: p.priority,
      });
      // A line that worked in a project (not the company) teaches its thread that project, once.
      const learn = p.project && p.folder && p.folder !== deps.companyFolder ? { project: p.project, folder: p.folder } : undefined;
      if (p.cause) bookkeep("trace.outbound", { msgId, threadId: p.cause.threadId }, at, learn);
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
    ref: msgRef,
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
    refreshThread: (threadId) => refreshThread(threadId),
    onThreadChange(listener) {
      threadListeners.add(listener);
      return () => void threadListeners.delete(listener);
    },
  };
}
