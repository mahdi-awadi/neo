// The console's languages — dependency-free, so config can validate `consoleLang` without i18next.
export const LANGS = ["en", "ar"] as const;
export type Lang = (typeof LANGS)[number];

export function isLang(s: unknown): s is Lang {
  return typeof s === "string" && (LANGS as readonly string[]).includes(s);
}
