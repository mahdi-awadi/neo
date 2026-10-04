// Fault injection (ADR-0010): break one unit on each wired path and prove the engine stays up and
// reports it — the failing call is contained, an engine fault is reported with its component, and
// nothing reaches the process as an unhandled rejection.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac } from "node:crypto";
import { configureFaults, createFaultReporter } from "../src/engine/fault";
import { runHeartbeatTick } from "../src/engine/heartbeat";
import { createHealthMonitor, startHealthTimer } from "../src/engine/health";
import { loadConfig, type NeoConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { openTrustStore } from "../src/engine/trust";
import { openInbox } from "../src/engine/inbox";
import { createRegistry, type Registry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { createSessionStore } from "../src/engine/web-session";
import { createWebApp } from "../src/frontends/web";
import { createTelegramBot } from "../src/frontends/telegram";
import { handleMessage } from "../src/engine/pipeline";
import { launchLoop, type LoopDef } from "../src/engine/loops";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";

const TOKEN = "123456:TESTTOKEN";
const ADMIN = 42;
const scratch = () => mkdtempSync(join(tmpdir(), "neo-fault-"));
const tick = (ms = 10) => Bun.sleep(ms);

/** Every fault reported during a test, by component. */
let faults: Array<{ component: string; message: string; [k: string]: unknown }> = [];
beforeEach(() => {
  faults = [];
  configureFaults(
    createFaultReporter(
      { log: () => {}, record: (d) => void faults.push(d as (typeof faults)[number]) },
      { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false, maxHandoffsPerHour: 0 },
    ),
  );
});
afterEach(() => {
  configureFaults(createFaultReporter({ log: (l) => console.error(l) }, { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false, maxHandoffsPerHour: 0 }));
});
const reported = (component: string) => faults.filter((f) => f.component === component);

function cfg(over: Partial<NeoConfig> = {}): NeoConfig {
  return { ...loadConfig(scratch()), telegramToken: TOKEN, telegramAllowFrom: [], decisionsChatId: undefined, workRoot: tmpdir(), ...over };
}

// ── heartbeat ────────────────────────────────────────────────────────────────────────────────

test("heartbeat: a throwing step and a rejecting step are reported; the other steps run and the tick re-arms", async () => {
  const ran: string[] = [];
  let rearmed = 0;
  const { faults: r } = await import("../src/engine/fault");
  runHeartbeatTick(
    [
      ["idle", () => void ran.push("idle")],
      ["watchdog", () => {
        throw new Error("database is locked");
      }],
      ["todo", () => Promise.reject(new Error("pump failed"))],
      ["scheduler", () => void ran.push("scheduler")],
    ],
    () => void rearmed++,
    r,
  );
  await tick();
  expect(ran).toEqual(["idle", "scheduler"]);
  expect(rearmed).toBe(1);
  expect(reported("heartbeat.watchdog")[0]?.message).toBe("database is locked");
  expect(reported("heartbeat.todo")[0]?.message).toBe("pump failed");
});

// ── health timer ─────────────────────────────────────────────────────────────────────────────

test("health timer: a late timer is measured as event-loop lag and reported once; a broken ledger is reported", () => {
  let clock = 0;
  let fire: () => void = () => {};
  const reports: string[] = [];
  let pingFails = false;
  const stop = startHealthTimer(
    createHealthMonitor({
      cfg: () => ({ everyMs: 1000, lagWarnMs: 500, rssWarnMb: 1e9 }),
      rssBytes: () => 1,
      dbPing: () => {
        if (pingFails) throw new Error("disk I/O error");
      },
      report: (t) => void reports.push(t),
    }),
    1000,
    { now: () => clock, setInterval: (fn) => ((fire = fn), 1), clearInterval: () => {} },
  );
  clock = 1000;
  fire(); // on time
  expect(reports).toEqual([]);
  clock = 2900;
  fire(); // due at 2000 → 900 ms late
  expect(reports[0]).toContain("event-loop lag 900ms");
  clock = 3900;
  pingFails = true;
  fire();
  expect(reports.some((r) => r.includes("ledger unreachable: disk I/O error"))).toBe(true);
  expect(reports.some((r) => r.includes("event-loop lag recovered"))).toBe(true);
  stop();
});

test("health timer: everyMs 0 turns the check off", () => {
  let armed = false;
  startHealthTimer({ sample: () => {} }, 0, { setInterval: () => ((armed = true), 1) });
  expect(armed).toBe(false);
});

// ── web ──────────────────────────────────────────────────────────────────────────────────────

function signedLogin(id: number): string {
  const data: Record<string, string> = { id: String(id), auth_date: "1000" };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update(TOKEN).digest()).update(dcs).digest("hex");
  return `http://neo.test/auth/telegram?${new URLSearchParams(data)}`;
}

/** A registry whose every call throws — a broken engine dependency. */
const brokenRegistry = (): Registry =>
  new Proxy(createRegistry(), {
    get: () => () => {
      throw new Error("registry exploded");
    },
  });

test("web: a route that throws answers 500 and is reported; a failed background send is reported, not thrown", async () => {
  const config = cfg();
  const app = createWebApp({
    engine: { cfg: config, ledger: openLedger(":memory:"), registry: brokenRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:") },
    botToken: TOKEN,
    botUsername: "neo_bot",
    sessions: createSessionStore({ secret: "s", ttlSec: 100000 }),
    admin: openAdminStore(":memory:"),
    now: () => 1000,
  });
  const login = await app.fetch(new Request(signedLogin(ADMIN)));
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const state = await app.fetch(new Request("http://neo.test/api/state", { headers: { cookie } }));
  expect(state.status).toBe(500);
  expect(reported("web.request")[0]?.path).toBe("/api/state");

  const msg = await app.fetch(new Request("http://neo.test/msg", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) }));
  expect(msg.status).toBe(200);
  await tick();
  expect(reported("web.send").length).toBe(1);
});

// ── pipeline ─────────────────────────────────────────────────────────────────────────────────

test("pipeline: a throw in the run's completion bookkeeping is reported with the project and order", async () => {
  let finish!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => (finish = res));
  const start = (_o: Order, _h: RunHandlers): SessionRun => ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false, close: () => {}, closed: () => false, done });
  const ledger = openLedger(":memory:");
  ledger.recordOutcome = () => {
    throw new Error("database is locked");
  };
  const dir = scratch();
  await handleMessage(`/open ${dir} do it`, 9, {
    cfg: cfg(),
    ledger,
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "allow",
    start,
  });
  finish({ ok: true, sessionId: "s1", summary: "ok", costUsd: 0 });
  await tick();
  const f = reported("pipeline.runDone")[0];
  expect(f?.message).toBe("database is locked");
  expect(f?.folder).toBe(dir);
  expect(typeof f?.orderId).toBe("string");
});

test("pipeline: a post-completion handoff that rejects is reported with the project, never an unhandled rejection", async () => {
  let finish!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => (finish = res));
  const start = (_o: Order, _h: RunHandlers): SessionRun => ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false, close: () => {}, closed: () => false, done });
  const dir = scratch();
  await handleMessage(`/open ${dir} do it`, 9, {
    cfg: cfg(),
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "allow",
    start,
    signals: () => ({ occupancy: 0.9, turns: 10, ageMs: 0, idleMs: 0 }), // a fat session → handoff
    handoff: async () => {
      throw new Error("handoff worker crashed");
    },
  });
  finish({ ok: true, sessionId: "s1", summary: "ok", costUsd: 0 });
  await tick();
  const f = reported("pipeline.handoff")[0];
  expect(f?.message).toBe("handoff worker crashed");
  expect(f?.folder).toBe(dir);
});

// ── manual loop start ────────────────────────────────────────────────────────────────────────

test("manual loop: a crashing run is reported and the operator's chat is told it failed", async () => {
  const replies: string[] = [];
  const loop: LoopDef = {
    name: "probe",
    usage: "/loop probe",
    summary: "",
    folder: scratch(),
    prompt: "p",
    goal: { kind: "command", command: ["true"] },
    trigger: { kind: "manual" },
    bounds: { maxIterations: 1 },
  };
  launchLoop(loop, 5, {
    reply: (_c, t) => void replies.push(t),
    cfg: cfg(),
    run: (async () => {
      throw new Error("spawn ENOENT");
    }) as never,
    check: async () => ({ met: false, detail: "" }),
  });
  await tick(50);
  expect(reported("loop.manual")[0]?.message).toBe("spawn ENOENT");
  expect(replies.some((r) => r.includes("probe") && r.includes("failed") && r.includes("spawn ENOENT"))).toBe(true);
});

// ── telegram ─────────────────────────────────────────────────────────────────────────────────

const botInfo = { id: 1, is_bot: true, first_name: "Neo", username: "neo_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

/** A bot with every handler wired and a stubbed Bot API (no network). The stub is grammy's
 *  `client.fetch`, BELOW every API transformer, so the real request path — the flood gate included —
 *  runs. `fail` decides which calls fail with a 400; `respond` can answer a call with any result. */
function telegramRig(
  o: {
    fail?: (method: string, payload: any) => boolean;
    respond?: (method: string, payload: any) => Record<string, unknown> | undefined;
    admin?: ReturnType<typeof openAdminStore>;
    config?: Partial<NeoConfig>;
  } = {},
) {
  const calls: Array<{ method: string; payload: any }> = [];
  const admin = o.admin ?? openAdminStore(":memory:");
  admin.claimAdmin(ADMIN);
  const inbox = openInbox(":memory:");
  const ledger = openLedger(":memory:");
  const config = cfg({ agentIngressSecret: "secret", ...o.config });
  let nextId = 100;
  const fetch = (async (url: string | URL, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop()!;
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    const body =
      o.respond?.(method, payload) ??
      (o.fail?.(method, payload)
        ? { ok: false, error_code: 400, description: "Bad Request: injected" }
        : { ok: true, result: method === "sendMessage" ? { message_id: nextId++, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } : true });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const bot = createTelegramBot(
    config,
    ledger,
    admin,
    createRegistry(),
    createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    openTrustStore(":memory:"),
    undefined,
    inbox,
    "http://gateway.invalid/send",
    undefined,
    undefined,
    { botInfo, client: { fetch } },
  );
  let updateId = 1;
  const from = { id: ADMIN, is_bot: false, first_name: "Neo" };
  const chat = { id: ADMIN, type: "private" as const, first_name: "Neo" };
  return {
    bot,
    calls,
    inbox,
    ledger,
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text)),
    text: (text: string) => bot.handleUpdate({ update_id: updateId++, message: { message_id: updateId, date: 0, chat, from, text } } as never),
    press: (data: string) =>
      bot.handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), from, chat_instance: "c", data, message: { message_id: 1, date: 0, chat, text: "x" } } } as never),
  };
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`${what} did not return within ${ms}ms`)))]);

test("telegram: an inbox send waiting on Allow/Deny no longer blocks the update queue — the Deny press arrives and cancels", async () => {
  const t = telegramRig();
  const item = t.inbox.record({ from: "customer@example.com", text: "hi" });
  t.inbox.setDraft(item.id, "Thanks for writing.");

  // Updates are handled one at a time: this handler MUST return while the approval is pending.
  await within(t.press(`inbox-send:${item.id}`), 500, "the inbox-send handler");
  await tick();
  const ask = t.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes("Approve this action?"));
  expect(ask).toBeDefined();
  const deny = ask!.payload.reply_markup.inline_keyboard[0][1].callback_data as string;
  expect(deny.startsWith("d:")).toBe(true);

  await within(t.press(deny), 500, "the Deny press");
  await tick();
  expect(t.sent()).toContain("Send cancelled.");
  expect(faults).toEqual([]);
});

test("telegram: when the approval post itself fails the gate denies instead of waiting forever, and reports it", async () => {
  const t = telegramRig({ fail: (m, p) => m === "sendMessage" && String(p.text).includes("Approve this action?") });
  const item = t.inbox.record({ from: "customer@example.com", text: "hi" });
  t.inbox.setDraft(item.id, "Thanks.");
  await within(t.press(`inbox-send:${item.id}`), 500, "the inbox-send handler");
  await tick(30);
  expect(t.sent()).toContain("Send cancelled.");
  expect(reported("telegram.approval").length).toBe(1);
  expect(t.ledger.listOpenDecisions()).toEqual([]); // the escalation row is closed as denied
});

test("telegram: a failed fire-and-forget send is reported, not an unhandled rejection", async () => {
  const t = telegramRig({ fail: (m) => m === "sendMessage" });
  await within(t.text("/help"), 500, "the /help handler");
  await tick();
  expect(reported("telegram.send").length).toBe(1);
  expect(String(reported("telegram.send")[0]?.message)).toContain("injected");
});

test("telegram: a handler that throws is reported by the error boundary and the bot keeps handling updates", async () => {
  const real = openAdminStore(":memory:");
  let explode = true;
  const admin = Object.assign(Object.create(null), real, {
    isAdmin: (id: number) => {
      if (explode) throw new Error("admin store locked");
      return real.isAdmin(id);
    },
  });
  const t = telegramRig({ admin });
  await within(t.press("use:nothing"), 500, "the failing update");
  expect(reported("telegram.update")[0]?.message).toBe("admin store locked");
  explode = false;
  await within(t.text("/help"), 500, "the next update");
  await tick();
  expect(t.sent().length).toBeGreaterThan(0);
});

// ── telegram 429 (through the flood gate) ────────────────────────────────────────────────────

test("telegram 429: a short retry_after is waited out and the send retried once — delivered, no fault", async () => {
  let limited = 1;
  const t = telegramRig({
    config: { telegramFloodMaxWaitMs: 1_000 },
    respond: (m) => (m === "sendMessage" && limited-- > 0 ? { ok: false, error_code: 429, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } } : undefined),
  });
  await within(t.text("/help"), 500, "the /help handler");
  await tick(30);
  expect(t.calls.filter((c) => c.method === "sendMessage")).toHaveLength(2); // the 429, then the retry
  expect(faults).toEqual([]);
});

test("telegram 429: a long ban holds later sends to that chat (never re-sent into the ban) and each failure is contained", async () => {
  const t = telegramRig({
    config: { telegramFloodMaxWaitMs: 0 },
    respond: (m) => (m === "sendMessage" ? { ok: false, error_code: 429, description: "Too Many Requests: retry after 3600", parameters: { retry_after: 3600 } } : undefined),
  });
  await within(t.text("/help"), 500, "the first /help");
  await within(t.text("/help"), 500, "the second /help");
  await tick(30);
  expect(t.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1); // the second was held by the gate
  expect(reported("telegram.send")).toHaveLength(2); // both failures contained and reported, none thrown
});

// ── telegram inbox Send idempotency ──────────────────────────────────────────────────────────

const approvalButtons = (t: ReturnType<typeof telegramRig>) =>
  t.calls.filter((c) => c.method === "sendMessage" && String(c.payload.text).includes("Approve this action?"));

test("telegram inbox: a double tap on Send posts ONE approval; the second tap is told a send is already waiting", async () => {
  const t = telegramRig();
  const item = t.inbox.record({ from: "customer@example.com", text: "hi" });
  t.inbox.setDraft(item.id, "Thanks for writing.");
  await within(t.press(`inbox-send:${item.id}`), 500, "first tap");
  await within(t.press(`inbox-send:${item.id}`), 500, "second tap");
  await tick();
  expect(approvalButtons(t)).toHaveLength(1);
  expect(t.sent()).toContain("A send for this message is already waiting for approval.");
});

test("telegram inbox: a draft edited while the approval waited is not sent on Allow (stale draft version)", async () => {
  const t = telegramRig();
  const item = t.inbox.record({ from: "customer@example.com", text: "hi" });
  t.inbox.setDraft(item.id, "Version one.");
  await within(t.press(`inbox-send:${item.id}`), 500, "the Send tap");
  await tick();
  t.inbox.setDraft(item.id, "Version two."); // the operator edits meanwhile
  const allow = approvalButtons(t)[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
  await within(t.press(allow), 500, "the Allow press");
  await tick(30);
  expect(t.sent().some((x) => x.startsWith("Not sent — the draft changed"))).toBe(true);
  expect(t.inbox.get(item.id)?.status).toBe("drafted");
});
