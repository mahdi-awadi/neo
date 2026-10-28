// The service worker's decision rule (ADR-0022, spec AC14/AC15) — pure, so it is unit-tested. The
// worker entry (./sw.ts) applies it. Only the public, static app shell is cached. `/` (login page OR
// console, by session) is never cached: as a page load it goes to the network, and only a failed load
// gets the offline page; as any other request it is not touched. `/app.js`, `/api/*`, `/stream`,
// `/auth/*`, `/upload`, `/file`, anything not GET and anything cross-origin are never touched.
import { ICONS } from "./brand";

export const CACHE_PREFIX = "neo-shell-";
/** Bump the version when the shell changes: activation then deletes the older `neo-shell-*` caches. */
export const CACHE = "neo-shell-v3"; // v3: icons on the console ink, the splash (ADR-0056)

export const OFFLINE_URL = "/offline.html";
/** The app shell: public, static, not personal. */
export const SHELL: readonly string[] = ["/manifest.webmanifest", OFFLINE_URL, ...ICONS.map((i) => `/icons/${i.file}`)];

/** Paths the worker never handles, even as a navigation (the login redirect, downloads, the API, the bundles). */
const NEVER = [/^\/api\//, /^\/auth\//, /^\/stream$/, /^\/upload$/, /^\/file$/, /^\/app\.js$/, /^\/sw\.js$/];

export type ShellRule = "cache" | "network-then-offline" | "ignore";

export function shellRule(req: { url: string; method: string; mode?: string }, origin: string): ShellRule {
  if (req.method !== "GET") return "ignore";
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "ignore";
  }
  if (url.origin !== origin) return "ignore";
  if (NEVER.some((re) => re.test(url.pathname))) return "ignore";
  if (!url.search && SHELL.includes(url.pathname)) return "cache";
  // A page load goes to the network (never cached); only a failed one gets the offline page.
  if (req.mode === "navigate") return "network-then-offline";
  return "ignore";
}
