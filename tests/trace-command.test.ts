// /trace — one engine command on both surfaces (spec §4.4), rendered by the pure renderTrace.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { openTrustStore } from "../src/engine/trust";
import { createTrace, renderTrace } from "../src/engine/trace";
import { handleCommand, telegramCommands } from "../src/engine/commands";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { createMeter } from "../src/engine/budget";
import { openAdminStore } from "../src/engine/admin";
import { createSessionStore } from "../src/engine/web-session";
import { createWebApp } from "../src/frontends/web";

function setup() {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  let clock = 1_000;
  const trace = createTrace({ ledger, registry, now: () => clock });
  const tick = (ms = 1_000) => (clock += ms);
  const deps = { registry, ledger, trust: openTrustStore(":memory:"), trace, cfg: { providers: { ownWork: "subscription" as const, customerWork: "gemini" as const }, publicUrl: "https://neo.example.com" } };
  return { ledger, registry, trace, tick, deps };
}

test("/trace <ref> renders the root, its state and project, then every child in time order with ref and kind", () => {
  const { ledger, trace, tick, deps } = setup();
  const root = trace.inbound({ chatId: 7, text: "fix the login bug\nwith details", surface: "telegram", channelMsgId: 10 });
  tick();
  const ack = trace.outbound({ chatId: 7, text: "↩︎ queued for eticket", cause: root, kind: "ack", project: "eticket" });
  tick();
  ledger.recordOrder({ id: "ord-1234567890", source: "neo", folder: "/home/eticket", task: "fix", chatId: 7, createdAt: 3_500 }, { cause: root });
  tick();
  const todo = ledger.addTodo({ project: "eticket", folder: "/home/eticket", brief: "write the test", workClass: "interactive", createdBy: "company", cause: root }, 4_500);
  tick();
  const result = trace.outbound({ chatId: 7, text: "eticket finished: login fixed", cause: root, kind: "result", project: "eticket" });

  const out = handleCommand(`/trace ${trace.ref(root.msgId)}`, 7, deps)!.text;
  const lines = out.split("\n");
  expect(lines[0]).toContain(trace.ref(root.threadId));
  expect(lines[0]).toContain("fix the login bug");
  expect(lines[1]).toContain("open"); // the thread's state: its todo is still queued
  expect(lines[1]).toContain("no project"); // an operator thread names no project until one is set
  // Children, oldest first, each with its own ref and kind; the root line is not repeated.
  const ackAt = lines.findIndex((l) => l.includes(trace.ref(ack)) && l.includes("ack"));
  const orderAt = lines.findIndex((l) => l.includes("order") && l.includes("ord-1234"));
  const todoAt = lines.findIndex((l) => l.includes(`#${todo.id}`) && l.includes("todo") && l.includes("queued"));
  const resultAt = lines.findIndex((l) => l.includes(trace.ref(result)) && l.includes("result"));
  expect([ackAt, orderAt, todoAt, resultAt].every((i) => i > 0)).toBe(true);
  expect(ackAt < orderAt && orderAt < todoAt && todoAt < resultAt).toBe(true);
});

test("/trace with a bad or unknown ref says so", () => {
  const { deps } = setup();
  expect(handleCommand("/trace m4g2", 7, deps)!.text).toBe("No message m4g2 — check the ref");
  expect(handleCommand("/trace hello", 7, deps)!.text).toBe("No message hello — check the ref");
  expect(handleCommand("/trace", 7, deps)!.text).toContain("/trace <ref>");
});

test("reply /trace to a Neo message shows that message's thread", () => {
  const { trace, deps } = setup();
  const root = trace.inbound({ chatId: 7, text: "deploy gold", surface: "telegram", channelMsgId: 10 });
  const out = trace.outbound({ chatId: 7, text: "gold deployed", cause: root, kind: "result" });
  trace.bindChannel(out, 7, 11);
  const text = handleCommand("/trace", 7, { ...deps, replyTo: { chatId: 7, channelMsgId: 11 } })!.text;
  expect(text.split("\n")[0]).toContain(trace.ref(root.threadId));
  expect(text).toContain("gold deployed");
  // A reply to a message we never traced is not an error.
  expect(handleCommand("/trace", 7, { ...deps, replyTo: { chatId: 7, channelMsgId: 999 } })!.text).toContain("not traced");
});

test("over 40 children: the first 10, '… N more …', the last 25 and the console link", () => {
  const { trace, deps } = setup();
  const root = trace.inbound({ chatId: 7, text: "big job", surface: "web" });
  const ids = Array.from({ length: 60 }, (_, i) => trace.outbound({ chatId: 7, text: `line ${i}`, cause: root, kind: "progress" }));
  const text = handleCommand(`/trace ${trace.ref(root.msgId)}`, 7, deps)!.text;
  for (const id of [...ids.slice(0, 10), ...ids.slice(35)]) expect(text).toContain(`${trace.ref(id)} ·`);
  for (const id of ids.slice(10, 35)) expect(text).not.toContain(`${trace.ref(id)} ·`);
  expect(text).toContain("… 25 more …");
  expect(text).toContain(`https://neo.example.com/api/trace/${trace.ref(root.threadId)}`);
});

test("40 children or fewer: all of them, no link", () => {
  const { trace } = setup();
  const root = trace.inbound({ chatId: 7, text: "small job", surface: "web" });
  const ids = Array.from({ length: 40 }, (_, i) => trace.outbound({ chatId: 7, text: `line ${i}`, cause: root, kind: "progress" }));
  const text = renderTrace(trace.tree(root.msgId), trace.ref, { consoleUrl: "https://neo.example.com" });
  for (const id of ids) expect(text).toContain(trace.ref(id));
  expect(text).not.toContain("more …");
  expect(text).not.toContain("/api/trace/");
});

test("an artifact whose thread row was pruned: 'thread pruned' plus what still exists", () => {
  const { ledger, trace, deps } = setup();
  // A cause on a missing thread stands in for a pruned one (no raw handle to delete the row).
  const ghost = { msgId: trace.inbound({ chatId: 7, text: "old", surface: "web" }).msgId, threadId: 777_777 };
  const line = trace.outbound({ chatId: 7, text: "left behind", cause: ghost, kind: "result" });
  ledger.addTodo({ project: "gold", folder: "/home/gold", brief: "still queued", workClass: "interactive", createdBy: "operator", cause: ghost });
  const text = handleCommand(`/trace ${trace.ref(line)}`, 7, deps)!.text;
  expect(text).toContain("thread pruned");
  expect(text).toContain("left behind");
  expect(text).toContain("still queued");
});

test("/trace is in the Telegram '/' menu with its summary; without a trace it is unavailable", () => {
  expect(telegramCommands()).toContainEqual({ command: "trace", description: "show everything a message caused" });
  const { deps } = setup();
  expect(handleCommand("/trace m1", 7, { ...deps, trace: undefined })!.text).toContain("unavailable");
});

// ── GET /api/trace/:ref ──────────────────────────────────────────────────────────────────────

function webRig() {
  const s = setup();
  const sessions = createSessionStore({ secret: "websecret", ttlSec: 100_000 });
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(555);
  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-trace-web-"))), publicUrl: "" };
  const app = createWebApp({
    engine: { cfg, ledger: s.ledger, registry: s.registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), trace: s.trace },
    botToken: "123456:TESTTOKEN",
    botUsername: "neo_bot",
    sessions,
    admin,
    now: () => 1000,
  });
  const cookie = `neo_session=${encodeURIComponent(sessions.issue(555, 1000))}`;
  const get = (path: string, auth = true) => app.fetch(new Request(`http://neo.test${path}`, auth ? { headers: { cookie } } : {}));
  return { ...s, get };
}

test("GET /api/trace/:ref returns the same tree as JSON; an unknown or bad ref is a 404; it needs a session", async () => {
  const w = webRig();
  const root = w.trace.inbound({ chatId: 7, text: "deploy gold", surface: "web" });
  const out = w.trace.outbound({ chatId: 7, text: "gold deployed", cause: root, kind: "result" });
  const res = await w.get(`/api/trace/${w.trace.ref(out)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ref: string; thread: { id: number; state: string }; messages: Array<{ id: number; content: string }> };
  const tree = w.trace.tree(out);
  expect(body.ref).toBe(w.trace.ref(out));
  expect(body.thread.id).toBe(root.threadId);
  expect(body.messages.map((m) => m.id)).toEqual(tree.messages.map((m) => m.id));
  expect((await w.get("/api/trace/m4g2")).status).toBe(404);
  expect((await w.get("/api/trace/hello")).status).toBe(404);
  expect((await w.get(`/api/trace/${w.trace.ref(out)}`, false)).status).toBe(401);
});
