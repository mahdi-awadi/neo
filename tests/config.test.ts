import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";

const dir = () => mkdtempSync(join(tmpdir(), "neo-cfg-"));

test("idleCloseMs defaults to 24h", () => {
  expect(loadConfig(dir()).idleCloseMs).toBe(24 * 60 * 60 * 1000);
});

test("config.json overrides idleCloseMs", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ idleCloseMs: 1000 }));
  expect(loadConfig(d).idleCloseMs).toBe(1000);
});

test("codebaseMemoryIndexTimeoutMs defaults to 5m", () => {
  expect(loadConfig(dir()).codebaseMemoryIndexTimeoutMs).toBe(5 * 60 * 1000);
});

test("config.json overrides codebaseMemoryIndexTimeoutMs", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ codebaseMemoryIndexTimeoutMs: 1000 }));
  expect(loadConfig(d).codebaseMemoryIndexTimeoutMs).toBe(1000);
});

test("stitchApiKey reads STITCH_API_KEY from env (empty when unset)", () => {
  // Hermetic: control the var directly (Bun auto-loads the repo .env into process.env).
  const saved = process.env.STITCH_API_KEY;
  try {
    delete process.env.STITCH_API_KEY;
    expect(loadConfig(dir()).stitchApiKey).toBe("");
    process.env.STITCH_API_KEY = "stitch-test-key";
    expect(loadConfig(dir()).stitchApiKey).toBe("stitch-test-key");
  } finally {
    if (saved === undefined) delete process.env.STITCH_API_KEY;
    else process.env.STITCH_API_KEY = saved;
  }
});

test("loopSchedulerEnabled defaults to true; NEO_LOOP_SCHEDULER=0 disables it", () => {
  const saved = process.env.NEO_LOOP_SCHEDULER;
  try {
    delete process.env.NEO_LOOP_SCHEDULER;
    expect(loadConfig(dir()).loopSchedulerEnabled).toBe(true);
    process.env.NEO_LOOP_SCHEDULER = "0";
    expect(loadConfig(dir()).loopSchedulerEnabled).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.NEO_LOOP_SCHEDULER;
    else process.env.NEO_LOOP_SCHEDULER = saved;
  }
});

test("dispatchTimeoutMs defaults to 900000 and reads config.json", () => {
  expect(loadConfig("/nonexistent-dir").dispatchTimeoutMs).toBe(900_000);
});

test("dispatch liveness knobs default per spec (ceiling 2h, stall 5m, grace 75s)", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.dispatchTimeoutMaxMs).toBe(7_200_000);
  expect(c.dispatchStallMs).toBe(300_000);
  expect(c.dispatchGraceMs).toBe(75_000);
});

test("watchdog thresholds default per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.stuckAfterMs).toBe(600_000);
  expect(c.longTurnAlertMs).toBe(1_200_000);
  expect(c.alertRepeatMs).toBe(900_000);
});

test("contextPolicy defaults per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.contextPolicy).toEqual({ handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000 });
});

/** Run `fn` with `key` forced to `value` (or unset when undefined), restoring the prior value after. */
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test("web console host/port default to localhost:3003 and read env", () => {
  withEnv("WEB_HOST", undefined, () =>
    withEnv("WEB_PORT", undefined, () => {
      const c = loadConfig("/nonexistent-dir");
      expect(c.webHost).toBe("127.0.0.1");
      expect(c.webPort).toBe(3003);
    }),
  );
  withEnv("WEB_HOST", "172.20.0.1", () =>
    withEnv("WEB_PORT", "4000", () => {
      const c = loadConfig("/nonexistent-dir");
      expect(c.webHost).toBe("172.20.0.1");
      expect(c.webPort).toBe(4000);
    }),
  );
});

test("publicUrl / gatewaySendUrl / botUsername are empty by default and read env", () => {
  withEnv("PUBLIC_URL", undefined, () =>
    withEnv("GATEWAY_SEND_URL", undefined, () =>
      withEnv("BOT_USERNAME", undefined, () => {
        const c = loadConfig("/nonexistent-dir");
        expect(c.publicUrl).toBe("");
        expect(c.gatewaySendUrl).toBe("");
        expect(c.botUsername).toBe("");
      }),
    ),
  );
  withEnv("PUBLIC_URL", "https://neo.example.com", () =>
    withEnv("BOT_USERNAME", "my_bot", () => {
      const c = loadConfig("/nonexistent-dir");
      expect(c.publicUrl).toBe("https://neo.example.com");
      expect(c.botUsername).toBe("my_bot");
    }),
  );
});

test("workRoot defaults to /home and reads WORK_ROOT; companyFolder defaults under cwd", () => {
  withEnv("WORK_ROOT", undefined, () =>
    withEnv("COMPANY_FOLDER", undefined, () => {
      const c = loadConfig("/nonexistent-dir");
      expect(c.workRoot).toBe("/home");
      expect(c.companyFolder).toBe(join(process.cwd(), "agent"));
    }),
  );
  withEnv("WORK_ROOT", "/srv/projects", () =>
    withEnv("COMPANY_FOLDER", "/srv/company", () => {
      const c = loadConfig("/nonexistent-dir");
      expect(c.workRoot).toBe("/srv/projects");
      expect(c.companyFolder).toBe("/srv/company");
    }),
  );
});

test("optional MCP add-on bins are OFF by default (no hardcoded personal paths)", () => {
  withEnv("GITNEXUS_BIN", undefined, () =>
    withEnv("CODEBASE_MEMORY_BIN", undefined, () => {
      const c = loadConfig("/nonexistent-dir");
      expect(c.gitnexusBin).toBe("");
      expect(c.codebaseMemoryBin).toBe("");
    }),
  );
  withEnv("GITNEXUS_BIN", "/usr/bin/gitnexus", () => {
    expect(loadConfig("/nonexistent-dir").gitnexusBin).toBe("/usr/bin/gitnexus");
  });
});

test("worker profiles: per-path overrides merge from config.json over inherit-everything defaults", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ workers: { handoff: { model: "haiku", effort: "low" } }, workerEnv: { MAX_MCP_OUTPUT_TOKENS: "12000" } }));
  const cfg = loadConfig(d);
  expect(cfg.workers.handoff.model).toBe("haiku");      // file override wins for that path
  expect(cfg.workers.company.effort).toBe("low");       // existing code behavior, now a default
  expect(cfg.workers.dispatch).toEqual({});             // code-writing paths inherit everything
  expect(cfg.workerEnv.MAX_MCP_OUTPUT_TOKENS).toBe("12000");
});

test("worker profiles: QUALITY INVARIANT — absent config changes no worker's model/effort/skills", () => {
  const cfg = loadConfig(dir());
  // Only the two effort:"low" behaviors that already exist in code move into config; every
  // other path (all code-writing paths included) inherits the CLI default model untouched.
  expect(cfg.workers).toEqual({
    company: { effort: "low" }, project: {}, dispatch: {}, loop: {},
    judge: {}, ingress: { effort: "low" }, handoff: {},
  });
  expect(cfg.workerEnv).toEqual({});
});
