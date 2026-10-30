// ADR-0066 search (spec "Search", AC1–AC4, AC14, the search side of AC9, AC24 for its event): exact ids
// first, then weighted RRF over the Qdrant nearest neighbours, the history words (body and stems) and the
// worker lines; the filters in every list; the modes on / partial / off (each reason) / skipped; a failed
// list never stops the others; Arabic normalization, stems and the highlight on the original text; the
// query checks; an unreadable store. The embedder is the fake TEI with a fixed concept map.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../src/engine/format";
import type { Ledger } from "../src/engine/ledger";
import type { Embedder } from "../src/engine/history/embedder";
import { exactLookup, parseQuery } from "../src/engine/history/exact";
import { findIdTokens } from "../src/engine/history/extract";
import { createIndexer } from "../src/engine/history/indexer";
import { normalize } from "../src/engine/history/normalize";
import { searchHistory, type HistoryQuery, type SearchDeps } from "../src/engine/history/search";
import { createQueryGate, type MeaningOffReason } from "../src/engine/history/services";
import type { HistoryStore } from "../src/engine/history/store";
import { NoVectorIndex, type VectorIndex } from "../src/engine/history/vector-index";
import { bench, operatorThread, order, todo, type Bench } from "./fixtures/history-harness";

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);

/** The fake embedder's concept map: paraphrases of "seats are not released" point the same way. */
const SEATS = /seat|capacity|released|freeing|مقاعد|تتحرر/;
const REFUNDS = /refund|wallet|استرداد/;
function vectorOf(text: string): number[] {
  const n = normalize(text);
  if (SEATS.test(n)) return [1, 0.05, 0, 0];
  if (REFUNDS.test(n)) return [0, 1, 0.05, 0];
  return [0, 0, 1, 0.3];
}

let benches: Bench[] = [];
afterEach(() => {
  for (const b of benches.splice(0)) b.stop();
});
function setup(): Bench {
  const b = bench({ vectorOf });
  benches.push(b);
  return b;
}
async function index(b: Bench, now = T0): Promise<void> {
  await createIndexer({ store: b.store, ledger: b.led, cfg: b.cfg, workRoot: b.workRoot, embedder: b.embedder, vectors: b.vectors, events: b.record, gate: createQueryGate(), pid: process.pid }).tick(now);
}
function deps(b: Bench, over: Partial<SearchDeps> = {}): SearchDeps {
  return { store: b.store, ledger: b.led, embedder: b.embedder, vectors: b.vectors, cfg: b.cfg, gate: createQueryGate(), events: b.record, ...over };
}
const search = (b: Bench, q: string | HistoryQuery, over: Partial<SearchDeps> = {}) => searchHistory(deps(b, over), typeof q === "string" ? { query: q } : q);

/** A small history: two seat entries (English and Arabic), distractors, and ids to find. */
function seed(b: Bench) {
  const t = operatorThread(b.led);
  const add = (brief: string, project = "eticket") => b.led.addTodo(todo({ brief, project, cause: { msgId: t, threadId: t } })).id;
  const english = add("Capacity is not released when a booking is cancelled.");
  const arabic = add("المقاعد لا تتحرر بعد إلغاء الحجز في الرحلة، يجب إصلاح ذلك.");
  const bus = add("The bus route map needs a new colour on the timetable page.");
  const refund = add("Refunds go to the wallet page for card payments now.");
  const pnr = add("Customer booking QX7K2P failed at the payment step yesterday.");
  const harakat = add("الحافلة والمقاعدُ المحجوزة لا تعود بعد الإلغاء.", "waselni");
  const digits = add("Booking 123 failed at the payment step for the bus.", "waselni");
  b.led.recordOrder(order({ id: "d1", task: "Ship the seat release fix to dev." }), { cause: { msgId: t, threadId: t } });
  b.led.recordOutcome("d1", "done", "Shipped in abc1234def0 on dev; the release job frees the capacity.", T0);
  return { t, english, arabic, bus, refund, pnr, harakat, digits };
}

describe("parsing the query", () => {
  test("ids, the id-only rule and the terms", () => {
    expect(parseQuery("#884", new Set())).toMatchObject({ idOnly: true, terms: [] });
    expect(parseQuery("todo 884", new Set())).toMatchObject({ idOnly: true });
    expect(parseQuery("bus seats #884", new Set(["the"]))).toMatchObject({ idOnly: false, terms: ["bus", "seats"] });
    expect(parseQuery("the seats of the bus", new Set(["the", "of"])).terms).toEqual(["seats", "bus"]);
    expect(parseQuery("١٢٣", new Set()).terms).toEqual(["123"]);
  });

  test("each id kind maps to its lookup", () => {
    const look = (q: string) => exactLookup(findIdTokens(q)[0]!);
    expect(look("todo:884")).toEqual({ refs: ["todo:884"] });
    expect(look("#884")).toEqual({ refs: ["todo:884"], meta: { field: "todo", value: 884 } });
    expect(look("plan 12")).toEqual({ refs: ["plan:12"] });
    expect(look("note 470")).toEqual({ refs: ["note:470"] });
    expect(look("#ab12cd34")).toEqual({ refs: [], prefix: "dec:ab12cd34" });
    expect(look("m4f2")).toEqual({ refs: [`msg:${parseInt("4f2", 36)}`], meta: { field: "thread", value: parseInt("4f2", 36) } });
    expect(look("abc1234")).toEqual({ refs: [], fts: '"abc1234"*' });
    expect(look("QX7K2P")).toEqual({ refs: [], fts: '"qx7k2p"' });
    const uuid = "0b9c6a2e-1111-4a2b-8c3d-1234567890ab";
    expect(look(uuid)).toEqual({ refs: [`order:${uuid}`, `result:${uuid}`], meta: { field: "order", value: uuid } });
  });
});

describe("AC1: meaning search in both languages", () => {
  test("the English entry and the Arabic paraphrase are in the top 3 for 'bus seats not freeing up'", async () => {
    const b = setup();
    const t = operatorThread(b.led);
    const add = (brief: string) => b.led.addTodo(todo({ brief, cause: { msgId: t, threadId: t } })).id;
    const english = add("Capacity is not released when a booking is cancelled.");
    const arabic = add("المقاعد لا تتحرر بعد إلغاء الحجز في الرحلة، يجب إصلاح ذلك.");
    add("The bus route map needs a new colour on the timetable page.");
    add("Refunds go to the wallet page for card payments now.");
    add("Upgrade the build image and pin its digest in compose.");
    await index(b);
    const r = await search(b, "bus seats not freeing up");
    expect(r.ok).toBe(true);
    expect(r.mode).toEqual({ meaning: "on" });
    const top = r.hits.slice(0, 3).map((h) => h.ref);
    expect(top).toContain(`todo:${english}`);
    expect(top).toContain(`todo:${arabic}`);
    expect(r.hits.find((h) => h.ref === `todo:${english}`)?.via).toContain("meaning");
  });
});

describe("AC2: exact ids first", () => {
  test("#id, a 7-character sha prefix, a decision id and a PNR-like code put their sources first", async () => {
    const b = setup();
    const s = seed(b);
    let dec = "";
    while (!/[a-f]/.test(dec.slice(0, 8))) {
      dec = b.led.openDecision({ kind: "decision", project: "eticket", question: "Which refund path should the wallet use?", options: ["A", "B"], cause: { msgId: s.t, threadId: s.t } }, T0);
    }
    await index(b);
    const calls = b.embedCalls();
    for (const [q, ref] of [[`#${s.english}`, `todo:${s.english}`], ["abc1234", "result:d1"], [`#${dec.slice(0, 8)}`, `dec:${dec}`], ["QX7K2P", `todo:${s.pnr}`]] as const) {
      const r = await search(b, q);
      expect(r.hits[0]?.ref).toBe(ref);
      expect(r.hits[0]?.via).toContain("exact");
      expect(r.mode).toEqual({ meaning: "skipped" });
    }
    expect(b.embedCalls()).toBe(calls); // an id-only query makes no embed call
  });

  test("an id with words still runs meaning, and the id's source is first", async () => {
    const b = setup();
    const s = seed(b);
    await index(b);
    const r = await search(b, `refund wallet #${s.bus}`);
    expect(r.hits[0]?.ref).toBe(`todo:${s.bus}`);
    expect(r.mode.meaning).toBe("on");
  });
});

describe("AC3: citations", () => {
  test("a hit has ref, kind, date, title, snippet, project, todo, order, thread, plan path and commits", async () => {
    const b = setup();
    const s = seed(b);
    const root = mkdtempSync(join(tmpdir(), "neo-hist-plans-"));
    mkdirSync(join(root, "eticket", "docs"), { recursive: true });
    writeFileSync(join(root, "eticket", "docs", "seats-plan.md"), "# Seat release plan\n\nFree the seats when a booking is cancelled, in the release job.");
    b.workRoot = root;
    const plan = b.led.upsertPlan({ project: "eticket", folder: join(root, "eticket"), path: "docs/seats-plan.md", title: "Seat release plan", sha256: "s1", status: "draft", stepsTotal: 1, stepsDone: 0, threadId: s.t });
    const row = b.led.addTodo(todo({ brief: "Wire the seat release job, see abc1234def0.", summary: "Seat release job", cause: { msgId: s.t, threadId: s.t } }));
    b.led.updateTodo(row.id, { orderId: "d1" });
    await index(b);
    const r = await search(b, "seat release");
    const result = r.hits.find((h) => h.ref === "result:d1")!;
    expect(result).toMatchObject({ kind: "result", project: "eticket", at: T0, todo: row.id, order: "d1", thread: s.t, archived: false, commits: ["abc1234def0"] });
    expect(result.title).toBe("Result: Seat release job");
    expect(result.snippet).toContain(SNIPPET_OPEN);
    const p = r.hits.find((h) => h.ref === `plan:${plan.id}`)!;
    expect(p).toMatchObject({ kind: "plan", title: "Seat release plan", path: join(root, "eticket", "docs", "seats-plan.md"), thread: s.t });
  });

  test("an archived entry says so", async () => {
    const b = setup();
    const s = seed(b);
    await index(b);
    b.store.markGone([`todo:${s.bus}`], T0);
    const r = await search(b, "timetable colour");
    expect(r.hits.find((h) => h.ref === `todo:${s.bus}`)?.archived).toBe(true);
  });
});

describe("AC4: the filters apply in every list", () => {
  test("each list gets the filters, and a row outside them never appears", async () => {
    const b = setup();
    const s = seed(b);
    const now = Date.now();
    b.led.insertMessage({ chatId: 1, role: "assistant", content: "worker: the payment step failed for booking", kind: "text", at: now, project: "waselni" });
    b.led.insertMessage({ chatId: 1, role: "assistant", content: "worker: the payment step failed for booking", kind: "text", at: now, project: "eticket" });
    await index(b);
    const seen: Record<string, unknown[]> = { words: [], meaning: [], lines: [] };
    const store = new Proxy(b.store, {
      get: (t, p) => (p === "searchWords" ? (m: unknown, f: unknown, l: number) => (seen.words!.push(f), t.searchWords(m as never, f as never, l)) : Reflect.get(t, p)),
    }) as HistoryStore;
    const vectors = new Proxy(b.vectors, {
      get: (t, p) => (p === "search" ? (v: never, f: unknown, o: never) => (seen.meaning!.push(f), t.search(v, f as never, o)) : Reflect.get(t, p)),
    }) as VectorIndex;
    const ledger = new Proxy(b.led, {
      get: (t, p) => (p === "searchWorkerLines" ? (q: string, f: never) => (seen.lines!.push(f), t.searchWorkerLines(q, f)) : Reflect.get(t, p)),
    }) as Ledger;
    const q: HistoryQuery = { query: "payment step failed booking", project: "waselni", since: now - 86_400_000, until: now + 86_400_000, kinds: ["todo", "line"] };
    const r = await searchHistory(deps(b, { store, vectors, ledger }), q);
    expect(seen.words!.length).toBeGreaterThan(0);
    for (const f of seen.words!) expect(f).toMatchObject({ project: "waselni", since: q.since, until: q.until, kinds: ["todo"] });
    expect(seen.meaning).toEqual([expect.objectContaining({ project: "waselni", since: q.since, until: q.until, kinds: ["todo"] })]);
    expect(seen.lines).toEqual([expect.objectContaining({ project: "waselni", since: q.since, until: q.until })]);
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      expect(h.project).toBe("waselni");
      expect(["todo", "line"]).toContain(h.kind);
    }
    expect(r.hits.map((h) => h.ref)).toContain(`todo:${s.digits}`);
    expect(r.hits.some((h) => h.kind === "line")).toBe(true);
    expect(r.hits.map((h) => h.ref)).not.toContain(`todo:${s.pnr}`); // eticket
  });

  test("an exact id outside the filters is not given", async () => {
    const b = setup();
    const s = seed(b);
    await index(b);
    expect((await search(b, { query: `#${s.english}`, project: "waselni" })).hits).toEqual([]);
    expect((await search(b, { query: `#${s.english}`, kinds: ["plan"] })).hits).toEqual([]);
    expect((await search(b, { query: `#${s.english}`, since: Date.now() + 86_400_000 })).hits).toEqual([]);
  });
});

describe("modes", () => {
  test("partial gives the coverage", async () => {
    const b = setup();
    seed(b);
    await index(b);
    b.qdrant.fail.set("PUT points", 503);
    for (let i = 0; i < 3; i++) b.led.recordOrder(order({ id: `x${i}`, task: `Another order number ${i} about the seats.` }));
    await index(b, T0 + 60_000);
    b.qdrant.fail.clear();
    const r = await search(b, "seats");
    expect(r.mode.meaning).toBe("partial");
    const cov = b.store.coverage(b.embedder.tag).ratio;
    expect(r.mode).toEqual({ meaning: "partial", coverage: cov });
    expect(cov).toBeLessThan(1);
  });

  test("off with each reason; keyword hits still come", async () => {
    const b = setup();
    const s = seed(b);
    await index(b);
    const embReasons: MeaningOffReason[] = ["not_configured", "config_refused", "embedder_down", "embedder_slow", "embedder_refused", "embedder_wrong_model"];
    for (const reason of embReasons) {
      const embedder: Embedder = { tag: b.embedder.tag, dims: b.embedder.dims, probe: b.embedder.probe, embed: b.embedder.embed, embedQuery: async () => ({ ok: false, reason }) };
      const r = await search(b, "timetable colour", { embedder });
      expect(r.mode).toEqual({ meaning: "off", reason });
      expect(r.hits[0]?.ref).toBe(`todo:${s.bus}`);
    }
    for (const reason of ["vectors_down", "vectors_slow", "vectors_refused", "collection_missing", "config_refused"] as MeaningOffReason[]) {
      const r = await search(b, "timetable colour", { vectors: new NoVectorIndex(reason) });
      expect(r.mode).toEqual({ meaning: "off", reason });
      expect(r.hits[0]?.ref).toBe(`todo:${s.bus}`);
    }
    b.tei.stop();
    expect((await search(b, "a new query about colour")).mode).toEqual({ meaning: "off", reason: "embedder_down" });
  });

  test("a failed list does not stop the other lists", async () => {
    const b = setup();
    const s = seed(b);
    await index(b);
    const ledger = new Proxy(b.led, { get: (t, p) => (p === "searchWorkerLines" ? () => { throw new Error("lines broke"); } : Reflect.get(t, p)) }) as Ledger;
    const vectors = new Proxy(b.vectors, { get: (t, p) => (p === "search" ? async () => { throw new Error("search broke"); } : Reflect.get(t, p)) }) as VectorIndex;
    const r = await search(b, "timetable colour", { ledger, vectors });
    expect(r.ok).toBe(true);
    expect(r.hits[0]?.ref).toBe(`todo:${s.bus}`);
    expect(r.mode).toEqual({ meaning: "off", reason: "vectors_down" });
  });
});

describe("AC14: Arabic", () => {
  test("مقاعد finds والمقاعدُ, ١٢٣ finds 123, and the highlight lands on the original text with its harakat", async () => {
    const b = setup();
    const s = seed(b);
    await index(b);
    const ar = await search(b, { query: "مقاعد", project: "waselni" });
    const hit = ar.hits.find((h) => h.ref === `todo:${s.harakat}`)!;
    expect(hit.via).toContain("words");
    expect(hit.snippet).toContain(`${SNIPPET_OPEN}والمقاعدُ${SNIPPET_CLOSE}`);
    const digits = await search(b, "١٢٣");
    expect(digits.hits.map((h) => h.ref)).toContain(`todo:${s.digits}`);
    expect(digits.hits.find((h) => h.ref === `todo:${s.digits}`)?.snippet).toContain(`${SNIPPET_OPEN}123${SNIPPET_CLOSE}`);
  });
});

describe("query checks and failures", () => {
  test("empty, stop words only, too long, an unknown kind, since after until", async () => {
    const b = setup();
    const calls = () => b.embedCalls();
    for (const [q, error] of [
      [{ query: "   " }, "query_empty"],
      [{ query: "the and of" }, "query_stopwords"],
      [{ query: "x".repeat(501) }, "query_too_long"],
      [{ query: "seats", kinds: ["bogus"] }, "unknown_kind"],
      [{ query: "seats", since: 10, until: 5 }, "bad_range"],
    ] as Array<[HistoryQuery, string]>) {
      const r = await searchHistory(deps(b), q);
      expect(r).toMatchObject({ ok: false, error, hits: [] });
    }
    expect(calls()).toBe(0);
  });

  test("an unreadable history.db gives ok: false", async () => {
    const b = setup();
    b.store.close();
    const r = await search(b, "seats");
    expect(r).toMatchObject({ ok: false, error: "history_unreadable", hits: [] });
  });

  test("the limit is clamped, and the history_search event has no query text", async () => {
    const b = setup();
    seed(b);
    await index(b);
    expect((await search(b, { query: "booking payment seats bus", limit: 1 })).hits).toHaveLength(1);
    expect((await search(b, { query: "booking payment seats bus", limit: 500 })).hits.length).toBeLessThanOrEqual(b.cfg.search.maxLimit);
    const ev = b.events.filter((e) => e.kind === "history_search");
    expect(ev.length).toBe(2);
    expect(ev[0]!.data).toMatchObject({ mode: expect.any(String), queryChars: 25 });
    const all = JSON.stringify(ev);
    for (const word of ["booking", "payment", "seats"]) expect(all).not.toContain(word);
  });
});
