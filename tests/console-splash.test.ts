// ADR-0056 amendment (2026-10-28): the animated Core splash, and PWA icons whose tile is the manifest's
// own background, so the native launch splash, the icon and the console's ink are one colour.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splashHideIn } from "../src/frontends/web/splash";
import { BRAND, ICONS } from "../src/frontends/web/brand";
import { CACHE } from "../src/frontends/web/sw-rules";
import { iconPage, ICON_MARK_RATIO } from "../tools/brand/render-icons";

const WEB = join(import.meta.dir, "../src/frontends/web");
const html = readFileSync(join(WEB, "index.html"), "utf8");

test("the splash is in the first paint: before the app, with the Core paths, its own timing token and a fallback", () => {
  const splash = html.indexOf('<div class="splash" id="splash"');
  expect(splash).toBeGreaterThan(0);
  expect(splash).toBeLessThan(html.indexOf('<div class="app">'));
  const block = html.slice(splash, html.indexOf("</div>", splash));
  for (const d of ["M10 42V29A11 11 0 0 1 32 29V42", "M41 29H63A11 11 0 1 0 59.8 36.8"]) expect(block).toContain(d);
  expect(block).toContain('cx="83" cy="29" r="11"');
  expect(block).toContain('aria-hidden="true"'); // decorative: no text, nothing to translate
  expect(html).toMatch(/--splash-ms:\d+ms/); // one timing source, read by the CSS and by splash.ts
  // If app.js never runs, the splash still goes (never a dead overlay).
  expect(html).toMatch(/<script>[^<]*getElementById\("splash"\)[^<]*setTimeout/);
  // Reduced motion: the global rule stops every animation, so the splash is a static logo.
  expect(html).toContain("@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important");
  // …and since the draw-in starts from hidden strokes, reduced motion shows them fully drawn.
  expect(html).toContain("@media (prefers-reduced-motion:reduce){.splash .draw{stroke-dashoffset:0}.splash .core{transform:none}}");
});

test("splashHideIn: the splash stays until its animation ends, then goes at once; reduced motion never waits", () => {
  expect(splashHideIn({ shownAt: 0, now: 300, animMs: 1200, reduced: false })).toBe(900);
  expect(splashHideIn({ shownAt: 0, now: 2000, animMs: 1200, reduced: false })).toBe(0);
  expect(splashHideIn({ shownAt: 0, now: 300, animMs: 1200, reduced: true })).toBe(0);
  expect(splashHideIn({ shownAt: 0, now: 300, animMs: Number.NaN, reduced: false })).toBe(0); // unreadable token → no wait
});

test("the icon tile IS the manifest background, so the native launch splash has no seam", () => {
  expect(BRAND.logoTile).toBe(BRAND.inkDark);
  const page = iconPage(192, ICON_MARK_RATIO.any, readFileSync(join(WEB, "icons", "favicon.svg"), "utf8"));
  expect(page).toContain(`background:${BRAND.logoTile}`);
  expect(page).toContain('<circle cx="32" cy="32" r="19"'); // the mark from the SVG, not redrawn
  expect(ICON_MARK_RATIO.maskable).toBeLessThan(0.8); // inside the maskable safe zone
  expect(ICONS.filter((i) => i.file.endsWith(".png")).length).toBe(4);
});

test("the shell cache moved on, so installed PWAs take the new icons by themselves", () => {
  expect(CACHE).toBe("neo-shell-v3");
});
