// The task history's embedder adapter (ADR-0066 Decision 5, spec "The embedder contract"): a client for
// the local text-embeddings-inference service. It accepts only a loopback URL, reads the bearer key once
// from the environment (`cfg.keyEnv`), and keeps no vector until `/info` has reported the configured model
// id and revision. `/embed` answers are checked for one vector of `dims` per input. 401/403 → refused,
// a timeout → slow, 413 → the batch is split, 429/503 → a back-off with no request until it ends,
// connection refused → down (and `/info` is checked again before the next vector). Results carry reason
// codes only: the key, and any transport error text that could hold it, never leave this module.
import type { EmbedderCfg } from "./defaults";
import { isLoopbackUrl, isTimeout, type MeaningOffReason, type ServiceState } from "./services";

export type EmbedFailure = { ok: false; reason: MeaningOffReason; retryAfterMs?: number };
export type EmbedResult = { ok: true; vectors: Float32Array[] } | EmbedFailure;
export type QueryVector = { ok: true; vector: Float32Array } | EmbedFailure;

export interface Embedder {
  /** The model tag of every vector this embedder makes. */
  readonly tag: string;
  readonly dims: number;
  /** Check the service: `/info` must name the configured model and revision. */
  probe(): Promise<ServiceState>;
  /** One vector per text, in order (a batch-sized call; `timeoutMs`). */
  embed(texts: string[]): Promise<EmbedResult>;
  /** A search query's vector (`queryTimeoutMs`), from the query cache when it holds it. */
  embedQuery(text: string): Promise<QueryVector>;
}

/** How many characters of the revision the model tag keeps. */
const REVISION_PREFIX = 12;

/** The model tag (ADR-0066 Decision 4.6): `<model id>@<dims>:<revision prefix>`. */
export function modelTag(model: string, dims: number, revision: string): string {
  return `${model}@${dims}:${revision.slice(0, REVISION_PREFIX)}`;
}

/** The same embedder under another model tag (the verify step's `<tag>~verify`, ADR-0066): every call goes
 *  to `e`; only the tag the indexer and search use changes. */
export function withTag(e: Embedder, tag: string): Embedder {
  return { tag, dims: e.dims, probe: () => e.probe(), embed: (texts) => e.embed(texts), embedQuery: (text) => e.embedQuery(text) };
}

type Call = { ok: true; res: Response } | EmbedFailure;

export function openEmbedder(
  cfg: EmbedderCfg,
  env: Record<string, string | undefined>,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Embedder {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const key = env[cfg.keyEnv]?.trim() ?? "";
  const base = cfg.url.replace(/\/+$/, "");
  const configError: MeaningOffReason | undefined = !isLoopbackUrl(cfg.url)
    ? "config_refused"
    : !key || !cfg.revision.trim() || !cfg.model.trim()
      ? "not_configured"
      : !(Number.isInteger(cfg.dims) && cfg.dims > 0)
        ? "config_refused"
        : undefined;
  /** `/info` matched since the last connection loss. */
  let verified = false;
  let backoffUntil = 0;
  let backoffStep = 0;
  const cache = new Map<string, Float32Array>();

  const fail = (reason: MeaningOffReason, retryAfterMs?: number): EmbedFailure => ({ ok: false, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

  async function call(path: string, timeoutMs: number, body?: unknown): Promise<Call> {
    try {
      const res = await doFetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      return { ok: true, res };
    } catch (e) {
      // The error text is never kept: a transport error may quote the request.
      if (isTimeout(e)) return fail("embedder_slow");
      verified = false;
      return fail("embedder_down");
    }
  }

  async function probe(): Promise<ServiceState> {
    if (configError) return { state: "off", reason: configError };
    const r = await call("/info", cfg.queryTimeoutMs);
    if (!r.ok) return { state: "down", reason: r.reason };
    if (r.res.status === 401 || r.res.status === 403) return (verified = false), { state: "off", reason: "embedder_refused" };
    if (!r.res.ok) return (verified = false), { state: "down", reason: "embedder_down" };
    let info: { model_id?: unknown; model_sha?: unknown };
    try {
      info = (await r.res.json()) as typeof info;
    } catch {
      return (verified = false), { state: "down", reason: "embedder_down" };
    }
    verified = info.model_id === cfg.model && info.model_sha === cfg.revision;
    return verified ? { state: "up" } : { state: "off", reason: "embedder_wrong_model" };
  }

  /** Start or lengthen the back-off; a Retry-After in seconds wins. */
  function backOff(res: Response): number {
    const header = Number(res.headers.get("retry-after"));
    const ms = Number.isFinite(header) && header > 0
      ? header * 1000
      : Math.min(cfg.backoffMaxMs, cfg.backoffMs * 2 ** backoffStep++);
    backoffUntil = now() + ms;
    return ms;
  }

  async function post(texts: string[], timeoutMs: number): Promise<EmbedResult> {
    const r = await call("/embed", timeoutMs, { inputs: texts, normalize: true, truncate: true });
    if (!r.ok) return r;
    const res = r.res;
    if (res.status === 401 || res.status === 403) return (verified = false), fail("embedder_refused");
    if (res.status === 429 || res.status === 503) return fail("embedder_slow", backOff(res));
    if (res.status === 413 && texts.length > 1) {
      const half = Math.ceil(texts.length / 2);
      const a = await post(texts.slice(0, half), timeoutMs);
      if (!a.ok) return a;
      const b = await post(texts.slice(half), timeoutMs);
      return b.ok ? { ok: true, vectors: [...a.vectors, ...b.vectors] } : b;
    }
    if (!res.ok) return fail("embedder_down");
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return fail("embedder_down");
    }
    if (!Array.isArray(body) || body.length !== texts.length) return fail("embedder_down");
    const vectors: Float32Array[] = [];
    for (const v of body) {
      // A vector of another length is another model: refused, nothing kept.
      if (!Array.isArray(v) || v.length !== cfg.dims || !v.every((x) => typeof x === "number" && Number.isFinite(x))) return fail("embedder_wrong_model");
      vectors.push(Float32Array.from(v as number[]));
    }
    backoffStep = 0;
    return { ok: true, vectors };
  }

  async function run(texts: string[], timeoutMs: number): Promise<EmbedResult> {
    if (configError) return fail(configError);
    if (texts.length === 0) return { ok: true, vectors: [] };
    if (now() < backoffUntil) return fail("embedder_slow", backoffUntil - now());
    if (!verified) {
      const p = await probe();
      if (p.state !== "up") return fail(p.reason);
    }
    return post(texts, timeoutMs);
  }

  return {
    tag: modelTag(cfg.model, cfg.dims, cfg.revision),
    dims: cfg.dims,
    probe,
    embed: (texts) => run(texts, cfg.timeoutMs),
    async embedQuery(text) {
      const hit = cache.get(text);
      if (hit) {
        cache.delete(text);
        cache.set(text, hit);
        return { ok: true, vector: hit };
      }
      const r = await run([text], cfg.queryTimeoutMs);
      if (!r.ok) return r;
      const vector = r.vectors[0]!;
      if (cfg.queryCache > 0) {
        cache.set(text, vector);
        while (cache.size > cfg.queryCache) cache.delete(cache.keys().next().value!);
      }
      return { ok: true, vector };
    },
  };
}
