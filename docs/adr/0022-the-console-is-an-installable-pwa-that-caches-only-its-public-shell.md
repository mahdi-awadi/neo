# The console is an installable PWA that caches only its public shell

**Status:** proposed (2026-10-07) · extends ADR-0017 (the bundled console)

The operator wants the web console on a phone, installable as an app. We keep one console: the same
page and bundle, made responsive with CSS breakpoints, plus a web app manifest and a small service
worker. The worker caches only the **app shell** — the public, static, non-personal files: the
manifest, the icons and a localized offline page. It never caches or intercepts `/` (it serves the
login page or the console depending on the session), `/app.js` (behind the session), `/api/*`, the SSE
`/stream`, `/auth/*` or `/upload`. A navigation that fails offline shows the offline page.

The decision rule is a pure function in `web/sw.ts`, unit-tested; the worker is built by `Bun.build`
like `/app.js` and served from `/sw.js` (scope `/`).

## Considered options

- **A separate mobile app or APK.** Rejected: a second implementation of the same console (engineering
  baseline rule 5), a second release path, and no gain — the console is a live view over the API.
- **Cache `/` and `/app.js` for an offline-first console.** Rejected: `/` is auth-dependent (a cached
  login page with an old bot name already broke Telegram login once; that is why `/` is `no-store`),
  a cached console shell would show to a logged-out device, and the console is useless without the
  API and SSE anyway.
- **Workbox.** Rejected for now: a build plugin and a dependency for four cached files and one
  fallback rule. The plain Cache API in ~60 lines is the standard primitive Workbox wraps. Revisit if
  offline features (sync, push) are added.
- **A manual light/dark switch.** Not now: `prefers-color-scheme` covers both; a switch can be added
  later as a cookie like the language switch.

## Consequences

- The console needs a restart to serve the new routes (restart-gated like every web change).
- Installed and browser tabs share the session cookie; nothing about auth changes.
- Push notifications and background sync stay out of scope (they would need the operator's yes and
  a new ADR).
