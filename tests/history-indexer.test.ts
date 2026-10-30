// ADR-0066 the indexer (spec "The indexer", AC5–AC11, AC24 for its events): the change feed and its
// mapping, updates that touch only the changed chunks, the archive, the firewall that wins over it,
// tombstones, the reconcile (first, gap, weekly orphans, a saved position), the down states and their
// recovery, drift without embed calls, the model change, and the bounds (slices, single flight, the lock,
// a query first). Every service is a fake on 127.0.0.1.
import { afterEach, describe, expect, test } from "bun:test";
import { CUSTOMER_CHAT } from "../src/engine/chats";
import { TODOS_KEEP, type Ledger } from "../src/engine/ledger";
import { safeFtsQuery } from "../src/engine/memory-recall";
import { modelTag, openEmbedder } from "../src/engine/history/embedder";
import { createIndexer, type IndexerDeps } from "../src/engine/history/indexer";
import { normalize } from "../src/engine/history/normalize";
import { createQueryGate } from "../src/engine/history/services";
import { openHistoryStore, type HistoryStore } from "../src/engine/history/store";
import { startFakeTei } from "./fixtures/fake-tei";
import { bench, DIMS, order, operatorThread, QDRANT_KEY, remotePoints, REV, REV2, TEI_KEY, todo, type Bench } from "./fixtures/history-harness";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const TAG = modelTag("BAAI/bge-m3", DIMS, REV);

let benches: Bench[] = [];
afterEach(() => {
  for (const b of benches.splice(0)) b.stop();
});
function setup(opts: Parameters<typeof bench>[0] = {}): Bench {
  const b = bench(opts);
  benches.push(b);
  return b;
}
function indexer(b: Bench, over: Partial<IndexerDeps> = {}) {
  return createIndexer({
    store: b.store, ledger: b.led, cfg: b.cfg, workRoot: b.workRoot, embedder: b.embedder, vectors: b.vectors,
    events: b.record, gate: createQueryGate(), pid: process.pid, ...over,
  });
}
const found = (s: HistoryStore, q: string) => s.searchWords({ body: safeFtsQuery(normalize(q), { mode: "any" }) }, {}, 50).map((h) => h.ref);

describe("freshness and the feed", () => {
  test("a new todo is keyword-searchable after one pass and has a point after its batches; a second pass does no work", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0); // the first reconcile on an empty ledger
    const t = operatorThread(b.led);
    const row = b.led.addTodo(todo({ brief: "Free the bus seats when a booking is cancelled.", cause: { msgId: t, threadId: t } }));
    const r = await ix.tick(T0 + MIN);
    expect(r.feed.read).toBeGreaterThan(0);
    expect(r.sources.indexed).toBe(1);
    expect(found(b.store, "seats")).toContain(`todo:${row.id}`);
    expect(r.embedded).toBe(1);
    expect(r.uploaded).toBe(1);
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(1);
    expect(r.backlog).toEqual({ feed: 0, toEmbed: 0, toUpload: 0, pendingDeletes: 0 });
    expect(r.coverage).toBe(1);
    const calls = b.embedCalls();
    const again = await ix.tick(T0 + 2 * MIN);
    expect(again.sources).toMatchObject({ indexed: 0 });
    expect(again.embedded + again.uploaded).toBe(0);
    expect(b.embedCalls()).toBe(calls);
  });

  test("the feed cursor survives a reopen of the store", async () => {
    const b = setup();
    await indexer(b).tick(T0);
    const t = operatorThread(b.led);
    b.led.addTodo(todo({ brief: "Cursor test: a brief long enough to index.", cause: { msgId: t, threadId: t } }));
    await indexer(b).tick(T0 + MIN);
    const cursor = b.store.getState("feed.cursor");
    expect(Number(cursor)).toBe(b.led.historyFeedBounds().newest);
    b.store.close();
    const reopened = openHistoryStore(b.dbPath);
    b.store = reopened;
    expect(reopened.getState("feed.cursor")).toBe(cursor);
    expect((await indexer(b).tick(T0 + 2 * MIN)).sources.indexed).toBe(0);
  });

  test("an order change touches its order, result and todo entries; a todo that gets the order removes the order entry", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0);
    b.led.recordOrder(order({ id: "d1", task: "Audit the refund path for the wallet." }));
    b.led.recordOutcome("d1", "done", "Refunds now go to the wallet, see abc1234.", 2_000);
    await ix.tick(T0 + MIN);
    expect(b.store.getSource("order:d1")).toBeDefined();
    expect(b.store.getSource("result:d1")?.title).toBe("Result: Audit the refund path for the wallet.");
    // A re-record with a new task changes the result's title: the order's feed row touches the result.
    b.led.recordOrder(order({ id: "d1", task: "Check the Qi refund path end to end." }));
    await ix.tick(T0 + 2 * MIN);
    expect(b.store.getSource("result:d1")?.title).toBe("Result: Check the Qi refund path end to end.");
    // A todo takes the order: the order is indexed as that todo from now on.
    const t = operatorThread(b.led);
    const row = b.led.addTodo(todo({ brief: "Refund audit as a todo with a long brief.", summary: "Refund audit", cause: { msgId: t, threadId: t } }));
    b.led.updateTodo(row.id, { orderId: "d1" });
    await ix.tick(T0 + 3 * MIN);
    expect(b.store.getSource("order:d1")).toBeUndefined();
    expect(b.store.getSource(`todo:${row.id}`)?.meta.order).toBe("d1");
    expect(b.store.getSource("result:d1")?.title).toBe("Result: Refund audit");
  });
});

describe("updates", () => {
  const para = (n: number, word: string) => `${word} paragraph ${n}. ` + `${word} `.repeat(200).trim() + ".";

  test("only changed chunks get a new vector; the same point id is overwritten; removed chunks leave Qdrant", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0);
    b.led.recordOrder(order({ id: "d1", task: "Long result order." }));
    b.led.recordOutcome("d1", "done", [para(1, "alpha"), para(2, "beta"), para(3, "gamma")].join("\n\n"), 2_000);
    await ix.tick(T0 + MIN);
    const before = b.store.chunksOf("result:d1");
    expect(before.length).toBeGreaterThanOrEqual(3);
    const pointsBefore = new Set(b.store.pointIdsOfTag(TAG));
    const remoteBefore = remotePoints(b.qdrant, TAG).length;
    const inputs = b.embedInputs().length;
    // Change the second paragraph only.
    b.led.recordOutcome("d1", "done", [para(1, "alpha"), para(2, "zeta"), para(3, "gamma")].join("\n\n"), 2_000);
    const r = await ix.tick(T0 + 2 * MIN);
    expect(r.chunks.changed).toBeGreaterThan(0);
    expect(r.chunks.changed).toBeLessThan(before.length);
    expect(b.embedInputs().length - inputs).toBe(r.chunks.changed);
    expect(new Set(b.store.pointIdsOfTag(TAG))).toEqual(pointsBefore); // the same ids, overwritten
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(remoteBefore);
    // Shrink: the removed chunks are queued and then deleted in Qdrant.
    b.led.recordOutcome("d1", "done", para(1, "alpha"), 2_000);
    const shrink = await ix.tick(T0 + 3 * MIN);
    expect(shrink.chunks.deleted).toBeGreaterThan(0);
    expect(shrink.pointsDeleted).toBe(shrink.chunks.deleted);
    expect(b.store.countPendingDeletes()).toBe(0);
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(b.store.chunksOf("result:d1").length);
  });
});

describe("the archive, the firewall and tombstones", () => {
  test("a pruned todo gets gone_at and stays searchable", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0);
    const t = operatorThread(b.led);
    const first = b.led.addTodo(todo({ brief: "Archived brief about the bus seats.", cause: { msgId: t, threadId: t } })).id;
    await ix.tick(T0 + MIN);
    b.led.updateTodo(first, { status: "done" });
    b.led.transaction(() => {
      for (let i = 0; i < TODOS_KEEP; i++) b.led.updateTodo(b.led.addTodo(todo({ brief: "x" })).id, { status: "cancelled" });
    });
    expect(b.led.todoById(first)).toBeUndefined();
    const r = await ix.tick(T0 + 2 * MIN);
    expect(r.sources.archived).toBe(1);
    expect(b.store.getSource(`todo:${first}`)?.goneAt).toBe(T0 + 2 * MIN);
    expect(found(b.store, "seats")).toContain(`todo:${first}`);
  });

  test("a verdict that changes to excluded removes the entry", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0);
    b.led.recordOrder(order({ id: "d1", task: "A dispatch order with enough text." }));
    await ix.tick(T0 + MIN);
    expect(b.store.getSource("order:d1")).toBeDefined();
    const pts = b.store.pointIdsOfTag(TAG).length;
    expect(pts).toBe(1);
    b.led.recordOrder(order({ id: "d1", task: "A dispatch order with enough text.", chatId: CUSTOMER_CHAT }));
    const r = await ix.tick(T0 + 2 * MIN);
    expect(r.sources.removedFirewall).toBe(1);
    expect(r.sources.skippedFirewall).toBe(1);
    expect(b.store.getSource("order:d1")).toBeUndefined();
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(0);
    expect(b.events.find((e) => e.kind === "history_firewall_skip")?.data).toEqual({ customer_chat: 1 });
  });

  test("a tombstone stops both the feed and the reconcile", async () => {
    const b = setup({ cfg: (c) => ({ ...c, reconcileCron: "* * * * *" }) });
    const ix = indexer(b);
    await ix.tick(T0);
    const t = operatorThread(b.led);
    const row = b.led.addTodo(todo({ brief: "A brief the operator will forget.", cause: { msgId: t, threadId: t } }));
    await ix.tick(T0 + MIN);
    b.store.transaction(() => {
      b.store.removeSource(`todo:${row.id}`, T0);
      b.store.addTombstone(`todo:${row.id}`, "operator", T0);
    });
    b.led.updateTodo(row.id, { summary: "changed" });
    await ix.tick(T0 + 2 * MIN); // the feed, and a weekly reconcile (cron every minute)
    await ix.tick(T0 + 3 * MIN);
    expect(b.store.getSource(`todo:${row.id}`)).toBeUndefined();
  });
});

describe("secrets and commits", () => {
  test("commits come only from kept chunks and never from a line with a secret shape", async () => {
    const b = setup({ cfg: (c) => ({ ...c, chunk: { ...c.chunk, chars: 90, overlap: 0 } }) });
    const ix = indexer(b);
    await ix.tick(T0);
    const t = operatorThread(b.led);
    const hexKey = ["9f3a", "2b1c", "7d0e"].join(""); // sha-shaped, built so the file holds no key-shaped literal
    const brief = [
      "Fix the bus seat release; the first part landed in 479236d on dev today.",
      `Deploy token: ${hexKey} for the staging box until it is rotated.`,
      `Push with ghp_${"a".repeat(36)} here\nand the hotfix is abc1234f too.`,
    ].join("\n\n");
    const row = b.led.addTodo(todo({ brief, cause: { msgId: t, threadId: t } }));
    await ix.tick(T0 + MIN);
    const src = b.store.getSource(`todo:${row.id}`)!;
    expect(src.meta.commits).toEqual(["479236d"]);
    expect(b.store.chunksOf(`todo:${row.id}`).map((c) => c.text).join(" ")).not.toContain("abc1234f");
  });
});

describe("the reconcile", () => {
  test("a feed gap starts a reconcile that indexes what the feed lost", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0);
    const t = operatorThread(b.led);
    const row = b.led.addTodo(todo({ brief: "Written while the feed was pruned.", cause: { msgId: t, threadId: t } }));
    b.led.pruneHistoryFeed(0);
    const r = await ix.tick(T0 + MIN);
    expect(r.feed.gap).toBe(true);
    expect(r.reconcile).toMatchObject({ reason: "gap", done: true });
    expect(b.store.getSource(`todo:${row.id}`)).toBeDefined();
    expect(b.events.some((e) => e.kind === "history_reconcile")).toBe(true);
  });

  test("the backfill continues from its saved position when the store opens again", async () => {
    const b = setup({ cfg: (c) => ({ ...c, indexer: { ...c.indexer, reconcileRows: 2, sliceRows: 1 } }) });
    const t = operatorThread(b.led);
    const ids = Array.from({ length: 5 }, (_, i) => b.led.addTodo(todo({ brief: `Backfill brief number ${i} with text.`, cause: { msgId: t, threadId: t } })).id);
    const r1 = await indexer(b).tick(T0);
    expect(r1.reconcile).toMatchObject({ reason: "first", done: false });
    const pos = r1.reconcile!.position;
    b.store.close();
    b.store = openHistoryStore(b.dbPath);
    const r2 = await indexer(b).tick(T0 + MIN);
    expect(r2.reconcile?.reason).toBe("first");
    expect(r2.reconcile?.position).not.toBe(pos);
    let r = r2;
    for (let i = 2; i < 20 && !r.reconcile?.done; i++) r = await indexer(b).tick(T0 + i * MIN);
    expect(r.reconcile?.done).toBe(true);
    for (const id of ids) expect(b.store.getSource(`todo:${id}`)).toBeDefined();
  });

  test("the backfill counts paragraphs first, so a paragraph in many briefs is left out of each", async () => {
    const b = setup({ cfg: (c) => ({ ...c, sources: { ...c.sources, boilerplateMinRows: 3 } }) });
    const t = operatorThread(b.led);
    const shared = "Follow the project rules and keep the tests green before you report.";
    const ids = ["alpha", "beta", "gamma"].map((w) => b.led.addTodo(todo({ brief: `${shared}\n\nThe ${w} task has its own words here.`, cause: { msgId: t, threadId: t } })).id);
    const r = await indexer(b).tick(T0);
    expect(r.reconcile).toMatchObject({ reason: "first", done: true });
    for (const id of ids) expect(b.store.chunksOf(`todo:${id}`).map((c) => c.text).join(" ")).not.toContain("project rules");
    expect(found(b.store, "gamma")).toEqual([`todo:${ids[2]}`]);
  });

  test("the weekly run deletes orphan ids in Qdrant", async () => {
    const b = setup({ cfg: (c) => ({ ...c, reconcileCron: "* * * * *" }) });
    const ix = indexer(b);
    b.led.recordOrder(order({ id: "d1", task: "A dispatch order with enough text." }));
    await ix.tick(T0);
    const orphan = "00000000-0000-4000-8000-000000000999";
    b.qdrant.collections.get("neo_history")!.points.set(orphan, { id: orphan, vector: [1, 0, 0, 0], payload: { kind: "todo", at: 1, m: TAG } });
    let r = await ix.tick(T0 + MIN);
    for (let i = 2; i < 6 && r.reconcile?.reason !== "weekly"; i++) r = await ix.tick(T0 + i * MIN);
    for (let i = 6; i < 12 && !(r.reconcile?.reason === "weekly" && r.reconcile.done); i++) r = await ix.tick(T0 + i * MIN);
    expect(r.reconcile).toMatchObject({ reason: "weekly", done: true });
    expect(remotePoints(b.qdrant, TAG)).not.toContain(orphan);
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(1);
  });
});

describe("down states and recovery", () => {
  test("embedder down: the chunks wait, the state and since are set; when it is up again the backlog drains", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0);
    b.tei.stop();
    b.led.recordOrder(order({ id: "d1", task: "Indexed while the embedder is down." }));
    const r = await ix.tick(T0 + MIN);
    expect(r.embedder).toEqual({ state: "down", since: T0 + MIN, reason: "embedder_down" });
    expect(found(b.store, "embedder")).toEqual(["order:d1"]);
    expect(r.backlog.toEmbed).toBe(1);
    expect((await ix.tick(T0 + 2 * MIN)).embedder.since).toBe(T0 + MIN);
    b.tei.restart();
    const up = await ix.tick(T0 + 3 * MIN);
    expect(up.embedder.state).toBe("up");
    expect(up.embedded).toBe(1);
    expect(up.backlog).toEqual({ feed: 0, toEmbed: 0, toUpload: 0, pendingDeletes: 0 });
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(1);
  });

  test("Qdrant down: the vectors are kept and the uploads wait; when it is up again the backlog drains", async () => {
    const b = setup();
    const ix = indexer(b);
    await ix.tick(T0);
    b.qdrant.fail.set("PUT points", 503);
    b.led.recordOrder(order({ id: "d1", task: "Indexed while Qdrant is down." }));
    const r = await ix.tick(T0 + MIN);
    expect(r.embedded).toBe(1);
    expect(r.uploaded).toBe(0);
    expect(r.vectors).toMatchObject({ state: "down", reason: "vectors_down" });
    expect(r.backlog.toUpload).toBe(1);
    expect(b.events.some((e) => e.kind === "history_vectors_error")).toBe(true);
    b.qdrant.fail.clear();
    const up = await ix.tick(T0 + 2 * MIN);
    expect(up.vectors.state).toBe("up");
    expect(up.uploaded).toBe(1);
    expect(up.backlog.toUpload).toBe(0);
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(1);
  });

  test("drift: an emptied collection clears the marks, makes the indexes again and uploads again with zero embed calls", async () => {
    const b = setup();
    const ix = indexer(b);
    b.led.recordOrder(order({ id: "d1", task: "First order for the drift test." }));
    b.led.recordOrder(order({ id: "d2", task: "Second order for the drift test." }));
    await ix.tick(T0);
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(2);
    const calls = b.embedCalls();
    const indexes = b.qdrant.indexes.length;
    b.qdrant.collections.get("neo_history")!.points.clear();
    const r = await ix.tick(T0 + MIN);
    expect(b.embedCalls()).toBe(calls);
    expect(r.uploaded).toBe(2);
    expect(remotePoints(b.qdrant, TAG)).toHaveLength(2);
    expect(b.qdrant.indexes.length - indexes).toBe(4);
    expect(b.events.find((e) => e.kind === "history_reupload")?.data).toEqual({ cleared: 2, remote: 0 });
  });

  test("a failing step never throws out of the pass; the other steps run", async () => {
    const b = setup();
    await indexer(b).tick(T0);
    b.tei.stop();
    b.led.recordOrder(order({ id: "d1", task: "Embedded after the feed read breaks." }));
    await indexer(b).tick(T0 + MIN);
    expect(b.store.countWithoutVector(TAG)).toBe(1);
    b.tei.restart();
    const led = new Proxy(b.led, {
      get: (t, p) => (p === "historyFeed" ? () => { throw new Error("feed read broke"); } : Reflect.get(t, p)),
    }) as Ledger;
    const r = await indexer(b, { ledger: led }).tick(T0 + 2 * MIN);
    expect(r.embedded).toBe(1);
    expect(r.uploaded).toBe(1);
    expect(b.events.find((e) => e.kind === "history_step_error")?.data).toEqual({ step: "feed" });
  });
});

describe("the model change", () => {
  test("with next set both tags are embedded and uploaded; after retireAfterDays the old tag goes", async () => {
    const b = setup();
    const tei2 = startFakeTei({ key: TEI_KEY, revision: REV2, dims: DIMS });
    try {
      const nextCfg = { ...b.cfg.embedder, url: tei2.url, revision: REV2 };
      const next = { embedder: openEmbedder(nextCfg, b.env), vectors: b.vectors };
      const NEXT = modelTag("BAAI/bge-m3", DIMS, REV2);
      b.led.recordOrder(order({ id: "d1", task: "Model change test order text." }));
      await indexer(b, { next }).tick(T0);
      expect(remotePoints(b.qdrant, TAG)).toHaveLength(1);
      expect(remotePoints(b.qdrant, NEXT)).toHaveLength(1);
      // The operator makes the next model active: the old tag retires after retireAfterDays.
      const promoted = indexer(b, { embedder: next.embedder });
      await promoted.tick(T0 + MIN);
      expect(remotePoints(b.qdrant, TAG)).toHaveLength(1);
      await promoted.tick(T0 + MIN + b.cfg.retireAfterDays * DAY);
      expect(remotePoints(b.qdrant, TAG)).toHaveLength(0);
      expect(remotePoints(b.qdrant, NEXT)).toHaveLength(1);
      expect(b.store.pointIdsOfTag(TAG)).toHaveLength(0);
      expect(b.store.countWithoutVector(TAG)).toBe(1); // its local vectors are gone
    } finally {
      tei2.stop();
    }
  });
});

describe("bounds", () => {
  test("no transaction covers more than sliceRows source rows, and no source write is outside one", async () => {
    const b = setup({ cfg: (c) => ({ ...c, indexer: { ...c.indexer, sliceRows: 2 } }) });
    let depth = 0;
    let inTx = 0;
    let maxInTx = 0;
    let outside = 0;
    const count = () => (depth > 0 ? (maxInTx = Math.max(maxInTx, ++inTx)) : outside++);
    const store = new Proxy(b.store, {
      get(t, p) {
        if (p === "transaction") {
          return <T>(fn: () => T): T => {
            if (depth++ === 0) inTx = 0;
            try {
              return t.transaction(fn);
            } finally {
              depth--;
            }
          };
        }
        if (p === "putSource" || p === "removeSource" || p === "markGone") return (...a: unknown[]) => (count(), (Reflect.get(t, p) as (...x: unknown[]) => unknown)(...a));
        return Reflect.get(t, p);
      },
    }) as HistoryStore;
    const t = operatorThread(b.led);
    for (let i = 0; i < 7; i++) b.led.addTodo(todo({ brief: `Slice test brief number ${i} with text.`, cause: { msgId: t, threadId: t } }));
    const ix = indexer(b, { store });
    await ix.tick(T0);
    for (let i = 0; i < 7; i++) b.led.addTodo(todo({ brief: `Feed slice brief number ${i} with text.`, cause: { msgId: t, threadId: t } }));
    await ix.tick(T0 + MIN);
    expect(maxInTx).toBeGreaterThan(0);
    expect(maxInTx).toBeLessThanOrEqual(2);
    expect(outside).toBe(0);
  });

  test("two calls at the same time run one pass", async () => {
    const b = setup();
    const ix = indexer(b);
    const [a, c] = await Promise.all([ix.tick(T0), ix.tick(T0)]);
    expect(a).toBe(c);
    expect(b.tei.requests.filter((r) => r.path === "/info")).toHaveLength(1);
  });

  test("a live lock from another process stops the indexer", async () => {
    const b = setup();
    b.store.takeLock(process.pid + 1, T0);
    b.led.recordOrder(order({ id: "d1", task: "Not indexed while locked." }));
    const r = await indexer(b).tick(T0 + MIN);
    expect(r.locked).toBe(true);
    expect(b.store.getSource("order:d1")).toBeUndefined();
    expect(b.tei.requests).toHaveLength(0);
  });

  test("a query in flight delays the next embed batch", async () => {
    const b = setup();
    const gate = createQueryGate();
    const ix = indexer(b, { gate });
    b.led.recordOrder(order({ id: "d1", task: "Waits for the query to finish." }));
    const leave = gate.enter();
    const pass = ix.tick(T0);
    await Bun.sleep(100);
    expect(b.embedCalls()).toBe(0);
    leave();
    const r = await pass;
    expect(r.embedded).toBe(1);
  });

  test("events carry ids and counts only, never text or keys", async () => {
    const b = setup();
    const ix = indexer(b);
    const t = operatorThread(b.led);
    b.led.addTodo(todo({ brief: "SECRETIVE-WORDING about seats ghp_" + "a".repeat(36), cause: { msgId: t, threadId: t } }));
    b.led.recordOrder(order({ id: "d1", task: "SECRETIVE-WORDING order text here." }));
    await ix.tick(T0);
    b.tei.stop();
    b.qdrant.fail.set("PUT points", 503);
    b.led.recordOrder(order({ id: "d2", task: "SECRETIVE-WORDING second order text." }));
    await ix.tick(T0 + MIN);
    const all = JSON.stringify(b.events);
    expect(b.events.map((e) => e.kind)).toContain("history_pass");
    for (const bad of ["SECRETIVE", "seats", "ghp_", TEI_KEY, QDRANT_KEY, "MARKER"]) expect(all).not.toContain(bad);
  });
});
