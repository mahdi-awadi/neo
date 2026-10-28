# ADR-0056: Neo's logo is "Core", and the console shows the running build under it

Status: **accepted** (2026-10-28, operator order). Related: ADR-0022 (console PWA, brand values),
ADR-0054 (the running build and the deploy gap).

## Decision

- **Logo.** Concept 3 "Core" from `agent/desks/dev/neo-logos.html` is Neo's logo. It is a lowercase
  "neo" wordmark with an orange engine dot in the o. The SVG paths are copied as they are, not
  redrawn. The main colour is `currentColor`, so the inline header logo follows the console theme
  (light ink on dark, dark ink on light). The accent is the logo's own orange (`BRAND.logoAccent`),
  separate from the console's green UI accent.
- **Favicon and app icons.** These use the "o" mark alone. `favicon.svg` switches its ink with
  `prefers-color-scheme`. The PNG icons (192, 512, maskable 512, Apple 180) are rendered from the same
  SVG on the logo's dark tile. The service worker cache name is bumped, so an installed PWA picks
  up the new shell by itself.
- **Build label.** Under the logo: `v<package version> · <short boot commit>`, 10px, muted, LTR.
  It comes from the boot record (`bootFacts` → `runningBuild`) plus the `package.json` version read
  at the same moment. It goes to the console in the state snapshot, beside `deploy`. It is the
  running build, never `dev`.

## Rejected

- **Reading git or `package.json` on each request.** It would show what is on disk, which after a
  `git checkout` or pull is not what runs. That is the exact confusion ADR-0054 removed.
- **A second version source (a build-time constant or an env var).** The boot record already exists
  and is what `/list` and the deploy chip use.
- **Recolouring the logo to the console's green accent.** The operator chose the orange.

## Amendment (2026-10-28): the animated splash and seamless PWA icons

- **Splash.** On load, the console shows the Core wordmark drawing in (`n`, `e`, the ring), then the
  orange engine core pops in. It takes about 1.2 s (`--splash-ms`) and uses CSS/SVG only. The overlay is
  in the HTML itself, so there is no flash of the bare page, in a browser tab or as an installed PWA.
  `splash.ts` fades it out at whichever comes later: the first state load settling, or the end of the
  intro. An inline script removes it after 6 × `--splash-ms` if the app never starts.
  `prefers-reduced-motion` shows the logo fully drawn, with no motion. The overlay is decorative
  (`aria-hidden`), with no text.
- **Seamless launch.** The PNG icons' tile is now the console's dark ink `#080b10` (`BRAND.logoTile` =
  `BRAND.inkDark`), which is also the manifest's `background_color` and `theme_color`. The native PWA
  launch screen, the icon and the console are one colour.
- **Reproducible icons.** `bun tools/brand/render-icons.ts` renders the four PNGs from `icons/favicon.svg`
  with headless Chrome (`CHROME_BIN` overrides the browser). The shell cache is `neo-shell-v3`, so
  installed PWAs pick up the new icons by themselves.

Rejected: a JavaScript animation library (the CSS is enough, and the splash must paint before any
script); keeping the splash until a fixed time (it would block a fast load); a separate splash page (it
would cost a navigation and flash).
