// The console registers its service worker and offers install (ADR-0022, spec AC16–AC18). The rules are
// pure (web/pwa.ts); the DOM wiring in app.ts is checked at source level like the other console tests.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_DISMISSED_KEY, installMode, isIos } from "../src/frontends/web/pwa";
import { consolePage } from "../src/frontends/web";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";

const APP = readFileSync(join(import.meta.dir, "../src/frontends/web/app.ts"), "utf8");

test("installMode: installed or dismissed → none; a browser prompt → prompt; iOS → the share hint; else none", () => {
  const m = (standalone: boolean, prompt: boolean, ios: boolean, dismissed: boolean) => installMode({ standalone, prompt, ios, dismissed });
  for (const prompt of [false, true])
    for (const ios of [false, true])
      for (const dismissed of [false, true]) expect(m(true, prompt, ios, dismissed)).toBe("none");
  for (const prompt of [false, true]) for (const ios of [false, true]) expect(m(false, prompt, ios, true)).toBe("none");
  expect(m(false, true, false, false)).toBe("prompt");
  expect(m(false, true, true, false)).toBe("prompt");
  expect(m(false, false, true, false)).toBe("ios-hint");
  expect(m(false, false, false, false)).toBe("none");
});

test("isIos: iPhone, iPad, iPod and iPadOS (a Mac UA with touch) — not Android, not a desktop Mac or PC", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const IPAD = "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
  const IPOD = "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
  const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
  expect(isIos(IPHONE, 5)).toBe(true);
  expect(isIos(IPAD, 5)).toBe(true);
  expect(isIos(IPOD, 5)).toBe(true);
  expect(isIos(MAC, 5)).toBe(true); // iPadOS 13+ Safari reports a desktop Mac UA
  expect(isIos(MAC, 0)).toBe(false);
  expect(isIos(MAC, 1)).toBe(false);
  expect(isIos(ANDROID, 5)).toBe(false);
  expect(isIos(WIN, 10)).toBe(false);
  expect(INSTALL_DISMISSED_KEY).toMatch(/^neo\./);
});

test("app.ts registers /sw.js at scope / only in a secure context with service worker support, contained", () => {
  const reg = APP.match(/if \(isSecureContext && "serviceWorker" in navigator\)[\s\S]*?\n\}/);
  expect(reg).not.toBeNull();
  expect(reg![0]).toMatch(/navigator\.serviceWorker\s*\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  expect(reg![0]).toContain(".catch(");
  expect(APP.match(/serviceWorker\s*\.register\(/g)).toHaveLength(1);
});

test("app.ts drives the install chip from installMode: beforeinstallprompt kept, appinstalled, standalone, dismissal remembered", () => {
  expect(APP).toMatch(/import \{[^}]*installMode[^}]*\} from "\.\/pwa"/);
  expect(APP).toMatch(/addEventListener\("beforeinstallprompt", \(e\) => \{\s*e\.preventDefault\(\);/);
  expect(APP).toContain('addEventListener("appinstalled"');
  expect(APP).toContain('matchMedia("(display-mode: standalone)").matches');
  expect(APP).toContain("navigator as Any).standalone === true");
  expect(APP).toContain("isIos(navigator.userAgent, navigator.maxTouchPoints)");
  expect(APP).toContain(".prompt()");
  expect(APP).toMatch(/localStorage\.setItem\(INSTALL_DISMISSED_KEY/);
  expect(APP).toMatch(/localStorage\.getItem\(INSTALL_DISMISSED_KEY/);
});

test("the page has a hidden install chip next to the language chip and a hidden iOS hint, keyed in the catalogue", () => {
  const html = consolePage();
  expect(html).toMatch(/<button class="chip" id="install" hidden data-i18n="pwa\.install" data-i18n-title="pwa\.installTitle"><\/button>\s*<button class="chip" id="lang"/);
  expect(html).toMatch(/<div class="hint" id="ioshint" hidden[^>]*>/);
  expect(html).toContain('data-i18n="pwa.iosHint"');
  expect(html).toContain('id="ioshint-x"');
  expect(html).toContain('data-i18n="pwa.dismiss"');
});

test("every new PWA string is in both catalogues, the Arabic is Arabic (AC18)", () => {
  const keys = ["name", "shortName", "description", "install", "installTitle", "iosHint", "dismiss"] as const;
  for (const k of keys) {
    expect((en.pwa as Record<string, string>)[k], k).toBeTruthy();
    expect((ar.pwa as Record<string, string>)[k], k).toMatch(/[؀-ۿ]/);
  }
  for (const k of ["title", "body", "retry"] as const) expect(ar.offline[k], k).toMatch(/[؀-ۿ]/);
});
