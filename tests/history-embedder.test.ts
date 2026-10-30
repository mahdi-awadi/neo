// ADR-0066 embedder adapter (spec "The embedder contract", AC9 embedder states, AC20 adapter part): only a
// loopback URL, the bearer key from the environment, `/info` model and revision checked before any vector
// is kept, the dims check, 401/403 refused, a timeout slow, 413 split, 429/503 back off, connection refused
// down and up again after a restart, a query cache — and the key never in a result.
import { afterEach, describe, expect, test } from "bun:test";
import { EMBEDDER_DEFAULTS, type EmbedderCfg } from "../src/engine/history/defaults";
import { modelTag, openEmbedder } from "../src/engine/history/embedder";
import { isLoopbackUrl } from "../src/engine/history/services";
import { startFakeTei, type FakeTei } from "./fixtures/fake-tei";

const KEY = "MARKER-embedder-key-7f3c9a";
const REV = "5617a9f61b028005a4858fdac845db406aefb181";
const env = { HISTORY_EMBEDDER_KEY: KEY };
let fakes: FakeTei[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function setup(over: Partial<EmbedderCfg> = {}, dims = 4): { fake: FakeTei; cfg: EmbedderCfg } {
  const fake = startFakeTei({ key: KEY, revision: REV, dims });
  fakes.push(fake);
  return { fake, cfg: { ...EMBEDDER_DEFAULTS, url: fake.url, revision: REV, dims, ...over } };
}
const embedCalls = (f: FakeTei) => f.requests.filter((r) => r.path === "/embed");

describe("the loopback rule", () => {
  test("127.0.0.1, ::1 and localhost pass; other hosts, credentials in the URL and other schemes do not", () => {
    for (const u of ["http://127.0.0.1:8088", "http://[::1]:8088", "http://localhost:8088", "https://localhost"]) expect(isLoopbackUrl(u)).toBe(true);
    for (const u of ["http://10.0.0.5:8088", "http://example.com", "http://127.0.0.1.evil.com", "http://user:pw@127.0.0.1:8088", "ftp://127.0.0.1", "not a url", "http://127.0.0.2", ""]) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });

  test("another host gives config_refused before any request", async () => {
    let calls = 0;
    const spy = (async () => (calls++, new Response("{}"))) as unknown as typeof fetch;
    for (const url of ["http://10.0.0.5:8088", "http://example.com", "http://user:pw@127.0.0.1:8088"]) {
      const e = openEmbedder({ ...EMBEDDER_DEFAULTS, url, revision: REV }, env, { fetch: spy });
      expect(await e.probe()).toEqual({ state: "off", reason: "config_refused" });
      expect(await e.embed(["some text"])).toMatchObject({ ok: false, reason: "config_refused" });
    }
    expect(calls).toBe(0);
  });
});

describe("configuration", () => {
  test("no key in the environment gives not_configured, and no request", async () => {
    const { fake, cfg } = setup();
    const e = openEmbedder(cfg, {});
    expect(await e.probe()).toEqual({ state: "off", reason: "not_configured" });
    expect(await e.embed(["x"])).toMatchObject({ ok: false, reason: "not_configured" });
    expect(openEmbedder(cfg, { HISTORY_EMBEDDER_KEY: "  " }).tag).toBe(e.tag);
    expect(await openEmbedder(cfg, { HISTORY_EMBEDDER_KEY: "  " }).probe()).toEqual({ state: "off", reason: "not_configured" });
    expect(await openEmbedder({ ...cfg, revision: "" }, env).probe()).toEqual({ state: "off", reason: "not_configured" });
    expect(fake.requests).toEqual([]);
  });

  test("the model tag is the model, the dims and the revision prefix", () => {
    expect(modelTag("BAAI/bge-m3", 1024, REV)).toBe("BAAI/bge-m3@1024:5617a9f61b02");
    expect(openEmbedder({ ...EMBEDDER_DEFAULTS, revision: REV }, env).tag).toBe("BAAI/bge-m3@1024:5617a9f61b02");
  });
});

describe("/info", () => {
  test("the right model and revision give up; each request carries the bearer key", async () => {
    const { fake, cfg } = setup();
    expect(await openEmbedder(cfg, env).probe()).toEqual({ state: "up" });
    expect(fake.requests).toEqual([{ path: "/info", auth: `Bearer ${KEY}` }]);
  });

  test("a wrong model or revision gives embedder_wrong_model, and no vector from it is kept", async () => {
    const { fake, cfg } = setup();
    fake.info.model_id = "Qwen/Qwen3-Embedding-0.6B";
    const e = openEmbedder(cfg, env);
    expect(await e.probe()).toEqual({ state: "off", reason: "embedder_wrong_model" });
    expect(await e.embed(["capacity is not released"])).toMatchObject({ ok: false, reason: "embedder_wrong_model" });
    expect(embedCalls(fake)).toEqual([]);
    fake.info.model_id = "BAAI/bge-m3";
    fake.info.model_sha = "0000000000000000000000000000000000000000";
    expect(await e.probe()).toEqual({ state: "off", reason: "embedder_wrong_model" });
    fake.info.model_sha = REV;
    expect(await e.probe()).toEqual({ state: "up" });
  });
});

describe("/embed", () => {
  test("success: one Float32Array of `dims` per input, in order, with normalize and truncate", async () => {
    const { fake, cfg } = setup();
    const e = openEmbedder(cfg, env);
    const r = await e.embed(["alpha", "beta", "gamma"]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.vectors).toHaveLength(3);
    for (const v of r.vectors) (expect(v).toBeInstanceOf(Float32Array), expect(v.length).toBe(4));
    expect(embedCalls(fake)).toEqual([{ path: "/embed", auth: `Bearer ${KEY}`, inputs: ["alpha", "beta", "gamma"] }]);
    expect(await e.embed([])).toEqual({ ok: true, vectors: [] });
  });

  test("a wrong vector length is refused", async () => {
    const { fake, cfg } = setup();
    fake.vectorLength = 3;
    expect(await openEmbedder(cfg, env).embed(["alpha"])).toMatchObject({ ok: false, reason: "embedder_wrong_model" });
  });

  test("401 and 403 give embedder_refused", async () => {
    const { fake, cfg } = setup();
    expect(await openEmbedder(cfg, { HISTORY_EMBEDDER_KEY: "wrong" }).probe()).toEqual({ state: "off", reason: "embedder_refused" });
    const e = openEmbedder(cfg, env);
    fake.queue.push(403);
    expect(await e.embed(["alpha"])).toMatchObject({ ok: false, reason: "embedder_refused" });
  });

  test("a timeout gives embedder_slow, marked timedOut (a back-off is not)", async () => {
    const { fake, cfg } = setup({ timeoutMs: 150, queryTimeoutMs: 150 });
    const e = openEmbedder(cfg, env);
    expect(await e.probe()).toEqual({ state: "up" });
    fake.queue.push("hang");
    expect(await e.embed(["alpha"])).toEqual({ ok: false, reason: "embedder_slow", timedOut: true });
    fake.queue.push(429);
    expect(await e.embed(["alpha"])).not.toHaveProperty("timedOut");
    fake.queue.push("hang");
    fake.queue.push("hang");
    expect(await e.embedQuery("beta")).toMatchObject({ ok: false, reason: "embedder_slow" });
  });

  test("413 splits the batch and keeps the order", async () => {
    const { fake, cfg } = setup();
    fake.maxBatch = 2;
    const e = openEmbedder(cfg, env);
    const texts = ["a1", "b2", "c3", "d4", "e5"];
    const r = await e.embed(texts);
    if (!r.ok) throw new Error(r.reason);
    const whole = await openEmbedder(cfg, env).embed(["c3"]);
    if (!whole.ok) throw new Error(whole.reason);
    expect(r.vectors).toHaveLength(5);
    expect([...r.vectors[2]!]).toEqual([...whole.vectors[0]!]);
    const sent = embedCalls(fake).map((c) => c.inputs!.length);
    expect(sent.filter((n) => n > 2).length).toBeGreaterThan(0); // the first try was the whole batch
    expect(sent.filter((n) => n <= 2).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
  });

  test("429 and 503 give a back-off: no request until it ends", async () => {
    let now = 1_000_000;
    const { fake, cfg } = setup({ backoffMs: 5_000 });
    const e = openEmbedder(cfg, env, { now: () => now });
    for (const status of [429, 503]) {
      fake.queue.push(status);
      const r = await e.embed(["alpha"]);
      expect(r).toMatchObject({ ok: false, reason: "embedder_slow" });
      expect(r.ok ? 0 : r.retryAfterMs).toBeGreaterThanOrEqual(5_000);
      const before = embedCalls(fake).length;
      expect(await e.embed(["alpha"])).toMatchObject({ ok: false, reason: "embedder_slow" });
      expect(embedCalls(fake).length).toBe(before);
      now += 60_000;
      expect((await e.embed(["alpha"])).ok).toBe(true);
    }
    fake.retryAfter = "7";
    fake.queue.push(429);
    const r = await e.embed(["alpha"]);
    expect(r.ok ? 0 : r.retryAfterMs).toBe(7_000);
  });

  test("connection refused gives embedder_down; after a restart of the fake the next probe gives up", async () => {
    const { fake, cfg } = setup();
    const e = openEmbedder(cfg, env);
    expect(await e.probe()).toEqual({ state: "up" });
    fake.stop();
    expect(await e.embed(["alpha"])).toMatchObject({ ok: false, reason: "embedder_down" });
    expect(await e.probe()).toEqual({ state: "down", reason: "embedder_down" });
    fake.restart();
    expect(await e.probe()).toEqual({ state: "up" });
    expect((await e.embed(["alpha"])).ok).toBe(true);
  });

  test("the query cache stops a second call for the same query", async () => {
    const { fake, cfg } = setup({ queryCache: 2 });
    const e = openEmbedder(cfg, env);
    const a = await e.embedQuery("bus seats not freeing up");
    const b = await e.embedQuery("bus seats not freeing up");
    expect(a.ok && b.ok).toBe(true);
    expect(embedCalls(fake)).toHaveLength(1);
    await e.embedQuery("two");
    await e.embedQuery("three"); // the cache holds 2: the first query is evicted
    await e.embedQuery("bus seats not freeing up");
    expect(embedCalls(fake)).toHaveLength(4);
  });
});

describe("the key never shows", () => {
  test("in any result or reason, also when the transport error names it", async () => {
    const { fake, cfg } = setup({ timeoutMs: 150 });
    const seen: unknown[] = [];
    const e = openEmbedder(cfg, env);
    seen.push(await e.probe(), await e.embed(["a"]));
    fake.queue.push(401, 403, 429, 503, 413, "hang");
    for (let i = 0; i < 6; i++) seen.push(await openEmbedder(cfg, env).embed(["b"]));
    const leaky = (async () => {
      throw new Error(`connect failed with Authorization: Bearer ${KEY}`);
    }) as unknown as typeof fetch;
    const l = openEmbedder(cfg, env, { fetch: leaky });
    seen.push(await l.probe(), await l.embed(["c"]), await l.embedQuery("d"));
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(JSON.stringify(seen)).not.toContain("MARKER");
  });
});
