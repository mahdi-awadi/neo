// ADR-0066 Decision 5, spec "The embedder contract", AC20 (plan task 15): Neo's own embedder service
// (TEI + BAAI/bge-m3), a digest-pinned, loopback-only, memory-capped Docker service like the shared
// browser (ADR-0032). The installer's decisions are pure and tested here; the docker/IO wrapper around them
// runs in the verify step (plan task 20).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDER_DEFAULTS } from "../src/engine/history/defaults";
import { parseEnvFile, ensureEnvKey } from "../tools/lib/env-file";
import { adapterCfg, composeArgs, composeEnv, embedderSettings, KEY_ENV, smokeTest, waitHealthy } from "../tools/history/install";
import { startFakeTei, type FakeTei } from "./fixtures/fake-tei";

const KIT = join(import.meta.dir, "..", "tools", "history");
const DIGEST = "img@sha256:" + "a".repeat(64);
const REV = "b".repeat(40);
const GOOD = { NEO_EMBEDDER_IMAGE: DIGEST, NEO_EMBEDDER_MODEL: "BAAI/bge-m3", NEO_EMBEDDER_REVISION: REV, NEO_EMBEDDER_PORT: "8088", NEO_EMBEDDER_MEM: "4g", NEO_EMBEDDER_CPUS: "3", NEO_EMBEDDER_THREADS: "3", NEO_EMBEDDER_PIDS: "256", NEO_EMBEDDER_DIMS: "1024", NEO_EMBEDDER_START_WAIT_S: "1200" };
const tracked = () => parseEnvFile(readFileSync(join(KIT, "embedder.env"), "utf8"));
const compose = () => Bun.YAML.parse(readFileSync(join(KIT, "compose.yml"), "utf8")) as { services: Record<string, Record<string, unknown>>; volumes: Record<string, { name?: string }> };

describe("settings", () => {
  test("the tracked settings pin the TEI image by digest and the bge-m3 revision the engine expects", () => {
    const s = embedderSettings([tracked()]);
    expect(s.image).toMatch(/^ghcr\.io\/huggingface\/text-embeddings-inference@sha256:[0-9a-f]{64}$/);
    expect(s.model).toBe(EMBEDDER_DEFAULTS.model);
    expect(s.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(s.revision).toBe(EMBEDDER_DEFAULTS.revision);
    expect(`http://127.0.0.1:${s.port}`).toBe(EMBEDDER_DEFAULTS.url);
    expect(s.dims).toBe(EMBEDDER_DEFAULTS.dims);
    expect(s.mem).toBe("4g");
    expect(s.cpus).toBe("3");
  });

  test("a later layer wins; a bad value keeps the earlier one (fails closed)", () => {
    const s = embedderSettings([GOOD, { NEO_EMBEDDER_MEM: "6g", NEO_EMBEDDER_CPUS: "nope", NEO_EMBEDDER_PORT: "70000" }]);
    expect(s.mem).toBe("6g");
    expect(s.cpus).toBe("3");
    expect(s.port).toBe(8088);
    expect(embedderSettings([GOOD, { NEO_EMBEDDER_CPUS: "1.5", NEO_EMBEDDER_MEM: "lots" }])).toMatchObject({ cpus: "1.5", mem: "4g" });
  });

  test("an image without a digest, a revision that is not a commit, or a missing value throws", () => {
    expect(() => embedderSettings([{ ...GOOD, NEO_EMBEDDER_IMAGE: "ghcr.io/huggingface/text-embeddings-inference:cpu-1.9" }])).toThrow(/digest/);
    expect(() => embedderSettings([{ ...GOOD, NEO_EMBEDDER_REVISION: "main" }])).toThrow(/REVISION/);
    const { NEO_EMBEDDER_PORT: _p, ...noPort } = GOOD;
    expect(() => embedderSettings([noPort])).toThrow(/PORT/);
    const { NEO_EMBEDDER_MEM: _m, ...noMem } = GOOD;
    expect(() => embedderSettings([noMem])).toThrow(/MEM/);
    expect(() => embedderSettings([{ ...GOOD, NEO_EMBEDDER_CPUS: "0" }])).toThrow(/CPUS/);
  });
});

describe("the compose file", () => {
  const svc = () => compose().services["neo-embedder"]!;

  test("binds loopback only, caps memory with no extra swap, CPUs and pids, low CPU shares", () => {
    const s = svc();
    expect(s.ports).toEqual(["127.0.0.1:${NEO_EMBEDDER_PORT}:80"]);
    expect(s.mem_limit).toBe("${NEO_EMBEDDER_MEM}");
    expect(s.memswap_limit).toBe(s.mem_limit);
    expect(s.cpus).toBe("${NEO_EMBEDDER_CPUS}");
    expect(s.cpu_shares).toBe(256);
    expect(s.pids_limit).toBe("${NEO_EMBEDDER_PIDS}");
    expect(s.image).toMatch(/^\$\{NEO_EMBEDDER_IMAGE:\?/);
  });

  test("hardening: all capabilities dropped, no new privileges, a TCP health check", () => {
    const s = svc();
    expect(s.cap_drop).toEqual(["ALL"]);
    expect(s.security_opt).toEqual(["no-new-privileges:true"]);
    expect(s.privileged).toBeUndefined();
    const hc = s.healthcheck as { test: string[] };
    expect(hc.test.join(" ")).toContain("/dev/tcp/127.0.0.1/80");
    expect(hc.test.join(" ")).not.toContain("API_KEY");
  });

  test("the model cache is a named volume on /data", () => {
    const c = compose();
    expect(svc().volumes).toEqual(["neo-embedder-models:/data"]);
    expect(c.volumes["neo-embedder-models"]?.name).toBe("neo-embedder-models");
    const env = svc().environment as Record<string, string>;
    expect(env.HUGGINGFACE_HUB_CACHE).toBe("/data");
    expect(env.MODEL_ID).toBe("${NEO_EMBEDDER_MODEL}");
    expect(env.REVISION).toBe("${NEO_EMBEDDER_REVISION}");
    expect(env.PORT).toBe("80");
  });

  test("the key comes only from the compose process environment, never argv, never a value in the kit", () => {
    const s = svc();
    const env = s.environment as Record<string, string>;
    expect(env.API_KEY).toMatch(/^\$\{HISTORY_EMBEDDER_KEY:\?.+\}$/);
    expect(JSON.stringify(s.command ?? "")).not.toMatch(/KEY/i);
    expect(JSON.stringify(s.entrypoint ?? "")).not.toMatch(/KEY/i);
    for (const f of readdirSync(KIT)) {
      const text = readFileSync(join(KIT, f), "utf8");
      // The name may appear; a value assigned to it may not.
      expect(text).not.toMatch(/HISTORY_EMBEDDER_KEY\s*[=:]\s*["']?[A-Za-z0-9_\-+/]{8,}/);
    }
  });

  test("the disk-cleanup kit protects the backup folder and the model volume", () => {
    const disk = JSON.parse(readFileSync(join(import.meta.dir, "..", "tools", "disk", "defaults.json"), "utf8")) as { protect: string[] };
    const hit = (t: string) => disk.protect.some((p) => new RegExp(p, "i").test(t));
    expect(hit("/var/backups/neo")).toBe(true);
    expect(hit("/var/backups/neo/history-20261030T034100Z.db.gz")).toBe(true);
    expect(hit("neo-embedder-models")).toBe(true);
    expect(hit("/var/backups/neon")).toBe(false);
  });
});

describe("compose arguments and environment", () => {
  test("project neo-embedder, the tracked settings, then the machine-local overrides when present", () => {
    expect(composeArgs(KIT, false, ["up", "-d"])).toEqual(["compose", "-p", "neo-embedder", "-f", join(KIT, "compose.yml"), "--env-file", join(KIT, "embedder.env"), "up", "-d"]);
    const withLocal = composeArgs(KIT, true, ["down"]);
    expect(withLocal.indexOf(join(KIT, "embedder.local.env"))).toBeGreaterThan(withLocal.indexOf(join(KIT, "embedder.env")));
    expect(withLocal.at(-1)).toBe("down");
  });

  test("the key reaches only the child's environment", () => {
    const env = composeEnv({ PATH: "/usr/bin" }, "marker-key-123");
    expect(env).toEqual({ PATH: "/usr/bin", [KEY_ENV]: "marker-key-123" });
    expect(composeArgs(KIT, true, ["up", "-d"]).join(" ")).not.toContain("marker-key-123");
  });
});

describe("the check after start", () => {
  const KEY = "marker-tei-key-0001";
  let tei: FakeTei | undefined;
  afterEach(() => tei?.stop());
  const s = () => embedderSettings([{ ...GOOD, NEO_EMBEDDER_PORT: String(tei!.port), NEO_EMBEDDER_DIMS: "4" }]);

  test("the adapter config matches the engine defaults except the service values", () => {
    tei = startFakeTei({ key: KEY, revision: REV, dims: 4 });
    expect(adapterCfg(s())).toEqual({ ...EMBEDDER_DEFAULTS, url: tei.url, model: "BAAI/bge-m3", revision: REV, dims: 4 });
  });

  test("health with the bearer key, then one test embed of the right length", async () => {
    tei = startFakeTei({ key: KEY, revision: REV, dims: 4 });
    expect(await waitHealthy(s(), KEY, 2_000, 10)).toBe(true);
    expect(tei.requests[0]).toMatchObject({ path: "/health", auth: `Bearer ${KEY}` });
    expect(await smokeTest(s(), KEY)).toEqual({ ok: true, dims: 4 });
  });

  test("a wrong revision, a wrong key or a wrong vector length fails with a reason and no key", async () => {
    tei = startFakeTei({ key: KEY, revision: "c".repeat(40), dims: 4 });
    const wrongRev = await smokeTest(s(), KEY);
    expect(wrongRev).toEqual({ ok: false, reason: "embedder_wrong_model" });
    tei.info.model_sha = REV;
    expect(await smokeTest(s(), "other-key")).toEqual({ ok: false, reason: "embedder_refused" });
    tei.vectorLength = 3;
    const short = await smokeTest(s(), KEY);
    expect(short.ok).toBe(false);
    expect(JSON.stringify([wrongRev, short])).not.toContain(KEY);
  });

  test("no answer within the wait gives false", async () => {
    tei = startFakeTei({ key: KEY, revision: REV, dims: 4 });
    tei.stop();
    expect(await waitHealthy(s(), KEY, 50, 10)).toBe(false);
    tei = undefined;
  });
});

describe("ensureEnvKey", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const tmp = () => (dir = mkdtempSync(join(tmpdir(), "neo-envkey-")));

  test("appends the key once, keeps the other lines, sets 0600 and returns no secret", () => {
    const f = join(tmp(), ".env");
    writeFileSync(f, "# keep me\nA=1\nB=two", { mode: 0o644 });
    let n = 0;
    const gen = () => `generated-${++n}-xxxxxxxxxxxx`;
    const first = ensureEnvKey(f, KEY_ENV, gen);
    expect(first).toEqual({ added: true });
    const text = readFileSync(f, "utf8");
    expect(text.startsWith("# keep me\nA=1\nB=two\n")).toBe(true);
    expect(parseEnvFile(text)[KEY_ENV]).toBe("generated-1-xxxxxxxxxxxx");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(ensureEnvKey(f, KEY_ENV, gen)).toEqual({ added: false });
    expect(readFileSync(f, "utf8")).toBe(text);
    expect(n).toBe(1);
  });

  test("an empty definition is replaced, a missing file is made with 0600", () => {
    const d = tmp();
    const f = join(d, ".env");
    writeFileSync(f, `A=1\n${KEY_ENV}=\nC=3\n`);
    expect(ensureEnvKey(f, KEY_ENV, () => "k-value-0000000000")).toEqual({ added: true });
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual(["A=1", "C=3", `${KEY_ENV}=k-value-0000000000`]);
    const g = join(d, "new.env");
    ensureEnvKey(g, KEY_ENV, () => "k2-value-000000000");
    expect(statSync(g).mode & 0o777).toBe(0o600);
    expect(parseEnvFile(readFileSync(g, "utf8"))[KEY_ENV]).toBe("k2-value-000000000");
  });

  test("a bad key name is refused", () => {
    expect(() => ensureEnvKey(join(tmp(), ".env"), "bad name", () => "x")).toThrow();
  });
});
