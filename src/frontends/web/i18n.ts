// The console's one translation setup (ADR-0017, engineering baseline): i18next over the per-locale
// catalogues in ./locales/<lang>/console.json, namespace "console". The browser bundle (app.ts) and the
// server-rendered login page both build their instance here, so there is one catalogue and one library.
import i18next, { type i18n } from "i18next";
import en from "./locales/en/console.json";
import ar from "./locales/ar/console.json";
import type { Lang } from "./langs";

export { LANGS, isLang, type Lang } from "./langs";

/** The catalogues, keyed by language then namespace (i18next's resource shape). */
export const RESOURCES = { en: { console: en }, ar: { console: ar } } as const;

/** A ready instance for one language (synchronous: the catalogues are bundled, nothing is fetched).
 *  Interpolated values are HTML-escaped by default — `t()` output goes into markup. */
export function createConsoleI18n(lang: Lang): i18n {
  const inst = i18next.createInstance();
  void inst.init({ lng: lang, fallbackLng: "en", ns: ["console"], defaultNS: "console", resources: RESOURCES, initAsync: false, returnNull: false });
  return inst;
}
