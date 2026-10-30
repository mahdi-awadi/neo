// The task history's search (ADR-0066 Decision 6, spec "Search"): validate the query, then run up to four
// ranked lists — exact (the sources its ids name, then the chunks that hold an id token), meaning (the
// query's vector against the shared Qdrant, the active model tag only), words (FTS5 on the normalized text
// and the Arabic stems) and lines (the ledger's worker lines) — each with the same project, date and kind
// filters, and fuse them (fuse.ts). A list that fails is left out and the others answer; the meaning mode
// says on, partial (with the coverage), off (with the reason) or skipped (an id-only query: no embed
// call). Hits cite their source and carry a snippet of the original text. The `history_search` event has
// sizes, codes and the query length — never the query text. `ok: false` only for a refused query or a
// `history.db` that cannot be read.
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../format";
import type { Ledger, SearchHit } from "../ledger";
import { safeFtsQuery } from "../memory-recall";
import { todoTitle } from "../todo-title";
import { arabicStems } from "./arabic-stem";
import { SOURCE_KINDS, type HistoryCfg } from "./defaults";
import type { Embedder } from "./embedder";
import { exactLookup, parseQuery, STOP_WORDS, type ParsedQuery } from "./exact";
import { fuse, type ListName, type Ranked } from "./fuse";
import { normalize } from "./normalize";
import type { MeaningOffReason, QueryGate } from "./services";
import { makeSnippet } from "./snippet";
import type { HistoryFilter, HistoryKind, HistoryStore, SourceRow } from "./store";
import type { VectorIndex } from "./vector-index";

/** `todo:884` `order:<uuid>` `result:<order uuid>` `msg:991` `plan:12` `note:470` `att:31` `dec:<uuid>`
 *  `mem:3` `line:<message id>` */
export type HistoryRef = string;

export interface HistoryQuery {
  /** 1–`search.maxQueryChars` characters after trim. */
  query: string;
  project?: string;
  /** ms, inclusive */
  since?: number;
  until?: number;
  kinds?: HistoryKind[];
  /** Default `search.defaultLimit`, at most `search.maxLimit`. */
  limit?: number;
}

export type MeaningMode =
  | { meaning: "on" }
  | { meaning: "partial"; coverage: number }
  | { meaning: "off"; reason: MeaningOffReason }
  | { meaning: "skipped" };

export interface HistoryHit {
  ref: HistoryRef;
  kind: HistoryKind;
  project?: string;
  at: number;
  title: string;
  /** The original text; the match between SNIPPET_OPEN and SNIPPET_CLOSE. */
  snippet: string;
  todo?: number;
  order?: string;
  thread?: number;
  path?: string;
  commits: string[];
  /** The ledger no longer has the source row. */
  archived: boolean;
  via: ListName[];
  /** Other refs with the same text. */
  alsoIn?: HistoryRef[];
}

export interface HistoryResult {
  ok: boolean;
  error?: string;
  hits: HistoryHit[];
  mode: MeaningMode;
}

export interface SearchDeps {
  store: HistoryStore;
  ledger: Pick<Ledger, "searchWorkerLines">;
  embedder: Embedder;
  vectors: VectorIndex;
  cfg: Pick<HistoryCfg, "search" | "vectors">;
  gate: QueryGate;
  events: (kind: string, data: Record<string, unknown>) => void;
}

const KNOWN_KINDS = new Set<string>([...SOURCE_KINDS, "line"]);
const LINE = "line:";
const MARKS = new RegExp(`[${SNIPPET_OPEN}${SNIPPET_CLOSE}]`, "g");

const refused = (error: string): HistoryResult => ({ ok: false, error, hits: [], mode: { meaning: "skipped" } });
const isTime = (v: unknown): boolean => v === undefined || (typeof v === "number" && Number.isFinite(v));

function passes(s: SourceRow, f: HistoryFilter): boolean {
  if (f.project !== undefined && s.project !== f.project) return false;
  if (f.since !== undefined && s.at < f.since) return false;
  if (f.until !== undefined && s.at > f.until) return false;
  return !f.kinds?.length || f.kinds.includes(s.kind);
}

export async function searchHistory(deps: SearchDeps, q: HistoryQuery): Promise<HistoryResult> {
  const started = Date.now();
  const { store, cfg } = deps;
  const query = typeof q.query === "string" ? q.query.trim() : "";
  if (!query) return refused("query_empty");
  if (query.length > cfg.search.maxQueryChars) return refused("query_too_long");
  if (q.kinds?.some((k) => !KNOWN_KINDS.has(k))) return refused("unknown_kind");
  if (!isTime(q.since) || !isTime(q.until) || (q.since !== undefined && q.until !== undefined && q.since > q.until)) return refused("bad_range");
  const parsed = parseQuery(query, STOP_WORDS);
  if (!parsed.tokens.length && !parsed.terms.length) return refused("query_stopwords");
  try {
    store.getState("feed.cursor");
  } catch {
    return { ok: false, error: "history_unreadable", hits: [], mode: { meaning: "skipped" } };
  }
  const limit = Math.max(1, Math.min(cfg.search.maxLimit, Math.floor(Number.isFinite(q.limit) ? q.limit! : cfg.search.defaultLimit)));
  const storeKinds = q.kinds?.filter((k): k is HistoryKind => k !== "line");
  const storeOn = !q.kinds?.length || !!storeKinds?.length;
  const linesOn = !q.kinds?.length || q.kinds.includes("line");
  const filter: HistoryFilter = {
    ...(q.project !== undefined ? { project: q.project } : {}), ...(q.since !== undefined ? { since: q.since } : {}),
    ...(q.until !== undefined ? { until: q.until } : {}), ...(storeKinds?.length ? { kinds: storeKinds } : {}),
  };
  const listLimit = Math.max(1, cfg.search.listLimit);
  const failed: ListName[] = [];
  const guard = <T>(name: ListName, fn: () => T[]): T[] => {
    try {
      return fn();
    } catch {
      failed.push(name);
      return [];
    }
  };
  const ranked = (hits: Array<{ chunkId: number; ref: string }>): Ranked[] =>
    hits.flatMap((h) => {
      const src = store.getSource(h.ref);
      const c = store.chunkById(h.chunkId);
      return src && c ? [{ ref: h.ref, at: src.at, chunkId: h.chunkId, textHash: c.textHash }] : [];
    });

  // Meaning goes first: it awaits the embedder and Qdrant while the local lists run.
  const meaning: Promise<{ mode: MeaningMode; list: Ranked[] }> = parsed.idOnly || !storeOn
    ? Promise.resolve({ mode: { meaning: "skipped" }, list: [] })
    : meaningList(deps, query, filter, ranked);

  const exact = storeOn && parsed.tokens.length ? guard("exact", () => exactList(store, parsed, filter, listLimit, ranked)) : [];
  const words = storeOn && parsed.terms.length ? guard("words", () => wordsList(store, parsed, filter, listLimit, cfg.search.maxTerms, ranked)) : [];
  const lineHits = new Map<string, SearchHit>();
  const lines = linesOn && !parsed.idOnly
    ? guard("lines", () =>
      deps.ledger.searchWorkerLines(query, {
        ...(q.project !== undefined ? { project: q.project } : {}), ...(q.since !== undefined ? { since: q.since } : {}),
        ...(q.until !== undefined ? { until: q.until } : {}), limit: listLimit,
      }).map((h) => {
        lineHits.set(`${LINE}${h.id}`, h);
        return { ref: `${LINE}${h.id}`, at: h.at };
      }))
    : [];
  const m = await meaning;

  const fused = fuse({ exact, meaning: m.list, words, lines }, {
    k: cfg.search.rrfK, weights: cfg.search.weights, exactBoost: cfg.search.exactBoost, limit,
  });
  const highlight = [
    ...parsed.terms, ...arabicStems(parsed.terms.join(" ")).split(" "), ...parsed.tokens.map((t) => normalize(t.value.replace(/^[a-z]+:/i, ""))),
  ].filter(Boolean);
  let hits: HistoryHit[];
  try {
    hits = fused.flatMap((f): HistoryHit[] => {
      if (f.ref.startsWith(LINE)) {
        const h = lineHits.get(f.ref);
        if (!h) return [];
        return [{
          ref: f.ref, kind: "line", ...(h.project !== undefined ? { project: h.project } : {}), at: h.at,
          title: todoTitle(h.snippet.replace(MARKS, "")), snippet: h.snippet, ...(h.threadId !== undefined ? { thread: h.threadId } : {}),
          commits: [], archived: false, via: f.via,
        }];
      }
      const src = store.getSource(f.ref);
      if (!src) return [];
      const chunk = f.chunkId !== undefined ? store.chunkById(f.chunkId) : store.chunksOf(f.ref)[0];
      const mt = src.meta;
      return [{
        ref: f.ref, kind: src.kind, ...(src.project !== undefined ? { project: src.project } : {}), at: src.at, title: src.title,
        snippet: chunk ? makeSnippet(chunk.text, highlight, cfg.search.snippetChars) : "",
        ...(mt.todo !== undefined ? { todo: mt.todo } : {}), ...(mt.order !== undefined ? { order: mt.order } : {}),
        ...(mt.thread !== undefined ? { thread: mt.thread } : {}), ...(mt.path !== undefined ? { path: mt.path } : {}),
        commits: mt.commits ?? [], archived: src.goneAt !== undefined, via: f.via, ...(f.alsoIn ? { alsoIn: f.alsoIn } : {}),
      }];
    });
  } catch {
    return { ok: false, error: "history_unreadable", hits: [], mode: m.mode };
  }
  deps.events("history_search", {
    ms: Date.now() - started, mode: m.mode.meaning, ...(m.mode.meaning === "off" ? { reason: m.mode.reason } : {}),
    lists: { exact: exact.length, meaning: m.list.length, words: words.length, lines: lines.length }, failed,
    queryChars: query.length, hits: hits.length,
  });
  return { ok: true, hits, mode: m.mode };
}

/** The sources the ids name (direct refs, a decision prefix, meta links), then the chunks that hold an id
 *  token (newest first); each through the filters. */
function exactList(store: HistoryStore, parsed: ParsedQuery, filter: HistoryFilter, limit: number, ranked: (h: Array<{ chunkId: number; ref: string }>) => Ranked[]): Ranked[] {
  const direct: string[] = [];
  const fts: Ranked[] = [];
  for (const t of parsed.tokens) {
    const look = exactLookup(t);
    direct.push(...look.refs);
    if (look.prefix) direct.push(...store.refsWithPrefix(look.prefix, limit));
    if (look.meta) direct.push(...store.refsByMeta(look.meta.field, look.meta.value, limit));
    if (look.fts) fts.push(...ranked(store.searchWords({ body: look.fts }, filter, limit)));
  }
  const out: Ranked[] = [];
  for (const ref of new Set(direct)) {
    const src = store.getSource(ref);
    if (src && passes(src, filter)) out.push({ ref, at: src.at });
  }
  return [...out, ...fts.sort((a, b) => b.at - a.at)].slice(0, limit);
}

/** FTS5 on the normalized words (OR mode) and on the Arabic stems, best bm25 first. */
function wordsList(store: HistoryStore, parsed: ParsedQuery, filter: HistoryFilter, limit: number, maxTerms: number, ranked: (h: Array<{ chunkId: number; ref: string }>) => Ranked[]): Ranked[] {
  const body = safeFtsQuery(parsed.terms.join(" "), { mode: "any", maxTerms });
  const stems = arabicStems(parsed.terms.join(" "));
  return ranked(store.searchWords({ body, ...(stems ? { stems: safeFtsQuery(stems, { mode: "any", maxTerms }) } : {}) }, filter, limit));
}

/** The query's vector against the active tag's points, mapped back to chunks; the mode from the result and
 *  the coverage. A query in flight holds the gate, so the indexer's next embed batch waits for it. */
async function meaningList(
  deps: SearchDeps, query: string, filter: HistoryFilter, ranked: (h: Array<{ chunkId: number; ref: string }>) => Ranked[],
): Promise<{ mode: MeaningMode; list: Ranked[] }> {
  const off = (reason: MeaningOffReason) => ({ mode: { meaning: "off", reason } as MeaningMode, list: [] });
  const leave = deps.gate.enter();
  let qv: Awaited<ReturnType<Embedder["embedQuery"]>>;
  try {
    qv = await deps.embedder.embedQuery(query);
  } catch {
    qv = { ok: false, reason: "embedder_down" };
  } finally {
    leave();
  }
  if (!qv.ok) return off(qv.reason);
  try {
    const res = await deps.vectors.search(qv.vector, {
      tag: deps.embedder.tag, ...(filter.project !== undefined ? { project: filter.project } : {}), ...(filter.kinds ? { kinds: filter.kinds } : {}),
      ...(filter.since !== undefined ? { since: filter.since } : {}), ...(filter.until !== undefined ? { until: filter.until } : {}),
    }, { limit: deps.cfg.vectors.knn, minScore: deps.cfg.vectors.minScore });
    if (!res.ok) return off(res.reason);
    const chunks = deps.store.chunksByPointIds(res.value.map((h) => h.id));
    // The payload filter ran in Qdrant; the local check catches a payload older than its source.
    const list = ranked(chunks).filter((r) => {
      const src = deps.store.getSource(r.ref);
      return !!src && passes(src, filter);
    });
    const coverage = deps.store.coverage(deps.embedder.tag).ratio;
    return { mode: coverage >= deps.cfg.search.fullCoverage ? { meaning: "on" } : { meaning: "partial", coverage }, list };
  } catch {
    return off("vectors_down");
  }
}
