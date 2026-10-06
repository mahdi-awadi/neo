# The console loads its bundle by content version

**Status:** accepted (2026-10-06) · extends ADR-0017 (the bundled console) and ADR-0022 (the PWA)

The console page is `no-store`, but its bundle `/app.js` was served with plain `no-cache`. Cloudflare,
in front of the console, rewrites `no-cache` to `max-age=14400` (the zone's Browser Cache TTL). After a
daemon restart, a phone got the new page shell and kept the four-hour-old bundle: the old catalogue
had no `pwa.*` keys (the install chip showed the raw key `pwa.install`) and the old code never wired
the new menu button (the drawer did not open).

The page now asks for **`/app.js?v=<bundle version>`**: the first 16 hex characters of the SHA-256 of
the built bundle. A changed bundle is a new URL, so no browser or CDN copy of the old bundle can answer
it. That URL is served `private, max-age=31536000, immutable`; any other `/app.js` URL (no version, an
old version) gets the current bundle with `private, no-cache`. `private` keeps a shared cache from
storing a bundle that sits behind the session.

## Considered options

- **Stronger `no-store` headers on `/app.js`.** Rejected: it fights the CDN instead of removing the
  failure mode, and a zone setting can still override it. A versioned URL is correct under any cache.
- **A Cloudflare rule or "respect existing headers" only.** Not enough alone: it is an external
  setting outside the repo that can drift. It is still worth setting (operator's call).
- **A version from the git commit or the daemon start time.** Rejected: it changes when the bundle
  does not (needless reloads) and needs git at runtime. The content hash changes exactly when the
  bundle does.
- **A hashed file name (`/app.<hash>.js`).** Equivalent; the query string keeps the one `/app.js`
  route and the service worker's `/app.js` exclusion unchanged.

## Consequences

- An open tab keeps its bundle until it reloads the page; the next page load always gets the new one.
- The service worker still never touches `/app.js` (its rule matches the path, not the query).
