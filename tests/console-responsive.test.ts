// The console on phones and tablets (spec 2026-10-07, AC1–AC10): a drawer sidebar on medium screens,
// master–detail Threads/Projects on narrow ones, 44 px touch targets, a light token set, reduced
// motion, safe areas and a height that follows the visual viewport (the on-screen keyboard).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";
import { consolePage } from "../src/frontends/web";
import { BRAND } from "../src/frontends/web/brand";

const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const SHELL = readFileSync(join(WEB, "index.html"), "utf8");
const CSS = SHELL.match(/<style>([\s\S]*?)<\/style>/)![1]!;

/** The body of the first `@media <query>{…}` block (brace-balanced). */
function media(query: string): string {
  const at = CSS.indexOf(`@media ${query}{`);
  if (at < 0) throw new Error(`no @media ${query}`);
  let depth = 0;
  const start = CSS.indexOf("{", at);
  for (let i = start; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) return CSS.slice(start + 1, i);
  }
  throw new Error(`unbalanced @media ${query}`);
}

test("viewport: device width, the safe-area cover and a keyboard that resizes the content (AC5)", () => {
  expect(consolePage()).toContain('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">');
  // The app height follows the visual viewport; the safe areas pad the bars.
  expect(CSS).toContain("height:var(--app-h,100dvh)");
  for (const edge of ["top", "bottom"]) expect(CSS).toContain(`env(safe-area-inset-${edge})`);
  expect(CSS).toMatch(/\.compose\{[^}]*calc\(13px \+ env\(safe-area-inset-bottom\)\)/);
  expect(APP).toContain("visualViewport");
  expect(APP).toContain('"--app-h"');
});

test("the breakpoints exist: medium (≤1024 px), narrow (≤768 px), touch, reduced motion, light", () => {
  for (const q of ["(max-width:1024px)", "(max-width:768px)", "(pointer:coarse),(max-width:768px)", "(prefers-reduced-motion:reduce)", "(prefers-color-scheme:light)"]) expect(media(q).length).toBeGreaterThan(0);
});

test("the drawer: a menu button that controls aside#side, a backdrop, hidden on wide screens (AC2)", () => {
  expect(SHELL).toMatch(/<button[^>]*id="menu"[^>]*aria-controls="side"[^>]*aria-expanded="false"/);
  expect(SHELL).toContain('<aside id="side"');
  expect(SHELL).toMatch(/class="scrim"/);
  // The menu button is the first thing in the top bar.
  expect(SHELL).toMatch(/<div class="top">\s*<button[^>]*id="menu"/);
  expect(CSS).toMatch(/#menu\{[^}]*display:none/);
  const md = media("(max-width:1024px)");
  expect(md).toMatch(/aside\{[^}]*position:fixed/);
  expect(md).toMatch(/aside\{[^}]*transform:translateX\(var\(--drawer-x\)\)/);
  expect(md).toContain(".drawer-open aside{transform:none");
  expect(md).toMatch(/#menu\{[^}]*display:inline-flex/);
  // Inline-start in both directions: off the left edge in English, off the right edge in Arabic.
  expect(CSS).toContain("--drawer-x:-100%");
  expect(CSS).toMatch(/:root\[dir=rtl\]\{[^}]*--drawer-x:100%/);
  // The client: toggles drawer-open + aria-expanded, closes on Esc and on a wide viewport, moves focus.
  expect(APP).toContain('"drawer-open"');
  expect(APP).toContain('"aria-expanded"');
  expect(APP).toContain('"Escape"');
  expect(APP).toContain('matchMedia("(max-width:1024px)")');
  expect(APP).toMatch(/\$\("menu"\)\.focus\(\)/);
});

test("tabs: one sideways-scrolling row; the active tab is scrolled into view (AC3)", () => {
  expect(SHELL).toMatch(/<nav class="tabs"[^>]*>\s*<button class="tab on" data-v="activity"/);
  const md = media("(max-width:1024px)");
  expect(md).toMatch(/\.tabs\{[^}]*overflow-x:auto/);
  expect(md).toMatch(/\.tabs\{[^}]*scroll-snap-type:x proximity/);
  const tabFn = APP.match(/function tab\([\s\S]*?\n\}\n/)![0];
  expect(tabFn).toContain("scrollIntoView");
  expect(tabFn).toContain('inline: "nearest"');
});

test("narrow master–detail for Threads and Projects, with a back button and the browser back (AC4)", () => {
  const nw = media("(max-width:768px)");
  expect(nw).toContain("#vthreads.detail .tlist");
  expect(nw).toContain("#vprojects.detail .tlist");
  expect(nw).toMatch(/\.detail \.back\{[^}]*display:/);
  expect((SHELL.match(/class="back"/g) || []).length).toBe(2);
  expect(APP).toContain('"detail"');
  expect(APP).toContain("history.pushState");
  expect(APP).toContain('addEventListener("popstate"');
  // The rail becomes a chip strip; the list loses its fixed width.
  const md = media("(max-width:1024px)");
  expect(md).toMatch(/\.trail\{[^}]*overflow-x:auto/);
  expect(md).toContain("clamp(260px,38%,400px)");
});

test("touch targets: 44 px buttons, the kill button always visible, wrapping button rows (AC6, AC7)", () => {
  const touch = media("(pointer:coarse),(max-width:768px)");
  for (const sel of [".tab", ".chip", ".run", ".btn", ".seg button", ".compose button", ".idel", ".kbtn", "#menu", ".back", ".tp"]) expect(touch).toContain(sel);
  expect(touch).toContain("min-height:44px");
  expect(touch).toMatch(/\.kbtn\{[^}]*opacity:1/);
  expect(CSS).toMatch(/\.acts\{[^}]*flex-wrap:wrap/);
  expect(CSS).toMatch(/\.lrow\{[^}]*flex-wrap:wrap/);
  // 16 px inputs on narrow screens: no iOS zoom on focus.
  expect(media("(max-width:768px)")).toMatch(/\.compose input[^{]*\{[^}]*font-size:16px/);
});

test("light theme: its own token set, ink = the brand's light ink, on-accent text is a token (AC8)", () => {
  const light = media("(prefers-color-scheme:light)");
  expect(light.match(/--ink:(#[0-9a-f]{6})/)![1]).toBe(BRAND.inkLight);
  for (const tok of ["--panel", "--fg", "--muted", "--accent", "--border", "--accent-fill", "--on-accent"]) expect(light).toContain(`${tok}:`);
  expect(CSS).toContain("color-scheme:dark light");
  // No hardcoded colours left in rules: the on-accent text and the old one-off reds/blues are tokens.
  const rules = CSS.replace(/:root\{[^}]*\}/, "").replace(/@media \(prefers-color-scheme:light\)\{:root\{[^}]*\}\}/, "");
  for (const hex of ["#06241a", "#e5484d", "#2f4a6a", "rgba(13,18,26"]) expect(rules).not.toContain(hex);
  expect(CSS).toContain("color:var(--on-accent)");
});

test("reduced motion turns off the entry, pulse and drawer animations (AC9)", () => {
  const rm = media("(prefers-reduced-motion:reduce)");
  expect(rm).toContain("animation:none");
  expect(rm).toContain("transition:none");
  expect(APP).toContain("prefers-reduced-motion: reduce");
});

test("RTL: the stylesheet uses logical properties only — no physical left/right (AC1, AC10)", () => {
  const physical = /(?<![\w-])(left|right)\s*:|(margin|padding|border)-(left|right)\b|text-align:\s*(left|right)|float:\s*(left|right)/g;
  expect(CSS.match(physical)).toBeNull();
  // The responsive rules (and the safe-area top bar) are logical on the block axis too.
  const block = /(margin|padding|border)-(top|bottom)\b|(?<![\w-])(top|bottom)\s*:/g;
  for (const q of ["(max-width:1024px)", "(max-width:768px)", "(pointer:coarse),(max-width:768px)"]) expect(media(q).match(block), q).toBeNull();
  expect(CSS.match(/\.top\{[^}]*\}/)![0].match(block)).toBeNull();
  // Long words never push the page wide.
  expect(CSS).toMatch(/\.row\{[^}]*overflow-wrap:anywhere/);
  expect(CSS).toMatch(/\.tmsg\{[^}]*overflow-wrap:anywhere/);
});

test("the new labels are in both catalogues", () => {
  for (const k of ["menu", "close", "back", "views"]) {
    expect((en.nav as Record<string, string>)[k]).toBeTruthy();
    expect((ar.nav as Record<string, string>)[k]).toMatch(/[؀-ۿ]/);
  }
  expect(SHELL).toContain('data-i18n-aria="nav.menu"');
  expect(APP).toContain("data-i18n-aria");
});

test("narrow top bar: two rows — the tabs get their own full-width scroller; the active project stays visible", () => {
  const narrow = media("(max-width:768px)");
  expect(narrow).toMatch(/\.top\{[^}]*flex-wrap:wrap/);
  expect(narrow).toMatch(/\.tabs\{order:10;flex:0 0 calc\(100% \+ 2 \* /);
  expect(narrow).toMatch(/\.who\{display:block;flex:1;min-width:0/);
});

test("the attach button is a secondary button, not a second primary Send", () => {
  expect(CSS).toMatch(/\.compose button\.chip\{[^}]*background:var\(--panel2\)/);
});

test("drawer focus: never dropped to <body>; content behind the open drawer is inert", () => {
  const set = APP.match(/function setDrawer\([\s\S]*?\n\}\n/)![0];
  // Main is inert while the drawer is open, and released before focus returns to it.
  expect(set).toMatch(/main[^;\n]*\.inert = open/);
  // Focus inside the closing drawer moves to the menu button BEFORE the drawer turns inert.
  const focusAt = set.indexOf('$("side").contains(document.activeElement)');
  const inertAt = set.indexOf('($("side") as');
  expect(focusAt).toBeGreaterThan(-1);
  expect(focusAt).toBeLessThan(inertAt);
});

// The touch rule `.chip{display:inline-flex}` beat the browser's own `[hidden]{display:none}`, so the
// install chip showed on every phone even when installMode() said "none". `hidden` must always win.
test("the hidden attribute always hides, whatever display an author rule sets", () => {
  expect(CSS).toMatch(/(^|[}\s])\[hidden\]\{display:none\s*!important\}/);
  expect(SHELL).toMatch(/<button class="chip" id="install" hidden /);
});
