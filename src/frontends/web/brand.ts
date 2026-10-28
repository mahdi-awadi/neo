// The console's brand values in one place (ADR-0022): the web app manifest and the `theme-color` meta
// tags read them here; a test pins them to the CSS tokens in index.html / login.html.

export const BRAND = {
  /** The dark theme's page ink — the CSS `--ink` token. */
  inkDark: "#080b10",
  /** The light theme's page ink (the light token set). */
  inkLight: "#f4f7f9",
  /** The accent — the CSS `--accent` token (buttons, focus, live state). */
  accent: "#3fe0a2",
  /** The logo's own accent (ADR-0056): the engine dot in the o of "Core". Not a UI colour. */
  logoAccent: "#f2552c",
  /** The logo tile behind the app icons: the dark panel of the logo source. */
  logoTile: "#121214",
} as const;

/** The app icons in ./icons — the only files `/icons/<name>` serves. `purpose` absent = not in the manifest.
 *  All are the "o" mark of the Core logo (ADR-0056); the PNGs are rendered from `favicon.svg`. */
export const ICONS = [
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "icon-maskable-512.png", size: 512, purpose: "maskable" },
  { file: "apple-touch-icon.png", size: 180 },
  { file: "favicon.svg", size: 64 },
] as const satisfies ReadonlyArray<{ file: string; size: number; purpose?: "any" | "maskable" }>;

/** The content type of an icon file, by its extension (only the two kinds ICONS holds). */
export function iconType(file: string): "image/svg+xml" | "image/png" {
  return file.endsWith(".svg") ? "image/svg+xml" : "image/png";
}
