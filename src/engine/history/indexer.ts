// The task history's indexer (ADR-0066 Decision 4, spec "The indexer"): one pass reads the ledger's change
// feed from its own cursor, walks the source tables when a reconcile is due (the first start, a feed gap,
// the weekly cron), extracts each row (sources.ts, through the firewall), writes the changed ones to
// `history.db` in slices of at most `sliceRows` rows per transaction, embeds the chunks that have no vector
// (a query in flight goes first), uploads the points that wait, sends the queued point deletes, re-uploads
// on drift without embedding, and retires an old model tag. A pass is single-flight, stops when another
// process holds the writer lock, catches the error of each step and goes on with the next, and always
// returns an `IndexReport`. Events carry ids, counts and codes only.
import type { HistoryFeedRow, HistoryOrderRow, HistoryTable, Ledger } from "../ledger";
import { cronDueBetween } from "../trigger";
import type { HistoryCfg } from "./defaults";
import type { Embedder } from "./embedder";
import { paragraphHashes } from "./extract";
import { countRule, type FirewallCounts, type FirewallRule } from "./firewall";
import type { MeaningOffReason, QueryGate } from "./services";
import { extractSource, ledgerLookups, ownBrief, prepareChunks, safeCommits, type SourceCtx, type SourceExtract } from "./sources";
import type { ChunkInput, HistoryKind, HistoryStore } from "./store";
import type { Point, VectorIndex, VectorProbe } from "./vector-index";

export interface ServiceReport {
  state: "up" | "down" | "off";
  /** When the service entered this state (ms). */
  since: number;
  reason?: MeaningOffReason;
}

export interface IndexReport {
  ms: number;
  feed: { read: number; cursor: number; gap: boolean };
  sources: { indexed: number; unchanged: number; archived: number; skippedFirewall: number; removedFirewall: number };
  chunks: { added: number; changed: number; deleted: number; skippedSecret: number };
  embedded: number;
  uploaded: number;
  pointsDeleted: number;
  reconcile?: { reason: ReconcileReason; done: boolean; position: string };
  embedder: ServiceReport;
  vectors: ServiceReport;
  backlog: { feed: number; toEmbed: number; toUpload: number; pendingDeletes: number };
  coverage: number;
  /** Another process holds the writer lock: this pass did nothing. */
  locked?: boolean;
}

export type ReconcileReason = "first" | "gap" | "weekly";

export interface IndexerDeps {
  store: HistoryStore;
  ledger: Pick<Ledger, "historyFeed" | "historyFeedBounds" | "historyRows" | "historyScan" | "historyLineage" | "threadById">;
  cfg: HistoryCfg;
  workRoot: string;
  embedder: Embedder;
  vectors: VectorIndex;
  /** The next model during a model change: its own embedder, and its collection's index. */
  next?: { embedder: Embedder; vectors: VectorIndex };
  events: (kind: string, data: Record<string, unknown>) => void;
  gate: QueryGate;
  /** This process (the writer lock's owner). */
  pid: number;
}

export interface Indexer {
  /** One pass, single-flight: a call while a pass runs gets that pass's report. Never throws. */
  tick(now: number): Promise<IndexReport>;
  /** The newest report, if a pass ran. */
  latest(): IndexReport | undefined;
  /** The services as the newest pass saw them. */
  services(): { embedder: ServiceReport; vectors: ServiceReport };
}

/** The ledger tables in the order a reconcile walks them, the ref prefixes of a row and the kinds it gives. */
const TABLES: HistoryTable[] = ["orders", "outcomes", "project_todos", "plans", "attention_items", "decisions", "messages"];
const REF_PREFIXES: Record<HistoryTable, string[]> = {
  orders: ["order"], outcomes: ["result"], project_todos: ["todo"], plans: ["plan"], attention_items: ["note", "att"], decisions: ["dec"], messages: ["msg"],
};
const KINDS_OF: Record<HistoryTable, HistoryKind[]> = {
  orders: ["order"], outcomes: ["result"], project_todos: ["todo"], plans: ["plan"], attention_items: ["note", "attention"], decisions: ["decision"], messages: ["message", "digest"],
};
/** The tables whose briefs count toward boilerplate, and the text each counts. */
const COUNTED: Partial<Record<HistoryTable, (row: unknown) => string>> = {
  orders: (r) => (r as HistoryOrderRow).task,
  project_todos: (r) => (r as { brief: string }).brief,
};

const K = {
  cursor: "feed.cursor",
  reconcile: "reconcile",
  firstDone: "reconcile.first",
  checked: "reconcile.checked",
  activeTag: "tag.active",
  retiring: "tag.retiring",
} as const;

const DAY = 86_400_000;

interface ReconcileState {
  reason: ReconcileReason;
  phase: "count" | "walk" | "gone" | "orphans";
  /** Index into TABLES (count/walk/gone). */
  t: number;
  /** The last key, ref or Qdrant offset done in this phase. */
  after?: string;
  rows: number;
}

/** What one ledger row asks of `history.db`. */
type Op =
  | { op: "put"; source: SourceExtract }
  | { op: "drop"; ref: string; rule?: FirewallRule }
  | { op: "skip"; rule?: FirewallRule }
  | { op: "gone"; refs: string[] };

interface Item {
  table: HistoryTable;
  key: string;
  /** The row when it was already read; `null` = read and absent. */
  row?: unknown;
}

interface Lane {
  role: "active" | "next";
  embedder: Embedder;
  vectors: VectorIndex;
  emb: ServiceReport;
  vec: ServiceReport;
  indexesReady: boolean;
}

const OFF_REASONS = new Set<MeaningOffReason>(["not_configured", "config_refused", "embedder_refused", "embedder_wrong_model", "vectors_refused", "collection_missing"]);
const stateOf = (reason: MeaningOffReason): "down" | "off" => (OFF_REASONS.has(reason) ? "off" : "down");
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
const keyOf = (ref: string): string => ref.slice(ref.indexOf(":") + 1);

export { cronDueBetween };

/** A report with no work and both services off: the start of each pass, and what a pass that cannot run gives. */
export function emptyIndexReport(): IndexReport {
  return {
    ms: 0,
    feed: { read: 0, cursor: 0, gap: false },
    sources: { indexed: 0, unchanged: 0, archived: 0, skippedFirewall: 0, removedFirewall: 0 },
    chunks: { added: 0, changed: 0, deleted: 0, skippedSecret: 0 },
    embedded: 0,
    uploaded: 0,
    pointsDeleted: 0,
    embedder: { state: "off", since: 0 },
    vectors: { state: "off", since: 0 },
    backlog: { feed: 0, toEmbed: 0, toUpload: 0, pendingDeletes: 0 },
    coverage: 0,
  };
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const { store, ledger, cfg, events } = deps;
  const kinds = new Set(cfg.sources.kinds);
  const lane = (role: Lane["role"], embedder: Embedder, vectors: VectorIndex): Lane => ({
    role, embedder, vectors, emb: { state: "off", since: 0 }, vec: { state: "off", since: 0 }, indexesReady: false,
  });
  const active = lane("active", deps.embedder, deps.vectors);
  const lanes: Lane[] = [active, ...(deps.next ? [lane("next", deps.next.embedder, deps.next.vectors)] : [])];
  let running: Promise<IndexReport> | undefined;
  let latest: IndexReport | undefined;

  // ── Service states ──────────────────────────────────────────────────────────────────────────────────

  function setService(l: Lane, which: "emb" | "vec", next: { state: "up" } | { state: "down" | "off"; reason: MeaningOffReason }, now: number): void {
    const prev = l[which];
    const reason = next.state === "up" ? undefined : next.reason;
    if (prev.state === next.state && prev.reason === reason && prev.since !== 0) return;
    l[which] = { state: next.state, since: now, ...(reason ? { reason } : {}) };
    if (next.state !== "up") events(which === "emb" ? "history_embed_error" : "history_vectors_error", { model: l.role, state: next.state, reason });
  }

  // ── Extraction and writes ───────────────────────────────────────────────────────────────────────────

  function sourceCtx(boilerplate: ReadonlySet<string>): SourceCtx & { look: ReturnType<typeof ledgerLookups> } {
    return { look: ledgerLookups(ledger, cfg.sources), workRoot: deps.workRoot, cfg: cfg.sources, boilerplate };
  }

  function opOf(item: Item, ctx: SourceCtx): Op {
    if (item.row === null || item.row === undefined) return { op: "gone", refs: REF_PREFIXES[item.table].map((p) => `${p}:${item.key}`) };
    const x = extractSource(item.table, item.row, ctx);
    if (x.status === "source") return kinds.has(x.source.kind) ? { op: "put", source: x.source } : { op: "drop", ref: x.source.ref };
    if (x.status === "none") return { op: "drop", ref: x.ref };
    if (x.status === "wait") return { op: "skip" };
    return x.ref !== undefined ? { op: "drop", ref: x.ref, rule: x.rule } : { op: "skip", rule: x.rule };
  }

  function apply(o: Op, now: number, r: IndexReport, rules: FirewallCounts): void {
    if (o.op === "gone") {
      r.sources.archived += store.markGone(o.refs, now);
      return;
    }
    if (o.op === "skip" || o.op === "drop") {
      if (o.rule) (r.sources.skippedFirewall++, countRule(rules, o.rule));
      if (o.op === "skip" || !store.getSource(o.ref)) return;
      r.chunks.deleted += store.removeSource(o.ref, now).chunks;
      if (o.rule) r.sources.removedFirewall++;
      return;
    }
    const src = o.source;
    if (store.tombstoned([src.ref]).size) return;
    const existing = store.getSource(src.ref);
    if (existing && existing.hash === src.hash && existing.goneAt === undefined) {
      r.sources.unchanged++;
      return;
    }
    let chunks: ChunkInput[];
    let meta = src.meta;
    if (src.keepText && existing) {
      chunks = store.chunksOf(src.ref).map((c) => ({ text: c.text, flags: c.flags }));
    } else {
      const p = prepareChunks(src.ref, src.text, cfg.chunk, events);
      chunks = p.chunks;
      r.chunks.skippedSecret += p.skippedSecret;
      if (p.cut) meta = { ...meta, cut: true };
    }
    if (!chunks.length && !existing) return; // too short (or all secret): not indexed
    // Commits only from the text that is kept: a sha in a chunk dropped for a secret is never shown.
    meta = { ...meta, commits: safeCommits([...chunks.map((c) => c.text), src.title]) };
    const { text: _text, keepText: _keep, ...input } = src;
    const put = store.putSource({ ...input, meta }, chunks, now);
    if (put.tombstoned) return;
    r.sources.indexed++;
    r.chunks.added += put.added;
    r.chunks.changed += put.changed;
    r.chunks.deleted += put.deleted;
  }

  /** Read the rows the items do not carry yet (one query per table). */
  function readRows(items: Item[]): void {
    const byTable = new Map<HistoryTable, Item[]>();
    for (const it of items) if (it.row === undefined) byTable.set(it.table, [...(byTable.get(it.table) ?? []), it]);
    for (const [table, list] of byTable) {
      const rows = new Map(ledger.historyRows(table, list.map((i) => i.key)).map((x) => [x.key, x.row as unknown]));
      for (const it of list) it.row = rows.get(it.key) ?? null;
    }
  }

  /** The order ids the firewall needs for these rows, so their lineages are read in one query. */
  function orderIdsOf(items: Item[]): string[] {
    const ids: string[] = [];
    for (const it of items) {
      const row = it.row as { id?: unknown; orderId?: unknown } | null;
      if (!row) continue;
      if (it.table === "orders" && typeof row.id === "string") ids.push(row.id);
      if (typeof row.orderId === "string") ids.push(row.orderId);
    }
    return ids;
  }

  /** Extract and write `items` in slices of at most `sliceRows` rows, one transaction each; `last` runs in
   *  the transaction of the last slice (it commits the position the items came from). */
  async function writeSlices(items: Item[], now: number, r: IndexReport, rules: FirewallCounts, boilerplate: ReadonlySet<string>, last: () => void): Promise<void> {
    const size = Math.max(1, cfg.indexer.sliceRows);
    if (!items.length) {
      store.transaction(last);
      return;
    }
    for (let i = 0; i < items.length; i += size) {
      const slice = items.slice(i, i + size);
      readRows(slice);
      const ctx = sourceCtx(boilerplate);
      ctx.look.prime(orderIdsOf(slice));
      const ops = slice.map((it) => opOf(it, ctx));
      const isLast = i + size >= items.length;
      store.transaction(() => {
        for (const o of ops) apply(o, now, r, rules);
        if (isLast) last();
      });
      await yieldNow();
    }
  }

  /** The feed rows as items, with what each change touches: an order its result and its todo, a todo its
   *  order (and so that order's result). */
  function feedItems(rows: HistoryFeedRow[]): Item[] {
    const items = new Map<string, Item>();
    const add = (table: HistoryTable, key: string): Item | undefined => {
      const id = `${table}\u0000${key}`;
      if (items.has(id)) return undefined;
      const it: Item = { table, key };
      items.set(id, it);
      return it;
    };
    let pending: Item[] = rows.flatMap((f) => add(f.tbl, f.key) ?? []);
    while (pending.length) {
      const watch = pending.filter((i) => i.table === "orders" || i.table === "project_todos");
      readRows(watch);
      const next: Item[] = [];
      for (const it of watch) {
        const row = it.row as (HistoryOrderRow & { orderId?: string }) | null;
        if (!row) continue;
        if (it.table === "orders") {
          next.push(...[add("outcomes", it.key), row.todoId !== undefined ? add("project_todos", String(row.todoId)) : undefined].filter((x): x is Item => !!x));
        } else if (row.orderId !== undefined) {
          const o = add("orders", row.orderId);
          if (o) next.push(o);
        }
      }
      pending = next;
    }
    return [...items.values()];
  }

  // ── Steps ───────────────────────────────────────────────────────────────────────────────────────────

  function readReconcile(): ReconcileState | undefined {
    const v = store.getState(K.reconcile);
    if (!v) return undefined;
    try {
      return JSON.parse(v) as ReconcileState;
    } catch {
      return undefined;
    }
  }
  const saveReconcile = (st: ReconcileState): void => store.setState(K.reconcile, JSON.stringify(st));
  function startReconcile(reason: ReconcileReason): ReconcileState {
    const st: ReconcileState = { reason, phase: reason === "first" ? "count" : "walk", t: 0, rows: 0 };
    saveReconcile(st);
    return st;
  }

  async function probe(now: number): Promise<void> {
    for (const l of lanes) {
      setService(l, "emb", await l.embedder.probe(), now);
      const v: VectorProbe = await l.vectors.probe(l.embedder.tag);
      setService(l, "vec", v.state === "up" ? { state: "up" } : v, now);
      if (v.state !== "up") {
        l.indexesReady = false;
        continue;
      }
      if (!l.indexesReady) await ensureIndexes(l, now);
      const uploaded = store.countUploaded(l.embedder.tag);
      if (uploaded > 0 && v.count < cfg.vectors.driftRatio * uploaded) {
        // The collection lost points: send the stored vectors again. No embed call.
        const cleared = store.clearUploadMarks(l.embedder.tag);
        await ensureIndexes(l, now);
        events("history_reupload", { cleared, remote: v.count });
      }
    }
  }

  async function ensureIndexes(l: Lane, now: number): Promise<void> {
    const res = await l.vectors.ensureIndexes();
    l.indexesReady = res.ok;
    if (!res.ok) setService(l, "vec", { state: stateOf(res.reason), reason: res.reason }, now);
  }

  async function feed(now: number, r: IndexReport, rules: FirewallCounts, boilerplate: ReadonlySet<string>): Promise<void> {
    const bounds = ledger.historyFeedBounds();
    let cursor = Number(store.getState(K.cursor) ?? "0");
    if (!store.getState(K.firstDone) && !readReconcile()) {
      // The first start: the backfill walks every row, so the feed starts from here.
      store.transaction(() => {
        store.setState(K.cursor, String(bounds.newest));
        startReconcile("first");
      });
      r.feed.cursor = bounds.newest;
      return;
    }
    const gap = bounds.oldest === undefined ? cursor < bounds.newest : cursor < bounds.oldest - 1;
    if (gap || cursor > bounds.newest) {
      // Rows were pruned before this cursor read them (or the ledger is another one): walk the tables.
      r.feed.gap = true;
      cursor = bounds.newest;
      store.transaction(() => {
        store.setState(K.cursor, String(cursor));
        startReconcile("gap");
      });
    }
    const rows = ledger.historyFeed(cursor, cfg.indexer.feedBatch);
    r.feed.read = rows.length;
    r.feed.cursor = cursor;
    if (!rows.length) return;
    const end = rows.at(-1)!.id;
    await writeSlices(feedItems(rows), now, r, rules, boilerplate, () => store.setState(K.cursor, String(end)));
    r.feed.cursor = end;
  }

  async function reconcile(now: number, r: IndexReport, rules: FirewallCounts, boilerplate: ReadonlySet<string>): Promise<void> {
    let st = readReconcile();
    const checked = Number(store.getState(K.checked) ?? String(now));
    store.setState(K.checked, String(now));
    if (!st && !store.getState(K.firstDone)) st = startReconcile("first");
    if (!st && cronDueBetween(cfg.reconcileCron, checked, now)) st = startReconcile("weekly");
    if (!st) return;
    const slice = Math.max(1, cfg.indexer.sliceRows);
    let budget = Math.max(1, cfg.indexer.reconcileRows);
    let bp = boilerplate;
    let done = false;
    while (budget > 0 && !done) {
      const ask = Math.min(slice, budget);
      const table: HistoryTable = TABLES[st.t]!;
      if (st.phase === "count") {
        const counted = (Object.keys(COUNTED) as HistoryTable[]);
        const ct: HistoryTable | undefined = counted.includes(table) ? table : counted.find((t) => TABLES.indexOf(t) > st!.t);
        if (!ct) {
          st = { ...st, phase: "walk", t: 0, after: undefined };
          saveReconcile(st);
          bp = store.boilerplate(cfg.sources.boilerplateMinRows); // the counts are complete now
          continue;
        }
        if (ct !== table) {
          st = { ...st, t: TABLES.indexOf(ct), after: undefined };
          continue;
        }
        const rows = ledger.historyScan(ct, st.after, ask);
        const text = COUNTED[ct]!;
        const nextSt: ReconcileState = rows.length < ask
          ? { ...st, t: st.t + 1, after: undefined, rows: st.rows + rows.length }
          : { ...st, after: rows.at(-1)!.key, rows: st.rows + rows.length };
        store.transaction(() => {
          for (const { row } of rows) store.countParagraphs(paragraphHashes(ownBrief(text(row))));
          saveReconcile(nextSt);
        });
        st = nextSt;
        budget -= Math.max(1, rows.length);
        await yieldNow();
        continue;
      }
      if (st.phase === "walk") {
        const rows = ledger.historyScan(table, st.after, ask);
        const nextSt: ReconcileState = rows.length < ask
          ? { ...st, phase: "gone", after: undefined, rows: st.rows + rows.length }
          : { ...st, after: rows.at(-1)!.key, rows: st.rows + rows.length };
        await writeSlices(rows.map((x) => ({ table, key: x.key, row: x.row as unknown })), now, r, rules, bp, () => saveReconcile(nextSt));
        st = nextSt;
        budget -= Math.max(1, rows.length);
        continue;
      }
      if (st.phase === "gone") {
        // Entries history has and the ledger no longer has: archived, never deleted.
        const refs = store.listRefs(KINDS_OF[table], st.after, ask);
        const present = new Set(ledger.historyRows(table, [...new Set(refs.map(keyOf))]).map((x) => x.key));
        const missing = refs.filter((ref) => !present.has(keyOf(ref)));
        const lastTable = st.t + 1 >= TABLES.length;
        const nextSt: ReconcileState = refs.length < ask
          ? lastTable
            ? { ...st, phase: "orphans", t: st.t, after: undefined }
            : { ...st, phase: "walk", t: st.t + 1, after: undefined }
          : { ...st, after: refs.at(-1)! };
        store.transaction(() => {
          r.sources.archived += store.markGone(missing, now);
          saveReconcile(nextSt);
        });
        st = nextSt;
        budget -= Math.max(1, refs.length);
        await yieldNow();
        continue;
      }
      // orphans: only the weekly run, and only while the vectors answer.
      if (st.reason !== "weekly" || active.vec.state !== "up") {
        done = true;
        break;
      }
      const page = await active.vectors.scrollIds(active.embedder.tag, st.after, Math.min(ask, cfg.vectors.uploadBatch));
      if (!page.ok) {
        setService(active, "vec", { state: stateOf(page.reason), reason: page.reason }, now);
        break;
      }
      const orphans = store.unknownPointIds(page.value.ids);
      if (orphans.length) {
        const del = await active.vectors.delete(orphans);
        if (!del.ok) {
          setService(active, "vec", { state: stateOf(del.reason), reason: del.reason }, now);
          break;
        }
        r.pointsDeleted += orphans.length;
      }
      budget -= Math.max(1, page.value.ids.length);
      if (page.value.next === undefined) done = true;
      else {
        st = { ...st, after: page.value.next };
        saveReconcile(st);
      }
    }
    const position = `${st.phase}:${TABLES[st.t] ?? "-"}:${st.after ?? ""}`;
    r.reconcile = { reason: st.reason, done, position };
    if (done) {
      store.transaction(() => {
        store.setState(K.reconcile, "");
        if (st!.reason === "first") store.setState(K.firstDone, String(now));
      });
      events("history_reconcile", { reason: st.reason, rows: st.rows, archived: r.sources.archived, orphans: r.pointsDeleted });
    }
  }

  async function embed(now: number, r: IndexReport): Promise<void> {
    for (const l of lanes) {
      const tag = l.embedder.tag;
      for (let i = 0; l.emb.state === "up" && i < cfg.indexer.embedBatchesPerPass; i++) {
        const texts = store.textsWithoutVector(tag, Math.max(1, cfg.embedder.batch));
        if (!texts.length) break;
        await deps.gate.idle(); // a query goes first
        const res = await l.embedder.embed(texts.map((t) => t.text));
        if (!res.ok) {
          setService(l, "emb", { state: stateOf(res.reason), reason: res.reason }, now);
          break;
        }
        store.putVectors(tag, texts.map((t, j) => ({ textHash: t.textHash, vec: res.vectors[j]! })));
        r.embedded += texts.length;
        await yieldNow();
      }
      // Chunks whose text already has a vector (a new one, or one embedded under another ref) get a point.
      const size = Math.max(1, cfg.indexer.sliceRows);
      while (store.addMissingPoints(tag, size) === size) await yieldNow();
    }
  }

  const payloadProject = (p: string | undefined): string | undefined => (p && p.length <= 64 ? p : undefined);

  async function upload(now: number, r: IndexReport): Promise<void> {
    for (const l of lanes) {
      const tag = l.embedder.tag;
      for (let i = 0; l.vec.state === "up" && i < cfg.indexer.uploadBatchesPerPass; i++) {
        const pts = store.pointsToUpload(tag, Math.max(1, cfg.vectors.uploadBatch));
        if (!pts.length) break;
        const points: Point[] = pts.map((p) => {
          const project = payloadProject(p.project);
          return { id: p.pointId, vector: p.vector, payload: { ...(project ? { project } : {}), kind: p.kind, at: p.at, m: tag } };
        });
        const res = await l.vectors.upsert(points);
        if (!res.ok) {
          setService(l, "vec", { state: stateOf(res.reason), reason: res.reason }, now);
          break;
        }
        store.markUploaded(pts.map((p) => p.pointId), now);
        r.uploaded += pts.length;
        await yieldNow();
      }
    }
    // The queued deletes go to every collection a point may live in.
    const targets = [...new Set(lanes.map((l) => l.vectors))];
    for (let i = 0; active.vec.state === "up" && i < cfg.indexer.uploadBatchesPerPass; i++) {
      const ids = store.pendingDeletes(Math.max(1, cfg.vectors.uploadBatch));
      if (!ids.length) break;
      for (const v of targets) {
        const res = await v.delete(ids);
        if (!res.ok) {
          setService(active, "vec", { state: stateOf(res.reason), reason: res.reason }, now);
          return;
        }
      }
      store.clearPendingDeletes(ids);
      r.pointsDeleted += ids.length;
    }
  }

  async function retire(now: number): Promise<void> {
    const tag = active.embedder.tag;
    const nextTag = deps.next?.embedder.tag;
    const stored = store.getState(K.activeTag);
    let retiring: Array<{ tag: string; since: number }> = [];
    try {
      retiring = JSON.parse(store.getState(K.retiring) ?? "[]") as typeof retiring;
    } catch {
      retiring = [];
    }
    if (stored && stored !== tag && stored !== nextTag && !retiring.some((x) => x.tag === stored)) retiring.push({ tag: stored, since: now });
    retiring = retiring.filter((x) => x.tag !== tag && x.tag !== nextTag);
    const keep: typeof retiring = [];
    for (const x of retiring) {
      if (now - x.since < cfg.retireAfterDays * DAY || active.vec.state !== "up") {
        keep.push(x);
        continue;
      }
      const res = await active.vectors.deleteTag(x.tag);
      if (!res.ok) {
        keep.push(x);
        continue;
      }
      const dropped = store.dropTag(x.tag);
      events("history_retire", { points: dropped.points.length, vectors: dropped.vectors });
    }
    store.transaction(() => {
      if (stored !== tag) store.setState(K.activeTag, tag);
      store.setState(K.retiring, JSON.stringify(keep));
    });
  }

  function finish(r: IndexReport, started: number): void {
    const tag = active.embedder.tag;
    r.embedder = { ...active.emb };
    r.vectors = { ...active.vec };
    try {
      const bounds = ledger.historyFeedBounds();
      r.backlog.feed = Math.max(0, bounds.newest - Number(store.getState(K.cursor) ?? "0"));
    } catch {
      r.backlog.feed = 0;
    }
    try {
      r.backlog.toEmbed = store.countWithoutVector(tag);
      r.backlog.toUpload = store.countToUpload(tag);
      r.backlog.pendingDeletes = store.countPendingDeletes();
      r.coverage = store.coverage(tag).ratio;
    } catch {
      // the store answered nothing: the report keeps zeros
    }
    r.ms = Date.now() - started;
  }

  async function pass(now: number): Promise<IndexReport> {
    const started = Date.now();
    const r = emptyIndexReport();
    let lock: ReturnType<HistoryStore["takeLock"]>;
    try {
      lock = store.takeLock(deps.pid, now);
    } catch {
      events("history_step_error", { step: "lock" });
      finish(r, started);
      return r;
    }
    if (!lock.ok) {
      r.locked = true;
      finish(r, started);
      return r;
    }
    const rules: FirewallCounts = {};
    let boilerplate: ReadonlySet<string> = new Set();
    const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
      try {
        await fn();
      } catch {
        events("history_step_error", { step: name });
      }
    };
    await step("probe", () => probe(now));
    await step("boilerplate", () => void (boilerplate = store.boilerplate(cfg.sources.boilerplateMinRows)));
    await step("feed", () => feed(now, r, rules, boilerplate));
    await step("reconcile", () => reconcile(now, r, rules, boilerplate));
    await step("embed", () => embed(now, r));
    await step("upload", () => upload(now, r));
    await step("retire", () => retire(now));
    finish(r, started);
    if (Object.keys(rules).length) events("history_firewall_skip", { ...rules });
    const changed = r.sources.indexed + r.sources.archived + r.sources.removedFirewall + r.chunks.deleted + r.embedded + r.uploaded + r.pointsDeleted;
    if (changed > 0 || r.feed.gap) {
      events("history_pass", {
        ms: r.ms, feed: r.feed.read, gap: r.feed.gap, ...r.sources, ...r.chunks,
        embedded: r.embedded, uploaded: r.uploaded, pointsDeleted: r.pointsDeleted, coverage: r.coverage,
      });
    }
    return r;
  }

  return {
    tick(now) {
      if (running) return running;
      running = pass(now)
        .catch(() => {
          // pass() catches each step; this is the last net, so tick never rejects.
          const r = emptyIndexReport();
          events("history_step_error", { step: "pass" });
          return r;
        })
        .then((r) => (latest = r))
        .finally(() => {
          running = undefined;
        });
      return running;
    },
    latest: () => latest,
    services: () => ({ embedder: { ...active.emb }, vectors: { ...active.vec } }),
  };
}
