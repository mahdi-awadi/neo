// ADR-0066 daemon wiring (plan task 11, spec "The indexer" and "Edge cases"): `startTaskHistory` is what
// the daemon calls. Disabled → no store opens and no seam exists (so no tool is attached). A corrupt
// `history.db` → the engine goes on, the file moves to `history.db.corrupt-<time>`, one alert goes out and
// the seam answers "history is not available". The heartbeat steps never throw out of the tick. While a
// pass leaves a backlog that can drain, the next pass starts after `indexer.busyPauseMs`, not at the next
// heartbeat; it stops when the backlog is empty or the service it waits for is down.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFaultReporter } from "../src/engine/fault";
import { runHeartbeatTick } from "../src/engine/heartbeat";
import { HISTORY_DEFAULTS, type HistoryCfg } from "../src/engine/history/defaults";
import type { IndexReport, TaskHistory, TaskHistoryDeps } from "../src/engine/history/index";
import { emptyIndexReport } from "../src/engine/history/indexer";
import { startTaskHistory, type HistoryRuntime, type HistoryRuntimeDeps } from "../src/engine/history/runtime";
import { openLedger } from "../src/engine/ledger";
import { operatorThread, todo } from "./fixtures/history-harness";

const T0 = Date.UTC(2026, 9, 30, 9, 15, 0);

let runtimes: HistoryRuntime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.close();
});

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "neo-hist-wiring-")), "history.db");
}

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    set: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear: (h: unknown) => void pending.delete(h as number),
    /** Fire every pending timer once. */
    fire() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, t] of due) t.fn();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A TaskHistory whose passes return the scripted reports in order (the last one repeats). */
function scripted(reports: IndexReport[]): TaskHistory & { passes: number; closed: boolean } {
  const h = {
    passes: 0,
    closed: false,
    search: async () => ({ ok: true, hits: [], mode: { meaning: "on" as const } }),
    remember: () => ({ ok: false as const, error: "unused" }),
    indexTick: async () => reports[Math.min(h.passes++, reports.length - 1)]!,
    forget: async () => ({ ok: false, chunks: 0, points: 0, pendingPoints: 0 }),
    status: () => ({ services: { embedder: { state: "up" as const, since: 0 }, vectors: { state: "up" as const, since: 0 } }, tags: [], pendingDeletes: 0 }),
    close: () => void (h.closed = true),
  };
  return h;
}

function report(over: { backlog?: Partial<IndexReport["backlog"]>; embedded?: number; uploaded?: number; read?: number; embedder?: IndexReport["embedder"]["state"]; vectors?: IndexReport["vectors"]["state"]; locked?: boolean; reconcile?: IndexReport["reconcile"] } = {}): IndexReport {
  const r = emptyIndexReport();
  return {
    ...r,
    feed: { ...r.feed, read: over.read ?? 0 },
    embedded: over.embedded ?? 0,
    uploaded: over.uploaded ?? 0,
    embedder: { state: over.embedder ?? "up", since: 0 },
    vectors: { state: over.vectors ?? "up", since: 0 },
    backlog: { ...r.backlog, ...over.backlog },
    ...(over.locked ? { locked: true } : {}),
    ...(over.reconcile ? { reconcile: over.reconcile } : {}),
  };
}

function deps(over: Partial<HistoryRuntimeDeps> & { cfg?: HistoryCfg } = {}) {
  const alerts: string[] = [];
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ledger = openLedger(":memory:");
  const d: HistoryRuntimeDeps = {
    cfg: { ...HISTORY_DEFAULTS, dbPath: tempDb() },
    ledger,
    workRoot: tmpdir(),
    env: {},
    events: (kind, data) => void events.push({ kind, data }),
    alert: (t) => void alerts.push(t),
    now: () => T0,
    ...over,
  };
  return { d, alerts, events, ledger };
}

function start(d: HistoryRuntimeDeps): HistoryRuntime {
  const r = startTaskHistory(d);
  runtimes.push(r);
  return r;
}

describe("disabled", () => {
  test("no store opens, no seam exists, a tick does nothing; the feed is still pruned", async () => {
    let opened = 0;
    const { d, ledger } = deps({ cfg: { ...HISTORY_DEFAULTS, enabled: false, dbPath: tempDb(), feedKeep: 1 }, open: () => (opened++, scripted([report()])) });
    const rt = start(d);
    expect(rt.history).toBeUndefined();
    expect(rt.available).toBe(false);
    expect(await rt.tick()).toBeUndefined();
    expect(opened).toBe(0);
    expect(existsSync(d.cfg.dbPath)).toBe(false);
    ledger.addTodo({ project: "p", folder: "/home/p", brief: "first brief", workClass: "interactive", createdBy: "operator" });
    ledger.addTodo({ project: "p", folder: "/home/p", brief: "second brief", workClass: "interactive", createdBy: "operator" });
    expect(rt.feedPrune()).toBeGreaterThan(0);
    expect(ledger.historyFeed(0, 10).length).toBe(1);
  });
});

describe("enabled with no service configured", () => {
  test("history opens keyword-only: a pass indexes a todo and search finds it, with no embedder or Qdrant", async () => {
    const { d, ledger } = deps();
    const rt = start(d);
    expect(rt.available).toBe(true);
    const t = operatorThread(ledger);
    ledger.addTodo(todo({ brief: "Bus seats are not released after a cancelled booking", cause: { msgId: t, threadId: t } }));
    const r = await rt.tick();
    expect(r?.embedder.state).toBe("off");
    expect(r?.vectors.state).toBe("off");
    const found = await rt.history!.search({ query: "seats released cancelled" });
    expect(found.ok).toBe(true);
    expect(found.mode).toEqual({ meaning: "off", reason: "not_configured" });
    expect(found.hits.some((h) => h.kind === "todo")).toBe(true);
  });
});

describe("a corrupt history.db", () => {
  test("is moved aside with its -wal file, one alert goes out, the seam says history is not available", async () => {
    const { d, alerts, events } = deps();
    const junk = "this is not a sqlite database ".repeat(200);
    writeFileSync(d.cfg.dbPath, junk);
    writeFileSync(`${d.cfg.dbPath}-wal`, "wal junk");
    const rt = start(d);
    const stamp = "20261030T091500Z";
    expect(existsSync(d.cfg.dbPath)).toBe(false);
    expect(readFileSync(`${d.cfg.dbPath}.corrupt-${stamp}`, "utf8")).toBe(junk);
    expect(readFileSync(`${d.cfg.dbPath}.corrupt-${stamp}-wal`, "utf8")).toBe("wal junk");
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain(`history.db.corrupt-${stamp}`);
    expect(events.find((e) => e.kind === "history_store_unavailable")?.data).toMatchObject({ code: "corrupt", moved: true });
    expect(rt.available).toBe(false);
    expect(rt.history).toBeDefined();
    expect(await rt.history!.search({ query: "anything" })).toMatchObject({ ok: false, error: "history_unavailable", hits: [] });
    expect(rt.history!.remember({ text: "a fact worth keeping", by: "worker" })).toEqual({ ok: false, error: "history_unavailable" });
    expect(await rt.history!.forget("todo:1", "why", T0)).toMatchObject({ ok: false, error: "history_unavailable" });
    // the pass does nothing, and nothing new is written where the file was
    expect(await rt.tick()).toBeUndefined();
    expect(existsSync(d.cfg.dbPath)).toBe(false);
    expect(alerts.length).toBe(1);
  });

  test("a store that cannot be read for another reason is left in place, with one alert", () => {
    const { d, alerts } = deps({ open: () => { throw Object.assign(new Error("history store x is unreadable: EACCES"), { code: "unreadable", path: "x" }); } });
    writeFileSync(d.cfg.dbPath, "kept");
    const rt = start(d);
    expect(existsSync(d.cfg.dbPath)).toBe(true);
    expect(readdirSync(join(d.cfg.dbPath, "..")).some((f) => f.includes("corrupt"))).toBe(false);
    expect(alerts.length).toBe(1);
    expect(rt.available).toBe(false);
  });
});

describe("heartbeat steps", () => {
  test("a failing pass and a failing prune never throw out of the tick; the chain re-arms", async () => {
    const logs: string[] = [];
    const reporter = createFaultReporter({ log: (l) => void logs.push(l) }, { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false, maxHandoffsPerHour: 0 });
    const broken = scripted([report()]);
    broken.indexTick = async () => {
      throw new Error("pass blew up");
    };
    const { d } = deps({ open: () => broken });
    (d.ledger as { pruneHistoryFeed: (k: number) => number }).pruneHistoryFeed = () => {
      throw new Error("prune blew up");
    };
    const rt = start(d);
    let rearmed = 0;
    expect(() => runHeartbeatTick([["history", () => rt.tick()], ["history.feedPrune", () => rt.feedPrune()]], () => void rearmed++, reporter)).not.toThrow();
    await flush();
    expect(rearmed).toBe(1);
    expect(logs.some((l) => l.includes("heartbeat.history.feedPrune") && l.includes("prune blew up"))).toBe(true);
    // a thrown pass is reported once and the next heartbeat may start a new one
    expect(logs.some((l) => l.includes("heartbeat.history") && l.includes("pass blew up"))).toBe(true);
    broken.indexTick = async () => report();
    expect(await rt.tick()).toBeDefined();
  });

  test("the prune runs at most once an hour and keeps feedKeep rows", () => {
    let now = T0;
    let calls = 0;
    const { d } = deps({ now: () => now, open: () => scripted([report()]) });
    (d.ledger as { pruneHistoryFeed: (k: number) => number }).pruneHistoryFeed = (k) => (calls++, expect(k).toBe(d.cfg.feedKeep), 0);
    const rt = start(d);
    rt.feedPrune();
    rt.feedPrune();
    expect(calls).toBe(1);
    now += 3_600_000;
    rt.feedPrune();
    expect(calls).toBe(2);
  });
});

describe("the busy follow-up", () => {
  const busyPauseMs = 250;
  const cfg = (): HistoryCfg => ({ ...HISTORY_DEFAULTS, dbPath: tempDb(), indexer: { ...HISTORY_DEFAULTS.indexer, busyPauseMs } });

  test("a backlog that drains starts the next pass after busyPauseMs, until it is empty", async () => {
    const h = scripted([
      report({ embedded: 64, backlog: { toEmbed: 500, toUpload: 64 } }),
      report({ embedded: 64, uploaded: 64, backlog: { toEmbed: 436, toUpload: 64 } }),
      report({ uploaded: 64 }),
    ]);
    const timers = manualTimers();
    const { d } = deps({ cfg: cfg(), open: () => h, timers });
    const rt = start(d);
    await rt.tick();
    expect(h.passes).toBe(1);
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([busyPauseMs]);
    timers.fire();
    await flush();
    expect(h.passes).toBe(2);
    expect(timers.pending.size).toBe(1);
    timers.fire();
    await flush();
    expect(h.passes).toBe(3);
    expect(timers.pending.size).toBe(0); // empty backlog: back to the heartbeat
    expect(rt.latest()?.uploaded).toBe(64);
  });

  test("no follow-up while the service a backlog waits for is down, or another process holds the lock", async () => {
    for (const r of [
      report({ embedded: 0, backlog: { toEmbed: 500 }, embedder: "down" }),
      report({ embedded: 8, backlog: { toUpload: 300 }, vectors: "down" }),
      report({ backlog: { pendingDeletes: 4 }, vectors: "off" }),
      report({ locked: true, backlog: { feed: 900 } }),
      report({ backlog: { toEmbed: 10 } }), // nothing moved in this pass: no tight loop
    ]) {
      const timers = manualTimers();
      const { d } = deps({ cfg: cfg(), open: () => scripted([r]), timers });
      const rt = start(d);
      await rt.tick();
      expect(timers.pending.size).toBe(0);
    }
  });

  test("a feed or reconcile backlog drains with the embedder down (it is local work)", async () => {
    for (const r of [
      report({ read: 500, backlog: { feed: 4000, toEmbed: 900 }, embedder: "down", vectors: "down" }),
      report({ reconcile: { reason: "first", done: false, position: "orders:200" }, embedder: "off" }),
    ]) {
      const timers = manualTimers();
      const { d } = deps({ cfg: cfg(), open: () => scripted([r]), timers });
      const rt = start(d);
      await rt.tick();
      expect(timers.pending.size).toBe(1);
    }
  });

  test("a heartbeat while a follow-up waits starts no second chain; close stops the chain and closes the store", async () => {
    const h = scripted([report({ embedded: 8, backlog: { toEmbed: 100 } })]);
    const timers = manualTimers();
    const { d } = deps({ cfg: cfg(), open: () => h, timers });
    const rt = startTaskHistory(d);
    await rt.tick();
    expect(timers.pending.size).toBe(1);
    await rt.tick(); // the heartbeat
    expect(h.passes).toBe(1);
    expect(timers.pending.size).toBe(1);
    rt.close();
    expect(timers.pending.size).toBe(0);
    expect(h.closed).toBe(true);
    expect(await rt.tick()).toBeUndefined();
  });

  test("the seam gets the config, the ledger, the work root and the env", () => {
    let got: TaskHistoryDeps | undefined;
    const { d } = deps({ env: { SHARED_QDRANT_URL: "http://127.0.0.1:6333" }, open: (x) => ((got = x), scripted([report()])) });
    start(d);
    expect(got).toMatchObject({ cfg: d.cfg, ledger: d.ledger, workRoot: d.workRoot, env: d.env });
  });
});
