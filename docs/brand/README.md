# Neo brand assets (ADR-0056)

The logo is concept 3 "Core" from `agent/desks/dev/neo-logos.html`: a lowercase "neo" wordmark with
an orange engine dot in the o. The paths are copied from that file as they are; never redraw them.

| File | What |
|---|---|
| `neo-logo-light.svg` | The wordmark for a light background (ink `#18181b`). |
| `neo-logo-dark.svg` | The wordmark for a dark background (ink `#f1f1ef`). |
| `neo-mark.svg` | The o mark alone (the same file as the console's `/icons/favicon.svg`). |

Colours: the ink follows the background. The accent is `#f2552c` (`BRAND.logoAccent` in
`src/frontends/web/brand.ts`). It is the logo's own colour, not the console's green UI accent.

In the console (`src/frontends/web/`):
- The header and login logo is inline SVG with `currentColor` ink, so it follows the theme.
- `icons/favicon.svg` switches its ink with `prefers-color-scheme`.
- The PNG app icons (`icon-192`, `icon-512`, `icon-maskable-512`, `apple-touch-icon`) are the o mark
  on the dark tile `#121214` (`BRAND.logoTile`). They were rendered with headless Chrome from an HTML
  page that holds the mark at 62% of the tile (46% for the maskable icon, inside the safe zone):
  `chrome --headless=new --no-sandbox --hide-scrollbars --window-size=N,N --screenshot=out.png page.html`.
- After an icon changes, bump `CACHE` in `sw-rules.ts`, so installed PWAs drop the old shell.
