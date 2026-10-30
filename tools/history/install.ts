// Neo's embedder (ADR-0066 Decision 5, spec "The embedder contract"): make the bearer key once, bring the
// loopback-only TEI service up, wait for its health answer, and check it through the engine's own adapter
// (`/info` names the pinned model and revision, one test embed has the configured length). The decisions
// are pure and tested (tests/history-embedder-service.test.ts); main is the thin docker/IO wrapper.
//
//   bun tools/history/install.ts         key into .env (once, 0600), up -d, health, test embed, print caps
//   bun tools/history/install.ts --down  stop and remove the service (the model volume stays)
//
// The key goes to `docker compose` only in that child's environment; it is never an argument, never
// printed, never in a tracked file.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDER_DEFAULTS, type EmbedderCfg } from "../../src/engine/history/defaults";
import { openEmbedder } from "../../src/engine/history/embedder";
import type { MeaningOffReason } from "../../src/engine/history/services";
import { ensureEnvKey, parseEnvFile, pickSetting } from "../lib/env-file";

/** The environment variable that holds the key; the engine reads the same one (`history.embedder.keyEnv`). */
export const KEY_ENV = EMBEDDER_DEFAULTS.keyEnv;

export interface EmbedderSettings {
  image: string;
  model: string;
  revision: string;
  dims: number;
  port: number;
  mem: string;
  cpus: string;
  threads: number;
  pids: number;
  /** TEI's MAX_BATCH_TOKENS: bounds the warm-up memory and (auto-truncate) the input length. */
  maxBatchTokens: number;
  startWaitS: number;
}

const posInt = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined);
const port = (v: string | undefined): number | undefined => {
  const n = posInt(v);
  return n !== undefined && n <= 65_535 ? n : undefined;
};
const memSize = (v: string | undefined): string | undefined => (v && /^\d+[kmg]$/i.test(v) && Number.parseInt(v, 10) > 0 ? v.toLowerCase() : undefined);
const cpuCount = (v: string | undefined): string | undefined => (v && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? v : undefined);
const plain = (v: string | undefined): string | undefined => (v ? v : undefined);

/** Settings from env layers, later layers winning; an invalid value keeps the earlier one (fails closed).
 *  The image must be pinned by digest and the revision must be a Hub commit; every value must be set. */
export function embedderSettings(layers: Array<Record<string, string>>): EmbedderSettings {
  const need = <T>(key: string, parse: (v: string | undefined) => T | undefined, rule: string): T => {
    const v = pickSetting(layers, key, parse);
    if (v === undefined) throw new Error(`${key} must be ${rule} (tools/history/embedder.env)`);
    return v;
  };
  return {
    image: need("NEO_EMBEDDER_IMAGE", (v) => (v && /@sha256:[0-9a-f]{64}$/.test(v) ? v : undefined), "pinned by digest (…@sha256:<64 hex>)"),
    model: need("NEO_EMBEDDER_MODEL", plain, "a model id"),
    revision: need("NEO_EMBEDDER_REVISION", (v) => (v && /^[0-9a-f]{40}$/.test(v) ? v : undefined), "a 40-character Hub commit"),
    dims: need("NEO_EMBEDDER_DIMS", posInt, "a positive whole number"),
    port: need("NEO_EMBEDDER_PORT", port, "a port (1–65535)"),
    mem: need("NEO_EMBEDDER_MEM", memSize, "a size such as 4g"),
    cpus: need("NEO_EMBEDDER_CPUS", cpuCount, "a CPU count above 0"),
    threads: need("NEO_EMBEDDER_THREADS", posInt, "a positive whole number"),
    pids: need("NEO_EMBEDDER_PIDS", posInt, "a positive whole number"),
    maxBatchTokens: need("NEO_EMBEDDER_MAX_BATCH_TOKENS", posInt, "a positive whole number of tokens"),
    startWaitS: need("NEO_EMBEDDER_START_WAIT_S", posInt, "a positive whole number of seconds"),
  };
}

/** `docker compose …` arguments: the tracked settings, then the machine-local overrides if present. */
export function composeArgs(kit: string, hasLocal: boolean, cmd: string[]): string[] {
  return [
    "compose", "-p", "neo-embedder", "-f", join(kit, "compose.yml"),
    "--env-file", join(kit, "embedder.env"),
    ...(hasLocal ? ["--env-file", join(kit, "embedder.local.env")] : []),
    ...cmd,
  ];
}

/** The environment of the `docker compose` child: the caller's, plus the key. */
export function composeEnv(base: Record<string, string | undefined>, key: string): Record<string, string | undefined> {
  return { ...base, [KEY_ENV]: key };
}

/** The engine adapter's config for this service: the engine defaults with the service's URL, model,
 *  revision and length. */
export function adapterCfg(s: EmbedderSettings): EmbedderCfg {
  return { ...EMBEDDER_DEFAULTS, url: `http://127.0.0.1:${s.port}`, model: s.model, revision: s.revision, dims: s.dims };
}

/** Poll `/health` with the bearer key until it answers 200 or `waitMs` ends. */
export async function waitHealthy(s: EmbedderSettings, key: string, waitMs: number, pollMs = 5_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/health`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000), redirect: "error" });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(pollMs);
  }
  return false;
}

/** Check the running service through the engine's adapter: `/info` must name the pinned model and revision,
 *  and one test embed must give one vector of `dims`. Reason codes only, never the key. */
export async function smokeTest(s: EmbedderSettings, key: string): Promise<{ ok: true; dims: number } | { ok: false; reason: MeaningOffReason }> {
  const embedder = openEmbedder(adapterCfg(s), { [KEY_ENV]: key });
  const state = await embedder.probe();
  if (state.state !== "up") return { ok: false, reason: state.reason };
  const r = await embedder.embed(["Neo embedder test: bus seats are freed after a cancelled booking."]);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, dims: r.vectors[0]!.length };
}

if (import.meta.main) {
  const kit = import.meta.dir;
  const envFile = join(kit, "..", "..", ".env");
  const local = join(kit, "embedder.local.env");
  const hasLocal = existsSync(local);
  const s = embedderSettings([parseEnvFile(readFileSync(join(kit, "embedder.env"), "utf8")), ...(hasLocal ? [parseEnvFile(readFileSync(local, "utf8"))] : [])]);
  const keyIn = (): string => (existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8"))[KEY_ENV] ?? "" : "");
  const docker = (cmd: string[], key: string) =>
    Bun.spawnSync(["docker", ...composeArgs(kit, hasLocal, cmd)], { env: composeEnv(process.env, key), stdout: "inherit", stderr: "inherit" }).exitCode;

  if (process.argv.includes("--down")) {
    // Compose checks `${HISTORY_EMBEDDER_KEY:?}` for every command; a stop needs no real key.
    process.exit(docker(["down"], keyIn() || "stopping"));
  }
  const { added } = ensureEnvKey(envFile, KEY_ENV, () => randomBytes(32).toString("base64url"));
  console.log(`${KEY_ENV} ${added ? "added to" : "already in"} ${envFile} (mode 0600)`);
  const key = keyIn();
  if (docker(["up", "-d"], key) !== 0) process.exit(1);
  if (!(await waitHealthy(s, key, s.startWaitS * 1000))) {
    console.error(`neo-embedder did not answer on 127.0.0.1:${s.port} within ${s.startWaitS} s — see: docker logs neo-embedder`);
    process.exit(1);
  }
  const check = await smokeTest(s, key);
  if (!check.ok) {
    console.error(`neo-embedder answered, but the check failed: ${check.reason} — see: docker logs neo-embedder`);
    process.exit(1);
  }
  console.log(`neo-embedder up: http://127.0.0.1:${s.port} · ${s.model} @ ${s.revision.slice(0, 12)} · ${check.dims} dims`);
  console.log(`  caps: memory ${s.mem} (no extra swap) · ${s.cpus} CPUs · ${s.threads} threads · ${s.pids} pids · ${s.maxBatchTokens} batch tokens · cpu_shares 256`);
  console.log("  The daemon reads the key at its next restart (the restart is the operator's).");
}
