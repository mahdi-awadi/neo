// P5 Task 5.4 (spec §7, AC5.5): one daily digest — counts per project, the top high items with
// → todo, to the Decisions group only when something is high.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { reconcile, listOpen, type AttentionDraft } from "../src/engine/attention";
import { renderDigest, runDigest } from "../src/engine/attention-actions";

const d = (over: Partial<AttentionDraft>): AttentionDraft => ({ project: "gold", folder: "/home/gold", source: "engine", kind: "queue_paused", key: "k", title: "t", severity: "normal", ...over });

test("renderDigest: a high item → result priority, per-project counts, top 3 high with → todo; empty projects omitted", () => {
  const l = openLedger(":memory:");
  reconcile(l, "engine", "gold", [1, 2, 3, 4].map((n) => d({ key: `h${n}`, title: `high ${n}`, severity: "high" })).concat([d({ key: "n1", title: "normal 1" })]), 100);
  reconcile(l, "engine", "acme", [d({ project: "acme", folder: "/home/acme", key: "a", title: "acme normal" })], 100);
  const r = renderDigest(l, { now: 200, prevIds: [], consoleUrl: "https://neo.example/", maxLines: 30 });
  expect(r.priority).toBe("result");
  expect(r.text.split("\n")).toEqual([
    "☀ attention today: 6 open, 4 high, 6 new since the last digest",
    "gold: 4 high · 1 normal",
    "  🔴 #4 high 4", // listOpen's order (as /attention): severity, then newest
    "  🔴 #3 high 3",
    "  🔴 #2 high 2",
    "acme: 1 normal",
    "https://neo.example/",
  ]);
  expect(r.buttons.map((b) => [b.id, b.actions])).toEqual([[4, ["todo"]], [3, ["todo"]], [2, ["todo"]]]);
});

test("renderDigest: nothing high → progress; nothing new and nothing high → one line", () => {
  const l = openLedger(":memory:");
  reconcile(l, "engine", "gold", [d({ key: "n1" })], 100);
  const rows = listOpen(l, { now: 200 });
  expect(renderDigest(l, { now: 200, prevIds: [], maxLines: 30 }).priority).toBe("progress");
  const quiet = renderDigest(l, { now: 200, prevIds: rows.map((r) => r.id), maxLines: 30 });
  expect(quiet).toMatchObject({ text: "☀ attention today: 1 open, nothing new, nothing high — /attention", priority: "progress", buttons: [] });
});

test("runDigest: due once at digestAt (survives a restart via meta), roots its own attention thread, sends with its priority", async () => {
  const ledger = openLedger(":memory:");
  const trace = createTrace({ ledger, registry: createRegistry() });
  reconcile(ledger, "engine", "gold", [d({ key: "h", title: "stuck approval", severity: "high" })], 100);
  const sent: Array<{ text: string; priority: string; ids: number[] }> = [];
  const deps = { ledger, trace, digestAt: "0 8 * * *", maxLines: 30, send: async (text: string, priority: "result" | "progress", buttons: Array<{ id: number }>) => void sent.push({ text, priority, ids: buttons.map((b) => b.id) }) };
  const eight = new Date(2026, 9, 7, 8, 0, 10).getTime(); // server-local time, like the cron matcher
  expect(await runDigest(deps, eight - 3_600_000)).toBe(false); // 07:00: not due
  expect(await runDigest(deps, eight)).toBe(true);
  expect(await runDigest(deps, eight + 20_000)).toBe(false); // same minute: once
  expect(sent).toEqual([{ text: expect.stringContaining("stuck approval"), priority: "result", ids: [1] }]);
  const root = ledger.listThreads({ origin: "attention" }, { limit: 5 }).rows[0];
  expect(root?.title).toContain("attention digest");
  // The next day nothing is new and nothing high was added: still the high item → result again.
  expect(await runDigest(deps, eight + 86_400_000)).toBe(true);
  expect(sent[1]!.text).toContain("0 new since the last digest");
});

test("the digest counts every open item (past one page) and stays one bounded message", () => {
  const l = openLedger(":memory:");
  for (let p = 0; p < 40; p++) reconcile(l, "engine", `p${p}`, [1, 2, 3].map((n) => d({ project: `p${p}`, folder: `/home/p${p}`, key: `k${n}`, title: `high ${n}`, severity: "high" })), 100);
  const r = renderDigest(l, { now: 200, prevIds: [], maxLines: 30 });
  expect(r.text.split("\n")[0]).toBe("☀ attention today: 120 open, 120 high, 120 new since the last digest");
  expect(r.text.split("\n").length).toBeLessThanOrEqual(31);
  expect(r.text.length).toBeLessThan(4096);
  expect(r.text).toContain("more projects");
});

test("a reply to the digest joins its thread (the sent message is bound)", async () => {
  const ledger = openLedger(":memory:");
  const trace = createTrace({ ledger, registry: createRegistry() });
  reconcile(ledger, "engine", "gold", [d({ key: "h", severity: "high" })], 100);
  const deps = { ledger, trace, digestAt: "0 8 * * *", maxLines: 30, send: async () => ({ chatId: -100, messageId: 77 }) };
  await runDigest(deps, new Date(2026, 9, 7, 8, 0, 10).getTime());
  expect(ledger.messageByChannel(-100, 77)?.threadId).toBeDefined();
});
