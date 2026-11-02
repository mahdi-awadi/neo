// The service worker's behaviour (ADR-0022, AC14/AC15), run against a fake worker scope: fake caches,
// a fake network and recorded events — no browser needed.
import { test, expect } from "bun:test";
import { attachWorker, type WorkerScope } from "../src/frontends/web/sw-worker";
import { CACHE, OFFLINE_URL, SHELL } from "../src/frontends/web/sw-rules";

const ORIGIN = "http://neo.test";
type Net = (req: Request) => Promise<Response>;

function fakeScope(net: Net, existing: string[] = []) {
  const store = new Map<string, Map<string, Response>>(existing.map((n) => [n, new Map()]));
  const key = (r: Request | string) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  const fetched: Request[] = [];
  const precached: Request[] = [];
  let claimed = false;
  const cacheFor = (n: string) => {
    if (!store.has(n)) store.set(n, new Map());
    const c = store.get(n)!;
    return {
      addAll: async (reqs: Request[]) => {
        for (const r of reqs) {
          precached.push(r);
          c.set(key(r), await net(r));
        }
      },
      match: async (r: Request | string) => c.get(key(r))?.clone(),
      put: async (r: Request | string, res: Response) => void c.set(key(r), res),
    };
  };
  const listeners: Record<string, (e: unknown) => void> = {};
  const scope = {
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    clients: { claim: async () => void (claimed = true) },
    skipWaiting: async () => {},
    addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn),
    fetch: (req: Request) => {
      fetched.push(req);
      return net(req);
    },
    caches: {
      open: async (n: string) => cacheFor(n),
      keys: async () => [...store.keys()],
      delete: async (n: string) => store.delete(n),
      match: async (r: Request | string) => {
        for (const c of store.values()) {
          const hit = c.get(key(r));
          if (hit) return hit.clone();
        }
        return undefined;
      },
    },
  };
  attachWorker(scope as unknown as WorkerScope);
  /** Fire an event; collect what it waited on and what it answered (undefined = not handled). */
  async function fire(type: string, request?: Request) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners[type]!({ request, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (responded = p) });
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return { response, handled: responded !== undefined };
  }
  return { store, fetched, precached, fire, claimed: () => claimed };
}

const ok = (body: string) => async () => new Response(body, { status: 200 });
const down: Net = async () => {
  throw new TypeError("network down");
};
const req = (path: string, init: RequestInit = {}) => new Request(ORIGIN + path, init);

test("install precaches the whole shell, fresh (cache: reload) and with credentials (the language cookie)", async () => {
  const w = fakeScope(async (r) => new Response(new URL(r.url).pathname));
  await w.fire("install");
  expect([...w.store.get(CACHE)!.keys()].map((u) => new URL(u).pathname).sort()).toEqual([...SHELL].sort());
  for (const r of w.precached) {
    expect(r.cache).toBe("reload");
    expect(r.credentials).toBe("include");
  }
});

test("activate deletes the older neo-shell-* caches, keeps the current and foreign ones, and claims the pages", async () => {
  const w = fakeScope(ok("x"), ["neo-shell-v0", CACHE, "someone-else"]);
  await w.fire("activate");
  expect([...w.store.keys()].sort()).toEqual([CACHE, "someone-else"].sort());
  expect(w.claimed()).toBe(true);
});

test("ignored requests never reach respondWith: SSE, API, /, the bundle, POST, other origins", async () => {
  const w = fakeScope(ok("net"));
  for (const r of [req("/stream"), req("/api/state?_=1"), req("/"), req("/app.js"), req("/auth/telegram?id=1"), req("/msg", { method: "POST", body: "{}" }), new Request("https://fonts.googleapis.com/css2")]) {
    const { handled } = await w.fire("fetch", r);
    expect(handled, r.url).toBe(false);
  }
  expect(w.fetched).toHaveLength(0);
});

test("a navigation answers the network response; when the network fails, the cached offline page", async () => {
  let online = true;
  const w = fakeScope(async (r) => {
    if (!online) throw new TypeError("offline");
    return new Response(new URL(r.url).pathname === OFFLINE_URL ? "offline page" : "live page");
  });
  await w.fire("install");
  const nav = () => req("/", { mode: "navigate" });
  const live = await w.fire("fetch", nav());
  expect(await live.response!.text()).toBe("live page");
  expect(w.store.get(CACHE)!.has(`${ORIGIN}/`)).toBe(false); // a page is never stored
  online = false;
  const off = await w.fire("fetch", nav());
  expect(await off.response!.text()).toBe("offline page");
});

test("a shell file is served from the cache and refreshed in the background", async () => {
  let version = "v1";
  const w = fakeScope(async () => new Response(version));
  await w.fire("install");
  version = "v2";
  const first = await w.fire("fetch", req("/manifest.webmanifest"));
  expect(await first.response!.text()).toBe("v1");
  const second = await w.fire("fetch", req("/manifest.webmanifest"));
  expect(await second.response!.text()).toBe("v2");
  const cold = fakeScope(down);
  expect((await cold.fire("fetch", req("/manifest.webmanifest"))).response!.type).toBe("error");
});
