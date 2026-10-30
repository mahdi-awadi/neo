// ADR-0067 plan task 18: the eval harness (tools/history/eval.ts) that the verify step uses to compare
// words only, meaning only and hybrid search, and two embedding models: recall@k and MRR on the eval set,
// and the latency percentiles. The metric math on fixtures; the set's schema (tools/history/eval-set.json
// ships the schema and two sample rows); one run over the real search with the fakes.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createQueryGate } from "../src/engine/history/services";
import { keepHit, modeWeights, parseEvalSet, percentile, reciprocalRank, recallAt, runEval, type EvalMode } from "../tools/history/eval";
import { searchHistory } from "../src/engine/history/search";
import { openTaskHistory } from "../src/engine/history/index";
import { backlogDrains } from "../src/engine/history/runtime";
import { bench, operatorThread, todo, type Bench } from "./fixtures/history-harness";

let open: Bench[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.stop();
});

test("recall@k: the share of the expected refs in the first k; MRR: one over the rank of the first expected ref", () => {
  const ranked = ["a", "b", "c", "d", "e", "f"];
  expect(recallAt(5, ["a", "c"], ranked)).toBe(1);
  expect(recallAt(5, ["a", "f"], ranked)).toBe(0.5);
  expect(recallAt(5, ["x"], ranked)).toBe(0);
  expect(recallAt(2, ["b", "c"], ranked)).toBe(0.5);
  expect(reciprocalRank(["c", "a"], ranked)).toBe(1);
  expect(reciprocalRank(["d"], ranked)).toBe(0.25);
  expect(reciprocalRank(["x"], ranked)).toBe(0);
  expect(reciprocalRank(["f"], ranked, 5)).toBe(0); // past the cut-off
});

test("percentiles by nearest rank", () => {
  const ms = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  expect(percentile(ms, 50)).toBe(50);
  expect(percentile(ms, 95)).toBe(100);
  expect(percentile([7], 95)).toBe(7);
  expect(percentile([], 50)).toBe(0);
});

test("the modes: words is the keyword-only search, meaning the meaning list alone, hybrid the configured weights", () => {
  const w = { meaning: 1, words: 1, lines: 0.5 };
  expect(modeWeights("words", w)).toEqual({ meaning: 0, words: 1, lines: 0.5 });
  expect(modeWeights("meaning", w)).toEqual({ meaning: 1, words: 0, lines: 0 });
  expect(modeWeights("hybrid", w)).toEqual(w);
  expect(keepHit("words", ["meaning"])).toBe(false);
  expect(keepHit("words", ["words", "meaning"])).toBe(true);
  expect(keepHit("meaning", ["words"])).toBe(false);
  expect(keepHit("meaning", ["meaning"])).toBe(true);
  expect(keepHit("hybrid", ["lines"])).toBe(true);
});

test("the shipped eval set (from the verify step) has the schema and at least 10 queries in each language; a bad row is refused with the reason", () => {
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, "..", "tools/history/eval-set.json"), "utf8"));
  const set = parseEvalSet(shipped);
  expect(set.k).toBe(5);
  expect(set.queries.length).toBeGreaterThanOrEqual(20);
  expect(set.queries.filter((q) => q.lang === "ar").length).toBeGreaterThanOrEqual(10);
  expect(set.queries.filter((q) => q.lang === "en").length).toBeGreaterThanOrEqual(10);
  expect(() => parseEvalSet({ ...shipped, queries: [{ id: "x", lang: "en", query: "q", expected: [] }] })).toThrow(/expected/);
  expect(() => parseEvalSet({ ...shipped, queries: [{ id: "x", lang: "fr", query: "q", expected: ["todo:1"] }] })).toThrow(/lang/);
  expect(() => parseEvalSet({ ...shipped, queries: [{ id: "x", lang: "en", query: "", expected: ["todo:1"] }] })).toThrow(/query/);
  expect(() => parseEvalSet({ ...shipped, queries: [shipped.queries[0], shipped.queries[0]] })).toThrow(/twice/);
  expect(() => parseEvalSet({ ...shipped, version: 2 })).toThrow(/version/);
});

test("a run over the real search: each mode's recall@5, MRR and latency, also per language", async () => {
  // The fake embedder maps the two paraphrases close; the words list finds only the English one.
  const SEATS = [1, 0, 0, 0];
  const vectorOf = (t: string) => (/seat|مقاعد|المقاعد/i.test(t) ? SEATS : [0, 1, 0, 0]);
  const b = bench({ vectorOf });
  open.push(b);
  // Index three todos through the real seam (the indexer embeds and uploads them).
  const h = openTaskHistory({ cfg: b.cfg, ledger: b.led, workRoot: b.workRoot, env: b.env, events: () => {}, store: b.store, embedder: b.embedder, vectors: b.vectors });
  const t = operatorThread(b.led);
  const add = (brief: string) => `todo:${b.led.addTodo(todo({ brief, cause: { msgId: t, threadId: t } })).id}`;
  const en = add("Seat capacity is not released when a booking is cancelled.");
  add("Add the Qeshm hotels to the destination list.");
  const ar = add("المقاعد لا تتحرر بعد إلغاء الحجز في الرحلة.");
  for (let i = 0; i < 10 && backlogDrains(await h.indexTick(5)); i++);
  expect(b.store.coverage(b.embedder.tag).ratio).toBe(1);

  const set = parseEvalSet({
    version: 1, k: 5,
    queries: [
      { id: "en-1", lang: "en", query: "bus seats not freeing up", expected: [en, ar] },
      { id: "ar-1", lang: "ar", query: "مقاعد الحافلة لا تتحرر", expected: [ar, en] },
    ],
  });
  const gate = createQueryGate();
  const search = (mode: EvalMode, q: { query: string }) =>
    searchHistory({ store: b.store, ledger: b.led, embedder: b.embedder, vectors: b.vectors, gate, events: () => {}, cfg: { ...b.cfg, search: { ...b.cfg.search, weights: modeWeights(mode, b.cfg.search.weights) } } }, { ...q, limit: b.cfg.search.maxLimit });
  const report = await runEval(set, ["words", "meaning", "hybrid"], search);
  expect(report.modes.meaning.recall).toBe(1);
  expect(report.modes.meaning.mrr).toBe(1);
  expect(report.modes.words.recall).toBeLessThan(1);
  expect(report.modes.hybrid.recall).toBe(1);
  expect(report.modes.hybrid.byLang.ar.queries).toBe(1);
  expect(report.modes.hybrid.p95Ms).toBeGreaterThanOrEqual(report.modes.hybrid.p50Ms);
  expect(report.modes.words.failed).toBe(0);
  expect(report.queries.find((q) => q.id === "en-1")!.modes.meaning.ranked.slice(0, 2).sort()).toEqual([en, ar].sort());
});
