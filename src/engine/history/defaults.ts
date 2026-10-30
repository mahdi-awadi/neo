// The task history's tunables and their defaults (ADR-0066, spec "Config"). The modules take these as
// parameters; the config reader (`readHistoryCfg`, plan task 11) keeps a value of the right type from
// `config.json` and falls back to these.

export interface ChunkCfg {
  /** Target chunk size in characters. */
  chars: number;
  /** Characters a chunk repeats from the end of the one before. */
  overlap: number;
  /** A source shorter than this (trimmed) is not indexed. */
  minChars: number;
  /** At most this many chunks per source; the rest is cut and the source flagged. */
  maxPerRef: number;
}

export interface StoreCfg {
  /** A writer lock whose heartbeat is older than this is stale and may be taken over. Three heartbeats. */
  lockStaleMs: number;
}

export const CHUNK_DEFAULTS: Readonly<ChunkCfg> = { chars: 1200, overlap: 150, minChars: 24, maxPerRef: 300 };

export const STORE_DEFAULTS: Readonly<StoreCfg> = { lockStaleMs: 180_000 };

/** A paragraph in at least this many distinct orders or todos is boilerplate (`sources.boilerplateMinRows`). */
export const BOILERPLATE_MIN_ROWS = 25;

export interface SourcesCfg {
  /** A plan file is read up to this many bytes; the rest is cut and the source flagged. */
  planMaxBytes: number;
  /** A paragraph in at least this many distinct orders or todos is boilerplate. */
  boilerplateMinRows: number;
  /** The firewall follows `parent_order_id` at most this many levels up; a deeper chain is excluded. */
  lineageDepth: number;
}

export const SOURCES_DEFAULTS: Readonly<SourcesCfg> = { planMaxBytes: 1_048_576, boilerplateMinRows: BOILERPLATE_MIN_ROWS, lineageDepth: 8 };

export interface EmbedderCfg {
  /** The TEI service; must be loopback. */
  url: string;
  /** The environment variable that holds the bearer key (never the key itself). */
  keyEnv: string;
  /** The model id and revision `/info` must report; both are part of the model tag. */
  model: string;
  revision: string;
  dims: number;
  /** Texts per `/embed` request. */
  batch: number;
  timeoutMs: number;
  queryTimeoutMs: number;
  /** Query vectors kept (least recently used goes first). */
  queryCache: number;
  /** The first back-off after a 429 or 503 (doubles while they repeat, up to `backoffMaxMs`). */
  backoffMs: number;
  backoffMaxMs: number;
}

/** `revision` has no default: the operator pins it (tools/history/embedder.env); empty → not configured. */
export const EMBEDDER_DEFAULTS: Readonly<EmbedderCfg> = {
  url: "http://127.0.0.1:8088", keyEnv: "HISTORY_EMBEDDER_KEY", model: "BAAI/bge-m3", revision: "", dims: 1024,
  batch: 8, timeoutMs: 60_000, queryTimeoutMs: 3_000, queryCache: 200, backoffMs: 5_000, backoffMaxMs: 300_000,
};

export interface VectorsCfg {
  /** The environment variables that hold the shared Qdrant's URL and key (never the values). */
  urlEnv: string;
  keyEnv: string;
  /** Must start with `neo_` and be in `allowedCollections`. */
  collection: string;
  allowedCollections: string[];
  /** Points per upsert request. */
  uploadBatch: number;
  timeoutMs: number;
  queryTimeoutMs: number;
  /** Nearest neighbours one search asks for. */
  knn: number;
  /** Hits below this cosine score are dropped. */
  minScore: number;
  /** A remote count below this share of the local upload marks is drift: upload again. */
  driftRatio: number;
}

export const VECTORS_DEFAULTS: Readonly<VectorsCfg> = {
  urlEnv: "SHARED_QDRANT_URL", keyEnv: "SHARED_QDRANT_API_KEY", collection: "neo_history", allowedCollections: ["neo_history"],
  uploadBatch: 128, timeoutMs: 10_000, queryTimeoutMs: 2_000, knn: 50, minScore: 0.35, driftRatio: 0.9,
};
