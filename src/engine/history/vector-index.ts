// The task history's vector index (ADR-0066 Decisions 1 and 4.9, spec "The shared Qdrant contract"):
// `QdrantIndex` talks REST to the shared Qdrant, `NoVectorIndex` answers `off`. Before any request the
// config is checked and refused (`config_refused`) when the URL is not loopback, the collection does not
// start with `neo_` or is not allowed, or the key is not a JWT whose `access` claim names only allowed
// collections (the payload is decoded to read the claim — never verified, never printed). Points carry only
// `id`, `vector` and the payload `{ project?, kind, at, m }`; anything else, a string over 64 characters or
// a vector of the wrong length throws before the request. 401/403 → `vectors_refused`; on the collection
// info a 404 → `collection_missing`, and a 401/403 asks the collection list which one it is: a list that
// answers without the collection → `collection_missing`, a list that refuses the key too (a rotated key's
// bad signature) or that names the collection → `vectors_key_rejected`. A timeout → `vectors_slow`, other
// failures → `vectors_down`. The key goes only into the `api-key` header; results and errors carry reason
// codes and never the key.
import type { VectorsCfg } from "./defaults";
import { isLoopbackUrl, isTimeout, type MeaningOffReason } from "./services";

export interface PointPayload {
  project?: string;
  kind: string;
  at: number;
  /** The model tag. */
  m: string;
}

export interface Point {
  id: string;
  vector: Float32Array | number[];
  payload: PointPayload;
}

/** `tag` is required: a search never mixes models. `since`/`until` are ms, inclusive. */
export interface VectorFilter {
  tag: string;
  project?: string;
  kinds?: string[];
  since?: number;
  until?: number;
}

export type VectorResult<T> = { ok: true; value: T } | { ok: false; reason: MeaningOffReason };
export type VectorProbe = { state: "up"; count: number } | { state: "down" | "off"; reason: MeaningOffReason };

export interface VectorIndex {
  readonly collection: string;
  /** Why this index answers nothing at all (not configured or refused by its settings), known without a
   *  request; undefined for a configured index. A search then never embeds its query. */
  offReason(): MeaningOffReason | undefined;
  /** The collection info (it must exist with `dims`) and the exact count of `tag`'s points. */
  probe(tag: string): Promise<VectorProbe>;
  /** The payload indexes: `project`, `kind`, `m` keyword, `at` integer with range. Idempotent. */
  ensureIndexes(): Promise<VectorResult<void>>;
  /** Upsert with `wait=true`; the value is the number sent. Throws on a bad point, before any request. */
  upsert(points: Point[]): Promise<VectorResult<number>>;
  delete(ids: string[]): Promise<VectorResult<number>>;
  /** Delete every point of a model tag (the filter `m = tag`). */
  deleteTag(tag: string): Promise<VectorResult<void>>;
  /** The exact count of every point in the collection, of any tag (the verify step refuses a collection that
   *  holds another tag's points). */
  countAll(): Promise<VectorResult<number>>;
  /** Nearest neighbours of `vector` under the filter, best first, ids and scores only. */
  search(vector: Float32Array | number[], filter: VectorFilter, opts: { limit: number; minScore?: number }): Promise<VectorResult<Array<{ id: string; score: number }>>>;
  /** One page of `tag`'s point ids, in id order; `next` is the offset of the next page. */
  scrollIds(tag: string, offset: string | undefined, limit: number): Promise<VectorResult<{ ids: string[]; next?: string }>>;
  /** Which of `ids` the collection holds (the weekly sweep sends the others again). */
  existing(ids: string[]): Promise<VectorResult<string[]>>;
}

/** The index when vectors are not configured or refused: every call answers `off` with the reason. */
export class NoVectorIndex implements VectorIndex {
  readonly collection = "";
  constructor(private readonly reason: MeaningOffReason = "not_configured") {}
  offReason(): MeaningOffReason {
    return this.reason;
  }
  async probe(_tag: string): Promise<VectorProbe> {
    return { state: "off", reason: this.reason };
  }
  private async off<T>(): Promise<VectorResult<T>> {
    return { ok: false, reason: this.reason };
  }
  ensureIndexes() { return this.off<void>(); }
  upsert(_points: Point[]) { return this.off<number>(); }
  delete(_ids: string[]) { return this.off<number>(); }
  deleteTag(_tag: string) { return this.off<void>(); }
  countAll() { return this.off<number>(); }
  search(_vector: Float32Array | number[], _filter: VectorFilter, _opts: { limit: number; minScore?: number }) {
    return this.off<Array<{ id: string; score: number }>>();
  }
  scrollIds(_tag: string, _offset: string | undefined, _limit: number) { return this.off<{ ids: string[]; next?: string }>(); }
  existing(_ids: string[]) { return this.off<string[]>(); }
}

/** The longest string a payload may carry (the contract: no text ever goes to the shared service). */
const PAYLOAD_MAX_CHARS = 64;
const PAYLOAD_KEYS = new Set(["project", "kind", "at", "m"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = "neo_";
const ACCESS_MODES = new Set(["r", "rw"]);

/** Why a collection and key may not be used, or undefined when they may. Decodes the JWT payload only. */
function refusal(collection: string, allowed: readonly string[], key: string): "config_refused" | undefined {
  const ok = (c: unknown): boolean => typeof c === "string" && c.startsWith(PREFIX) && allowed.includes(c);
  if (!ok(collection)) return "config_refused";
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return "config_refused";
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return "config_refused";
  }
  const access = (claims as { access?: unknown } | null)?.access;
  // A missing or string `access` is global (every collection): refused. Each entry must name an allowed one.
  if (!Array.isArray(access) || access.length === 0) return "config_refused";
  for (const a of access) {
    const e = a as { collection?: unknown; access?: unknown } | null;
    if (!e || !ok(e.collection) || !ACCESS_MODES.has(e.access as string)) return "config_refused";
  }
  return access.some((a) => (a as { collection: string }).collection === collection) ? undefined : "config_refused";
}

function checkVector(v: Float32Array | number[], dims: number): number[] {
  if (v.length !== dims) throw new Error(`history vector: the length is not ${dims}`);
  const out = Array.from(v);
  if (!out.every(Number.isFinite)) throw new Error("history vector: a value is not a finite number");
  return out;
}

const shortString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= PAYLOAD_MAX_CHARS;

/** The request body of one point, or a throw that names the rule (never a value). */
function pointBody(p: Point, dims: number): { id: string; vector: number[]; payload: PointPayload } {
  if (typeof p.id !== "string" || !UUID.test(p.id)) throw new Error("history vector point: the id is not a UUID");
  const payload = p.payload as unknown as Record<string, unknown>;
  for (const k of Object.keys(payload)) if (!PAYLOAD_KEYS.has(k)) throw new Error("history vector point: a payload key is not allowed");
  if (!shortString(payload.kind) || !shortString(payload.m)) throw new Error(`history vector point: kind and m must be strings of 1-${PAYLOAD_MAX_CHARS} characters`);
  if (payload.project !== undefined && !shortString(payload.project)) throw new Error(`history vector point: project must be a string of 1-${PAYLOAD_MAX_CHARS} characters`);
  if (!Number.isSafeInteger(payload.at)) throw new Error("history vector point: at must be an integer");
  return {
    id: p.id,
    vector: checkVector(p.vector, dims),
    payload: { ...(payload.project !== undefined ? { project: payload.project as string } : {}), kind: payload.kind, at: payload.at as number, m: payload.m },
  };
}

const tagFilter = (tag: string) => ({ must: [{ key: "m", match: { value: tag } }] });

function searchFilter(f: VectorFilter): { must: unknown[] } {
  const must: unknown[] = [{ key: "m", match: { value: f.tag } }];
  if (f.project !== undefined) must.push({ key: "project", match: { value: f.project } });
  if (f.kinds?.length) must.push({ key: "kind", match: { any: f.kinds } });
  if (f.since !== undefined || f.until !== undefined) {
    must.push({ key: "at", range: { ...(f.since !== undefined ? { gte: f.since } : {}), ...(f.until !== undefined ? { lte: f.until } : {}) } });
  }
  return { must };
}

const INDEXES: Array<{ field_name: string; field_schema: unknown }> = [
  { field_name: "project", field_schema: "keyword" },
  { field_name: "kind", field_schema: "keyword" },
  { field_name: "m", field_schema: "keyword" },
  { field_name: "at", field_schema: { type: "integer", lookup: false, range: true } },
];

type Reply = { ok: true; result: unknown } | { ok: false; reason: MeaningOffReason };

/** The shared Qdrant at `env[cfg.urlEnv]` with the key in `env[cfg.keyEnv]`, read once. `dims` is the
 *  embedder's; `collection` overrides `cfg.collection` (a next model's collection, which must be allowed). */
export function openVectorIndex(
  cfg: VectorsCfg,
  env: Record<string, string | undefined>,
  deps: { dims: number; collection?: string; fetch?: typeof fetch },
): VectorIndex {
  const doFetch = deps.fetch ?? fetch;
  const url = env[cfg.urlEnv]?.trim() ?? "";
  const key = env[cfg.keyEnv]?.trim() ?? "";
  const collection = deps.collection ?? cfg.collection;
  const configError: MeaningOffReason | undefined = !url || !key
    ? "not_configured"
    : !isLoopbackUrl(url) || !(Number.isInteger(deps.dims) && deps.dims > 0)
      ? "config_refused"
      : refusal(collection, cfg.allowedCollections, key);
  if (configError) return new NoVectorIndex(configError);
  const root = `${url.replace(/\/+$/, "")}/collections`;
  const base = `${root}/${encodeURIComponent(collection)}`;

  async function call(method: "GET" | "POST" | "PUT", path: string, body: unknown, timeoutMs: number, info = false, at = base): Promise<Reply> {
    let res: Response;
    try {
      res = await doFetch(`${at}${path}`, {
        method,
        headers: { "api-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (e) {
      // The error text is never kept: a transport error may quote the request.
      return { ok: false, reason: isTimeout(e) ? "vectors_slow" : "vectors_down" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: info ? await refusedInfo(timeoutMs) : "vectors_refused" };
    if (info && res.status === 404) return { ok: false, reason: "collection_missing" };
    if (!res.ok) return { ok: false, reason: "vectors_down" };
    try {
      return { ok: true, result: ((await res.json()) as { result?: unknown }).result };
    } catch (e) {
      return { ok: false, reason: isTimeout(e) ? "vectors_slow" : "vectors_down" };
    }
  }
  /** The collection info refused the key: a rejected key is refused by the list too (or the list names the
   *  collection the key may not read); a list that answers without the collection means it does not exist. */
  async function refusedInfo(timeoutMs: number): Promise<MeaningOffReason> {
    const list = await call("GET", "", undefined, timeoutMs, false, root);
    if (!list.ok) return list.reason === "vectors_refused" ? "vectors_key_rejected" : list.reason;
    const names = (list.result as { collections?: Array<{ name?: unknown }> } | undefined)?.collections;
    if (!Array.isArray(names)) return "vectors_down";
    return names.some((c) => c?.name === collection) ? "vectors_key_rejected" : "collection_missing";
  }
  const fail = <T>(r: { reason: MeaningOffReason }): VectorResult<T> => ({ ok: false, reason: r.reason });

  return {
    collection,
    offReason: () => undefined,
    async probe(tag) {
      const info = await call("GET", "", undefined, cfg.timeoutMs, true);
      if (!info.ok) return { state: info.reason === "collection_missing" || info.reason === "vectors_key_rejected" ? "off" : "down", reason: info.reason };
      const size = (info.result as { config?: { params?: { vectors?: { size?: unknown } } } } | undefined)?.config?.params?.vectors?.size;
      if (size !== deps.dims) return { state: "off", reason: "config_refused" };
      const count = await call("POST", "/points/count", { filter: tagFilter(tag), exact: true }, cfg.timeoutMs);
      if (!count.ok) return { state: count.reason === "vectors_refused" ? "off" : "down", reason: count.reason };
      const n = (count.result as { count?: unknown } | undefined)?.count;
      return Number.isInteger(n) ? { state: "up", count: n as number } : { state: "down", reason: "vectors_down" };
    },
    async ensureIndexes() {
      for (const index of INDEXES) {
        const r = await call("PUT", "/index?wait=true", index, cfg.timeoutMs);
        if (!r.ok) return fail(r);
      }
      return { ok: true, value: undefined };
    },
    async upsert(points) {
      const bodies = points.map((p) => pointBody(p, deps.dims));
      if (bodies.length === 0) return { ok: true, value: 0 };
      const r = await call("PUT", "/points?wait=true", { points: bodies }, cfg.timeoutMs);
      return r.ok ? { ok: true, value: bodies.length } : fail(r);
    },
    async delete(ids) {
      if (!ids.every((id) => typeof id === "string" && UUID.test(id))) throw new Error("history vector delete: an id is not a UUID");
      if (ids.length === 0) return { ok: true, value: 0 };
      const r = await call("POST", "/points/delete?wait=true", { points: ids }, cfg.timeoutMs);
      return r.ok ? { ok: true, value: ids.length } : fail(r);
    },
    async deleteTag(tag) {
      if (!shortString(tag)) throw new Error("history vector delete: the tag is not a short string");
      const r = await call("POST", "/points/delete?wait=true", { filter: tagFilter(tag) }, cfg.timeoutMs);
      return r.ok ? { ok: true, value: undefined } : fail(r);
    },
    async countAll() {
      const r = await call("POST", "/points/count", { exact: true }, cfg.timeoutMs);
      if (!r.ok) return fail(r);
      const n = (r.result as { count?: unknown } | undefined)?.count;
      return Number.isInteger(n) ? { ok: true, value: n as number } : { ok: false, reason: "vectors_down" };
    },
    async search(vector, filter, opts) {
      const body = {
        query: checkVector(vector, deps.dims), filter: searchFilter(filter), limit: opts.limit, with_payload: false, with_vector: false,
        ...(opts.minScore !== undefined ? { score_threshold: opts.minScore } : {}),
      };
      const r = await call("POST", "/points/query", body, cfg.queryTimeoutMs);
      if (!r.ok) return fail(r);
      const points = (r.result as { points?: unknown } | undefined)?.points;
      if (!Array.isArray(points)) return { ok: false, reason: "vectors_down" };
      return { ok: true, value: points.flatMap((p: { id?: unknown; score?: unknown }) => (typeof p.id === "string" && typeof p.score === "number" ? [{ id: p.id, score: p.score }] : [])) };
    },
    async scrollIds(tag, offset, limit) {
      const body = { filter: tagFilter(tag), limit, with_payload: false, with_vector: false, ...(offset !== undefined ? { offset } : {}) };
      const r = await call("POST", "/points/scroll", body, cfg.timeoutMs);
      if (!r.ok) return fail(r);
      const res = r.result as { points?: Array<{ id?: unknown }>; next_page_offset?: unknown } | undefined;
      if (!Array.isArray(res?.points)) return { ok: false, reason: "vectors_down" };
      const ids = res.points.flatMap((p) => (typeof p.id === "string" ? [p.id] : []));
      return { ok: true, value: { ids, ...(typeof res.next_page_offset === "string" ? { next: res.next_page_offset } : {}) } };
    },
    async existing(ids) {
      if (!ids.every((id) => typeof id === "string" && UUID.test(id))) throw new Error("history vector lookup: an id is not a UUID");
      if (ids.length === 0) return { ok: true, value: [] };
      const r = await call("POST", "/points", { ids, with_payload: false, with_vector: false }, cfg.timeoutMs);
      if (!r.ok) return fail(r);
      if (!Array.isArray(r.result)) return { ok: false, reason: "vectors_down" };
      return { ok: true, value: (r.result as Array<{ id?: unknown }>).flatMap((p) => (typeof p.id === "string" ? [p.id] : [])) };
    },
  };
}
