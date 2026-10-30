// What the task history's two outside services share (ADR-0066 Decision 4.9): the reasons meaning search
// is off, a service state, and the loopback rule — the embedder and the vector index accept only an
// http(s) URL on 127.0.0.1, ::1 or localhost, with no credentials in it. Also the one line that tells the
// operator what to do about a service state (the attention items and the admin status name it).
import type { HistoryCfg } from "./defaults";

export type MeaningOffReason =
  | "not_configured" | "config_refused" | "embedder_down" | "embedder_slow" | "embedder_refused"
  | "embedder_wrong_model" | "vectors_down" | "vectors_slow" | "vectors_refused" | "collection_missing"
  /** The probe: the shared Qdrant rejects Neo's key itself (a rotated key's bad signature, or no access). */
  | "vectors_key_rejected"
  /** A search only: the indexer has an embed request in flight, so the query is not queued behind it. */
  | "embedder_busy";

/** `off`: the operator must act (config, key, model, collection); `down`: it may come back by itself. */
export type ServiceState = { state: "up" } | { state: "down" | "off"; reason: MeaningOffReason };

/** The two outside services, by the name the attention items and the admin status use. */
export type HistoryService = "embedder" | "vectors";

/** What the operator does about a service state, one line. The names come from the config, so a renamed
 *  key, URL or collection reads right. English data, like every attention title. */
export function operatorStep(service: HistoryService, reason: MeaningOffReason, cfg: Pick<HistoryCfg, "embedder" | "vectors">): string {
  const { embedder: e, vectors: v } = cfg;
  const install = "run `bun tools/history/install.ts`, then reload Neo";
  switch (reason) {
    case "not_configured":
      return service === "embedder"
        ? `the embedder is not installed: ${install} (it writes ${e.keyEnv} into .env)`
        : `${v.urlEnv} or ${v.keyEnv} is not in .env: ask ops for the shared Qdrant URL and a key for ${v.collection}, then reload Neo`;
    case "config_refused":
      return service === "embedder"
        ? `the embedder settings were refused: history.embedder.url must be a loopback URL (now ${e.url}); fix config.json, then reload Neo`
        : `the shared index settings were refused: ${v.urlEnv} must be a loopback URL, ${v.keyEnv} a key for ${v.collection} only, and the collection one of ${v.allowedCollections.join(", ")}; then reload Neo`;
    case "embedder_refused":
      return `the embedder refused the key: ${install} (the key in .env and the service must match)`;
    case "embedder_wrong_model":
      return `the embedder runs another model or revision than ${e.model}: ${install} (it pins the model), or set history.embedder.model and revision to match`;
    case "vectors_refused":
      return `the shared Qdrant refused the key (ops may have rotated it): reload Neo to read the new key; if it still fails, ask ops for a key for ${v.collection}`;
    case "vectors_key_rejected":
      return `Neo's key was rejected by the shared Qdrant: ask ops to reissue ${v.keyEnv} for ${v.collection}; the daemon must reload to read it`;
    case "collection_missing":
      return `ask ops to create the collection ${v.collection} (${e.dims} dims, cosine) in the shared Qdrant`;
    case "embedder_busy":
      return "nothing to do: the indexer is embedding a backlog; meaning search answers again between its batches";
    case "embedder_down":
    case "embedder_slow":
      return "check the neo-embedder container (`docker compose -p neo-embedder ps` and its logs); `bun tools/history/install.ts` starts it again";
    case "vectors_down":
    case "vectors_slow":
      return `check the shared Qdrant (an ops service) and the URL in ${v.urlEnv}`;
  }
}

const LOOPBACK_HOSTS =new Set(["127.0.0.1", "[::1]", "localhost"]);

/** True for an http(s) URL whose host is exactly 127.0.0.1, ::1 or localhost and that carries no user or
 *  password. Anything that does not parse is false. */
export function isLoopbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname) && u.username === "" && u.password === "";
}

/** True when a fetch failed because its time ran out (an abort signal's timeout). */
export function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/** Queries go first on the embedder (spec "The indexer", step 4): a search enters the gate around its
 *  query embed, and the indexer waits for the gate to be idle before each embed batch. The other way
 *  round, a search never queues behind a batch: the indexer marks each embed request, and a search that
 *  finds one in flight answers without meaning search (`embedder_busy`) instead of waiting for it. */
export interface QueryGate {
  /** Mark one query in flight; call the returned function when it is done (twice is harmless). */
  enter(): () => void;
  /** Resolves when no query is in flight. */
  idle(): Promise<void>;
  /** Mark one indexer embed request in flight; call the returned function when it ends (twice is harmless). */
  batch(): () => void;
  /** Whether an indexer embed request is in flight now. */
  batchActive(): boolean;
}

export function createQueryGate(): QueryGate {
  let inFlight = 0;
  let batches = 0;
  const waiters: Array<() => void> = [];
  return {
    batch() {
      batches++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        batches--;
      };
    },
    batchActive: () => batches > 0,
    enter() {
      inFlight++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (--inFlight === 0) for (const w of waiters.splice(0)) w();
      };
    },
    idle() {
      return inFlight === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r));
    },
  };
}
