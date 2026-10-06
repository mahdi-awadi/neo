# Console on phones and tablets, installable as a PWA — design

**Status:** proposed (2026-10-07) · **ADR:** 0022 · **Glossary:** `CONTEXT.md` → "The operator web
console" (App shell, Installed console, Narrow layout, Detail view)

## 1. What the operator asked for

The existing web console (`src/frontends/web/`, ADR-0017) must work well on a phone (360–430 px) and a
tablet, and must be installable from the browser as an app. Extend the current console. No second
app, no APK, no separate mobile version.

Verified start: `index.html` has a viewport meta tag, but no `@media` rules, no manifest and no
service worker. The console is dark only.

## 2. Decisions (details and rejected options in ADR-0022)

1. **One console, three widths.** The same `index.html` + `app.ts`. CSS breakpoints change the
   layout: **wide** (> 1024 px, today's layout), **medium** (≤ 1024 px: the sidebar becomes a drawer),
   **narrow** (≤ 768 px: list and detail panes stack).
2. **Light and dark.** The CSS tokens get a light set under `prefers-color-scheme: light`. Dark stays
   the default look. No manual toggle (the system setting decides).
3. **PWA = manifest + a small service worker that caches only the app shell.** The app shell is the
   public, static, non-personal files: the manifest, the icons and a localized offline page. Never
   cached and never intercepted: `/` (it is the login page OR the console, by session),
   `/app.js` (behind the session), `/api/*`, `/stream` (SSE), `/auth/*`, `/upload`, anything not GET,
   anything cross-origin.
4. **Install prompt** inside the console: an "Install app" chip in the top bar when the browser offers
   `beforeinstallprompt`; on iOS Safari (no such event) the chip shows the "Share → Add to Home
   Screen" hint. Hidden when already installed (display-mode standalone) or dismissed.

## 3. Acceptance criteria

### Layout
- AC1 No horizontal page scroll at 360, 390, 412 and 430 px wide, in EN (LTR) and AR (RTL). Only
  intended inner scrollers scroll sideways: the tab strip, code blocks and markdown tables.
- AC2 Medium and narrow: a menu button in the top bar opens the sidebar as a drawer (from the
  inline-start edge, so from the right in Arabic) with a backdrop. The backdrop, Esc, the button
  again, opening a project, or "Open project" closes it. `aria-expanded` follows the state.
- AC3 The tabs stay one row; on narrow screens the row scrolls sideways and the active tab is
  scrolled into view.
- AC4 Narrow: Threads and Projects show the list full width. Opening a thread or a project shows its
  pane full width with a back button that returns to the list. The Threads project rail becomes a
  horizontal strip above the list.
- AC5 The composer (Activity and the thread reply) stays at the bottom, above the on-screen keyboard
  and the home indicator: the app height follows the visual viewport, and the bottom padding adds
  `env(safe-area-inset-bottom)`. Inputs use 16 px text on narrow screens (no iOS zoom on focus).
- AC6 On a coarse pointer or a narrow screen every button is at least 44 × 44 px: tabs, chips (the
  approval Allow/Deny, plan Approve/Changes/Execute, attention → todo/snooze/dismiss/remove), the
  SDK switch, Run/Send, the kill button (always visible, no hover on touch).
- AC7 Every tab works narrow: Activity, Threads, Projects, Queue, Loops, Usage, Recent, Inbox —
  rows wrap instead of overflowing; `/plans` and `/attention` results in the feed fit.
- AC8 Light theme under `prefers-color-scheme: light` with readable contrast (body text ≥ 4.5:1);
  `theme-color` meta tags for both schemes.
- AC9 `prefers-reduced-motion: reduce` turns off the entry and pulse animations and the drawer slide.
- AC10 Numbers, refs, shas, paths and phone numbers stay one LTR run attached to their label (the
  existing `ltr()`/`iso()` helpers), also in narrow RTL.

### PWA
- AC11 `GET /manifest.webmanifest` (public, `application/manifest+json`): `name`, `short_name`,
  `description`, `lang`, `dir` (from the operator's language cookie, else `consoleLang`), `start_url`
  `/`, `scope` `/`, `display` `standalone`, `background_color`, `theme_color`, icons 192 and 512 (PNG)
  plus a 512 maskable icon. Strings come from the catalogues.
- AC12 `GET /sw.js` (public, JavaScript, `cache-control: no-cache`) is built by `Bun.build` from
  `web/sw.ts`, like `/app.js`.
- AC13 `GET /icons/<name>` serves only the listed icon files (no path traversal); `GET /offline.html`
  is public and localized (EN/AR, RTL for AR).
- AC14 The cache rule is a pure function, tested: shell URLs → cache; navigations → network, offline
  page only when the network fails; everything else (incl. `/`, `/app.js`, `/api/*`, `/stream`,
  `/auth/*`, `/upload`, POST, other origins) → not handled by the worker at all.
- AC15 The worker's cache name carries a version; activation deletes older Neo caches.
- AC16 Both pages link the manifest, the Apple touch icon and the theme colours; the console
  registers `/sw.js` (only in a secure context). Login, the session cookie and the SSE feed work
  unchanged with the worker active.
- AC17 The install chip follows the pure rule `installMode({ standalone, prompt, ios, dismissed })` →
  `none | prompt | ios-hint`; dismissal is remembered on the device.
- AC18 Every new user-facing string is in `locales/en/console.json` and `locales/ar/console.json`.

## 4. Edge cases

- A logged-out operator opens the installed app: `/` is never cached, so they get the live login
  page; the Telegram widget's redirect (`/auth/telegram` → `/`) stays inside the app's scope.
- Offline: navigation fails → the offline page (retry button). The console itself never runs from
  cache; it needs the API and SSE.
- A new daemon build: `/app.js` is not cached by the worker, so a restart is picked up on reload as
  today. A changed shell bumps the cache version.
- The language changes: the manifest and offline page are re-fetched (`no-cache`), so the next
  install or offline view uses the new language.
- iOS: no `beforeinstallprompt`; the hint is shown instead, once per device until dismissed.
- Browsers without service workers or outside a secure context: no registration, nothing breaks.

## 5. Out of scope

Push notifications, background sync, offline use of the console, a manual theme switch.

## 6. Verification

`bunx tsc --noEmit`, `bun test`, the bundle builds (`app.js` and `sw.js`). Playwright on a throwaway
local server with sample data: iPhone (390 × 844) and Android (412 × 915) sizes, plus a 360 px phone
and a tablet (820 × 1180); EN + AR; light + dark. Screenshots saved under
`docs/superpowers/evidence/2026-10-07-console-mobile/` (not committed; path reported).
