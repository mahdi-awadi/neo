// The task history's eval harness (ADR-0067 plan task 18; the verify step, task 20, writes the real set and
// runs it): recall@k and MRR of words-only, meaning-only and hybrid search over an eval set of queries with
// their expected refs, and the latency percentiles. It runs the engine's own search (`searchHistory`) over
// a store, read-only, with the mode's list weights; nothing here is a second search.
//
//   bun tools/history/eval.ts --db <file> [--set tools/history/eval-set.json] [--ledger <copy>] [--verify]
//                             [--modes words,meaning,hybrid] [--json] [model flags as in admin.ts]
//
// Modes: `words` is the keyword-only search (exact, words and lines; the meaning weight 0), `meaning` the
// meaning list alone (exact ids still rank first), `hybrid` the configured weights. A mode keeps only the
// hits its lists found. `--verify` searches the verify tag that `admin.ts backfill --verify` uploaded.
// The config and the keys come through the engine's loader (`realContext` → `loadConfig`); none is printed.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openLedger } from "../../src/engine/ledger";
import type { HistoryCfg } from "../../src/engine/history/defaults";
import { openEmbedder, withTag } from "../../src/engine/history/embedder";
import type { ListName } from "../../src/engine/history/fuse";
import { searchHistory, type HistoryQuery, type HistoryResult } from "../../src/engine/history/search";
import { createQueryGate } from "../../src/engine/history/services";
import { openHistoryStore, type HistoryKind } from "../../src/engine/history/store";
import { openVectorIndex } from "../../src/engine/history/vector-index";
import { embedderFrom, outsideData, realContext, Refused, verifyTag } from "./admin";

export type EvalMode = "words" | "meaning" | "hybrid";
export const EVAL_MODES: readonly EvalMode[] = ["words", "meaning", "hybrid"];

export interface EvalRow {
  id: string;
  lang: "ar" | "en";
  query: string;
  /** The refs a good answer holds (any order); at least one. */
  expected: string[];
  project?: string;
  kinds?: HistoryKind[];
}

export interface EvalSet {
  version: 1;
  /** The cut-off of recall@k and MRR. */
  k: number;
  queries: EvalRow[];
}

/** Check an eval set. Throws with the reason of the first bad field. */
export function parseEvalSet(raw: unknown): EvalSet {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (r.version !== 1) throw new Error("eval set: version must be 1");
  if (!Number.isInteger(r.k) || (r.k as number) <= 0) throw new Error("eval set: k must be a positive whole number");
  if (!Array.isArray(r.queries) || !r.queries.length) throw new Error("eval set: queries must be a non-empty list");
  const seen = new Set<string>();
  const queries = r.queries.map((q: unknown, i): EvalRow => {
    const row = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
    const at = `eval set: query ${i + 1}`;
    if (typeof row.id !== "string" || !row.id) throw new Error(`${at}: id must be a string`);
    if (seen.has(row.id)) throw new Error(`${at}: id ${row.id} is used twice`);
    seen.add(row.id);
    if (row.lang !== "ar" && row.lang !== "en") throw new Error(`${at}: lang must be "ar" or "en"`);
    if (typeof row.query !== "string" || !row.query.trim()) throw new Error(`${at}: query must be a non-empty string`);
    if (!Array.isArray(row.expected) || !row.expected.length || !row.expected.every((e) => typeof e === "string" && e)) throw new Error(`${at}: expected must be a non-empty list of refs`);
    if (row.project !== undefined && typeof row.project !== "string") throw new Error(`${at}: project must be a string`);
    if (row.kinds !== undefined && !(Array.isArray(row.kinds) && row.kinds.every((k) => typeof k === "string"))) throw new Error(`${at}: kinds must be a list of kinds`);
    return {
      id: row.id, lang: row.lang, query: row.query, expected: row.expected as string[],
      ...(row.project ? { project: row.project } : {}), ...(row.kinds ? { kinds: row.kinds as HistoryKind[] } : {}),
    };
  });
  return { version: 1, k: r.k as number, queries };
}

/** The share of `expected` among the first `k` of `ranked`. */
export function recallAt(k: number, expected: readonly string[], ranked: readonly string[]): number {
  if (!expected.length) return 0;
  const top = new Set(ranked.slice(0, k));
  return expected.filter((e) => top.has(e)).length / expected.length;
}

/** One over the rank of the first expected ref within the first `k` (all when no `k`); 0 when none. */
export function reciprocalRank(expected: readonly string[], ranked: readonly string[], k = ranked.length): number {
  const want = new Set(expected);
  const i = ranked.slice(0, k).findIndex((r) => want.has(r));
  return i < 0 ? 0 : 1 / (i + 1);
}

/** The nearest-rank percentile `p` (0–100) of `values`; 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
}

/** A mode's list weights over the configured ones. */
export function modeWeights(mode: EvalMode, w: HistoryCfg["search"]["weights"]): HistoryCfg["search"]["weights"] {
  if (mode === "words") return { ...w, meaning: 0 };
  if (mode === "meaning") return { meaning: w.meaning, words: 0, lines: 0 };
  return { ...w };
}

/** True when a hit was found by a list the mode uses. */
export function keepHit(mode: EvalMode, via: readonly ListName[]): boolean {
  if (mode === "words") return via.some((v) => v !== "meaning");
  if (mode === "meaning") return via.includes("meaning");
  return true;
}

export interface ModeScore {
  queries: number;
  recall: number;
  mrr: number;
  p50Ms: number;
  p95Ms: number;
  /** Searches that answered `ok: false`. */
  failed: number;
  /** The meaning modes seen (on, partial, off: <reason>, skipped) and how often. */
  meaningModes: Record<string, number>;
}

export interface EvalReport {
  k: number;
  modes: Record<EvalMode, ModeScore & { byLang: Record<"ar" | "en", ModeScore> }>;
  queries: Array<{ id: string; lang: "ar" | "en"; modes: Record<EvalMode, { recall: number; rr: number; ms: number; ranked: string[] }> }>;
}

type Search = (mode: EvalMode, q: HistoryQuery) => Promise<HistoryResult>;

function score(rows: Array<{ recall: number; rr: number; ms: number; ok: boolean; meaning: string }>): ModeScore {
  const n = rows.length;
  const meaningModes: Record<string, number> = {};
  for (const r of rows) meaningModes[r.meaning] = (meaningModes[r.meaning] ?? 0) + 1;
  return {
    queries: n,
    recall: n ? rows.reduce((a, r) => a + r.recall, 0) / n : 0,
    mrr: n ? rows.reduce((a, r) => a + r.rr, 0) / n : 0,
    p50Ms: percentile(rows.map((r) => r.ms), 50),
    p95Ms: percentile(rows.map((r) => r.ms), 95),
    failed: rows.filter((r) => !r.ok).length,
    meaningModes,
  };
}

/** Run every query in every mode, one at a time (latency is measured per search). */
export async function runEval(set: EvalSet, modes: readonly EvalMode[], search: Search): Promise<EvalReport> {
  const per: Record<string, Array<{ lang: "ar" | "en"; recall: number; rr: number; ms: number; ok: boolean; meaning: string }>> = {};
  const queries: EvalReport["queries"] = [];
  for (const q of set.queries) {
    const row = { id: q.id, lang: q.lang, modes: {} as EvalReport["queries"][number]["modes"] };
    for (const mode of modes) {
      const started = performance.now();
      const r = await search(mode, { query: q.query, ...(q.project ? { project: q.project } : {}), ...(q.kinds ? { kinds: q.kinds } : {}) });
      const ms = performance.now() - started;
      const ranked = r.ok ? r.hits.filter((h) => keepHit(mode, h.via)).map((h) => h.ref) : [];
      const m = r.mode;
      const meaning = m.meaning === "off" ? `off: ${m.reason}` : m.meaning;
      const result = { recall: recallAt(set.k, q.expected, ranked), rr: reciprocalRank(q.expected, ranked, set.k), ms, ranked: ranked.slice(0, set.k) };
      row.modes[mode] = result;
      (per[mode] ??= []).push({ lang: q.lang, ...result, ok: r.ok, meaning });
    }
    queries.push(row);
  }
  const modesOut = {} as EvalReport["modes"];
  for (const mode of modes) {
    const rows = per[mode] ?? [];
    modesOut[mode] = { ...score(rows), byLang: { ar: score(rows.filter((r) => r.lang === "ar")), en: score(rows.filter((r) => r.lang === "en")) } };
  }
  return { k: set.k, modes: modesOut, queries };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** The report as lines: one per mode, then per language. */
export function reportLines(r: EvalReport): string[] {
  const lines: string[] = [];
  for (const [mode, s] of Object.entries(r.modes)) {
    lines.push(`${mode.padEnd(8)} recall@${r.k} ${pct(s.recall)} · MRR ${s.mrr.toFixed(3)} · p50 ${s.p50Ms.toFixed(0)} ms · p95 ${s.p95Ms.toFixed(0)} ms · ${s.queries} queries${s.failed ? ` · ${s.failed} failed` : ""} · meaning ${JSON.stringify(s.meaningModes)}`);
    for (const [lang, l] of Object.entries(s.byLang)) if (l.queries) lines.push(`  ${lang} recall@${r.k} ${pct(l.recall)} · MRR ${l.mrr.toFixed(3)} · ${l.queries} queries`);
  }
  return lines;
}

if (import.meta.main) {
  const { values: f } = parseArgs({
    args: process.argv.slice(2), strict: true, allowPositionals: false,
    options: {
      db: { type: "string" }, set: { type: "string" }, ledger: { type: "string" }, verify: { type: "boolean" }, modes: { type: "string" }, json: { type: "boolean" },
      "embedder-url": { type: "string" }, model: { type: "string" }, revision: { type: "string" }, dims: { type: "string" }, "key-env": { type: "string" },
    },
  });
  const ctx = realContext(process.env.NEO_DIR || undefined);
  const db = resolve(ctx.neoDir, f.db ?? ctx.cfg.dbPath);
  if (!existsSync(db)) {
    console.error(`no history store at ${db}`);
    process.exit(1);
  }
  const set = parseEvalSet(JSON.parse(readFileSync(f.set ?? join(import.meta.dir, "eval-set.json"), "utf8")));
  const modes = (f.modes?.split(",") ?? [...EVAL_MODES]) as EvalMode[];
  if (!modes.every((m) => EVAL_MODES.includes(m))) {
    console.error(`--modes takes ${EVAL_MODES.join(",")}`);
    process.exit(2);
  }
  // The ledger copy is opened by the engine (which migrates it): never a file inside data/.
  let ledgerPath = ":memory:";
  try {
    if (f.ledger) ledgerPath = outsideData(ctx, f.ledger, "the ledger copy");
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    console.error(`refused: ${e.message}`);
    process.exit(1);
  }
  const ecfg = embedderFrom(f, ctx.cfg.embedder);
  const base = openEmbedder(ecfg, ctx.env);
  const embedder = f.verify ? withTag(base, verifyTag(base.tag)) : base;
  const store = openHistoryStore(db, ctx.cfg.store);
  const deps = {
    store, ledger: openLedger(ledgerPath), embedder, vectors: openVectorIndex(ctx.cfg.vectors, ctx.env, { dims: ecfg.dims }),
    gate: createQueryGate(), events: () => {},
  };
  const report = await runEval(set, modes, (mode, q) =>
    searchHistory({ ...deps, cfg: { ...ctx.cfg, search: { ...ctx.cfg.search, weights: modeWeights(mode, ctx.cfg.search.weights) } } }, { ...q, limit: ctx.cfg.search.maxLimit }));
  store.close();
  console.log(`eval ${set.queries.length} queries · tag ${embedder.tag} · ${db}`);
  for (const l of reportLines(report)) console.log(l);
  if (f.json) console.log(JSON.stringify(report));
}
