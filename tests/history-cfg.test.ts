// ADR-0066 config `history` (spec "Config", plan task 11): `readHistoryCfg` keeps a value of the right type
// and falls back to the default for anything else, section by section, so one bad key never turns a guard
// off. `allowedCollections` keeps only `neo_` names; `next` is kept only when it is a complete, different
// model whose vectors have a place to go.
import { describe, expect, test } from "bun:test";
import { EMBEDDER_DEFAULTS, HISTORY_DEFAULTS, SOURCE_KINDS } from "../src/engine/history/defaults";
import { readHistoryCfg } from "../src/engine/history/cfg";

const REV = "5617a9f61b028005a4858fdac845db406aefb181";
const NEXT = { model: "Qwen/Qwen3-Embedding-0.6B", revision: "aaaabbbbccccddddeeeeffff0000111122223333", url: "http://127.0.0.1:8089" };

describe("readHistoryCfg", () => {
  test("no section, or not an object, gives the defaults", () => {
    expect(readHistoryCfg(undefined)).toEqual(HISTORY_DEFAULTS);
    expect(readHistoryCfg(null)).toEqual(HISTORY_DEFAULTS);
    expect(readHistoryCfg("on")).toEqual(HISTORY_DEFAULTS);
    expect(readHistoryCfg([])).toEqual(HISTORY_DEFAULTS);
  });

  test("good values are kept, the rest of each section stays default", () => {
    const c = readHistoryCfg({
      enabled: false, dbPath: "data/h2.db", retireAfterDays: 3, feedKeep: 5000, reconcileCron: "0 5 * * 1",
      chunk: { chars: 800, overlap: 100 },
      sources: { kinds: ["todo", "plan"], planMaxBytes: 4096 },
      embedder: { revision: REV, batch: 4 },
      vectors: { collection: "neo_history2", allowedCollections: ["neo_history", "neo_history2"], minScore: 0.4 },
      search: { weights: { lines: 0.25 }, defaultLimit: 5 },
      indexer: { busyPauseMs: 500 },
      remember: { perSessionHour: 5 },
      telegram: { findLimit: 3 },
      degradedAlertMinutes: 30,
    });
    expect(c.enabled).toBe(false);
    expect(c.dbPath).toBe("data/h2.db");
    expect(c.retireAfterDays).toBe(3);
    expect(c.feedKeep).toBe(5000);
    expect(c.reconcileCron).toBe("0 5 * * 1");
    expect(c.chunk).toEqual({ ...HISTORY_DEFAULTS.chunk, chars: 800, overlap: 100 });
    expect(c.sources).toEqual({ ...HISTORY_DEFAULTS.sources, kinds: ["todo", "plan"], planMaxBytes: 4096 });
    expect(c.embedder).toEqual({ ...EMBEDDER_DEFAULTS, revision: REV, batch: 4 });
    expect(c.vectors.collection).toBe("neo_history2");
    expect(c.vectors.allowedCollections).toEqual(["neo_history", "neo_history2"]);
    expect(c.vectors.minScore).toBe(0.4);
    expect(c.vectors.urlEnv).toBe("SHARED_QDRANT_URL");
    expect(c.search.weights).toEqual({ ...HISTORY_DEFAULTS.search.weights, lines: 0.25 });
    expect(c.search.defaultLimit).toBe(5);
    expect(c.indexer.busyPauseMs).toBe(500);
    expect(readHistoryCfg({ indexer: { embedGrowAfter: 2 } }).indexer.embedGrowAfter).toBe(2);
    expect(c.remember.perSessionHour).toBe(5);
    expect(c.telegram.findLimit).toBe(3);
    expect(c.degradedAlertMinutes).toBe(30);
  });

  test("each wrong value keeps its default", () => {
    const c = readHistoryCfg({
      enabled: "yes", dbPath: "  ", retireAfterDays: -1, feedKeep: 1.5, reconcileCron: "every sunday", degradedAlertMinutes: "60",
      chunk: { chars: 0, overlap: -5, minChars: "24", maxPerRef: Infinity },
      sources: { kinds: ["todo", "email"], planMaxBytes: 0, boilerplateMinRows: 1.2, lineageDepth: -1 },
      embedder: { url: 42, keyEnv: "my key", model: "", revision: 7, dims: 0, batch: -1, timeoutMs: NaN, queryTimeoutMs: "3000", queryCache: -1, backoffMs: 0, backoffMaxMs: null },
      vectors: { urlEnv: "url-env", keyEnv: "", collection: "history", uploadBatch: 0, timeoutMs: -1, queryTimeoutMs: 0, knn: 0, minScore: 1.5, driftRatio: 2 },
      search: { rrfK: 0, weights: { meaning: -1, words: "1" }, exactBoost: -1, defaultLimit: 0, maxLimit: 0, listLimit: 0, snippetChars: 0, maxQueryChars: 0, maxTerms: 0, fullCoverage: 1.2 },
      indexer: { feedBatch: 0, sliceRows: -2, busyPauseMs: -1, reconcileRows: 0, embedBatchesPerPass: 0, embedGrowAfter: 0, uploadBatchesPerPass: "8" },
      remember: { minChars: 0, maxChars: -1, perSessionHour: 0 },
      telegram: { findLimit: 0 },
      store: { lockStaleMs: 0 },
      next: "qwen",
    });
    expect(c).toEqual(HISTORY_DEFAULTS);
  });

  test("an overlap not below the chunk size, a default limit above the max and a back-off cap below the back-off are refused", () => {
    expect(readHistoryCfg({ chunk: { chars: 500, overlap: 500 } }).chunk).toEqual({ ...HISTORY_DEFAULTS.chunk, chars: 500 });
    expect(readHistoryCfg({ search: { defaultLimit: 60 } }).search.defaultLimit).toBe(HISTORY_DEFAULTS.search.defaultLimit);
    // a smaller max is kept, and the default limit comes down to it
    expect(readHistoryCfg({ search: { maxLimit: 5 } }).search).toMatchObject({ maxLimit: 5, defaultLimit: 5 });
    expect(readHistoryCfg({ embedder: { backoffMs: 10_000, backoffMaxMs: 5_000 } }).embedder).toMatchObject({ backoffMs: 10_000, backoffMaxMs: EMBEDDER_DEFAULTS.backoffMaxMs });
    expect(readHistoryCfg({ remember: { minChars: 50, maxChars: 40 } }).remember).toEqual({ ...HISTORY_DEFAULTS.remember, minChars: 50 });
  });

  test("source kinds: only known kinds, no duplicates; an empty or unknown list keeps all kinds", () => {
    expect(readHistoryCfg({ sources: { kinds: ["todo", "todo", "note"] } }).sources.kinds).toEqual(["todo", "note"]);
    expect(readHistoryCfg({ sources: { kinds: [] } }).sources.kinds).toEqual([...SOURCE_KINDS]);
    expect(readHistoryCfg({ sources: { kinds: ["line"] } }).sources.kinds).toEqual([...SOURCE_KINDS]);
  });

  test("each allowedCollections entry must start with neo_; a collection outside the list is refused", () => {
    expect(readHistoryCfg({ vectors: { allowedCollections: ["neo_history", "shared_docs"] } }).vectors.allowedCollections).toEqual(["neo_history"]);
    expect(readHistoryCfg({ vectors: { allowedCollections: ["shared_docs"] } }).vectors.allowedCollections).toEqual(["neo_history"]);
    expect(readHistoryCfg({ vectors: { allowedCollections: "neo_history" } }).vectors.allowedCollections).toEqual(["neo_history"]);
    expect(readHistoryCfg({ vectors: { allowedCollections: ["neo_a", " neo_b "] } }).vectors.allowedCollections).toEqual(["neo_a", "neo_b"]);
    // neo_history is the default collection, but it is not in the list given here
    expect(readHistoryCfg({ vectors: { allowedCollections: ["neo_a"] } }).vectors).toMatchObject({ collection: "neo_history", allowedCollections: ["neo_a"] });
    expect(readHistoryCfg({ vectors: { collection: "neo_other" } }).vectors.collection).toBe("neo_history");
  });

  test("env names, not values: a name must look like an environment variable", () => {
    const c = readHistoryCfg({ embedder: { keyEnv: "NEO_TEI_KEY" }, vectors: { urlEnv: "QDRANT_URL_2", keyEnv: "QDRANT_KEY_2" } });
    expect(c.embedder.keyEnv).toBe("NEO_TEI_KEY");
    expect(c.vectors).toMatchObject({ urlEnv: "QDRANT_URL_2", keyEnv: "QDRANT_KEY_2" });
    expect(readHistoryCfg({ embedder: { keyEnv: "eyJhbGciOi.secret" } }).embedder.keyEnv).toBe("HISTORY_EMBEDDER_KEY");
  });

  describe("next", () => {
    test("a complete model with the same dims is kept, over the embedder defaults", () => {
      const c = readHistoryCfg({ embedder: { revision: REV }, next: NEXT });
      expect(c.next).toEqual({ ...EMBEDDER_DEFAULTS, ...NEXT });
    });

    test("a model with no model id, no revision or the same tag as the active one is dropped", () => {
      expect(readHistoryCfg({ next: { ...NEXT, model: "" } }).next).toBeNull();
      expect(readHistoryCfg({ next: { ...NEXT, revision: "" } }).next).toBeNull();
      expect(readHistoryCfg({ embedder: { revision: REV }, next: { model: EMBEDDER_DEFAULTS.model, revision: REV } }).next).toBeNull();
      expect(readHistoryCfg({ next: null }).next).toBeNull();
    });

    test("other dims need an allowed neo_ collection; a collection with the same dims is kept", () => {
      const allowed = { allowedCollections: ["neo_history", "neo_history_768"] };
      expect(readHistoryCfg({ next: { ...NEXT, dims: 768 } }).next).toBeNull();
      expect(readHistoryCfg({ vectors: allowed, next: { ...NEXT, dims: 768, collection: "neo_history_999" } }).next).toBeNull();
      expect(readHistoryCfg({ vectors: allowed, next: { ...NEXT, dims: 768, collection: "neo_history_768" } }).next).toMatchObject({ dims: 768, collection: "neo_history_768" });
      expect(readHistoryCfg({ next: { ...NEXT, collection: "neo_history" } }).next).toMatchObject({ collection: "neo_history" });
    });
  });
});
