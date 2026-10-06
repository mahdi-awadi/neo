import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac } from "node:crypto";
import { createWebApp } from "../src/frontends/web";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { createSessionStore } from "../src/engine/web-session";
import { openTrustStore } from "../src/engine/trust";
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
    botUsername: "", webHost: "127.0.0.1", webPort: 3003, publicUrl: "", companyFolder: "/tmp/agent", gatewaySendUrl: "",
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
    workers: { company: { effort: "low" }, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: { effort: "low" }, handoff: {}, secretary: {} },
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

function app(over: { admin?: ReturnType<typeof openAdminStore>; start?: ReturnType<typeof fakeStart> } = {}) {
  const registry = createRegistry();
  const admin = over.admin ?? openAdminStore(":memory:");
  const config = cfg();
  const ledger = openLedger(":memory:");
  return {
    registry,
    admin,
    ledger,
    cfg: config,
    instance: createWebApp({
      engine: { cfg: config, ledger, registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), start: over.start },
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
  expect(page).toContain("NEO");
  expect(page).toContain('<script type="module" src="/app.js"></script>');
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
  const ok = await post({ id: plan.id, action: "approve", version: 1 });
  expect(await ok.json()).toEqual({ ok: true, text: "Approved" });
  expect(a.ledger.planById(plan.id)!.status).toBe("approved");
  expect((await post({ id: plan.id, action: "explode" })).status).toBe(400);
  expect((await post({ action: "drop" })).status).toBe(400);
  // "Changes" needs the operator's text, which the console does not carry yet: refused, not guessed.
  expect(await (await post({ id: plan.id, action: "changes" })).json()).toEqual({ ok: false, text: "reply to the plan card on Telegram with your changes" });
});
