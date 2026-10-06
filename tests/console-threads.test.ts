// P3 Tasks 3.1 + 3.2 (ADR-0017, spec §6): paged thread and message reads, and FTS5 search, from the
// ledger — never by replaying the live feed.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac, createHash } from "node:crypto";
import { openLedger, type Ledger, type ThreadOrigin, type ThreadState } from "../src/engine/ledger";
import { createWebApp } from "../src/frontends/web";
import { loadConfig } from "../src/config";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { createSessionStore } from "../src/engine/web-session";
import { openTrustStore } from "../src/engine/trust";
import { createTrace } from "../src/engine/trace";
import { SNIPPET_OPEN, SNIPPET_CLOSE } from "../src/engine/format";

/** One thread rooted at a fresh operator message; `n` extra lines; returns the thread id. */
function thread(l: Ledger, o: { project?: string; state?: ThreadState; origin?: ThreadOrigin; at: number; title?: string; n?: number; text?: string }): number {
  const id = l.insertMessage({ chatId: 1, role: "user", content: o.text ?? `root ${o.title ?? o.at}`, at: o.at, surface: "web", project: o.project });
  l.insertThread({ id, origin: o.origin ?? "operator", title: o.title ?? `t${o.at}`, state: o.state ?? "open", createdAt: o.at, project: o.project });
  l.setMessageThread(id, id);
  let last = id;
  for (let i = 0; i < (o.n ?? 0); i++) last = l.insertMessage({ chatId: 1, role: "assistant", content: `line ${i}`, at: o.at + i + 1, threadId: id, project: o.project });
  l.touchThread(id, last, o.at + (o.n ?? 0));
  return id;
}

test("listThreads: newest-updated first, every filter, keyset pages with no overlap or gap, limit clamped to 100", () => {
  const l = openLedger(":memory:");
  const gold = [thread(l, { project: "gold", at: 100, n: 2 }), thread(l, { project: "gold", at: 300, state: "waiting" })];
  const wa = thread(l, { project: "waselni", at: 200, state: "done", origin: "loop" });
  const all = l.listThreads({}, { limit: 50 });
  expect(all.rows.map((t) => t.id)).toEqual([gold[1], wa, gold[0]]);
  expect(all.next).toBeUndefined();
  expect(all.rows[2]).toMatchObject({ project: "gold", messages: 3, openDecisions: 0, activeTodos: 0 });
  expect(l.listThreads({ project: "gold" }, { limit: 50 }).rows.map((t) => t.id)).toEqual([gold[1], gold[0]]);
  expect(l.listThreads({ state: "waiting" }, { limit: 50 }).rows.map((t) => t.id)).toEqual([gold[1]]);
  expect(l.listThreads({ origin: "loop" }, { limit: 50 }).rows.map((t) => t.id)).toEqual([wa]);
  expect(l.listThreads({ since: 150 }, { limit: 50 }).rows.map((t) => t.id)).toEqual([gold[1], wa]);
  // Keyset paging: page 1 (2 rows) + page 2 = everything, once each.
  const p1 = l.listThreads({}, { limit: 2 });
  expect(p1.rows.map((t) => t.id)).toEqual([gold[1], wa]);
  const p2 = l.listThreads({}, { limit: 2, before: p1.next });
  expect(p2.rows.map((t) => t.id)).toEqual([gold[0]]);
  expect(p2.next).toBeUndefined();
  // Same updated_at: the id breaks the tie, so a page boundary never skips one.
  const l2 = openLedger(":memory:");
  const same = [1, 2, 3].map(() => thread(l2, { at: 500 }));
  const a = l2.listThreads({}, { limit: 2 });
  const b = l2.listThreads({}, { limit: 2, before: a.next });
  expect([...a.rows, ...b.rows].map((t) => t.id).sort()).toEqual(same.sort());
  for (let i = 0; i < 120; i++) thread(l2, { at: 1000 + i });
  expect(l2.listThreads({}, { limit: 1000 }).rows.length).toBe(100);
  // A garbage cursor is the first page, never a throw.
  expect(l2.listThreads({}, { limit: 1, before: "nope" }).rows.length).toBe(1);
});

test("threadListRow: one thread with its list counts; undefined when gone", () => {
  const l = openLedger(":memory:");
  const id = thread(l, { project: "gold", at: 100, n: 2 });
  expect(l.threadListRow(id)).toEqual(l.listThreads({}, { limit: 1 }).rows[0]!);
  expect(l.threadListRow(id + 999)).toBeUndefined();
});

test("the thread-list queries use their indexes (spec §11.11)", () => {
  const l = openLedger(":memory:");
  expect(l._explain("threadsByProject")).toContain("idx_threads_project");
  expect(l._explain("threadsByState")).toContain("idx_threads_state");
  expect(l._explain("threadsRecent")).toContain("idx_threads_updated");
});

test("searchMessages: FTS5 hits newest first with thread and snippet; operator characters never throw; Arabic is found", () => {
  const l = openLedger(":memory:");
  const t1 = thread(l, { project: "gold", at: 100, text: "fix the fare list for gold" });
  const t2 = thread(l, { project: "eticket", at: 200, text: "تذكرة الطيران لم تصدر" });
  const hits = l.searchMessages("fare", { limit: 10 });
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ id: t1, threadId: t1, project: "gold" });
  expect(hits[0]!.snippet).toContain("fare");
  expect(hits[0]!.snippet).toContain(`${SNIPPET_OPEN}fare${SNIPPET_CLOSE}`); // the match is marked
  expect(l.searchMessages("تذكرة", { limit: 10 }).map((h) => h.threadId)).toEqual([t2]);
  for (const q of ['"', "foo -bar", "NEAR(a b)", "(", "AND", "*", ""]) expect(Array.isArray(l.searchMessages(q, { limit: 10 }))).toBe(true);
  expect(l.searchMessages("fare", { limit: 10, project: "eticket" })).toEqual([]);
  // Keyset: `before` pages below an id.
  const t3 = thread(l, { project: "gold", at: 300, text: "fare again" });
  expect(l.searchMessages("fare", { limit: 1 }).map((h) => h.id)).toEqual([t3]);
  expect(l.searchMessages("fare", { limit: 1, before: t3 }).map((h) => h.id)).toEqual([t1]);
});

// ── routes (admin-session-gated) ───────────────────────────────────────────────────────────

const TOKEN = "123456:TESTTOKEN";
function loginUrl(id: number): string {
  const data: Record<string, string> = { id: String(id), auth_date: "1000" };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update(TOKEN).digest()).update(dcs).digest("hex");
  return `http://neo.test/auth/telegram?${new URLSearchParams(data).toString()}`;
}

function app() {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const config = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-threads-"))), telegramToken: TOKEN };
  const trace = createTrace({ ledger, registry });
  const instance = createWebApp({
    engine: { cfg: config, ledger, registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), trace },
    botToken: TOKEN,
    botUsername: "neo_bot",
    sessions: createSessionStore({ secret: "websecret", ttlSec: 100000 }),
    admin: openAdminStore(":memory:"),
    now: () => 1000,
  });
  return { ledger, trace, instance };
}

test("GET /api/threads, /api/threads/:id and /api/search: paged JSON behind the admin session", async () => {
  const a = app();
  const t1 = thread(a.ledger, { project: "gold", at: 100, n: 3, text: "fix the fare list" });
  const unauth = await a.instance.fetch(new Request("http://neo.test/api/threads"));
  expect(unauth.status).toBe(401);
  const cookie = (await a.instance.fetch(new Request(loginUrl(555)))).headers.get("set-cookie")!.split(";")[0]!;
  const get = async (u: string) => (await a.instance.fetch(new Request(`http://neo.test${u}`, { headers: { cookie } }))).json() as Promise<any>;

  const list = await get("/api/threads?project=gold&limit=5");
  expect(list.rows).toHaveLength(1);
  expect(list.rows[0]).toMatchObject({ id: t1, ref: a.trace.ref(t1), project: "gold", messages: 4 });

  const one = await get(`/api/threads/${t1}?limit=2`);
  expect(one.thread).toMatchObject({ id: t1, ref: a.trace.ref(t1) });
  expect(one.messages.map((m: { content: string }) => m.content)).toEqual(["line 2", "line 1"]);
  expect(one.next).toBe(one.messages[1].id);
  expect(one).toHaveProperty("todos");
  expect(one).toHaveProperty("decisions");
  expect(one).toHaveProperty("plans");
  expect(one).toHaveProperty("toolActions");

  const older = await get(`/api/threads/${t1}?limit=2&before=${one.next}`);
  expect(older.messages.map((m: { content: string }) => m.content)).toEqual(["line 0", "fix the fare list"]);

  const search = await get("/api/search?q=fare");
  expect(search.rows[0]).toMatchObject({ id: t1, threadId: t1, ref: a.trace.ref(t1) });

  expect((await a.instance.fetch(new Request("http://neo.test/api/threads/999999", { headers: { cookie } }))).status).toBe(404);
  // Bad filter values are ignored (never a 500).
  expect((await get("/api/threads?state=nonsense&origin=x&since=abc&limit=-4")).rows).toHaveLength(1);
});

test("threadProjects: projects with threads and their counts, most recently active first", () => {
  const l = openLedger(":memory:");
  thread(l, { project: "gold", at: 100 });
  thread(l, { project: "gold", at: 150 });
  thread(l, { project: "waselni", at: 300 });
  thread(l, { at: 400 }); // no project: not in the rail
  expect(l.threadProjects(10)).toEqual([
    { project: "waselni", threads: 1 },
    { project: "gold", threads: 2 },
  ]);
});

test("GET /api/thread-projects and a thread's plans with the actions their status offers", async () => {
  const a = app();
  const t1 = thread(a.ledger, { project: "gold", at: 100 });
  a.ledger.upsertPlan({ project: "gold", folder: "/home/gold", path: "plans/a.md", title: "A", sha256: "s", status: "approved", stepsTotal: 2, stepsDone: 1, threadId: t1 });
  const cookie = (await a.instance.fetch(new Request(loginUrl(555)))).headers.get("set-cookie")!.split(";")[0]!;
  const get = async (u: string) => (await a.instance.fetch(new Request(`http://neo.test${u}`, { headers: { cookie } }))).json() as Promise<any>;
  expect(await get("/api/thread-projects")).toEqual({ rows: [{ project: "gold", threads: 1 }] });
  const view = await get(`/api/threads/${t1}`);
  expect(view.plans).toEqual([expect.objectContaining({ title: "A", status: "approved", actions: ["execute", "drop"] })]);
});
