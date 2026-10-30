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

/** `model` and `revision` name the pair that tools/history/embedder.env pins (the embedder service test
 *  checks they match); an empty revision → not configured. */
export const EMBEDDER_DEFAULTS: Readonly<EmbedderCfg> = {
  url: "http://127.0.0.1:8088", keyEnv: "HISTORY_EMBEDDER_KEY", model: "BAAI/bge-m3", revision: "5617a9f61b028005a4858fdac845db406aefb181", dims: 1024,
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

export interface IndexerCfg {
  /** Change-feed rows one pass reads. */
  feedBatch: number;
  /** At most this many source rows are written in one `history.db` transaction. */
  sliceRows: number;
  /** The pause before the next pass while a backlog exists (the daemon's scheduler reads it). */
  busyPauseMs: number;
  /** Ledger rows one pass walks during a reconcile (in slices of `sliceRows`). */
  reconcileRows: number;
  /** Embed requests one pass sends for each model tag (of at most `embedder.batch` texts each). */
  embedBatchesPerPass: number;
  /** A timed-out embed batch is halved (down to one text) and its first chunks sent again; after this many
   *  successes in a row the batch doubles again, up to `embedder.batch`. */
  embedGrowAfter: number;
  /** Upsert requests (of `vectors.uploadBatch` points) one pass sends for each model tag. */
  uploadBatchesPerPass: number;
}

export const INDEXER_DEFAULTS: Readonly<IndexerCfg> = {
  feedBatch: 500, sliceRows: 200, busyPauseMs: 200, reconcileRows: 500, embedBatchesPerPass: 16, embedGrowAfter: 4, uploadBatchesPerPass: 8,
};

export interface SearchCfg {
  /** The `k` of reciprocal rank fusion. */
  rrfK: number;
  /** The weight of each ranked list in the fusion. */
  weights: { meaning: number; words: number; lines: number };
  /** What an exact id hit adds, so exact hits come first. */
  exactBoost: number;
  defaultLimit: number;
  maxLimit: number;
  /** Hits each list gives the fusion. */
  listLimit: number;
  /** About this many characters of the original text around the first match. */
  snippetChars: number;
  /** A longer query is refused, not cut. */
  maxQueryChars: number;
  /** At most this many terms go into the words query (the longest are kept). */
  maxTerms: number;
  /** Coverage below this share gives the mode `partial`. */
  fullCoverage: number;
  /** Searches one worker session may make in a minute (`history_search`; the operator surfaces are not limited). */
  perSessionMinute: number;
}

export const SEARCH_DEFAULTS: Readonly<SearchCfg> = {
  rrfK: 60, weights: { meaning: 1, words: 1, lines: 0.5 }, exactBoost: 1, defaultLimit: 10, maxLimit: 50, listLimit: 50,
  snippetChars: 240, maxQueryChars: 500, maxTerms: 12, fullCoverage: 0.99, perSessionMinute: 30,
};

/** A project name is a folder name: longer input is not one (every surface and the seam check it). */
export const PROJECT_MAX = 128;

/** A project name the history keeps: 1–PROJECT_MAX characters, no slash, backslash or control character. */
export const isProjectName = (p: string): boolean => p.length > 0 && p.length <= PROJECT_MAX && !/[\u0000-\u001f/\\]/.test(p);

export interface RememberCfg {
  minChars: number;
  maxChars: number;
  /** Entries one session may save in an hour. */
  perSessionHour: number;
}

export const REMEMBER_DEFAULTS: Readonly<RememberCfg> = { minChars: 10, maxChars: 4000, perSessionHour: 20 };

/** The next model during a model change (ADR-0066 Decision 4.6): its own embedder; a collection only when
 *  its dimensions differ (it must be allowed). */
export interface NextModelCfg extends EmbedderCfg {
  collection?: string;
}

/** Every source kind the indexer knows; `sources.kinds` may turn some off. */
export const SOURCE_KINDS = ["todo", "order", "result", "digest", "message", "plan", "note", "attention", "decision", "remembered"] as const;
/** Every kind a query may name: the stored kinds and the ledger's worker lines. */
export const QUERY_KINDS = [...SOURCE_KINDS, "line"] as const;

/** The whole `history` config section (spec "Config"); `readHistoryCfg` (plan task 11) fills it from `config.json`. */
export interface HistoryCfg {
  enabled: boolean;
  dbPath: string;
  chunk: ChunkCfg;
  sources: SourcesCfg & { kinds: string[] };
  embedder: EmbedderCfg;
  next: NextModelCfg | null;
  /** The old model's points and vectors go this many days after the model tag changed. */
  retireAfterDays: number;
  vectors: VectorsCfg;
  search: SearchCfg;
  indexer: IndexerCfg;
  /** When the weekly reconcile runs (5-field cron, local time). */
  reconcileCron: string;
  feedKeep: number;
  degradedAlertMinutes: number;
  remember: RememberCfg;
  telegram: { findLimit: number };
  store: StoreCfg;
}

export const HISTORY_DEFAULTS: Readonly<HistoryCfg> = {
  enabled: true, dbPath: "data/history.db", chunk: CHUNK_DEFAULTS, sources: { ...SOURCES_DEFAULTS, kinds: [...SOURCE_KINDS] },
  embedder: EMBEDDER_DEFAULTS, next: null, retireAfterDays: 7, vectors: VECTORS_DEFAULTS, search: SEARCH_DEFAULTS,
  indexer: INDEXER_DEFAULTS, reconcileCron: "17 4 * * 0", feedKeep: 200_000, degradedAlertMinutes: 60,
  remember: REMEMBER_DEFAULTS, telegram: { findLimit: 5 }, store: STORE_DEFAULTS,
};
