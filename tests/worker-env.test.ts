import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubWorkerEnv, reportableEngineKeys, type EnvScrubOptions } from "../src/engine/worker-env";
import { mergedSdkEnv, runConfig, setDefaultEnvScrub } from "../src/engine/session-runner";
import { loadDotEnv } from "../src/config";
import { readToolsCfg } from "../src/engine/tools-catalogue";

const SENTINEL = "SENTINEL-worker-env-value";
const base = (mode: "report" | "strip"): EnvScrubOptions => ({
  engineKeys: new Set(["TELEGRAM_TOKEN", "ANTHROPIC_API_KEY"]),
  relayKeys: new Set(["SCALEDOWN_API_KEY"]),
  inherit: new Set(["ANTHROPIC_API_KEY"]),
  mode,
});
const env = () => ({ PATH: "/bin", TELEGRAM_TOKEN: SENTINEL, ANTHROPIC_API_KEY: SENTINEL, SCALEDOWN_API_KEY: SENTINEL });

describe("scrubWorkerEnv", () => {
  test("relay keys are removed in both modes", () => {
    for (const mode of ["report", "strip"] as const) {
      expect(scrubWorkerEnv(env(), base(mode)).env.SCALEDOWN_API_KEY).toBeUndefined();
    }
  });
  test("report keeps engine keys and lists their names", () => {
    const r = scrubWorkerEnv(env(), base("report"));
    expect(r.env.TELEGRAM_TOKEN).toBe(SENTINEL);
    expect(r.reported).toEqual(["TELEGRAM_TOKEN"]);
    expect(r.stripped).toEqual(["SCALEDOWN_API_KEY"]);
  });
  test("strip removes engine keys except inherit", () => {
    const r = scrubWorkerEnv(env(), base("strip"));
    expect(r.env.TELEGRAM_TOKEN).toBeUndefined();
    expect(r.env.ANTHROPIC_API_KEY).toBe(SENTINEL);
    expect(r.env.PATH).toBe("/bin");
    expect(r.stripped.sort()).toEqual(["SCALEDOWN_API_KEY", "TELEGRAM_TOKEN"]);
    expect(r.reported).toEqual([]);
  });
  test("no value leaks into stripped or reported", () => {
    for (const mode of ["report", "strip"] as const) {
      const r = scrubWorkerEnv(env(), base(mode));
      expect(JSON.stringify([r.stripped, r.reported])).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(reportableEngineKeys(base("report")))).not.toContain(SENTINEL);
  });
  test("reportableEngineKeys excludes inherit and relay names", () => {
    expect(reportableEngineKeys(base("report"))).toEqual(["TELEGRAM_TOKEN"]);
  });
});

describe("mergedSdkEnv applies the scrub", () => {
  afterEach(() => { setDefaultEnvScrub(undefined); delete process.env.SCALEDOWN_API_KEY; });
  test("explicit scrub removes a relay key from process.env", () => {
    process.env.SCALEDOWN_API_KEY = SENTINEL;
    expect(mergedSdkEnv("subscription", { NEO_WORKER: "1" }, base("report")).SCALEDOWN_API_KEY).toBeUndefined();
  });
  test("the daemon default applies, and runConfig honours RunDeps.envScrub", () => {
    process.env.SCALEDOWN_API_KEY = SENTINEL;
    setDefaultEnvScrub(base("report"));
    expect(mergedSdkEnv("subscription", {}).SCALEDOWN_API_KEY).toBeUndefined();
    setDefaultEnvScrub(undefined);
    expect(mergedSdkEnv("subscription", {}).SCALEDOWN_API_KEY).toBe(SENTINEL);
    const c = runConfig({ env: { NEO_WORKER: "1" }, envScrub: base("report") } as never) as { env: Record<string, string> };
    expect(c.env.SCALEDOWN_API_KEY).toBeUndefined();
  });
  test("codex path is scrubbed too", () => {
    process.env.SCALEDOWN_API_KEY = SENTINEL;
    expect(mergedSdkEnv("codex", {}, base("strip")).SCALEDOWN_API_KEY).toBeUndefined();
  });
});

describe("loadDotEnv returns every key name in the file", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "neo-denv-")); });
  afterEach(() => {
    delete process.env.WE_NEW_KEY; delete process.env.WE_OLD_KEY;
    rmSync(dir, { recursive: true, force: true });
  });
  test("lists a key already in process.env (Bun preloaded it); fill-missing is unchanged; no values", () => {
    process.env.WE_OLD_KEY = "already";
    writeFileSync(join(dir, ".env"), `WE_NEW_KEY=${SENTINEL}\nWE_OLD_KEY=${SENTINEL}\n# c\n`);
    const names = loadDotEnv(dir);
    expect(names).toEqual(["WE_NEW_KEY", "WE_OLD_KEY"]);
    expect(process.env.WE_OLD_KEY).toBe("already");
    expect(process.env.WE_NEW_KEY).toBe(SENTINEL);
    expect(JSON.stringify(names)).not.toContain(SENTINEL);
  });
});

describe("tools.workerEnv config", () => {
  test("defaults to report with the SDK auth names", () => {
    const c = readToolsCfg({});
    expect(c.workerEnv.engineSecrets).toBe("report");
    expect(c.workerEnv.inherit).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
  test("bad values fall back; strip is accepted", () => {
    expect(readToolsCfg({ workerEnv: { engineSecrets: "nope", inherit: [1] } }).workerEnv.engineSecrets).toBe("report");
    expect(readToolsCfg({ workerEnv: { engineSecrets: "strip", inherit: ["A"] } }).workerEnv).toEqual({ engineSecrets: "strip", inherit: ["A"] });
  });
});
