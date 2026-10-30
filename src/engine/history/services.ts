// What the task history's two outside services share (ADR-0066 Decision 4.9): the reasons meaning search
// is off, a service state, and the loopback rule — the embedder and the vector index accept only an
// http(s) URL on 127.0.0.1, ::1 or localhost, with no credentials in it.

export type MeaningOffReason =
  | "not_configured" | "config_refused" | "embedder_down" | "embedder_slow" | "embedder_refused"
  | "embedder_wrong_model" | "vectors_down" | "vectors_slow" | "vectors_refused" | "collection_missing";

/** `off`: the operator must act (config, key, model, collection); `down`: it may come back by itself. */
export type ServiceState = { state: "up" } | { state: "down" | "off"; reason: MeaningOffReason };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

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
 *  query embed, and the indexer waits for the gate to be idle before each embed batch. */
export interface QueryGate {
  /** Mark one query in flight; call the returned function when it is done (twice is harmless). */
  enter(): () => void;
  /** Resolves when no query is in flight. */
  idle(): Promise<void>;
}

export function createQueryGate(): QueryGate {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  return {
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
