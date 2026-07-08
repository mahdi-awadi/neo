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
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2, workRoot: "/home",
    budgetWindowUsd: 100, budgetWindowMs: 3_600_000,
    agentIngressSecret: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
    gitnexusBin: "",
    codebaseMemoryBin: "",
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
    dispatchTimeoutMs: 900_000,
    dispatchTimeoutMaxMs: 7_200_000,
    dispatchStallMs: 300_000,
    dispatchGraceMs: 75_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
    drainWindowMs: 90_000,
    contextPolicy: { handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000 },
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-webapp-"));

function fakeStart(onStart?: (h: RunHandlers) => void) {
  const done = new Promise<RunResult>(() => {});
  const start = (_o: Order, h: RunHandlers): SessionRun => {
    onStart?.(h);
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done };
  };
  return start;
}

function app(over: { admin?: ReturnType<typeof openAdminStore>; start?: ReturnType<typeof fakeStart> } = {}) {
  const registry = createRegistry();
  const admin = over.admin ?? openAdminStore(":memory:");
  return {
    registry,
    admin,
    instance: createWebApp({
      engine: { cfg: cfg(), ledger: openLedger(":memory:"), registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), start: over.start },
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

test("GET / serves the login page when unauthenticated and the console when authenticated", async () => {
  const a = app();
  const anon = await a.instance.fetch(new Request("http://neo.test/"));
  expect(await anon.text()).toContain("telegram-widget");
  const cookie = cookieFrom(await a.instance.fetch(new Request(loginUrl(555))));
  const authed = await a.instance.fetch(new Request("http://neo.test/", { headers: { cookie } }));
  expect(await authed.text()).toContain("Neo");
});
