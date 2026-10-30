// A fake Qdrant REST server for the task history tests (ADR-0067): `Bun.serve` on 127.0.0.1, port 0. It
// keeps points in memory per collection, evaluates the filters Neo sends (`match.value`, `match.any`,
// `range`), answers count, upsert, delete (ids or filter), query (cosine), scroll and payload-index
// requests and the collection list, checks the `api-key` header (a wrong key answers 403 with Qdrant's JWT
// error, a missing collection 404, as Qdrant does for a key scoped to it), and records every request. A
// path can be told to answer a status or to hang.

export interface FakePoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface FakeQdrant {
  readonly url: string;
  readonly port: number;
  /** The collections that exist, with their vector size. */
  collections: Map<string, { size: number; points: Map<string, FakePoint> }>;
  /** `<METHOD> <path suffix>` (e.g. `GET info`, `GET list`, `POST count`, `PUT points`) → a status, or `hang`. */
  fail: Map<string, number | "hang">;
  requests: Array<{ method: string; path: string; apiKey: string | null; body?: unknown }>;
  indexes: Array<{ collection: string; field_name: string; field_schema: unknown }>;
  stop(): void;
}

type Cond = { key: string; match?: { value?: unknown; any?: unknown[] }; range?: { gte?: number; lte?: number } };

function matches(p: FakePoint, filter: { must?: Cond[] } | undefined): boolean {
  for (const c of filter?.must ?? []) {
    const v = p.payload[c.key];
    if (c.match && "value" in c.match && v !== c.match.value) return false;
    if (c.match?.any && !c.match.any.includes(v)) return false;
    if (c.range) {
      if (typeof v !== "number") return false;
      if (c.range.gte !== undefined && v < c.range.gte) return false;
      if (c.range.lte !== undefined && v > c.range.lte) return false;
    }
  }
  return true;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) (dot += a[i]! * b[i]!, na += a[i]! ** 2, nb += b[i]! ** 2);
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function startFakeQdrant(opts: { key: string; collections?: Record<string, number> }): FakeQdrant {
  const hangs: Array<() => void> = [];
  const fake: FakeQdrant = {
    url: "",
    port: 0,
    collections: new Map(Object.entries(opts.collections ?? { neo_history: 4 }).map(([n, size]) => [n, { size, points: new Map() }])),
    fail: new Map(),
    requests: [],
    indexes: [],
    stop() {
      for (const h of hangs.splice(0)) h();
      server.stop(true);
    },
  };
  const ok = (result: unknown) => Response.json({ status: "ok", time: 0, result });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      fake.requests.push({ method: req.method, path: url.pathname + url.search, apiKey: req.headers.get("api-key"), ...(body !== undefined ? { body } : {}) });
      if (req.headers.get("api-key") !== opts.key) return Response.json({ status: { error: "Forbidden: Invalid JWT: InvalidSignature" }, time: 0 }, { status: 403 });
      if (url.pathname === "/collections" && req.method === "GET") {
        const forced = fake.fail.get("GET list");
        if (forced === "hang") return new Promise<Response>((done) => hangs.push(() => done(new Response("gone", { status: 503 }))));
        if (forced !== undefined) return new Response("forced", { status: forced });
        return ok({ collections: [...fake.collections.keys()].map((name) => ({ name })) });
      }
      const m = /^\/collections\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const name = decodeURIComponent(m[1]!);
      const rest = m[2] ?? "";
      const op = rest === "" ? "info" : rest === "points" ? "points" : rest.replace(/^points\//, "");
      const forced = fake.fail.get(`${req.method} ${op}`);
      if (forced === "hang") return new Promise<Response>((done) => hangs.push(() => done(new Response("gone", { status: 503 }))));
      if (forced !== undefined) return new Response("forced", { status: forced });
      const col = fake.collections.get(name);
      if (!col) return Response.json({ status: { error: `Not found: Collection \`${name}\` doesn't exist!` }, time: 0 }, { status: 404 });
      const b = (body ?? {}) as Record<string, unknown>;
      if (op === "info" && req.method === "GET") {
        return ok({ status: "green", points_count: col.points.size, config: { params: { vectors: { size: col.size, distance: "Cosine" } } } });
      }
      if (op === "index" && req.method === "PUT") {
        fake.indexes.push({ collection: name, field_name: b.field_name as string, field_schema: b.field_schema });
        return ok({ operation_id: 1, status: "completed" });
      }
      if (op === "count" && req.method === "POST") {
        return ok({ count: [...col.points.values()].filter((p) => matches(p, b.filter as never)).length });
      }
      if (op === "points" && req.method === "PUT") {
        for (const p of (b.points as FakePoint[]) ?? []) col.points.set(p.id, p);
        return ok({ operation_id: 2, status: "completed" });
      }
      if (op === "points" && req.method === "POST") {
        return ok(((b.ids as string[]) ?? []).filter((id) => col.points.has(id)).map((id) => ({ id })));
      }
      if (op === "delete" && req.method === "POST") {
        if (Array.isArray(b.points)) for (const id of b.points as string[]) col.points.delete(id);
        else for (const p of [...col.points.values()]) if (matches(p, b.filter as never)) col.points.delete(p.id);
        return ok({ operation_id: 3, status: "completed" });
      }
      if (op === "query" && req.method === "POST") {
        const q = b.query as number[];
        const hits = [...col.points.values()]
          .filter((p) => matches(p, b.filter as never))
          .map((p) => ({ id: p.id, version: 1, score: cosine(q, p.vector) }))
          .filter((h) => typeof b.score_threshold !== "number" || h.score >= b.score_threshold)
          .sort((x, y) => y.score - x.score)
          .slice(0, Number(b.limit ?? 10));
        return ok({ points: hits });
      }
      if (op === "scroll" && req.method === "POST") {
        const all = [...col.points.values()].filter((p) => matches(p, b.filter as never)).map((p) => p.id).sort();
        const from = typeof b.offset === "string" ? all.indexOf(b.offset) : 0;
        const limit = Number(b.limit ?? 10);
        const page = all.slice(Math.max(0, from), Math.max(0, from) + limit);
        const next = all[Math.max(0, from) + limit];
        return ok({ points: page.map((id) => ({ id })), next_page_offset: next ?? null });
      }
      return new Response("not found", { status: 404 });
    },
  });
  Object.assign(fake, { port: server.port, url: `http://127.0.0.1:${server.port}` });
  return fake;
}
