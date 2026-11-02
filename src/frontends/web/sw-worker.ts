// The service worker's handlers (ADR-0022), attached to a worker scope. ./sw.ts is the thin classic-script
// entry that attaches them to `self`; tests attach them to a fake scope. The decision rule is the pure
// shellRule() in ./sw-rules.ts. An "ignore" request never reaches respondWith, so the browser handles it
// as if no worker existed (the SSE feed, the API, login).
import { CACHE, CACHE_PREFIX, OFFLINE_URL, SHELL, shellRule } from "./sw-rules";

// The worker-scope slice used here (the project's TS program carries the DOM lib, not WebWorker).
interface ExtendableEvt {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvt extends ExtendableEvt {
  request: Request;
  respondWith(r: Promise<Response>): void;
}
export interface WorkerScope {
  location: { origin: string; href: string };
  clients: { claim(): Promise<void> };
  caches: CacheStorage;
  fetch(req: Request): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvt) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvt) => void): void;
}

export function attachWorker(sw: WorkerScope): void {
  const caches = sw.caches;

  sw.addEventListener("install", (e) => {
    // `cache: "reload"` skips the HTTP cache, so a new worker never precaches a stale shell; credentials
    // like the page's own manifest link, so the server sees the language cookie.
    const shell = SHELL.map((u) => new Request(new URL(u, sw.location.href), { cache: "reload", credentials: "include" }));
    e.waitUntil(
      caches
        .open(CACHE)
        .then((c) => c.addAll(shell))
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

  /** Cache-first, refreshed in the background (the next load sees a changed manifest). */
  async function fromShell(e: FetchEvt): Promise<Response> {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    const refresh = sw
      .fetch(e.request)
      .then((res) => (res.ok ? cache.put(e.request, res.clone()).then(() => res) : res))
      .catch(() => undefined);
    if (hit) {
      e.waitUntil(refresh);
      return hit;
    }
    return (await refresh) ?? Response.error();
  }

  /** The network; when it fails, the cached offline page (it picks its language on the client). Never stored. */
  async function networkThenOffline(req: Request): Promise<Response> {
    try {
      return await sw.fetch(req);
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
}
