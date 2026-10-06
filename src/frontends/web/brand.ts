// The console's brand values in one place (ADR-0022): the web app manifest and the `theme-color` meta
// tags read them here; a test pins them to the CSS tokens in index.html / login.html.

export const BRAND = {
  /** The dark theme's page ink — the CSS `--ink` token. */
  inkDark: "#080b10",
  /** The light theme's page ink (the light token set). */
  inkLight: "#f4f7f9",
  /** The accent — the CSS `--accent` token (the pulse dot). */
  accent: "#3fe0a2",
} as const;

/** The app icons in ./icons — the only files `/icons/<name>` serves. `purpose` absent = not in the manifest. */
export const ICONS = [
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "icon-maskable-512.png", size: 512, purpose: "maskable" },
  { file: "apple-touch-icon.png", size: 180 },
] as const satisfies ReadonlyArray<{ file: string; size: number; purpose?: "any" | "maskable" }>;
