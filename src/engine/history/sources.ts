// The task history's sources (ADR-0066 Decision 3, spec "Sources"): one ledger row → one source extract
// (ref, kind, project, `at`, title, meta, text and the hash of all of them), after the firewall verdict
// (firewall.ts) and the "is it a source" rules. Engine blocks and boilerplate leave a brief; a plan file is
// read only inside its project folder under the work root (realpath, `.md`, at most `planMaxBytes`).
// `prepareChunks` cuts the text and applies the chunk rules: a chunk with a secret shape (`findSecret`,
// ADR-0043) is dropped and the event names the pattern, never the text; prompt-injection shapes (the
// memory scan's) are made harmless and the chunk is flagged. Pure apart from the plan file read.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { explainAttention } from "../attention-explain";
import type { AttentionRow, DecisionRow, HistoryOrderRow, HistoryOutcomeRow, HistoryRowMap, HistoryTable, Ledger, MessageRow, OrderLineage, PlanRow, ThreadOrigin, TodoRow } from "../ledger";
import { MEMORY_INJECTION_PATTERNS } from "../memory";
import { noteView } from "../project-notes";
import { findSecret } from "../secret-patterns";
import { summarizeBrief, todoLabel, todoTitle } from "../todo-title";
import { SIDE_CHAT, SUB_CHAT } from "../chats";
import { chunkText } from "./chunker";
import type { ChunkCfg, SourcesCfg } from "./defaults";
import { findShas, hashText, removeBoilerplate, stripEngineBlocks, unwrapContinuation } from "./extract";
import { anchoredVerdict, orderVerdict, type Anchors, type FirewallLookups, type FirewallRule, type Verdict } from "./firewall";
import type { ChunkInput, HistoryKind, SourceInput, SourceMeta } from "./store";

type TodoSourceRow = TodoRow & { threadId?: number };
type DecisionSourceRow = DecisionRow & { threadId?: number };

/** What sources read besides the row: the firewall facts, and the order, todo and thread a row points at. */
export interface SourceLookups extends FirewallLookups {
  order(id: string): HistoryOrderRow | undefined;
  /** Whether an order the firewall excludes (a customer-driven brief) was made for `folder` from `from` to
   *  `to`, other than `self`: such a brief is delivered into the live session of that folder. */
  customerDelivery(folder: string, from: number, to: number, self?: string): boolean;
  todo(id: number): TodoSourceRow | undefined;
  thread(id: number): { origin: ThreadOrigin; project?: string } | undefined;
}

export interface SourceCtx {
  look: SourceLookups;
  /** Plan folders must resolve inside this folder. */
  workRoot: string;
  cfg: SourcesCfg;
  /** Paragraph hashes that are boilerplate (`store.boilerplate(cfg.boilerplateMinRows)`). */
  boilerplate: ReadonlySet<string>;
}

/** A source and the text its chunks are cut from. `keepText`: the plan file could not be read — keep the
 *  chunks already stored (`text` is only the title, for a source that has none yet). */
export interface SourceExtract extends SourceInput {
  text: string;
  keepText?: boolean;
}

/** `none`: the row is not (or no longer) a source — an entry under `ref` goes. `wait`: not placed yet.
 *  `excluded`: the firewall's rule (`ref` absent when the row could not even be named). */
export type Extracted =
  | { status: "source"; source: SourceExtract }
  | { status: "none"; ref: string }
  | { status: "wait"; ref: string }
  | { status: "excluded"; ref?: string; rule: FirewallRule };

/** Lookups over the ledger's history reads, cached for one batch. `prime` reads many lineages in one query. */
export function ledgerLookups(
  ledger: Pick<Ledger, "historyLineage" | "historyRows" | "threadById" | "historyFolderOrders">,
  cfg: Pick<SourcesCfg, "lineageDepth">,
): SourceLookups & { prime(orderIds: string[]): void } {
  const lineages = new Map<string, OrderLineage>();
  const orders = new Map<string, HistoryOrderRow | undefined>();
  const todos = new Map<number, TodoSourceRow | undefined>();
  const threads = new Map<number, { origin: ThreadOrigin; project?: string } | undefined>();
  const prime = (ids: string[]) => {
    const todo = [...new Set(ids)].filter((id) => !lineages.has(id));
    if (todo.length) for (const [id, l] of ledger.historyLineage(todo, { maxDepth: cfg.lineageDepth })) lineages.set(id, l);
  };
  const thread = (id: number) => {
    if (!threads.has(id)) {
      const t = ledger.threadById(id);
      threads.set(id, t ? { origin: t.origin, ...(t.project !== undefined ? { project: t.project } : {}) } : undefined);
    }
    return threads.get(id);
  };
  return {
    prime,
    lineage(id) {
      prime([id]);
      return lineages.get(id);
    },
    threadOrigin: (id) => thread(id)?.origin,
    thread,
    order(id) {
      if (!orders.has(id)) orders.set(id, ledger.historyRows("orders", [id])[0]?.row);
      return orders.get(id);
    },
    customerDelivery(folder, from, to, self) {
      if (!(to >= from)) return false;
      const ids = ledger.historyFolderOrders(folder, from, to, DELIVERY_SCAN).filter((id) => id !== self);
      prime(ids);
      // More orders than one read holds: fail closed.
      return ids.length >= DELIVERY_SCAN || ids.some((id) => orderVerdict(lineages.get(id)).verdict !== "ok");
    },
    todo(id) {
      if (!todos.has(id)) todos.set(id, ledger.historyRows("project_todos", [String(id)])[0]?.row);
      return todos.get(id);
    },
  };
}

/** Orders one delivery check reads; a folder with more in the window is treated as tainted (fail closed). */
const DELIVERY_SCAN = 500;

// ── Extraction ──────────────────────────────────────────────────────────────────────────────────────────

const RESULT_STATUSES = new Set(["done", "error", "failed"]);
const DISPATCH_CHATS = new Set([SUB_CHAT, SIDE_CHAT]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** The minimal shape each table's row must have; a row without it cannot be classified. */
const SHAPES: { [T in HistoryTable]: (r: Record<string, unknown>) => boolean } = {
  orders: (r) => isStr(r.id) && isStr(r.source) && isStr(r.folder) && isStr(r.task) && isInt(r.chatId) && isInt(r.createdAt),
  outcomes: (r) => isStr(r.orderId) && isStr(r.status) && isStr(r.summary) && isInt(r.at),
  project_todos: (r) => isInt(r.id) && isStr(r.brief) && isStr(r.project) && isInt(r.createdAt),
  plans: (r) => isInt(r.id) && isStr(r.title) && isStr(r.folder) && isStr(r.path) && isStr(r.project) && isInt(r.updatedAt),
  attention_items: (r) => isInt(r.id) && isStr(r.source) && isStr(r.title) && isStr(r.project) && isInt(r.firstSeen),
  decisions: (r) => isStr(r.id) && isStr(r.question) && isStr(r.status) && isInt(r.createdAt),
  messages: (r) => isInt(r.id) && isInt(r.chatId) && isStr(r.role) && isStr(r.content) && isInt(r.at),
};
const isTable = (t: string): t is HistoryTable => Object.hasOwn(SHAPES, t);

/** The source of one ledger row of `table` (a `historyRows`/`historyScan` row). Never throws: an unknown
 *  table or a row of the wrong shape is excluded (`unknown_table`, `unclassified`). */
export function extractSource(table: string, row: unknown, ctx: SourceCtx): Extracted {
  if (!isTable(table)) return { status: "excluded", rule: "unknown_table" };
  if (!isObj(row) || !SHAPES[table](row)) return { status: "excluded", rule: "unclassified" };
  try {
    return EXTRACT[table](row as never, ctx);
  } catch {
    return { status: "excluded", rule: "unclassified" };
  }
}

const EXTRACT: { [T in HistoryTable]: (row: HistoryRowMap[T], ctx: SourceCtx) => Extracted } = {
  orders(o, ctx) {
    const ref = `order:${o.id}`;
    const v = orderVerdict(ctx.look.lineage(o.id));
    if (v.verdict !== "ok") return gate(ref, v);
    if (o.todoId !== undefined || !DISPATCH_CHATS.has(o.chatId)) return { status: "none", ref };
    const text = briefText(o.task, ctx);
    return made(ref, "order", o.id, {
      project: basename(o.folder), at: o.createdAt, title: summarizeBrief(text), text,
      meta: { order: o.id, ...(o.threadId !== undefined ? { thread: o.threadId } : {}) },
    });
  },

  outcomes(r: HistoryOutcomeRow, ctx) {
    const ref = `result:${r.orderId}`;
    const v = anchoredVerdict({ orderId: r.orderId }, ctx.look, "unclassified");
    if (v.verdict !== "ok") return gate(ref, v);
    if (!RESULT_STATUSES.has(r.status)) return { status: "none", ref };
    const o = ctx.look.order(r.orderId);
    if (!o) return { status: "excluded", ref, rule: "missing_order" };
    // The run took a customer-driven brief before it ended: its result may carry that turn.
    if (ctx.look.customerDelivery(o.folder, o.createdAt, r.at, o.id)) return { status: "excluded", ref, rule: "customer_delivery" };
    const t = o.todoId !== undefined ? ctx.look.todo(o.todoId) : undefined;
    const title = `Result: ${t ? todoLabel(t) : summarizeBrief(briefText(o.task, ctx))}`;
    return made(ref, "result", r.orderId, {
      project: t?.project ?? basename(o.folder), at: r.at, title, text: r.summary.trim(),
      meta: { ...(t ? { todo: t.id } : {}), order: r.orderId, ...(o.threadId !== undefined ? { thread: o.threadId } : {}) },
    });
  },

  project_todos(t: TodoSourceRow, ctx) {
    const ref = `todo:${t.id}`;
    const thread = t.threadId ?? t.cause?.threadId;
    const v = anchoredVerdict({ orderId: t.orderId, threadId: thread }, ctx.look, "wait");
    if (v.verdict !== "ok") return gate(ref, v);
    return made(ref, "todo", t.id, {
      project: t.project, at: t.createdAt, title: todoLabel(t), text: briefText(t.brief, ctx),
      meta: { todo: t.id, ...(t.orderId !== undefined ? { order: t.orderId } : {}), ...(thread !== undefined ? { thread } : {}) },
    });
  },

  plans(p: PlanRow, ctx) {
    const ref = `plan:${p.id}`;
    let anchors: Anchors = { orderId: p.orderId, threadId: p.threadId };
    if (p.orderId === undefined && p.threadId === undefined && p.todoId !== undefined) {
      // Only a todo: the plan follows that todo's order and thread.
      const t = ctx.look.todo(p.todoId);
      anchors = t ? { orderId: t.orderId, threadId: t.threadId ?? t.cause?.threadId } : {};
    }
    const v = anchoredVerdict(anchors, ctx.look, "unclassified");
    if (v.verdict !== "ok") return gate(ref, v);
    // A plan of a run that took a customer-driven brief before this version was written.
    const host = anchors.orderId !== undefined ? ctx.look.order(anchors.orderId) : undefined;
    if (host && ctx.look.customerDelivery(host.folder, host.createdAt, p.updatedAt, host.id)) return { status: "excluded", ref, rule: "customer_delivery" };
    const path = resolve(p.folder, p.path);
    const file = readPlanFile(p.folder, p.path, ctx.workRoot, ctx.cfg.planMaxBytes);
    const meta: SourceMeta = {
      ...(p.todoId !== undefined ? { todo: p.todoId } : {}), ...(p.orderId !== undefined ? { order: p.orderId } : {}),
      ...(p.threadId !== undefined ? { thread: p.threadId } : {}), path,
    };
    if (!file) return made(ref, "plan", p.id, { project: p.project, at: p.updatedAt, title: p.title, text: p.title.trim(), meta: { ...meta, fileMissing: true }, keepText: true });
    return made(ref, "plan", p.id, {
      project: p.project, at: p.updatedAt, title: p.title, text: `${p.title.trim()}\n\n${file.text}`,
      meta: { ...meta, ...(file.cut ? { cut: true } : {}) },
    });
  },

  attention_items(a: AttentionRow) {
    if (a.source === "note") {
      const ref = `note:${a.id}`;
      const n = noteView(a);
      const resolution = [n.state !== "open" && n.state !== "acknowledged" ? n.state : "", n.commit ?? "", n.reason ?? ""].filter(Boolean).join(": ");
      const text = [a.title, n.body, n.refs.length ? `refs: ${n.refs.join(", ")}` : "", n.answer ? `Answer: ${n.answer}` : "", resolution ? `Resolution: ${resolution}` : ""]
        .map((s) => s.trim()).filter(Boolean).join("\n\n");
      return made(ref, "note", a.id, {
        project: a.project, at: a.firstSeen, title: a.title, text,
        meta: a.fromProject !== undefined ? { from: a.fromProject } : {},
      });
    }
    const ref = `att:${a.id}`;
    if (a.source !== "github" && a.source !== "git") return { status: "none", ref };
    const e = explainAttention(a);
    const f = e.facts;
    const facts = [
      f.pr !== undefined ? `PR #${f.pr}` : "", f.issue !== undefined ? `issue #${f.issue}` : "",
      typeof f.branch === "string" ? `branch ${f.branch}` : "", typeof f.workflow === "string" ? `workflow ${f.workflow}` : "",
    ].filter(Boolean);
    return made(ref, "attention", a.id, { project: a.project, at: a.firstSeen, title: e.plain, text: [e.plain, ...facts].join("\n"), meta: {} });
  },

  decisions(d: DecisionSourceRow, ctx) {
    const ref = `dec:${d.id}`;
    const thread = d.threadId ?? d.cause?.threadId;
    const v = anchoredVerdict({ chatId: d.chatId, orderId: d.orderId, threadId: thread }, ctx.look, "unclassified");
    if (v.verdict !== "ok") return gate(ref, v);
    return made(ref, "decision", d.id, {
      project: d.project, at: d.createdAt, title: d.spec?.title?.trim() || todoTitle(d.question), text: decisionText(d),
      meta: { ...(d.orderId !== undefined ? { order: d.orderId } : {}), ...(thread !== undefined ? { thread } : {}) },
    });
  },

  messages(m: MessageRow, ctx) {
    const ref = `msg:${m.id}`;
    const kind: HistoryKind | undefined = m.kind === "digest" ? "digest" : m.role === "user" && m.surface !== "engine" ? "message" : undefined;
    const v = anchoredVerdict({ chatId: m.chatId, threadId: m.threadId, orderId: m.orderId }, ctx.look, "ok");
    if (v.verdict !== "ok") return gate(ref, v);
    if (!kind) return { status: "none", ref };
    const project = m.project ?? (m.threadId !== undefined ? ctx.look.thread(m.threadId)?.project : undefined);
    return made(ref, kind, m.id, {
      project, at: m.at, title: todoTitle(m.content), text: m.content.trim(),
      meta: { ...(m.orderId !== undefined ? { order: m.orderId } : {}), ...(m.threadId !== undefined ? { thread: m.threadId } : {}) },
    });
  },
};

/** A firewall verdict that is not `ok`, as an extraction result. */
function gate(ref: string, v: Exclude<Verdict, { verdict: "ok" }>): Extracted {
  return v.verdict === "wait" ? { status: "wait", ref } : { status: "excluded", ref, rule: v.rule };
}

/** A brief without the engine's text: the continuation wrapper unwrapped and the engine blocks gone. The
 *  boilerplate count (the indexer's backfill) hashes the paragraphs of this text. */
export function ownBrief(brief: string): string {
  return stripEngineBlocks(unwrapContinuation(stripEngineBlocks(brief)));
}

/** A brief's own words: `ownBrief` without the boilerplate paragraphs. */
function briefText(brief: string, ctx: SourceCtx): string {
  return removeBoilerplate(ownBrief(brief), ctx.boilerplate).trim();
}

function decisionText(d: DecisionSourceRow): string {
  const s = d.spec;
  const parts: string[] = [];
  if (s?.title) parts.push(s.title);
  parts.push(d.question);
  if (s?.context) parts.push(s.context);
  const questions = s?.questions?.length ? s.questions : [{ question: d.question, options: d.options ?? [] }];
  for (const q of questions) {
    if (q.question.trim() !== d.question.trim()) parts.push(q.question);
    const lines = q.options.map((label, i) => {
      const detail = "optionDetails" in q ? q.optionDetails?.[i] : undefined;
      const star = "recommended" in q && q.recommended === i ? " (recommended)" : "";
      return `- ${label}${star}${detail ? ` — ${detail}` : ""}`;
    });
    if (lines.length) parts.push(lines.join("\n"));
  }
  if (s?.recommendation) parts.push(`Recommendation: ${s.recommendation}`);
  if (d.answer) parts.push(`Answer: ${d.answer}`);
  parts.push(`Status: ${d.status}`);
  return parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
}

const WORK = /^(todo|order|result):(.+)$/;

/** The refs of one piece of work: a todo, its order and that order's result (from the ref and its meta).
 *  Forget tombstones all of them, so the work cannot come back under another of its refs (an order whose
 *  todo retention pruned is a source of its own). Another ref gives only itself. */
export function sameWorkRefs(ref: string, link: { todo?: number; order?: string }): string[] {
  const m = WORK.exec(ref);
  if (!m) return [ref];
  const order = m[1] === "todo" ? link.order : m[2];
  const todo = m[1] === "todo" ? m[2] : link.todo;
  return [...new Set([ref, ...(todo !== undefined ? [`todo:${todo}`] : []), ...(order !== undefined ? [`order:${order}`, `result:${order}`] : [])])];
}

/** The commit shas of `texts`, never one on a line the secret finder matches (a hex key in a `token: …`
 *  line is sha-shaped). The indexer calls it again on the chunks it keeps, so a sha only in a dropped
 *  chunk is never a commit either. */
export function safeCommits(texts: string[]): string[] {
  const lines = texts.flatMap((t) => t.split("\n")).filter((l) => !findSecret(l));
  return findShas(lines.join("\n"));
}

/** Build the extract: commits from the text, a title that is safe to show, and the hash of every field. */
function made(
  ref: string, kind: HistoryKind, id: string | number,
  f: { project?: string; at: number; title: string; text: string; meta: SourceMeta; keepText?: boolean },
): Extracted {
  const title = safeTitle(f.title, kind, id);
  const meta: SourceMeta = { ...f.meta, commits: safeCommits([f.text, title]) };
  const project = f.project?.trim() || undefined;
  const hash = hashText(JSON.stringify([kind, project ?? null, f.at, title, meta, f.text, f.keepText ?? false]));
  return {
    status: "source",
    source: { ref, kind, ...(project !== undefined ? { project } : {}), at: f.at, title, hash, meta, text: f.text, ...(f.keepText ? { keepText: true } : {}) },
  };
}

/** A title with a secret shape becomes the kind and the id; an injection shape is made harmless. */
function safeTitle(title: string, kind: HistoryKind, id: string | number): string {
  if (findSecret(title)) return `${kind} ${id}`;
  return defang(title.trim()).text || `${kind} ${id}`;
}

// ── Plan files ──────────────────────────────────────────────────────────────────────────────────────────

const within = (parent: string, child: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const isMd = (p: string): boolean => p.toLowerCase().endsWith(".md");

/** A plan file's text when it resolves (realpath) to a regular `.md` file inside `folder`, and `folder`
 *  inside `workRoot`: at most `maxBytes`, cut on a character boundary. Undefined when missing or refused. */
function readPlanFile(folder: string, path: string, workRoot: string, maxBytes: number): { text: string; cut: boolean } | undefined {
  try {
    const root = realpathSync(workRoot);
    const dir = realpathSync(folder);
    if (!within(root, dir) || !isMd(path)) return undefined;
    const real = realpathSync(resolve(dir, path));
    if (!within(dir, real) || !isMd(real)) return undefined;
    // O_NOFOLLOW: the checked path is opened as it is, never through a link swapped in after the check.
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return undefined;
      const want = Math.max(0, Math.min(st.size, maxBytes));
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, got);
        if (n === 0) break;
        got += n;
      }
      const cut = st.size > got;
      // `stream: true` holds back a character cut in half instead of emitting U+FFFD.
      const text = new TextDecoder("utf-8").decode(buf.subarray(0, got), { stream: cut });
      return { text, cut };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// ── Chunks: secrets and injection ───────────────────────────────────────────────────────────────────────

/** `chunks.flags`: the chunk held a prompt-injection shape, made harmless. */
export const CHUNK_FLAG_INJECTION = 1;

/** How far around a chunk boundary a secret cut in two is looked for. */
const BOUNDARY_WINDOW = 256;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const INJECTION = MEMORY_INJECTION_PATTERNS.map(({ pattern }) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
/** The closing form of a tag the scan names by its opening form. */
const CLOSING_TAG = /<\/system-reminder/gi;

/** `text` with each prompt-injection shape made harmless: an angle bracket in it is replaced, a phrase is
 *  quoted. `flagged` when one was found. */
export function defang(text: string): { text: string; flagged: boolean } {
  let flagged = false;
  let out = text;
  for (const re of [...INJECTION, CLOSING_TAG]) {
    out = out.replace(re, (m) => {
      flagged = true;
      return m.includes("<") ? m.replace(/</g, "‹") : `«${m}»`;
    });
  }
  return { text: out, flagged };
}

export interface PreparedChunks {
  chunks: ChunkInput[];
  /** Chunks dropped for a secret shape. */
  skippedSecret: number;
  /** The text had more than `maxPerRef` chunks and was cut. */
  cut: boolean;
}

/** Cut `text` into chunks and apply the chunk rules. A chunk is dropped when it has a secret shape, when a
 *  secret is cut across one of its boundaries, or when it lies in a private-key block. One
 *  `history_secret_skip` event per pattern, with the ref, the pattern name and the chunk count. */
export function prepareChunks(ref: string, text: string, cfg: ChunkCfg, events: (kind: string, data: Record<string, unknown>) => void): PreparedChunks {
  const { chunks, cut } = chunkText(text, cfg);
  const keyBlocks = [...text.matchAll(PRIVATE_KEY_BLOCK)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const dropped = new Map<number, string>();
  for (const [i, c] of chunks.entries()) {
    const own = findSecret(c.text) ?? (keyBlocks.some(([s, e]) => c.start < e && c.end > s) ? "private_key" : undefined);
    if (own) dropped.set(i, own);
  }
  // A secret cut across a boundary that neither chunk shows whole drops both chunks.
  // A secret that one side of the window shows whole is not cut, and is handled by the chunk holding it.
  for (let i = 0; i + 1 < chunks.length; i++) {
    const at = chunks[i]!.end;
    const left = text.slice(Math.max(0, at - BOUNDARY_WINDOW), at);
    const right = text.slice(at, at + BOUNDARY_WINDOW);
    const pattern = findSecret(left + right);
    if (!pattern || findSecret(left) || findSecret(right)) continue;
    if (!dropped.has(i)) dropped.set(i, pattern);
    if (!dropped.has(i + 1)) dropped.set(i + 1, pattern);
  }
  const out: ChunkInput[] = [];
  for (const [i, c] of chunks.entries()) {
    if (dropped.has(i)) continue;
    const d = defang(c.text);
    out.push(d.flagged ? { text: d.text, flags: CHUNK_FLAG_INJECTION } : { text: d.text });
  }
  const byPattern = new Map<string, number>();
  for (const p of dropped.values()) byPattern.set(p, (byPattern.get(p) ?? 0) + 1);
  for (const [pattern, n] of byPattern) events("history_secret_skip", { ref, pattern, chunks: n });
  return { chunks: out, skippedSecret: dropped.size, cut };
}
