// The console is an installable PWA that caches only its public shell (ADR-0022, spec AC11–AC16):
// a localized manifest, a shell-only service worker built by Bun.build, allowlisted icons and a
// localized offline page — all public, none personal.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac } from "node:crypto";
import { consolePage, consoleSwJs, createWebApp, loginPage } from "../src/frontends/web";
import { createConsoleI18n } from "../src/frontends/web/i18n";
import { BRAND, ICONS } from "../src/frontends/web/brand";
import { CACHE, CACHE_PREFIX, SHELL, shellRule } from "../src/frontends/web/sw-rules";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { createSessionStore } from "../src/engine/web-session";
import { openTrustStore } from "../src/engine/trust";

const WEB = join(import.meta.dir, "../src/frontends/web");
const TOKEN = "123456:TESTTOKEN";
const ORIGIN = "http://neo.test";

function loginUrl(): string {
  const data: Record<string, string> = { id: "555", auth_date: "1000" };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update(TOKEN).digest()).update(dcs).digest("hex");
  return `${ORIGIN}/auth/telegram?${new URLSearchParams(data).toString()}`;
}
function app(consoleLang: "en" | "ar" = "en") {
  return createWebApp({
    engine: { cfg: { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-pwa-"))), telegramToken: TOKEN, consoleLang }, ledger: openLedger(":memory:"), registry: createRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:") },
    botToken: TOKEN,
    botUsername: "neo_bot",
    sessions: createSessionStore({ secret: "s", ttlSec: 100000 }),
    admin: openAdminStore(":memory:"),
    now: () => 1000,
  });
}
const get = (a: ReturnType<typeof app>, path: string, cookie?: string) => a.fetch(new Request(ORIGIN + path, cookie ? { headers: { cookie } } : {}));

test("the manifest is public JSON (AC11): standalone app at /, brand colours, 192/512/maskable icons, catalogue strings", async () => {
  const res = await get(app(), "/manifest.webmanifest");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/manifest+json");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const m = await res.json();
  const en = createConsoleI18n("en");
  expect(m).toMatchObject({
    id: "/", start_url: "/", scope: "/", display: "standalone", lang: "en", dir: "ltr",
    name: en.t("pwa.name"), short_name: en.t("pwa.shortName"), description: en.t("pwa.description"),
    background_color: BRAND.inkDark, theme_color: BRAND.inkDark,
  });
  expect(m.icons).toEqual([
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);
});

test("the manifest follows the language: the neo_lang cookie wins, else consoleLang; Arabic is rtl", async () => {
  const ar = createConsoleI18n("ar");
  const m = await (await get(app("en"), "/manifest.webmanifest", "neo_lang=ar")).json();
  expect(m).toMatchObject({ lang: "ar", dir: "rtl", name: ar.t("pwa.name"), short_name: ar.t("pwa.shortName"), description: ar.t("pwa.description") });
  expect((await (await get(app("ar"), "/manifest.webmanifest")).json()).dir).toBe("rtl");
  expect(ar.t("pwa.name")).not.toBe(createConsoleI18n("en").t("pwa.name"));
});

test("/sw.js is public JavaScript, no-cache, built by Bun.build into a classic script (no import/export)", async () => {
  const res = await get(app(), "/sw.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const js = await res.text();
  expect(js).toBe(await consoleSwJs());
  expect(js).toContain(CACHE);
  // A service worker registered without {type:"module"} is a classic script: it must parse as one.
  expect(() => new Function(js)).not.toThrow();
});

test("/icons serves only the allowlisted PNGs (AC13): no traversal, unknown names 404", async () => {
  const a = app();
  for (const i of ICONS) {
    const res = await get(a, `/icons/${i.file}`);
    expect(res.status, i.file).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    // The PNG header's width/height match the declared size.
    const dv = new DataView(bytes.buffer);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([i.size, i.size]);
  }
  expect((await get(a, "/icons/nope.png")).status).toBe(404);
  expect((await get(a, "/icons/%2e%2e%2fweb.ts")).status).toBe(404);
  expect((await get(a, "/icons/..%2F..%2Fweb.ts")).status).toBe(404);
  expect((await get(a, "/icons/")).status).toBe(404);
  // `/icons/../web.ts` normalizes to `/web.ts`: behind the session gate, and not a route either.
  const cookie = (await a.fetch(new Request(loginUrl()))).headers.get("set-cookie")!.split(";")[0]!;
  expect((await get(a, "/icons/../web.ts", cookie)).status).toBe(404);
  expect(ICONS.map((i) => i.file).sort()).toEqual(["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]);
});

test("/offline.html is public, no-cache, localized; Arabic is rtl", async () => {
  const en = await get(app(), "/offline.html");
  expect(en.status).toBe(200);
  expect(en.headers.get("content-type")).toContain("text/html");
  expect(en.headers.get("cache-control")).toBe("no-cache");
  const html = await en.text();
  const i = createConsoleI18n("en");
  for (const k of ["offline.title", "offline.body", "offline.retry"]) expect(html).toContain(i.t(k));
  expect(html).toContain('<html lang="en" dir="ltr"');
  const arHtml = await (await get(app(), "/offline.html", "neo_lang=ar")).text();
  expect(arHtml).toContain('<html lang="ar" dir="rtl"');
  expect(arHtml).toContain(createConsoleI18n("ar").t("offline.body"));
  expect(arHtml).not.toMatch(/%[A-Z_]+%/);
});

test("shellRule (AC14): shell → cache; navigations → network then offline; everything else untouched", () => {
  const r = (url: string, method = "GET", mode?: string) => shellRule({ url: url.startsWith("http") ? url : ORIGIN + url, method, mode }, ORIGIN);
  for (const s of SHELL) expect(r(s), s).toBe("cache");
  expect(SHELL).toContain("/manifest.webmanifest");
  expect(SHELL).toContain("/offline.html");
  for (const i of ICONS) expect(SHELL).toContain(`/icons/${i.file}`);
  expect(r("/", "GET", "navigate")).toBe("network-then-offline");
  expect(r("/?x=1", "GET", "navigate")).toBe("network-then-offline");
  for (const p of ["/", "/app.js", "/sw.js", "/api/x", "/api/state?_=1", "/stream", "/auth/telegram?id=1", "/upload", "/file?token=a", "/msg"]) expect(r(p), p).toBe("ignore");
  // The never-touch list wins over navigation: the login redirect and downloads are the browser's.
  for (const p of ["/auth/telegram?id=1", "/file?token=a", "/api/x", "/stream", "/app.js"]) expect(r(p, "GET", "navigate"), p).toBe("ignore");
  expect(r("/manifest.webmanifest", "POST")).toBe("ignore");
  expect(r("/", "POST", "navigate")).toBe("ignore");
  expect(r("https://fonts.googleapis.com/css2?family=x")).toBe("ignore");
  expect(r("https://other.test/", "GET", "navigate")).toBe("ignore");
  expect(r("https://other.test/manifest.webmanifest")).toBe("ignore");
});

test("the cache name carries a version (AC15); old Neo caches share its prefix", () => {
  expect(CACHE.startsWith(CACHE_PREFIX)).toBe(true);
  expect(CACHE).toMatch(/^neo-shell-v\d+$/);
  const sw = readFileSync(join(WEB, "sw.ts"), "utf8");
  // activate deletes the other neo-shell-* caches and claims the open pages; install precaches the shell fresh.
  expect(sw).toMatch(/startsWith\(CACHE_PREFIX\)\s*&&\s*\w+\s*!==\s*CACHE/);
  expect(sw).toContain("clients.claim()");
  expect(sw).toContain('cache: "reload"');
});

test("both pages link the manifest, the Apple touch icon and theme colours for both schemes (AC16)", () => {
  for (const html of [consolePage(), loginPage("neo_bot")]) {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">');
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${BRAND.inkDark}">`);
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${BRAND.inkLight}">`);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
    expect(html).not.toMatch(/%THEME_[A-Z]+%/);
  }
});

test("the brand colours are the CSS tokens: dark ink is --ink, accent is --accent", () => {
  for (const f of ["index.html", "login.html", "offline.html"]) {
    const css = readFileSync(join(WEB, f), "utf8");
    expect(css.match(/--ink:(#[0-9a-f]{6})/)![1], f).toBe(BRAND.inkDark);
    expect(css.match(/--accent:(#[0-9a-f]{6})/)![1], f).toBe(BRAND.accent);
  }
  expect(BRAND.inkLight).toMatch(/^#[0-9a-f]{6}$/);
});
