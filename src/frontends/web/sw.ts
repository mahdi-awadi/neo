// The console's service worker (ADR-0022): bundled by Bun.build and served as /sw.js (scope /). It
// precaches the app shell and applies the pure rule in ./sw-rules.ts. An "ignore" request never reaches
// respondWith, so the browser handles it as if no worker existed (the SSE feed, the API, login).
// No exports: a worker registered without {type:"module"} is a classic script.
import { CACHE, CACHE_PREFIX, OFFLINE_URL, SHELL, shellRule } from "./sw-rules";

// The worker-scope slice used here (the project's TS program carries the DOM lib, not WebWorker).
interface ExtendableEvt extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvt extends ExtendableEvt {
  request: Request;
  respondWith(r: Promise<Response>): void;
}
interface WorkerScope {
  location: Location;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvt) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvt) => void): void;
}
const sw = self as unknown as WorkerScope;

sw.addEventListener("install", (e) => {
  // `cache: "reload"` skips the HTTP cache, so a new worker never precaches a stale shell.
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => sw.clients.claim()),
  );
});

/** Cache-first, refreshed in the background (the next load sees a changed manifest/offline page). */
async function fromShell(e: FetchEvt): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(e.request);
  const refresh = fetch(e.request)
    .then((res) => (res.ok ? cache.put(e.request, res.clone()).then(() => res) : res))
    .catch(() => undefined);
  if (hit) {
    e.waitUntil(refresh);
    return hit;
  }
  return (await refresh) ?? Response.error();
}

/** The network; when it fails, the cached offline page. Never stored. */
async function networkThenOffline(req: Request): Promise<Response> {
  try {
    return await fetch(req);
  } catch {
    return (await caches.match(OFFLINE_URL)) ?? Response.error();
  }
}

sw.addEventListener("fetch", (e) => {
  const rule = shellRule(e.request, sw.location.origin);
  if (rule === "cache") e.respondWith(fromShell(e));
  else if (rule === "network-then-offline") e.respondWith(networkThenOffline(e.request));
  // "ignore": no respondWith — the browser fetches it itself.
});
