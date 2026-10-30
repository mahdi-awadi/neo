// Config `history` (ADR-0066, spec "Config"): `readHistoryCfg(raw)` keeps each value of the right type and
// range and falls back to its default for anything else, key by key, so one bad value never turns a guard
// off. It is pure. Secrets never live here: the embedder and Qdrant keys and the Qdrant URL are named by
// their environment variables (`keyEnv`, `urlEnv`) and read through the engine's env loader. Every
// `allowedCollections` entry must start with `neo_`; `next` is kept only when it names a complete model
// that differs from the active one and whose vectors have an allowed place to go.
import { isValidCron } from "../trigger";
import {
  HISTORY_DEFAULTS, SOURCE_KINDS,
  type ChunkCfg, type EmbedderCfg, type HistoryCfg, type IndexerCfg, type NextModelCfg, type RememberCfg, type SearchCfg,
  type SourcesCfg, type StoreCfg, type VectorsCfg,
} from "./defaults";

type Raw = Record<string, unknown>;

const COLLECTION_PREFIX = "neo_";
/** An environment variable name (never a value). */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
/** A whole number at least `min`. */
const int = (v: unknown, d: number, min = 1): number => (typeof v === "number" && Number.isInteger(v) && v >= min ? v : d);
/** A finite number in [min, max]. */
const num = (v: unknown, d: number, min: number, max: number): number => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d);
const text = (v: unknown, d: string): string => (typeof v === "string" && v.trim() ? v.trim() : d);
const envName = (v: unknown, d: string): string => (typeof v === "string" && ENV_NAME.test(v.trim()) ? v.trim() : d);

function readChunk(raw: unknown, d: ChunkCfg): ChunkCfg {
  const r = obj(raw);
  const chars = int(r.chars, d.chars);
  const overlap = int(r.overlap, d.overlap, 0);
  return {
    chars,
    // The overlap must stay below the chunk size, or a chunk never moves on.
    overlap: overlap < chars ? overlap : d.overlap < chars ? d.overlap : 0,
    minChars: int(r.minChars, d.minChars),
    maxPerRef: int(r.maxPerRef, d.maxPerRef),
  };
}

function readSources(raw: unknown, d: SourcesCfg & { kinds: string[] }): SourcesCfg & { kinds: string[] } {
  const r = obj(raw);
  const known = new Set<string>(SOURCE_KINDS);
  const kinds = Array.isArray(r.kinds) && r.kinds.length && r.kinds.every((k) => typeof k === "string" && known.has(k))
    ? [...new Set(r.kinds as string[])]
    : [...d.kinds];
  return {
    kinds,
    planMaxBytes: int(r.planMaxBytes, d.planMaxBytes),
    boilerplateMinRows: int(r.boilerplateMinRows, d.boilerplateMinRows),
    lineageDepth: int(r.lineageDepth, d.lineageDepth),
  };
}

function readEmbedder(raw: unknown, d: EmbedderCfg): EmbedderCfg {
  const r = obj(raw);
  const backoffMs = int(r.backoffMs, d.backoffMs);
  const backoffMaxMs = int(r.backoffMaxMs, d.backoffMaxMs);
  return {
    // The loopback rule is the adapter's (it reports `config_refused`, so the operator sees why).
    url: text(r.url, d.url),
    keyEnv: envName(r.keyEnv, d.keyEnv),
    model: text(r.model, d.model),
    revision: typeof r.revision === "string" ? r.revision.trim() : d.revision,
    dims: int(r.dims, d.dims),
    batch: int(r.batch, d.batch),
    timeoutMs: int(r.timeoutMs, d.timeoutMs),
    queryTimeoutMs: int(r.queryTimeoutMs, d.queryTimeoutMs),
    queryCache: int(r.queryCache, d.queryCache, 0),
    backoffMs,
    backoffMaxMs: backoffMaxMs >= backoffMs ? backoffMaxMs : Math.max(d.backoffMaxMs, backoffMs),
  };
}

function readVectors(raw: unknown, d: VectorsCfg): VectorsCfg {
  const r = obj(raw);
  const listed = Array.isArray(r.allowedCollections)
    ? (r.allowedCollections as unknown[]).flatMap((c) => (typeof c === "string" && c.trim().startsWith(COLLECTION_PREFIX) && c.trim().length > COLLECTION_PREFIX.length ? [c.trim()] : []))
    : [];
  const allowedCollections = listed.length ? [...new Set(listed)] : [...d.allowedCollections];
  const collection = text(r.collection, d.collection);
  return {
    urlEnv: envName(r.urlEnv, d.urlEnv),
    keyEnv: envName(r.keyEnv, d.keyEnv),
    // Kept only when allowed; else the default, which the adapter refuses in its turn if it is not allowed.
    collection: allowedCollections.includes(collection) ? collection : d.collection,
    allowedCollections,
    uploadBatch: int(r.uploadBatch, d.uploadBatch),
    timeoutMs: int(r.timeoutMs, d.timeoutMs),
    queryTimeoutMs: int(r.queryTimeoutMs, d.queryTimeoutMs),
    knn: int(r.knn, d.knn),
    minScore: num(r.minScore, d.minScore, 0, 1),
    driftRatio: num(r.driftRatio, d.driftRatio, Number.MIN_VALUE, 1),
  };
}

function readSearch(raw: unknown, d: SearchCfg): SearchCfg {
  const r = obj(raw);
  const w = obj(r.weights);
  const maxLimit = int(r.maxLimit, d.maxLimit);
  const defaultLimit = int(r.defaultLimit, d.defaultLimit);
  return {
    rrfK: int(r.rrfK, d.rrfK),
    weights: { meaning: num(w.meaning, d.weights.meaning, 0, Infinity), words: num(w.words, d.weights.words, 0, Infinity), lines: num(w.lines, d.weights.lines, 0, Infinity) },
    exactBoost: num(r.exactBoost, d.exactBoost, 0, Infinity),
    defaultLimit: defaultLimit <= maxLimit ? defaultLimit : Math.min(d.defaultLimit, maxLimit),
    maxLimit,
    listLimit: int(r.listLimit, d.listLimit),
    snippetChars: int(r.snippetChars, d.snippetChars),
    maxQueryChars: int(r.maxQueryChars, d.maxQueryChars),
    maxTerms: int(r.maxTerms, d.maxTerms),
    fullCoverage: num(r.fullCoverage, d.fullCoverage, Number.MIN_VALUE, 1),
  };
}

function readIndexer(raw: unknown, d: IndexerCfg): IndexerCfg {
  const r = obj(raw);
  return {
    feedBatch: int(r.feedBatch, d.feedBatch),
    sliceRows: int(r.sliceRows, d.sliceRows),
    busyPauseMs: int(r.busyPauseMs, d.busyPauseMs, 0),
    reconcileRows: int(r.reconcileRows, d.reconcileRows),
    embedBatchesPerPass: int(r.embedBatchesPerPass, d.embedBatchesPerPass),
    uploadBatchesPerPass: int(r.uploadBatchesPerPass, d.uploadBatchesPerPass),
  };
}

function readRemember(raw: unknown, d: RememberCfg): RememberCfg {
  const r = obj(raw);
  const minChars = int(r.minChars, d.minChars);
  const maxChars = int(r.maxChars, d.maxChars);
  return { minChars, maxChars: maxChars >= minChars ? maxChars : Math.max(d.maxChars, minChars), perSessionHour: int(r.perSessionHour, d.perSessionHour) };
}

function readStore(raw: unknown, d: StoreCfg): StoreCfg {
  return { lockStaleMs: int(obj(raw).lockStaleMs, d.lockStaleMs) };
}

/** The next model during a model change (ADR-0066 Decision 4.6), or null. Kept only with a model id and a
 *  revision, a tag that differs from the active one, and an allowed `neo_` collection when its dimensions
 *  differ (the active collection holds only one size). */
function readNext(raw: unknown, active: EmbedderCfg, vectors: VectorsCfg): NextModelCfg | null {
  if (!isObj(raw)) return null;
  const r = raw;
  if (typeof r.model !== "string" || !r.model.trim() || typeof r.revision !== "string" || !r.revision.trim()) return null;
  const e = readEmbedder(r, HISTORY_DEFAULTS.embedder);
  if (e.model === active.model && e.revision === active.revision && e.dims === active.dims) return null;
  const collection = typeof r.collection === "string" ? r.collection.trim() : undefined;
  if (collection !== undefined && !(collection.startsWith(COLLECTION_PREFIX) && vectors.allowedCollections.includes(collection))) return null;
  if (e.dims !== active.dims && (collection === undefined || collection === vectors.collection)) return null;
  return { ...e, ...(collection ? { collection } : {}) };
}

/** Config `history`: a value of the right type and range is kept, anything else is its default. */
export function readHistoryCfg(raw: unknown): HistoryCfg {
  const r = obj(raw);
  const d = HISTORY_DEFAULTS;
  const embedder = readEmbedder(r.embedder, d.embedder);
  const vectors = readVectors(r.vectors, d.vectors);
  const cron = typeof r.reconcileCron === "string" ? r.reconcileCron.trim() : "";
  return {
    enabled: bool(r.enabled, d.enabled),
    dbPath: text(r.dbPath, d.dbPath),
    chunk: readChunk(r.chunk, d.chunk),
    sources: readSources(r.sources, d.sources),
    embedder,
    next: readNext(r.next, embedder, vectors),
    retireAfterDays: int(r.retireAfterDays, d.retireAfterDays),
    vectors,
    search: readSearch(r.search, d.search),
    indexer: readIndexer(r.indexer, d.indexer),
    reconcileCron: cron && isValidCron(cron) ? cron : d.reconcileCron,
    feedKeep: int(r.feedKeep, d.feedKeep),
    degradedAlertMinutes: int(r.degradedAlertMinutes, d.degradedAlertMinutes),
    remember: readRemember(r.remember, d.remember),
    telegram: { findLimit: int(obj(r.telegram).findLimit, d.telegram.findLimit) },
    store: readStore(r.store, d.store),
  };
}
