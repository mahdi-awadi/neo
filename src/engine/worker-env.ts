// Neo engine — scrub the environment a worker inherits (ADR-0050 §7, P1.5).
// Pure: no I/O, no process.env read. Names only — a value is never copied, listed or logged.
//   relay keys  = every tool card's `relay.envKey`. The engine holds them for the API relay, so
//                 a worker never gets them (both modes).
//   engine keys = the names Neo's own env file set at start. `report` keeps them and lists their
//                 names; `strip` removes them, except the `inherit` names (the SDK auth keys).

export type WorkerEnvMode = "report" | "strip";

export interface EnvScrubOptions {
  engineKeys: ReadonlySet<string>;
  relayKeys: ReadonlySet<string>;
  inherit: ReadonlySet<string>;
  mode: WorkerEnvMode;
}

export interface EnvScrubResult {
  env: Record<string, string>;
  /** Names removed from the env. */
  stripped: string[];
  /** Engine-key names left in the env (report mode only). */
  reported: string[];
}

export function scrubWorkerEnv(env: Record<string, string>, o: EnvScrubOptions): EnvScrubResult {
  const out: Record<string, string> = {};
  const stripped: string[] = [];
  const reported: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (o.relayKeys.has(key)) { stripped.push(key); continue; }
    if (o.engineKeys.has(key) && !o.inherit.has(key)) {
      if (o.mode === "strip") { stripped.push(key); continue; }
      reported.push(key);
    }
    out[key] = value;
  }
  return { env: out, stripped, reported };
}

/** The names `report` mode lists for a start: the engine keys a worker can still see. */
export function reportableEngineKeys(o: EnvScrubOptions): string[] {
  return [...o.engineKeys].filter((k) => !o.relayKeys.has(k) && !o.inherit.has(k)).sort();
}
