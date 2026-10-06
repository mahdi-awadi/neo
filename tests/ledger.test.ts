import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger, EVENTS_KEEP, EVENTS_PRUNE_INTERVAL } from "../src/engine/ledger";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return { id: "o1", source: "neo", folder: "/tmp", task: "t", chatId: 1, createdAt: 1000, ...over };
}

test("recordOrder then listRecent returns the order with its fields", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", task: "build x", folder: "/p", chatId: 7, createdAt: 5 }));
  const recent = led.listRecent();
  expect(recent).toEqual([
    { id: "a", source: "neo", folder: "/p", task: "build x", chatId: 7, createdAt: 5 },
  ]);
});

test("listRecent returns most-recent first and respects the limit", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", createdAt: 1 }));
  led.recordOrder(order({ id: "b", createdAt: 2 }));
  led.recordOrder(order({ id: "c", createdAt: 3 }));
  expect(led.listRecent(2).map((o) => o.id)).toEqual(["c", "b"]);
});

test("message routes persist (chat,message) -> session/folder/project and read back", () => {
  const led = openLedger(":memory:");
  led.rememberRoute(5, 100, { sessionId: "sess-a", folder: "/home/acme", project: "acme" });
  expect(led.routeFor(5, 100)).toEqual({ sessionId: "sess-a", folder: "/home/acme", project: "acme" });
  expect(led.routeFor(5, 999)).toBeUndefined(); // unknown message id
  expect(led.routeFor(6, 100)).toBeUndefined(); // right message id, wrong chat
});

test("rememberRoute upserts on the same (chat,message) key", () => {
  const led = openLedger(":memory:");
  led.rememberRoute(1, 7, { sessionId: "old", folder: "/home/x", project: "x" });
  led.rememberRoute(1, 7, { sessionId: "new", folder: "/home/y", project: "y" });
  expect(led.routeFor(1, 7)?.sessionId).toBe("new");
});

test("recordOutcome is retrievable via getOutcome", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a" }));
  led.recordOutcome("a", "done", "added function");
  expect(led.getOutcome("a")).toEqual({ status: "done", summary: "added function" });
});

test("recordSession persists the SDK session id for an order; lastSessionFor reads it back", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/proj", chatId: 9 }));
  led.recordSession("a", "sdk-123");
  expect(led.lastSessionFor("/proj", 9)).toBe("sdk-123");
});

test("lastSessionFor returns the most recent session id for a folder/chat", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/proj", chatId: 9, createdAt: 1 }));
  led.recordOrder(order({ id: "b", folder: "/proj", chatId: 9, createdAt: 2 }));
  led.recordSession("a", "sdk-old");
  led.recordSession("b", "sdk-new");
  expect(led.lastSessionFor("/proj", 9)).toBe("sdk-new");
});

test("lastSessionFor is undefined when no session was recorded for that folder/chat", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/proj", chatId: 9 }));
  expect(led.lastSessionFor("/proj", 9)).toBeUndefined();
  expect(led.lastSessionFor("/other", 9)).toBeUndefined();
});

test("records conversation messages and reads them back chronologically per chat", () => {
  const led = openLedger(":memory:");
  led.recordMessage(7, "user", "do the thing");
  led.recordMessage(7, "assistant", "doing work");
  led.recordMessage(7, "assistant", "done");
  led.recordMessage(8, "user", "a different conversation");
  expect(led.conversation(7).map((m) => [m.role, m.content])).toEqual([
    ["user", "do the thing"],
    ["assistant", "doing work"],
    ["assistant", "done"],
  ]);
  expect(led.conversation(8).map((m) => m.content)).toEqual(["a different conversation"]);
  expect(led.conversation(9)).toEqual([]);
});

test("conversation(limit) returns the most recent N messages, still oldest-first", () => {
  const led = openLedger(":memory:");
  for (let i = 1; i <= 5; i++) led.recordMessage(1, "user", `m${i}`);
  expect(led.conversation(1, 2).map((m) => m.content)).toEqual(["m4", "m5"]);
});

test("records and reads auto-approvals for an order", () => {
  const led = openLedger(":memory:");
  led.recordAutoApproval("o1", "risky shell command: git push");
  led.recordAutoApproval("o1", "risky shell command: rm -rf build");
  expect(led.autoApprovalsFor("o1")).toEqual([
    "risky shell command: git push",
    "risky shell command: rm -rf build",
  ]);
  expect(led.autoApprovalsFor("o2")).toEqual([]);
});

test("context events record + list, and clearSessionsFor wipes resume targets", () => {
  const l = openLedger(":memory:");
  l.recordContextEvent("/p/gold", "handoff", 0.71, 123);
  expect(l.listContextEvents()[0]).toMatchObject({ folder: "/p/gold", verdict: "handoff", occupancy: 0.71, at: 123 });
  const o = order({ id: "o9", folder: "/p/gold", chatId: 5 });
  l.recordOrder(o);
  l.recordSession("o9", "sess-9");
  expect(l.lastSessionFor("/p/gold", 5)).toBe("sess-9");
  l.clearSessionsFor("/p/gold");
  expect(l.lastSessionFor("/p/gold", 5)).toBeUndefined();
});

test("cache observations record + list, newest-first, capped by limit", () => {
  const l = openLedger(":memory:");
  l.recordCacheObservation(10 * 60_000, true);
  l.recordCacheObservation(70 * 60_000, false);
  const rows = l.listCacheObservations(50);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ gapMs: 70 * 60_000, hit: false }); // newest first
  expect(rows[1]).toMatchObject({ gapMs: 10 * 60_000, hit: true });
  for (let i = 0; i < 5; i++) l.recordCacheObservation(i, true);
  expect(l.listCacheObservations(3)).toHaveLength(3);
});

test("recordEvent then listEvents round-trips kind, columns, and parsed data, newest-first", () => {
  const l = openLedger(":memory:");
  l.recordEvent("api_retry", { orderId: "o1", folder: "/p/safari", data: { attempt: 1, delayMs: 30000 }, at: 100 });
  l.recordEvent("dispatch_start", { orderId: "o2", folder: "/p/gold", data: { resume: false }, at: 200 });
  const events = l.listEvents();
  expect(events[0]).toEqual({ kind: "dispatch_start", at: 200, orderId: "o2", sessionId: undefined, folder: "/p/gold", data: { resume: false } });
  expect(events[1]).toMatchObject({ kind: "api_retry", at: 100, orderId: "o1", data: { attempt: 1, delayMs: 30000 } });
});

test("listEvents filters by kind and by orderId, and respects limit", () => {
  const l = openLedger(":memory:");
  l.recordEvent("api_retry", { orderId: "a", at: 1 });
  l.recordEvent("api_giveup", { orderId: "a", at: 2 });
  l.recordEvent("api_retry", { orderId: "b", at: 3 });
  expect(l.listEvents({ kind: "api_retry" }).map((e) => e.orderId)).toEqual(["b", "a"]);
  expect(l.listEvents({ orderId: "a" }).map((e) => e.kind)).toEqual(["api_giveup", "api_retry"]);
  expect(l.listEvents({ limit: 1 })).toHaveLength(1);
});

test("recordEvent with no data reads back data: undefined and null columns as undefined", () => {
  const l = openLedger(":memory:");
  l.recordEvent("session_interrupted", { at: 5 });
  expect(l.listEvents()[0]).toEqual({ kind: "session_interrupted", at: 5, orderId: undefined, sessionId: undefined, folder: undefined, data: undefined });
});

test("retention caps are configurable via openLedger opts (not hardcoded)", () => {
  const l = openLedger(":memory:", { eventsKeep: 10, routeKeep: 3 });
  // The prune fires exactly on the EVENTS_PRUNE_INTERVAL-th insert, trimming to the CONFIGURED
  // cap of 10 (the built-in default of 50 000 would leave all 1000).
  for (let i = 0; i < EVENTS_PRUNE_INTERVAL; i++) l.recordEvent("tick", { at: i });
  expect(l.listEvents({ limit: 9999 }).length).toBe(10);
  expect(l.listEvents({ limit: 1 })[0].at).toBe(EVENTS_PRUNE_INTERVAL - 1); // newest survives
  // Routes prune on every insert; only the newest routeKeep=3 (messageIds 7,8,9) survive.
  for (let m = 0; m < 10; m++) l.rememberRoute(1, m, { sessionId: "s", folder: "/f", project: "p" });
  expect(l.routeFor(1, 9)).toBeDefined();
  expect(l.routeFor(1, 6)).toBeUndefined();
});

test("events retention prunes to bound the table (never unbounded growth)", () => {
  const l = openLedger(":memory:");
  const total = EVENTS_KEEP + EVENTS_PRUNE_INTERVAL + 5;
  for (let i = 0; i < total; i++) l.recordEvent("tick", { at: i });
  const count = l.listEvents({ limit: total }).length;
  // Amortised: after the last prune the count can sit up to one interval above the keep-window,
  // but it is bounded — and strictly fewer than everything inserted (pruning actually happened).
  expect(count).toBeLessThanOrEqual(EVENTS_KEEP + EVENTS_PRUNE_INTERVAL);
  expect(count).toBeLessThan(total);
  // Newest rows are the ones kept (oldest pruned): the most recent event survives.
  expect(l.listEvents({ limit: 1 })[0].at).toBe(total - 1);
});

test("folders lists every distinct folder an order was ever recorded for", () => {
  const led = openLedger(":memory:");
  expect(led.folders()).toEqual([]);
  led.recordOrder(order({ id: "a", folder: "/p/b" }));
  led.recordOrder(order({ id: "b", folder: "/p/a" }));
  led.recordOrder(order({ id: "c", folder: "/p/b" }));
  expect(led.folders()).toEqual(["/p/a", "/p/b"]);
});

test("model windows: the newest SDK-reported window per model wins (ADR-0013)", () => {
  const l = openLedger(":memory:");
  expect(l.modelWindows()).toEqual({});
  l.recordModelWindow("claude-opus-5-5", 200_000, 1);
  l.recordModelWindow("claude-opus-5-5", 1_000_000, 2);
  l.recordModelWindow("claude-haiku-4-5", 200_000, 3);
  expect(l.modelWindows()).toEqual({ "claude-opus-5-5": 1_000_000, "claude-haiku-4-5": 200_000 });
});

// ADR-0014: every context reset is one row with its reason, the boundary it fired at, and detail.
test("a context event records reason, boundary, session and detail, and returns its id", () => {
  const l = openLedger(":memory:");
  const id = l.recordContextEvent("/p/gold", "handoff", 0.52, 100, { reason: "above-sweet-spot", boundary: "settled", sessionId: "s1", detail: { written: true } });
  expect(id).toBeGreaterThan(0);
  expect(l.listContextEvents()[0]).toEqual({ id, folder: "/p/gold", verdict: "handoff", occupancy: 0.52, at: 100, reason: "above-sweet-spot", boundary: "settled", sessionId: "s1", detail: { written: true } });
  l.recordContextEvent("/p/gold", "clear", 0.95, 50); // the pre-ADR-0014 four-argument call still works
  expect(l.listContextEvents()[1]).toMatchObject({ verdict: "clear", reason: undefined, detail: undefined });
});

test("context events list per folder, newest first, capped", () => {
  const l = openLedger(":memory:");
  l.recordContextEvent("/p/a", "handoff", 0.5, 1);
  l.recordContextEvent("/p/b", "handoff", 0.5, 2);
  l.recordContextEvent("/p/a", "deferred", 0.5, 3);
  expect(l.listContextEvents({ folder: "/p/a" }).map((e) => e.verdict)).toEqual(["deferred", "handoff"]);
  expect(l.listContextEvents({ limit: 1 }).map((e) => e.at)).toEqual([3]);
  expect(l.listContextEvents(2)).toHaveLength(2); // legacy numeric limit
});

test("updateContextEventDetail merges into the row's detail", () => {
  const l = openLedger(":memory:");
  const id = l.recordContextEvent("/p/a", "resumed", 0, 1, { detail: { handoffId: 7 } });
  l.updateContextEventDetail(id, { steps: 12, success: true });
  expect(l.listContextEvents()[0].detail).toEqual({ handoffId: 7, steps: 12, success: true });
});

test("pendingHandoff: the newest handoff of a folder until a resumed row follows it", () => {
  const l = openLedger(":memory:");
  expect(l.pendingHandoff("/p/a")).toBeUndefined();
  const h = l.recordContextEvent("/p/a", "handoff", 0.5, 10, { reason: "above-sweet-spot" });
  l.recordContextEvent("/p/a", "deferred", 0.5, 11); // other verdicts don't consume it
  expect(l.pendingHandoff("/p/a")?.id).toBe(h);
  expect(l.pendingHandoff("/p/b")).toBeUndefined();
  l.recordContextEvent("/p/a", "resumed", 0, 12);
  expect(l.pendingHandoff("/p/a")).toBeUndefined();
});

test("an old ledger's context_events table gains the new columns on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-ctxmig-"));
  const path = join(dir, "l.db");
  const old = new Database(path);
  old.run(`CREATE TABLE context_events (folder TEXT NOT NULL, verdict TEXT NOT NULL, occupancy REAL NOT NULL, at INTEGER NOT NULL)`);
  old.run(`INSERT INTO context_events VALUES ('/p/a', 'clear', 1.5, 1)`);
  old.close();
  const l = openLedger(path);
  l.recordContextEvent("/p/a", "handoff", 0.5, 2, { reason: "heavy", boundary: "checkpoint" });
  expect(l.listContextEvents().map((e) => [e.verdict, e.reason])).toEqual([["handoff", "heavy"], ["clear", undefined]]);
});
