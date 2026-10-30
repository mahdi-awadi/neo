import { test, expect } from "bun:test";
import { reconcile } from "../src/engine/attention";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { withAttachments } from "../src/engine/files";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac } from "node:crypto";
import { consoleAppJs, consoleAppJsVersion, createWebApp } from "../src/frontends/web";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { createSessionStore } from "../src/engine/web-session";
import { openTrustStore } from "../src/engine/trust";
import { createTrace } from "../src/engine/trace";
import type { NeoConfig } from "../src/config";
import { DEFAULT_FAULTS, DEFAULT_HEALTH, DEFAULT_MODELS, DEFAULT_UPDATES } from "../src/config";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";

const TOKEN = "123456:TESTTOKEN";

function signLogin(data: Record<string, string>): string {
  const dcs = Object.keys(data).filter((k) => k !== "hash").sort().map((k) => `${k}=${data[k]}`).join("\n");
  return createHmac("sha256", createHash("sha256").update(TOKEN).digest()).update(dcs).digest("hex");
}
function loginUrl(id: number, authDate = 1000): string {
  const data: Record<string, string> = { id: String(id), auth_date: String(authDate) };
  data.hash = signLogin(data);
  const qs = new URLSearchParams(data).toString();
  return `http://neo.test/auth/telegram?${qs}`;
}
function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  return sc.split(";")[0]; // neo_session=...
}

function cfg(): NeoConfig {
  return {
    telegramToken: TOKEN, telegramAllowFrom: [], geminiApiKey: "",
    botUsername: "", webHost: "127.0.0.1", webPort: 3003, webBindRetryMs: 15_000, publicUrl: "", companyFolder: "/tmp/agent", gatewaySendUrl: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2, workRoot: "/home",
    budgetWindowUsd: 100, budgetWindowMs: 3_600_000,
    agentIngressSecret: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
    codebaseMemoryBin: "",
    codebaseMemoryIndexTimeoutMs: 300_000,
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
    dispatchStallMs: 300_000,
    dispatchGraceMs: 75_000,
    dispatchProgressMs: 600_000,
    dispatchRecoverWindowMs: 86_400_000,
    todoOnFailure: "continue",
    todoRetryBackoffMs: [],
    handoffNotesDir: "data/handoffs",
    apiRetryLadderMs: [30_000, 120_000, 480_000],
    apiRetryJitterFrac: 0.2,
    apiCooldownMs: 60_000,
    routeKeep: 20_000,
    eventsKeep: 50_000,
    decisionsKeep: 5_000,
    toolActionsKeep: 100_000,
    secretaryCron: "0 8-22/2 * * *",
    secretaryStaleHours: 24,
    codebaseMemoryListTimeoutMs: 15_000,
    inboxListDefault: 100,
    webFeedWindow: 500,
    messageRoutesCacheCap: 2_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
    drainWindowMs: 90_000,
    trustNewProjects: false,
    contextPolicy: { sweetSpotPct: 0.65, checkpointPct: 0.8, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 },
    models: DEFAULT_MODELS,
    updates: DEFAULT_UPDATES,
    faults: DEFAULT_FAULTS,
    health: DEFAULT_HEALTH,
    sqliteBusyTimeoutMs: 5_000,
    workers: { company: { effort: "low" }, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: { effort: "low" }, handoff: {}, secretary: {}, consult: {} },
    workerEnv: {},
    memory: { scopes: [], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 },
    telegramToolSteps: false,
    telegramFloodMaxWaitMs: 30_000,
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-webapp-"));

function fakeStart(onStart?: (h: RunHandlers) => void) {
  const done = new Promise<RunResult>(() => {});
  const start = (_o: Order, h: RunHandlers): SessionRun => {
    onStart?.(h);
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false, close: () => {}, closed: () => false, done };
  };
  return start;
}

function app(over: { admin?: ReturnType<typeof openAdminStore>; start?: ReturnType<typeof fakeStart>; traced?: boolean } = {}) {
  const registry = createRegistry();
  const admin = over.admin ?? openAdminStore(":memory:");
  const config = cfg();
  const ledger = openLedger(":memory:");
  const trace = over.traced ? createTrace({ ledger, registry }) : undefined;
  return {
    registry,
    admin,
    ledger,
    trace,
    cfg: config,
    instance: createWebApp({
      engine: { cfg: config, ledger, registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), start: over.start, ...(trace ? { trace } : {}) },
      botToken: TOKEN,
      botUsername: "neo_bot",
      sessions: createSessionStore({ secret: "websecret", ttlSec: 100000 }),
      admin,
      now: () => 1000,
    }),
  };
}

test("a valid Telegram login enrolls the admin, sets a cookie, and redirects", async () => {
  const a = app();
  const res = await a.instance.fetch(new Request(loginUrl(555)));
  expect(res.status).toBe(302);
  expect(res.headers.get("set-cookie") ?? "").toContain("neo_session=");
  expect(a.admin.adminId()).toBe(555);
});

test("a tampered Telegram login is rejected (403)", async () => {
  const a = app();
  const res = await a.instance.fetch(new Request(loginUrl(555) + "0")); // corrupt the hash
  expect(res.status).toBe(403);
  expect(a.admin.adminId()).toBeUndefined();
});

test("a non-admin valid login is rejected once an admin is enrolled (403)", async () => {
  const admin = openAdminStore(":memory:");
  admin.claimAdmin(555); // someone already enrolled
  const a = app({ admin });
  const res = await a.instance.fetch(new Request(loginUrl(999)));
  expect(res.status).toBe(403);
  expect(a.admin.adminId()).toBe(555);
});

test("POST /msg without a session cookie is unauthorized (401)", async () => {
  const a = app();
  const res = await a.instance.fetch(new Request("http://neo.test/msg", { method: "POST", body: JSON.stringify({ text: "hi" }) }));
  expect(res.status).toBe(401);
});

test("POST /msg with a valid session drives the pipeline", async () => {
  const dir = scratch();
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const res = await a.instance.fetch(
    new Request("http://neo.test/msg", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: `/open ${dir} do it` }) }),
  );
  expect(res.status).toBe(200);
  expect(a.registry.list().length).toBe(1); // a live session was started
});

test("POST /api/loop/create without a session is unauthorized (401)", async () => {
  const a = app();
  const res = await a.instance.fetch(new Request("http://neo.test/api/loop/create", { method: "POST", body: "{}" }));
  expect(res.status).toBe(401);
});

test("POST /api/loop/create with a session creates a custom loop", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const res = await a.instance.fetch(
    new Request("http://neo.test/api/loop/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "tidy",
        summary: "tidy up",
        folder: "/home/neo",
        prompt: "tidy",
        goalKind: "command",
        goalCommand: "true",
        triggerKind: "manual",
        maxIterations: 1,
      }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("POST /api/loop/create rejects invalid input with ok:false", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const res = await a.instance.fetch(
    new Request("http://neo.test/api/loop/create", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "", folder: "/nope", goalKind: "command", triggerKind: "manual", maxIterations: 1 }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: false });
});

test("POST /api/sdk with a session switches the worker SDK", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));

  const res = await a.instance.fetch(
    new Request("http://neo.test/api/sdk", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex" }),
    }),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, sdk: { provider: "codex" } });
  expect(a.cfg.providers.ownWork).toBe("codex");

  const state = await a.instance.fetch(new Request("http://neo.test/api/state", { headers: { cookie } }));
  expect(await state.json()).toMatchObject({ sdk: { provider: "codex" } });
});

test("GET / serves the login page when unauthenticated and the console when authenticated", async () => {
  const a = app();
  const anon = await a.instance.fetch(new Request("http://neo.test/"));
  expect(await anon.text()).toContain("telegram-widget");
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const authed = await a.instance.fetch(new Request("http://neo.test/", { headers: { cookie } }));
  const page = await authed.text();
  expect(page).toContain('<svg class="logo"'); // the Core logo (ADR-0056)
  expect(page).toContain(`<script type="module" src="/app.js?v=${await consoleAppJsVersion()}"></script>`);
});

// ADR-0023: a CDN in front of the console (Cloudflare) rewrote `no-cache` on /app.js to max-age=14400,
// so a phone ran a four-hour-old bundle under a new page shell (raw "pwa.install", a dead menu). The
// page now loads the bundle by its content version; only that URL is cacheable, and only privately.
test("GET /app.js: the versioned URL is private + immutable; any other URL is private + no-cache", async () => {
  const a = app();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const get = (q: string) => a.instance.fetch(new Request(`http://neo.test/app.js${q}`, { headers: { cookie } }));
  const v = await consoleAppJsVersion();
  expect(v).toMatch(/^[0-9a-f]{16}$/);
  const current = await get(`?v=${v}`);
  expect(current.status).toBe(200);
  expect(current.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(await current.text()).toBe(await consoleAppJs());
  for (const q of ["", "?v=0000000000000000"]) {
    const other = await get(q);
    expect(other.status, q).toBe(200);
    expect(other.headers.get("cache-control"), q).toBe("private, no-cache");
  }
  expect((await a.instance.fetch(new Request(`http://neo.test/app.js?v=${v}`))).status).toBe(401);
});

// ADR-0014: /stream tags each feed event with an SSE id and resumes from Last-Event-ID.
async function readStream(res: Response, want: number): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (let i = 0; i < 20 && (text.match(/^data: /gm) ?? []).length < want; i++) {
    const r = await Promise.race([reader.read(), Bun.sleep(100).then(() => ({ done: true, value: undefined }))]);
    if (r.done) break;
    text += dec.decode(r.value);
  }
  return text;
}

test("GET /stream sends an SSE id per event and resumes after Last-Event-ID", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const msg = (text: string) =>
    a.instance.fetch(new Request("http://neo.test/msg", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text }) }));
  await msg("/help");
  await msg("/help");

  const ac = new AbortController();
  const full = await readStream(await a.instance.fetch(new Request("http://neo.test/stream", { headers: { cookie }, signal: ac.signal })), 2);
  ac.abort();
  const ids = [...full.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(ids.length).toBe(2);

  const ac2 = new AbortController();
  const resumed = await readStream(
    await a.instance.fetch(new Request("http://neo.test/stream", { headers: { cookie, "last-event-id": String(ids[0]) }, signal: ac2.signal })),
    1,
  );
  ac2.abort();
  expect([...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([ids[1]]);
});

// ADR-0019: the plan card's actions on the web console go through the same engine rules as a tap.
test("POST /api/plan applies a plan action; a bad body is a 400", async () => {
  const a = app();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const plan = a.ledger.upsertPlan({ project: "gold", folder: "/home/gold", path: "plans/a.md", title: "A", sha256: "s", status: "sent", stepsTotal: 0, stepsDone: 0, version: 1 });
  const post = (body: unknown) =>
    a.instance.fetch(new Request("http://neo.test/api/plan", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect(await (await post({ id: plan.id, action: "approve", version: 2 })).json()).toEqual({ ok: false, text: "this card is v2 — the newest is v1; use that card" });
  // Approve & build with no held worker is an Execute (ADR-0036): it needs the todo queue.
  expect(await (await post({ id: plan.id, action: "approve", version: 1 })).json()).toEqual({ ok: false, text: "the todo queue is unavailable — Execute needs it" });
  const ok = await post({ id: plan.id, action: "drop", version: 1 });
  expect(await ok.json()).toEqual({ ok: true, text: "Dropped" });
  expect(a.ledger.planById(plan.id)!.status).toBe("abandoned");
  expect((await post({ id: plan.id, action: "explode" })).status).toBe(400);
  expect((await post({ action: "drop" })).status).toBe(400);
  // "Changes" needs the operator's text, which the console does not carry yet: refused, not guessed.
  expect(await (await post({ id: plan.id, action: "changes" })).json()).toEqual({ ok: false, text: "reply to the plan card on Telegram with your changes" });
});

// ADR-0018: an attention item's one-tap actions on the web console use the same engine rules as a tap.
test("POST /api/attention applies an attention action; a bad body is a 400", async () => {
  const a = app();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const [id] = reconcile(a.ledger, "engine", "gold", [{ project: "gold", folder: "/home/gold", source: "engine", kind: "queue_paused", key: "/home/gold", title: "paused", severity: "normal" }], 100).opened;
  const post = (body: unknown) =>
    a.instance.fetch(new Request("http://neo.test/api/attention", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect(await (await post({ id, action: "snooze" })).json()).toMatchObject({ ok: true });
  expect((await post({ id, action: "explode" })).status).toBe(400);
  expect((await post({ action: "dismiss" })).status).toBe(400);
});

// P6 Task 6.2: the project dashboard on the web — the list and one project's view.
test("GET /api/projects lists the known projects (bounded); GET /api/projects/:name is the view, 404 when unknown", async () => {
  const a = app();
  const root = mkdtempSync(join(tmpdir(), "neo-webpj-"));
  const { mkdirSync } = await import("node:fs");
  for (let i = 0; i < 105; i++) {
    const f = join(root, `p${String(i).padStart(3, "0")}`);
    mkdirSync(f);
    a.ledger.recordOrder({ id: crypto.randomUUID(), source: "neo", folder: f, task: "t", chatId: 0, createdAt: 1 });
  }
  reconcile(a.ledger, "engine", "p050", [{ project: "p050", folder: join(root, "p050"), source: "engine", kind: "thread_failed", key: "k", title: "run failed", severity: "high" }], Date.now());
  const get = (path: string, cookie?: string) => a.instance.fetch(new Request(`http://neo.test${path}`, cookie ? { headers: { cookie } } : {}));
  expect((await get("/api/projects")).status).toBe(401);
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const list = await get("/api/projects", cookie);
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toContain("no-store");
  const body = (await list.json()) as { rows: Array<{ name: string; health: string; queue: number; attention: Record<string, number> }>; total: number };
  expect(body.rows.length).toBe(100);
  expect(body.total).toBeGreaterThan(100);
  expect(body.rows[0]).toMatchObject({ name: "p050", health: "attention", queue: 0, attention: { high: 1, normal: 0, low: 0 } });
  const one = await get("/api/projects/p050", cookie);
  expect(one.status).toBe(200);
  expect(one.headers.get("cache-control")).toContain("no-store");
  const v = (await one.json()) as Record<string, unknown>;
  expect(v).toMatchObject({ name: "p050", health: "attention", now: null, queue: [], decisions: [], plans: [], threads: [] });
  expect((v.attention as unknown[]).length).toBe(1);
  expect(typeof v.snoozeHours).toBe("number"); // the console's snooze button names its hours
  expect((v.git as { error?: string }).error).toBeDefined(); // not a repo: named, never a 500
  expect((await get("/api/projects/ghost", cookie)).status).toBe(404);
  expect((await get("/api/projects/%2Fetc", cookie)).status).toBe(404);
});

/** /msg answers before the pipeline finishes: wait until the /open made its session, then pin it as
 *  the console's project (WEB_CHAT_ID = 0), so attachments have an inbox. */
async function opened(a: { registry: ReturnType<typeof createRegistry> }): Promise<void> {
  for (let i = 0; i < 100 && !a.registry.list().length; i++) await Bun.sleep(5);
  a.registry.setFocus(0, a.registry.list()[0]!.id, "pinned");
}

// ── staged attachments (ADR-0026): /upload stages, /msg sends the text and the files together ──
test("POST /upload stages the file and sends nothing; /msg with its token is ONE message with the path", async () => {
  const dir = scratch();
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const post = (path: string, body: unknown) =>
    a.instance.fetch(new Request(`http://neo.test${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  await post("/msg", { text: `/open ${dir} do it` });
  await opened(a);
  const rowsBefore = a.ledger.conversation(0, 50).length;
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" }));
  const up = await a.instance.fetch(new Request("http://neo.test/upload", { method: "POST", headers: { cookie }, body: fd }));
  expect(up.status).toBe(200);
  const staged = (await up.json()) as { ok: boolean; token: string; name: string; size: number };
  expect(staged).toMatchObject({ ok: true, name: "shot.png", size: 4 });
  expect(typeof staged.token).toBe("string");
  expect(JSON.stringify(staged)).not.toContain(dir); // the browser never sees a server path
  expect(existsSync(join(dir, "inbox", "shot.png"))).toBe(true);
  expect(a.ledger.conversation(0, 50).length).toBe(rowsBefore); // staging sent nothing

  await post("/msg", { text: "look at this", attachments: [staged.token] });
  const users = a.ledger.conversation(0, 50).filter((m) => m.role === "user").map((m) => m.content);
  expect(users.at(-1)).toBe(withAttachments("look at this", [{ name: "shot.png", path: join(dir, "inbox", "shot.png") }]));
});

test("POST /msg with files and no text still sends; /upload/discard deletes a staged file", async () => {
  const dir = scratch();
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const post = (path: string, body: unknown) =>
    a.instance.fetch(new Request(`http://neo.test${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  await post("/msg", { text: `/open ${dir} do it` });
  await opened(a);
  const stage = async (name: string) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([1])], name));
    return ((await (await a.instance.fetch(new Request("http://neo.test/upload", { method: "POST", headers: { cookie }, body: fd }))).json()) as { token: string }).token;
  };
  const keep = await stage("keep.txt");
  const drop = await stage("drop.txt");
  expect(await (await post("/upload/discard", { token: drop })).json()).toEqual({ ok: true });
  expect(existsSync(join(dir, "inbox", "drop.txt"))).toBe(false);
  expect(await (await post("/upload/discard", { token: drop })).json()).toEqual({ ok: false });
  // A send naming a gone file is refused whole (409), so the composer keeps its text and chips.
  const rows = a.ledger.conversation(0, 50).length;
  const refused = await post("/msg", { text: "   ", attachments: [keep, drop] });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ ok: false, error: "expired" });
  expect(a.ledger.conversation(0, 50).length).toBe(rows);
  const command = await post("/msg", { text: "/list", attachments: [keep] });
  expect(await command.json()).toEqual({ ok: false, error: "command" });
  expect((await post("/msg", { text: "   ", attachments: [keep, 7] })).status).toBe(200);
  const users = a.ledger.conversation(0, 50).filter((m) => m.role === "user").map((m) => m.content);
  expect(users.at(-1)).toBe(withAttachments("", [{ name: "keep.txt", path: join(dir, "inbox", "keep.txt") }]));
});

test("POST /upload with no active project is refused (409)", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1])], "a.txt"));
  const res = await a.instance.fetch(new Request("http://neo.test/upload", { method: "POST", headers: { cookie }, body: fd }));
  expect(res.status).toBe(409);
});

// ADR-0027: the Queue tab's Retry re-runs a failed todo through the shared /todo command.
test("POST /api/todo accepts retry; an unknown action is a 400", async () => {
  const a = app();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const post = (body: unknown) =>
    a.instance.fetch(new Request("http://neo.test/api/todo", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const r = await post({ action: "retry", id: 999 });
  expect(r.status).toBe(200);
  expect(((await r.json()) as { text: string }).text).not.toContain("required");
  expect((await post({ action: "explode", id: 1 })).status).toBe(400);
});

// ADR-0038: the operator closes a thread from the console — behind the admin session.
test("POST /api/thread/close closes the thread; no session 401, a bad id 400, an unknown thread 404", async () => {
  const a = app({ traced: true });
  const root = a.trace!.inbound({ chatId: 7, text: "build it", surface: "web" });
  const d = a.ledger.openDecision({ kind: "decision", question: "Which bank?", cause: root }, 500);
  a.trace!.refreshThread(root.threadId);
  const req = (body: unknown, cookie?: string) =>
    a.instance.fetch(new Request("http://neo.test/api/thread/close", { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect((await req({ id: root.threadId })).status).toBe(401);
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  expect((await req({ id: "x" }, cookie)).status).toBe(400);
  expect((await req({ id: 987654 }, cookie)).status).toBe(404);
  const ok = await req({ id: root.threadId }, cookie);
  expect(await ok.json()).toEqual({ ok: true, closed: true, decisions: 1, todosCancelled: [], stillActive: [] });
  expect(a.ledger.threadById(root.threadId)).toMatchObject({ state: "done", closedByOperator: true });
  expect(a.ledger.decisionById(d)).toMatchObject({ status: "dismissed", answer: "thread closed by the operator" });
});

// ── Markdown file links (ADR-0046) ──────────────────────────────────────────────────────────────
function mdApp() {
  const a = app();
  const base = realpathSync(scratch());
  const root = join(base, "work");
  mkdirSync(join(root, "learning", "notes"), { recursive: true });
  writeFileSync(join(root, "learning", "notes", "how-neo-works.md"), "# How Neo works\n");
  writeFileSync(join(root, "learning", "notes", "big.md"), "x".repeat(64));
  writeFileSync(join(root, "learning", ".env"), "dotenv fixture\n");
  writeFileSync(join(base, "outside.md"), "outside\n");
  symlinkSync(join(base, "outside.md"), join(root, "learning", "escape.md"));
  a.cfg.mdFiles = { roots: [root], maxBytes: 32 };
  const get = (path: string, cookie?: string) =>
    a.instance.fetch(new Request(`http://neo.test/md-file?path=${encodeURIComponent(path)}`, cookie ? { headers: { cookie } } : {}));
  return { a, root, base, get };
}

test("GET /md-file serves an allowed .md file as an attachment with safe headers, and logs it", async () => {
  const { a, root, get } = mdApp();
  a.cfg.mdFiles!.maxBytes = 1024;
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const p = join(root, "learning", "notes", "how-neo-works.md");
  const res = await get(p, cookie);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("# How Neo works\n");
  expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename="how-neo-works.md"; filename*=UTF-8''how-neo-works.md`);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const [ev] = a.ledger.listEvents({ kind: "md_file" });
  expect(ev?.data).toMatchObject({ path: p, real: p, status: 200, uid: 555 });
  expect(typeof ev?.data?.session).toBe("string");
  expect(JSON.stringify(ev?.data)).not.toContain(decodeURIComponent(cookie.split("=")[1]!));
});

test("GET /md-file without a session is 401, reads nothing and logs nothing", async () => {
  const { a, root, get } = mdApp();
  const res = await get(join(root, "learning", "notes", "how-neo-works.md"));
  expect(res.status).toBe(401);
  expect(a.ledger.listEvents({ kind: "md_file" })).toHaveLength(0);
});

test("GET /md-file refuses outside a root, a symlink escape, .env, non-.md, a missing file and a too-large file", async () => {
  const { a, root, base, get } = mdApp();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const status = async (p: string) => (await get(p, cookie)).status;
  expect(await status(join(base, "outside.md"))).toBe(403);
  expect(await status(join(root, "learning", "escape.md"))).toBe(403);
  expect(await status(join(root, "learning", ".env"))).toBe(403);
  expect(await status(join(root, "learning", "notes", "x.txt"))).toBe(403);
  expect(await status(join(root, "learning", "notes", "missing.md"))).toBe(404);
  expect(await status(join(root, "learning", "notes", "big.md"))).toBe(413);
  expect(await status(`${root}/learning/notes/../notes/how-neo-works.md`)).toBe(400);
  const bare = await a.instance.fetch(new Request("http://neo.test/md-file", { headers: { cookie } }));
  expect(bare.status).toBe(400);
  // A refusal never carries the file and is logged with its status.
  const evs = a.ledger.listEvents({ kind: "md_file", limit: 20 });
  expect(evs.map((e) => e.data?.status).sort()).toEqual([400, 400, 403, 403, 403, 403, 404, 413]);
});

test("a non-ASCII .md name gets an ASCII filename and an RFC 5987 filename*", async () => {
  const { a, root, get } = mdApp();
  const p = join(root, "learning", "notes", "ملاحظات \"x\".md");
  writeFileSync(p, "ar\n");
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const res = await get(p, cookie);
  expect(res.status).toBe(200);
  const cd = res.headers.get("content-disposition") ?? "";
  expect(cd).toStartWith('attachment; filename="');
  expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("ملاحظات \"x\".md")}`);
  expect(cd.split(";")[1]).not.toMatch(/[^\x20-\x7e]/);
  expect(cd.split(";")[1]).toBe(` filename="${"_".repeat(9)}x_.md"`);
});

// ADR-0058: the console's "Running now" strip — the state carries the running calls, and the admin
// session can stop or background one.
test("the state carries running tool calls; POST /api/tool/stop|background acts through the seam (admin only)", async () => {
  const a = app();
  const s = a.registry.add({ id: "w", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  const calls: string[] = [];
  a.registry.attachControl(s.id, {
    followUp: () => {},
    interrupt: async () => {},
    tools: { provider: "claude", running: () => [{ toolUseId: "toolu_A", tool: "Bash", summary: "git push origin dev", since: 500 }], background: async (id: string) => (calls.push(`bg ${id}`), { ok: true }), stop: async () => ({ ok: true }) },
  } as never);
  const post = (path: string, body: unknown, cookie?: string) =>
    a.instance.fetch(new Request(`http://neo.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
  expect((await post("/api/tool/background", { session: s.id, toolUseId: "toolu_A" })).status).not.toBe(200); // no session
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const state = await (await a.instance.fetch(new Request("http://neo.test/api/state", { headers: { cookie } }))).json();
  expect(state.running).toEqual([{ session: s.id, name: "eticket-v3", project: "eticket-v3", toolUseId: "toolu_A", tool: "Bash", summary: "git push origin dev", since: 500, provider: "claude" }]);
  expect((await post("/api/tool/background", { session: s.id }, cookie)).status).toBe(400); // toolUseId required
  expect((await post("/api/tool/explode", { session: s.id, toolUseId: "toolu_A" }, cookie)).status).toBe(404);
  const r = await (await post("/api/tool/background", { session: s.id, toolUseId: "toolu_A" }, cookie)).json();
  expect(r).toMatchObject({ ok: true, outcome: "backgrounded" });
  expect(calls).toEqual(["bg toolu_A"]);
  expect(a.ledger.listEvents({ kind: "tool_control" })[0]!.data).toMatchObject({ by: "operator:web" });
});

// ADR-0065: the "Pinned — needs you" strip, pins and the todo detail on the web console.
test("GET /api/needs-you lists what needs the operator; POST /api/pin pins and refuses a closed item; bad bodies are 400", async () => {
  const a = app();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const get = (path: string) => a.instance.fetch(new Request(`http://neo.test${path}`, { headers: { cookie } }));
  const pin = (body: unknown) =>
    a.instance.fetch(new Request("http://neo.test/api/pin", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect((await a.instance.fetch(new Request("http://neo.test/api/needs-you"))).status).toBe(401);
  const [failed] = reconcile(a.ledger, "engine", "gold", [{ project: "gold", folder: "/home/gold", source: "engine", kind: "thread_failed", key: "t1", title: "run failed", severity: "normal" }], 100).opened;
  const [pr] = reconcile(a.ledger, "github", "gold", [{ project: "gold", folder: "/home/gold", source: "github", kind: "pr_open", key: "31", title: "PR #31: refunds", severity: "normal" }], 100).opened;
  const list = await get("/api/needs-you");
  expect(list.headers.get("cache-control")).toContain("no-store");
  expect(((await list.json()) as { items: Array<{ ref: string }> }).items.map((i) => i.ref)).toEqual([`att:${failed}`]);
  expect(await (await pin({ ref: `att:${pr}`, state: "pinned" })).json()).toMatchObject({ ok: true });
  expect(((await (await get("/api/needs-you")).json()) as { items: Array<{ ref: string; pinned: boolean }> }).items.map((i) => [i.ref, i.pinned])).toEqual([
    [`att:${failed}`, false],
    [`att:${pr}`, true],
  ]);
  a.ledger.updateAttention(failed!, { resolvedAt: 200 });
  expect(await (await pin({ ref: `att:${failed}`, state: "pinned" })).json()).toMatchObject({ ok: false });
  expect(await (await pin({ ref: `att:${pr}`, state: null })).json()).toMatchObject({ ok: true });
  expect((await pin({ ref: `att:${pr}`, state: "maybe" })).status).toBe(400);
  expect((await pin({ state: "pinned" })).status).toBe(400);
});

test("GET /api/todo/:id is the todo's detail; an unknown or malformed id is a 404", async () => {
  const a = app();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const get = (path: string) => a.instance.fetch(new Request(`http://neo.test${path}`, { headers: { cookie } }));
  const t = a.ledger.addTodo({ project: "gold", folder: "/home/gold", brief: "Fix the wallet refund", workClass: "interactive", createdBy: "operator" }, 100);
  const r = await get(`/api/todo/${t.id}`);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toContain("no-store");
  expect(await r.json()).toMatchObject({ id: t.id, project: "gold", brief: "Fix the wallet refund", status: "queued", actions: ["cancel"] });
  expect((await get("/api/todo/99999")).status).toBe(404);
  expect((await get("/api/todo/abc")).status).toBe(404);
  expect((await a.instance.fetch(new Request(`http://neo.test/api/todo/${t.id}`))).status).toBe(401);
});

// ── A pin's Open lands on the item; a plan can be read before it is approved (ADR-0071) ─────────
test("GET /md-file?view=html renders the plan with the console's safe renderer, under the same checks and audit", async () => {
  const { a, root, base, get } = mdApp();
  a.cfg.mdFiles!.maxBytes = 1024;
  const p = join(root, "learning", "notes", "plan.md");
  writeFileSync(p, "# Plan\n\n- step one\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n");
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const view = (path: string, c?: string) => a.instance.fetch(new Request(`http://neo.test/md-file?view=html&path=${encodeURIComponent(path)}`, c ? { headers: { cookie: c } } : {}));
  const res = await view(p, cookie);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { name: string; html: string };
  expect(body.name).toBe("plan.md");
  expect(body.html).toContain(`class="mh"`); // the feed renderer's heading
  expect(body.html).toContain("step one");
  expect(body.html).not.toContain("<script>"); // raw HTML is text
  expect(body.html).toContain("&lt;script&gt;");
  expect(body.html).not.toContain("javascript:");
  // The same refusals, with the same status, as the download.
  for (const [path, status] of [[join(base, "outside.md"), 403], [join(root, "learning", "escape.md"), 403], [join(root, "learning", ".env"), 403], [`${root}/learning/notes/../notes/plan.md`, 400], [join(root, "learning", "notes", "missing.md"), 404]] as const) {
    expect((await view(path, cookie)).status).toBe(status);
  }
  expect((await view(p)).status).toBe(401);
  const evs = a.ledger.listEvents({ kind: "md_file", limit: 20 });
  expect(evs.some((e) => e.data?.view === true && e.data?.status === 200)).toBe(true);
});

test("GET /api/item returns the item a pin names; a bad ref is 400 and a gone one 404; no session is 401", async () => {
  const a = app();
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const dec = a.ledger.openDecision({ kind: "decision", question: "Which bank?", options: ["Qi", "Zain"], folder: "/home/q", project: "q" }, 1);
  const get = (ref: string, c: string | undefined = cookie) => a.instance.fetch(new Request(`http://neo.test/api/item?ref=${encodeURIComponent(ref)}`, c ? { headers: { cookie: c } } : {}));
  const res = await get(`dec:${dec}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ type: "decision", decision: { id: dec, question: "Which bank?", options: ["Qi", "Zain"], answerable: true } });
  expect((await get("x:../../etc")).status).toBe(400);
  expect((await get("att:999")).status).toBe(404);
  expect((await get(`dec:${dec}`, "")).status).toBe(401);
});

test("POST /api/decision/answer answers an open decision through the shared path; refusals are explained", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const post = (body: unknown, c: string | undefined = cookie) =>
    a.instance.fetch(new Request("http://neo.test/api/decision/answer", { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }));
  const dec = a.ledger.openDecision({ kind: "decision", question: "Should I write a plan?", folder: scratch(), project: "neo", orderId: "o1" }, 1);
  expect((await post({ id: dec, answer: "yes" }, "")).status).toBe(401);
  expect((await post({ id: dec })).status).toBe(400);
  expect(await (await post({ id: dec, answer: "   " })).json()).toMatchObject({ ok: false });
  expect(await (await post({ id: dec, answer: "x".repeat(5000) })).json()).toMatchObject({ ok: false });
  expect(a.ledger.decisionById(dec)!.status).toBe("open");
  const ok = await post({ id: dec, answer: "  yes, write it  " });
  expect(await ok.json()).toMatchObject({ ok: true });
  expect(a.ledger.decisionById(dec)).toMatchObject({ status: "answered", answer: "yes, write it" });
  expect(await (await post({ id: dec, answer: "again" })).json()).toMatchObject({ ok: false, text: "already answered" });
  expect(await (await post({ id: "nope", answer: "x" })).json()).toMatchObject({ ok: false });
  // A plan card is approved or dropped through the plan action, never answered in free text.
  const card = a.ledger.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/p.md — P", folder: "/home/p", project: "p" }, 2);
  a.ledger.upsertPlan({ project: "p", folder: "/home/p", path: "docs/p.md", title: "P", sha256: "x", stepsTotal: 1, stepsDone: 0, status: "sent", gate: "approval", decisionId: card } as never);
  expect(await (await post({ id: card, answer: "ok" })).json()).toMatchObject({ ok: false });
  expect(a.ledger.decisionById(card)!.status).toBe("open");
  // An alert is acknowledged: dismissed, no worker resumed; it is never answered with text.
  const alert = a.ledger.openDecision({ kind: "alert", question: "Disk 95% full", orderId: "o2" }, 3);
  expect(await (await post({ id: alert, answer: "ok" })).json()).toMatchObject({ ok: false });
  expect(await (await post({ id: alert, acknowledge: true })).json()).toMatchObject({ ok: true });
  expect(a.ledger.decisionById(alert)!.status).toBe("dismissed");
  // A governor approval (no order) is released only by its card's Allow/Deny: refused here, left open.
  const approval = a.ledger.openDecision({ kind: "decision", question: "risky shell command: git push" }, 4);
  expect(await (await post({ id: approval, answer: "allow" })).json()).toMatchObject({ ok: false });
  expect(a.ledger.decisionById(approval)!.status).toBe("open");
});

test("POST /api/decision/answer takes picks for a structured card: complete picks become the answer text", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const post = (body: unknown) =>
    a.instance.fetch(new Request("http://neo.test/api/decision/answer", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const spec = { questions: [{ question: "Which providers?", header: "Providers", options: ["Qi", "Zain", "Asia"], multiSelect: true }, { question: "When?", header: "When", options: ["Now", "Later"] }] };
  const dec = a.ledger.openDecision({ kind: "decision", question: "Refunds", spec, folder: scratch(), project: "eticket-v3", orderId: "o1" } as never, 1);
  expect(await (await post({ id: dec, picks: [[0, 2]] })).json()).toMatchObject({ ok: false }); // the second question is unanswered
  expect(await (await post({ id: dec, picks: [[0, 9], [1]] })).json()).toMatchObject({ ok: false }); // out of range
  expect((await post({ id: dec, picks: "x" })).status).toBe(400);
  expect(await (await post({ id: dec, picks: [[0, 2], [1]] })).json()).toMatchObject({ ok: true });
  expect(a.ledger.decisionById(dec)).toMatchObject({ status: "answered", answer: "Providers: Qi, Asia | When: Later" });
});

// Design review (2026-10-30): a state-changing request from another site — including a sibling subdomain on
// this host — is refused, whatever the cookie; the console's own fetches are same-origin.
test("a non-GET request whose Sec-Fetch-Site is not same-origin is refused (403) before any route runs", async () => {
  const a = app({ start: fakeStart() });
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const dec = a.ledger.openDecision({ kind: "decision", question: "Q?", folder: scratch(), project: "neo", orderId: "o1" }, 1);
  const post = (site?: string) =>
    a.instance.fetch(new Request("http://neo.test/api/decision/answer", { method: "POST", headers: { cookie, "content-type": "application/json", ...(site ? { "sec-fetch-site": site } : {}) }, body: JSON.stringify({ id: dec, answer: "yes" }) }));
  expect((await post("cross-site")).status).toBe(403);
  expect((await post("same-site")).status).toBe(403);
  expect(a.ledger.decisionById(dec)!.status).toBe("open");
  expect((await post("same-origin")).status).toBe(200);
  expect(a.ledger.decisionById(dec)!.status).toBe("answered");
  // A GET (the md download link, a page load) is not affected.
  expect((await a.instance.fetch(new Request("http://neo.test/api/needs-you", { headers: { cookie, "sec-fetch-site": "cross-site" } }))).status).toBe(200);
});
