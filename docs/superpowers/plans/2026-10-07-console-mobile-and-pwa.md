# Console on phones and tablets + installable PWA — implementation plan

> For agentic workers: REQUIRED SUB-SKILL superpowers:test-driven-development per task. Steps use
> checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-10-07-console-mobile-and-pwa-design.md` (AC1–AC18, edge cases).
**ADR:** 0022. **Glossary:** `CONTEXT.md` → App shell, Installed console, Narrow layout, Detail view.
**Branch:** `feat/console-mobile-pwa` (temporary worktree `/home/neo-wt-mobile`) → merge to `dev`,
no push, restart-gated.

## Global constraints

- Extend `src/frontends/web/` (index.html, login.html, app.ts, locales) and `src/frontends/web.ts`.
  No second app, no new framework, no new dependency.
- Every user-facing string in `locales/{en,ar}/console.json` (namespaced, real Arabic); RTL via
  logical properties only (`inline-start/end`), never `left/right` in new CSS.
- No literals that belong in one place: theme colours live in `web/brand.ts` (manifest + meta tags),
  and a test pins them to the CSS tokens; breakpoints are CSS custom-media comments + one constant in
  `app.ts` read from `matchMedia`.
- Pure logic in small modules with unit tests (the `paste.ts` pattern): `web/sw.ts` (`shellRule`),
  `web/pwa.ts` (`installMode`, `isIos`).
- Public routes go above the session gate in `web.ts`; nothing personal is public.
- `bunx tsc --noEmit` + `bun test` green and both bundles build before each commit. One commit per
  task. Never restart the daemon.

## Task 1 — PWA server side (AC11–AC16)

Files: create `web/brand.ts`, `web/sw.ts`, `web/offline.html`, `web/icons/{icon-192.png,icon-512.png,
icon-maskable-512.png,apple-touch-icon.png}`; modify `web.ts`, `index.html`, `login.html`, both
catalogues. Test: `tests/console-pwa.test.ts`.

- [ ] Tests first: manifest is public, `application/manifest+json`, fields per AC11, localized by the
      `neo_lang` cookie (AR → `dir: rtl`); `/sw.js` public JS `no-cache`; `/icons/icon-192.png` is a PNG,
      `/icons/../web.ts` and unknown names 404; `/offline.html` public, localized, RTL in AR, no literal
      text; `shellRule` table (shell → `cache`, navigate → `network-then-offline`, `/`, `/app.js`,
      `/api/x`, `/stream`, `/auth/telegram`, `/upload`, POST, cross-origin → `ignore`); cache name
      carries the version; both pages link the manifest + apple-touch-icon + two `theme-color` metas;
      brand colours equal the CSS `--ink` tokens.
- [ ] Implement; icons rendered once from a simple geometric mark (the console's pulse dot on ink)
      with headless Chromium, committed as PNGs. Commit `feat(console): web app manifest, shell-only
      service worker, icons and offline page (ADR-0022)`.

## Task 2 — Registration + install prompt (AC16, AC17, AC18)

Files: create `web/pwa.ts`; modify `app.ts`, `index.html` (install chip + iOS hint container),
catalogues. Test: `tests/console-pwa-client.test.ts`.

- [ ] Tests first: `installMode` truth table; `isIos` for iPhone/iPad (incl. iPadOS desktop UA with
      touch) vs Android/desktop; app.ts registers `/sw.js` only when `isSecureContext` and
      `serviceWorker` exist; chip keys exist in EN + AR.
- [ ] Implement; commit `feat(console): register the worker and offer install`.

## Task 3 — Responsive layout, light theme, reduced motion (AC1–AC10)

Files: modify `index.html` (CSS + menu button, backdrop, back buttons), `app.ts` (drawer, detail
view, active tab into view, visual-viewport height), catalogues. Test: extend
`tests/console-page.test.ts` / new `tests/console-responsive.test.ts` (structure: media queries
present, viewport meta has `viewport-fit=cover` and `interactive-widget=resizes-content`, drawer
button has `aria-controls`/`aria-expanded`, every new string keyed in EN + AR, no `left:`/`right:` in
new rules, light token set exists, reduced-motion block exists).

- [ ] Tests first; implement; commit `feat(console): phone and tablet layout, light theme`.

## Task 4 — Visual verification

- [ ] Throwaway preview server (outside the repo's src; sample data; signs its own Telegram login
      with a test token — no auth bypass in product code). Playwright at 360 × 740, 390 × 844 (iPhone),
      412 × 915 (Android), 820 × 1180 (tablet); EN + AR; light + dark. Check AC1–AC10 by eye and by
      `scrollWidth <= clientWidth`; check the worker registers and `/stream` + `/api/*` are not served
      from cache. Fix what fails (commit `fix(console): …`).
- [ ] Screenshots → `/home/neo/.superpowers/evidence/2026-10-07-console-mobile/` (gitignored, outside
      the temporary worktree; reported).

## Task 5 — Review, docs, merge

- [ ] Code review (requesting-code-review); fix wave.
- [ ] Docs: `docs/HISTORY.md` entry, README console section (install + mobile).
- [ ] Merge to `dev` (no push), `git worktree remove /home/neo-wt-mobile`; list what is live after the
      next restart.
