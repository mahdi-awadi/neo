// ADR-0066 vector index adapter (spec "The shared Qdrant contract", AC13, AC10 adapter part): configs
// refused before any request (a non-loopback URL; a collection without `neo_` or outside the allowed list;
// a key that is not a JWT, a global JWT, a JWT for another collection), the probe and its status mapping,
// idempotent payload indexes, upserts that carry only id, vector and {project, kind, at, m}, deletes by
// ids and by tag, filtered search without payload, scroll pages, NoVectorIndex — and the key never in an
// error, a result or a log line.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { VECTORS_DEFAULTS, type VectorsCfg } from "../src/engine/history/defaults";
import { NoVectorIndex, openVectorIndex, type Point } from "../src/engine/history/vector-index";
import { startFakeQdrant, type FakeQdrant } from "./fixtures/fake-qdrant";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A JWT-shaped key; the signature holds a marker so a leak is easy to find. */
const jwt = (payload: unknown) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.MARKERsig${"x".repeat(20)}`;
const KEY = jwt({ access: [{ collection: "neo_history", access: "rw" }] });
const TAG = "BAAI/bge-m3@4:5617a9f61b02";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vec = (...xs: number[]) => Float32Array.from(xs);
const point = (n: number, over: Partial<Point> = {}): Point => ({ id: id(n), vector: vec(1, n, 0, 0), payload: { project: "eticket", kind: "todo", at: 1000 + n, m: TAG }, ...over });

let fakes: FakeQdrant[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});
function setup(over: Partial<VectorsCfg> = {}, key = KEY): { fake: FakeQdrant; cfg: VectorsCfg; env: Record<string, string> } {
  const fake = startFakeQdrant({ key, collections: { neo_history: 4, neo_other: 4 } });
  fakes.push(fake);
  return { fake, cfg: { ...VECTORS_DEFAULTS, ...over }, env: { SHARED_QDRANT_URL: fake.url, SHARED_QDRANT_API_KEY: key } };
}
const open = (cfg: VectorsCfg, env: Record<string, string | undefined>) => openVectorIndex(cfg, env, { dims: 4 });

describe("configs refused before any request", () => {
  test("a URL that is not loopback", async () => {
    const { fake, cfg } = setup();
    for (const url of ["http://10.1.2.3:6333", "https://qdrant.example.com", "http://user:pw@127.0.0.1:6333"]) {
      const v = open(cfg, { SHARED_QDRANT_URL: url, SHARED_QDRANT_API_KEY: KEY });
      expect(await v.probe(TAG)).toEqual({ state: "off", reason: "config_refused" });
      expect(await v.upsert([point(1)])).toEqual({ ok: false, reason: "config_refused" });
    }
    expect(fake.requests).toHaveLength(0);
  });

  test("a collection without neo_, or outside allowedCollections", async () => {
    const { fake, env } = setup();
    for (const cfg of [
      { ...VECTORS_DEFAULTS, collection: "history", allowedCollections: ["history"] },
      { ...VECTORS_DEFAULTS, collection: "neo_other", allowedCollections: ["neo_history"] },
      { ...VECTORS_DEFAULTS, collection: "neo_history", allowedCollections: [] },
    ]) {
      const v = open(cfg, env);
      expect(await v.probe(TAG)).toEqual({ state: "off", reason: "config_refused" });
      expect(await v.search(vec(1, 0, 0, 0), { tag: TAG }, { limit: 5 })).toEqual({ ok: false, reason: "config_refused" });
    }
    expect(fake.requests).toHaveLength(0);
  });

  test("a key that is not a JWT, a JWT with a global access, a JWT that names another collection", async () => {
    const { fake, cfg, env } = setup();
    for (const key of [
      "plain-api-key-MARKER",
      "a.b",
      `${b64({ alg: "HS256" })}.not-json.sig`,
      jwt({}),
      jwt({ access: "rw" }),
      jwt({ access: "r" }),
      jwt({ access: [{ collection: "neo_other", access: "rw" }] }),
      jwt({ access: [{ collection: "neo_history", access: "rw" }, { collection: "customers", access: "r" }] }),
      jwt({ access: [] }),
      jwt({ access: [{ access: "rw" }] }),
    ]) {
      const v = open(cfg, { ...env, SHARED_QDRANT_API_KEY: key });
      expect(await v.probe(TAG)).toEqual({ state: "off", reason: "config_refused" });
      expect(await v.deleteTag(TAG)).toEqual({ ok: false, reason: "config_refused" });
    }
    expect(fake.requests).toHaveLength(0);
  });

  test("no URL or no key gives not_configured", async () => {
    const { fake, cfg, env } = setup();
    expect(await open(cfg, { ...env, SHARED_QDRANT_URL: undefined }).probe(TAG)).toEqual({ state: "off", reason: "not_configured" });
    expect(await open(cfg, { ...env, SHARED_QDRANT_API_KEY: "" }).probe(TAG)).toEqual({ state: "off", reason: "not_configured" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("probe", () => {
  test("reads the collection info and the exact count for a tag, with the api-key header", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    expect(await v.upsert([point(1), point(2), point(3, { payload: { kind: "todo", at: 1, m: "other@4:x" } })])).toEqual({ ok: true, value: 3 });
    expect(await v.probe(TAG)).toEqual({ state: "up", count: 2 });
    const count = fake.requests.find((r) => r.path.endsWith("/points/count"))!;
    expect(count.body).toEqual({ filter: { must: [{ key: "m", match: { value: TAG } }] }, exact: true });
    expect(fake.requests.every((r) => r.apiKey === KEY)).toBe(true);
    expect(fake.requests.find((r) => r.method === "GET")!.path).toBe("/collections/neo_history");
  });

  test("a missing collection (404, or a 401/403 info while the list lacks it) gives collection_missing", async () => {
    const { fake, cfg, env } = setup({ timeoutMs: 150, queryTimeoutMs: 150 });
    const v = open(cfg, env);
    fake.collections.delete("neo_history");
    expect(await v.probe(TAG)).toEqual({ state: "off", reason: "collection_missing" });
    for (const status of [401, 403]) {
      fake.fail.set("GET info", status);
      expect(await v.probe(TAG)).toEqual({ state: "off", reason: "collection_missing" });
    }
    expect(fake.requests.some((r) => r.method === "GET" && r.path === "/collections")).toBe(true);
  });

  test("a rejected key (a bad signature, a 401/403 the list repeats, or no access to a listed collection) gives vectors_key_rejected", async () => {
    const { fake, cfg, env } = setup({ timeoutMs: 150, queryTimeoutMs: 150 });
    // A rotated key: the same claims, another signature. Qdrant answers 403 InvalidSignature to every call.
    const rotated = `${KEY.slice(0, KEY.lastIndexOf("."))}.OTHERsig${"y".repeat(20)}`;
    expect(await open(cfg, { ...env, SHARED_QDRANT_API_KEY: rotated }).probe(TAG)).toEqual({ state: "off", reason: "vectors_key_rejected" });
    const v = open(cfg, env);
    for (const status of [401, 403]) {
      fake.fail.set("GET info", status);
      fake.fail.set("GET list", status);
      expect(await v.probe(TAG)).toEqual({ state: "off", reason: "vectors_key_rejected" });
    }
    fake.fail.delete("GET list");
    fake.fail.set("GET info", 403); // the list names the collection, yet the key may not read it
    expect(await v.probe(TAG)).toEqual({ state: "off", reason: "vectors_key_rejected" });
    fake.fail.set("GET list", "hang");
    expect(await v.probe(TAG)).toEqual({ state: "down", reason: "vectors_slow" });
  });

  test("401 or 403 on other calls gives vectors_refused; a timeout vectors_slow", async () => {
    const { fake, cfg, env } = setup({ timeoutMs: 150, queryTimeoutMs: 150 });
    const v = open(cfg, env);
    fake.fail.set("POST count", 403);
    expect(await v.probe(TAG)).toEqual({ state: "off", reason: "vectors_refused" });
    fake.fail.clear();
    for (const op of ["PUT points", "POST delete", "POST query", "POST scroll", "PUT index"]) {
      fake.fail.set(op, 401);
    }
    expect(await v.upsert([point(1)])).toEqual({ ok: false, reason: "vectors_refused" });
    expect(await v.delete([id(1)])).toEqual({ ok: false, reason: "vectors_refused" });
    expect(await v.search(vec(1, 0, 0, 0), { tag: TAG }, { limit: 5 })).toEqual({ ok: false, reason: "vectors_refused" });
    expect(await v.scrollIds(TAG, undefined, 10)).toEqual({ ok: false, reason: "vectors_refused" });
    expect(await v.ensureIndexes()).toEqual({ ok: false, reason: "vectors_refused" });
    fake.fail.clear();
    fake.fail.set("GET info", "hang");
    expect(await v.probe(TAG)).toEqual({ state: "down", reason: "vectors_slow" });
    fake.fail.clear();
    fake.fail.set("POST query", "hang");
    expect(await v.search(vec(1, 0, 0, 0), { tag: TAG }, { limit: 5 })).toEqual({ ok: false, reason: "vectors_slow" });
    fake.fail.clear();
    fake.fail.set("GET info", 500);
    expect(await v.probe(TAG)).toEqual({ state: "down", reason: "vectors_down" });
  });

  test("a collection with another vector size is refused; a stopped server is down", async () => {
    const { fake, cfg, env } = setup();
    expect(await openVectorIndex(cfg, env, { dims: 1024 }).probe(TAG)).toEqual({ state: "off", reason: "config_refused" });
    fake.stop();
    expect(await open(cfg, env).probe(TAG)).toEqual({ state: "down", reason: "vectors_down" });
  });
});

describe("payload indexes", () => {
  test("ensureIndexes sends four requests; a second call sends the same and gives no error", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    expect(await v.ensureIndexes()).toEqual({ ok: true, value: undefined });
    expect(await v.ensureIndexes()).toEqual({ ok: true, value: undefined });
    const want = [
      { collection: "neo_history", field_name: "project", field_schema: "keyword" },
      { collection: "neo_history", field_name: "kind", field_schema: "keyword" },
      { collection: "neo_history", field_name: "m", field_schema: "keyword" },
      { collection: "neo_history", field_name: "at", field_schema: { type: "integer", lookup: false, range: true } },
    ];
    expect(fake.indexes).toEqual([...want, ...want]);
    expect(fake.requests.filter((r) => r.method === "PUT").every((r) => r.path === "/collections/neo_history/index?wait=true")).toBe(true);
  });
});

describe("upsert", () => {
  test("sends wait=true and only id, vector and payload {project, kind, at, m}", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    expect(await v.upsert([point(1), point(2, { payload: { kind: "note", at: 5, m: TAG } })])).toEqual({ ok: true, value: 2 });
    const req = fake.requests.find((r) => r.method === "PUT")!;
    expect(req.path).toBe("/collections/neo_history/points?wait=true");
    expect(req.body).toEqual({
      points: [
        { id: id(1), vector: [1, 1, 0, 0], payload: { project: "eticket", kind: "todo", at: 1001, m: TAG } },
        { id: id(2), vector: [1, 2, 0, 0], payload: { kind: "note", at: 5, m: TAG } },
      ],
    });
    expect(await v.upsert([])).toEqual({ ok: true, value: 0 });
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  test("an extra payload key, a long string, a wrong vector length or a bad id throws before the request", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    const bad: Point[] = [
      point(1, { payload: { kind: "todo", at: 1, m: TAG, text: "the chunk text" } as never }),
      point(1, { payload: { kind: "todo", at: 1, m: TAG, project: "p".repeat(65) } }),
      point(1, { payload: { kind: "k".repeat(65), at: 1, m: TAG } }),
      point(1, { payload: { kind: "todo", at: 1, m: "m".repeat(65) } }),
      point(1, { payload: { kind: "todo", at: 1.5, m: TAG } }),
      point(1, { payload: { kind: "todo", m: TAG } as never }),
      point(1, { vector: vec(1, 2, 3) }),
      point(1, { vector: vec(1, Number.NaN, 0, 0) }),
      point(1, { id: "not-a-uuid" }),
    ];
    for (const p of bad) await expect(v.upsert([point(2), p])).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});

describe("delete, deleteTag, search, scrollIds", () => {
  test("delete by ids; deleteTag by the filter on m", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    await v.upsert([point(1), point(2), point(3, { payload: { kind: "todo", at: 1, m: "old@4:x" } })]);
    expect(await v.delete([id(1)])).toEqual({ ok: true, value: 1 });
    expect(await v.delete([])).toEqual({ ok: true, value: 0 });
    expect(await v.deleteTag("old@4:x")).toEqual({ ok: true, value: undefined });
    expect([...fake.collections.get("neo_history")!.points.keys()]).toEqual([id(2)]);
    const del = fake.requests.filter((r) => r.path === "/collections/neo_history/points/delete?wait=true").map((r) => r.body);
    expect(del).toEqual([{ points: [id(1)] }, { filter: { must: [{ key: "m", match: { value: "old@4:x" } }] } }]);
    await expect(v.delete(["nope"])).rejects.toThrow();
  });

  test("search sends the filters (m, project, kind any, at range) and with_payload false; ids and scores come back", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    await v.upsert([point(1), point(2, { payload: { project: "waselni", kind: "todo", at: 1002, m: TAG } }), point(3, { payload: { project: "eticket", kind: "plan", at: 5000, m: TAG } })]);
    const r = await v.search(vec(1, 1, 0, 0), { tag: TAG, project: "eticket", kinds: ["todo", "plan"], since: 1000, until: 2000 }, { limit: 7, minScore: 0.1 });
    expect(r.ok && r.value.map((h) => h.id)).toEqual([id(1)]);
    expect(r.ok && r.value[0]!.score).toBeCloseTo(1, 5);
    const q = fake.requests.find((x) => x.path.endsWith("/points/query"))!;
    expect(q.body).toEqual({
      query: [1, 1, 0, 0], limit: 7, with_payload: false, with_vector: false, score_threshold: 0.1,
      filter: { must: [
        { key: "m", match: { value: TAG } }, { key: "project", match: { value: "eticket" } },
        { key: "kind", match: { any: ["todo", "plan"] } }, { key: "at", range: { gte: 1000, lte: 2000 } },
      ] },
    });
    await expect(v.search(vec(1, 2, 3), { tag: TAG }, { limit: 5 })).rejects.toThrow();
  });

  test("existing names the ids the collection holds, ids only (no payload, no vector)", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    await v.upsert([point(1), point(2)]);
    expect(await v.existing([id(1), id(3), id(2)])).toEqual({ ok: true, value: [id(1), id(2)] });
    expect(await v.existing([])).toEqual({ ok: true, value: [] });
    expect(fake.requests.filter((r) => r.method === "POST" && r.path === "/collections/neo_history/points").map((r) => r.body)).toEqual([
      { ids: [id(1), id(3), id(2)], with_payload: false, with_vector: false },
    ]);
    await expect(v.existing(["nope"])).rejects.toThrow();
    fake.fail.set("POST points", 500);
    expect(await v.existing([id(1)])).toEqual({ ok: false, reason: "vectors_down" });
  });

  test("scrollIds pages the ids of a tag", async () => {
    const { fake, cfg, env } = setup();
    const v = open(cfg, env);
    await v.upsert([1, 2, 3, 4, 5].map((n) => point(n)));
    const a = await v.scrollIds(TAG, undefined, 2);
    expect(a).toEqual({ ok: true, value: { ids: [id(1), id(2)], next: id(3) } });
    const b = await v.scrollIds(TAG, id(3), 2);
    expect(b).toEqual({ ok: true, value: { ids: [id(3), id(4)], next: id(5) } });
    const c = await v.scrollIds(TAG, id(5), 2);
    expect(c).toEqual({ ok: true, value: { ids: [id(5)] } });
    const s = fake.requests.find((x) => x.path.endsWith("/points/scroll"))!;
    expect(s.body).toEqual({ filter: { must: [{ key: "m", match: { value: TAG } }] }, limit: 2, with_payload: false, with_vector: false });
  });
});

describe("NoVectorIndex and the key", () => {
  test("NoVectorIndex answers off", async () => {
    const v = new NoVectorIndex();
    expect(await v.probe(TAG)).toEqual({ state: "off", reason: "not_configured" });
    expect(await v.upsert([point(1)])).toEqual({ ok: false, reason: "not_configured" });
    expect(await v.search(vec(1, 0, 0, 0), { tag: TAG }, { limit: 1 })).toEqual({ ok: false, reason: "not_configured" });
    expect(await new NoVectorIndex("config_refused").deleteTag(TAG)).toEqual({ ok: false, reason: "config_refused" });
  });

  test("a marker key never shows in an error, a result or a log line", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    try {
      const { fake, cfg, env } = setup({ timeoutMs: 150, queryTimeoutMs: 150 });
      const seen: unknown[] = [];
      const v = open(cfg, env);
      seen.push(await v.probe(TAG), await v.ensureIndexes(), await v.upsert([point(1)]));
      for (const op of ["GET info", "PUT points", "POST query"]) {
        for (const status of [401, 403, 500, "hang"] as const) {
          fake.fail.set(op, status);
          seen.push(await v.probe(TAG), await v.upsert([point(2)]), await v.search(vec(1, 0, 0, 0), { tag: TAG }, { limit: 1 }));
          fake.fail.clear();
        }
      }
      for (const p of [point(1, { vector: vec(1) }), point(1, { payload: { kind: "x", at: 1, m: TAG, secret: KEY } as never })]) {
        try {
          await v.upsert([p]);
        } catch (e) {
          seen.push(String(e), (e as Error).stack);
        }
      }
      const leaky = (async () => {
        throw new Error(`failed: api-key ${KEY}`);
      }) as unknown as typeof fetch;
      const l = openVectorIndex(cfg, env, { dims: 4, fetch: leaky });
      seen.push(await l.probe(TAG), await l.upsert([point(1)]), await l.deleteTag(TAG));
      for (const key of ["plain-MARKER-key", jwt({ access: "rw" })]) seen.push(await open(cfg, { ...env, SHARED_QDRANT_API_KEY: key }).probe(TAG));
      const all = JSON.stringify(seen) + logs.join("\n");
      expect(all).not.toContain("MARKER");
      expect(all).not.toContain(KEY.split(".")[1]!);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
