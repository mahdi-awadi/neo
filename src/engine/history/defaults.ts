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
