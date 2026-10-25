// The API relay (ADR-0044, spec §4): one test per check, each with 0 fetches and a reply naming the check.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { neoMcpServers, type DispatchDeps } from "../src/engine/dispatch";
import { runCompanyBrief } from "../src/engine/ingress";
import { createCatalogue, DEFAULT_TOOLS_CFG, relayCall, type RelayCtx, type ToolCard } from "../src/engine/tools-catalogue";

const SENTINEL = "SENTINEL-KEY-VALUE-123456";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const card = (over: Partial<ToolCard> = {}): ToolCard => ({
  id: "demo-api", kind: "api", status: "active", owner: "neo", when: "w", scope: "all", env: ["DEMO_KEY"], cost: "c", limits: "l",
  dataLeavesHost: true, tags: ["t"], examples: ["e"], body: "", file: "demo-api.md",
  relay: { baseUrl: "https://api.example.com/", authHeader: "x-api-key", envKey: "DEMO_KEY", maxBodyBytes: 100, operations: [{ name: "compress", method: "POST", path: "/compress/" }, { name: "ping", method: "GET", path: "/ping" }] },
  ...over,
});

function setup(over: Partial<RelayCtx> = {}, cfgOver: Partial<typeof DEFAULT_TOOLS_CFG> = {}) {
  const ledger = openLedger(":memory:");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const ctx: RelayCtx = {
    project: "proj", folder: "/w/proj", cfg: { ...DEFAULT_TOOLS_CFG, relayEnabled: true, ...cfgOver }, env: { DEMO_KEY: SENTINEL }, ledger,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response("pong", { status: 200 }); }, now: () => NOW, ...over,
  };
  return { ledger, calls, ctx };
}

test("check 1: disabled by default", async () => {
  const { calls, ctx } = setup({}, { relayEnabled: false });
  const r = await relayCall([card()], "demo-api", "compress", {}, ctx);
  expect(r).toContain("check 1");
  expect(calls.length).toBe(0);
});

test("check 2: unknown, inactive or non-api card", async () => {
  for (const c of [card({ id: "other" }), card({ status: "candidate" }), card({ kind: "cli" })]) {
    const { calls, ctx } = setup();
    expect(await relayCall([c], "demo-api", "compress", {}, ctx)).toContain("check 2");
    expect(calls.length).toBe(0);
  }
});

test("check 3: undeclared operation", async () => {
  const { calls, ctx } = setup();
  expect(await relayCall([card()], "demo-api", "delete", {}, ctx)).toContain("check 3");
  expect(calls.length).toBe(0);
});

test("check 4: scope excludes the project", async () => {
  const { calls, ctx } = setup();
  expect(await relayCall([card({ scope: ["other"] })], "demo-api", "compress", {}, ctx)).toContain("check 4");
  expect(calls.length).toBe(0);
});

test("check 5: body over maxBodyBytes", async () => {
  const { calls, ctx } = setup();
  expect(await relayCall([card()], "demo-api", "compress", { t: "x".repeat(200) }, ctx)).toContain("check 5");
  expect(calls.length).toBe(0);
});

test("check 6: a secret in the body, nested, when data leaves the host", async () => {
  const { calls, ctx } = setup();
  const body = { a: [{ b: { c: "token = ghp_" + "a".repeat(36) } }] };
  expect(await relayCall([card({ relay: { ...card().relay!, maxBodyBytes: 1000 } })], "demo-api", "compress", body, ctx)).toContain("check 6");
  expect(calls.length).toBe(0);
  // not data-leaving: the same body is not checked
  const ok = await relayCall([card({ dataLeavesHost: false, relay: { ...card().relay!, maxBodyBytes: 1000 } })], "demo-api", "compress", body, ctx);
  expect(ok).toContain("HTTP 200");
});

test("check 7: the daily cap counts this folder's events in 24 h only", async () => {
  const { ledger, calls, ctx } = setup({}, { maxCallsPerProjectPerDay: 3 });
  for (let i = 0; i < 2; i++) ledger.recordEvent("tool_api", { folder: "/w/proj", at: NOW - HOUR });
  ledger.recordEvent("tool_api", { folder: "/w/proj", at: NOW - 25 * HOUR }); // too old
  ledger.recordEvent("tool_api", { folder: "/w/other", at: NOW - HOUR }); // another project
  expect(await relayCall([card()], "demo-api", "ping", undefined, ctx)).toContain("HTTP 200");
  expect(await relayCall([card()], "demo-api", "ping", undefined, ctx)).toContain("check 7");
  expect(calls.length).toBe(1);
});

test("check 8: a missing key names the key, never a value", async () => {
  const { calls, ctx } = setup({ env: {} });
  const r = await relayCall([card()], "demo-api", "compress", {}, ctx);
  expect(r).toContain("check 8");
  expect(r).toContain("DEMO_KEY");
  expect(calls.length).toBe(0);
});

test("a good call: one fetch with the key header, one event without the body or the key", async () => {
  const { ledger, calls, ctx } = setup();
  const r = await relayCall([card()], "demo-api", "compress", { text: "hello" }, ctx);
  expect(r).toBe("HTTP 200\npong");
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe("https://api.example.com/compress/");
  const h = calls[0]!.init.headers as Record<string, string>;
  expect(h["x-api-key"]).toBe(SENTINEL);
  expect(h["content-type"]).toBe("application/json");
  expect(calls[0]!.init.body).toBe('{"text":"hello"}');
  const ev = ledger.listEvents({ kind: "tool_api" });
  expect(ev.length).toBe(1);
  expect(ev[0]!.folder).toBe("/w/proj");
  expect(ev[0]!.data).toMatchObject({ card: "demo-api", operation: "compress", project: "proj", status: 200 });
  const dump = JSON.stringify(ev);
  expect(dump).not.toContain(SENTINEL);
  expect(dump).not.toContain("hello");
  expect(r).not.toContain(SENTINEL);
});

test("the reply is cut to maxReplyChars; a 5xx passes through, no retry", async () => {
  const { calls, ctx } = setup({ fetch: async (u, i) => { calls.push({ url: u, init: i }); return new Response("e".repeat(100), { status: 503 }); } }, { maxReplyChars: 20 });
  const r = await relayCall([card()], "demo-api", "ping", undefined, ctx);
  expect(r.startsWith("HTTP 503")).toBe(true);
  expect(r.length).toBeLessThan(40);
  expect(calls.length).toBe(1);
});

test("a hanging fetch times out into a reply, not a throw", async () => {
  const { ledger, ctx } = setup({
    fetch: (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))),
  }, { timeoutMs: 20 });
  const r = await relayCall([card()], "demo-api", "ping", undefined, ctx);
  expect(r).toContain("timeout");
  expect(ledger.listEvents({ kind: "tool_api" })[0]!.data).toMatchObject({ refused: "timeout" });
});

test("a fetch error never leaks into the reply", async () => {
  const { ctx } = setup({ fetch: async () => { throw new Error(`boom ${SENTINEL}`); } });
  const r = await relayCall([card()], "demo-api", "ping", undefined, ctx);
  expect(r).not.toContain(SENTINEL);
  expect(r).toContain("network");
});

// --- the worker tool gate
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
const neoTools = (servers: Record<string, unknown>) =>
  (servers.neo as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools;

function deps(withTools: boolean): { d: DispatchDeps; ledger: ReturnType<typeof openLedger>; calls: unknown[] } {
  const ledger = openLedger(":memory:");
  const calls: unknown[] = [];
  const tools = createCatalogue({
    cards: [card({ scope: ["proj"] })], cfg: { ...DEFAULT_TOOLS_CFG, relayEnabled: true }, ledger, env: { DEMO_KEY: SENTINEL },
    fetch: async (u) => { calls.push(u); return new Response("ok"); },
  });
  return {
    ledger, calls,
    d: { ledger, registry: createRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), reply: () => {}, askApproval: async () => "deny", ...(withTools ? { tools } : {}) },
  };
}

test("tool_api exists only when deps.tools is wired; the caller comes from the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-relay-"));
  mkdirSync(join(root, "proj"));
  expect(Object.keys(neoTools(neoMcpServers(deps(false).d, 1, { dispatch: false, folder: join(root, "proj") })))).not.toContain("tool_api");
  const { d, calls } = deps(true);
  const t = neoTools(neoMcpServers(d, 1, { dispatch: false, folder: join(root, "proj"), projectName: "proj" }));
  expect(Object.keys(t)).toContain("tool_api");
  // an args-supplied project is ignored: scope is judged on the session's project
  const ok = await t.tool_api!.handler({ card: "demo-api", operation: "ping", project: "evil" }, {});
  expect(ok.content[0]!.text).toContain("HTTP 200");
  const t2 = neoTools(neoMcpServers(d, 1, { dispatch: false, folder: join(root, "proj"), projectName: "intruder" }));
  expect((await t2.tool_api!.handler({ card: "demo-api", operation: "ping" }, {})).content[0]!.text).toContain("check 4");
  expect(calls.length).toBe(1);
});

test("the ingress path strips tools", () => {
  const src = require("node:fs").readFileSync(join(import.meta.dir, "../src/engine/ingress.ts"), "utf8") as string;
  expect(src).toMatch(/notes: undefined,[\s\S]*tools: undefined/);
  expect(typeof runCompanyBrief).toBe("function");
});
