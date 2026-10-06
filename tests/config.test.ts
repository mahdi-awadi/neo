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

test("dispatch has no wall-clock ceiling knob (ADR-0007)", () => {
  const c = loadConfig("/nonexistent-dir") as unknown as Record<string, unknown>;
  expect(c.dispatchTimeoutMs).toBeUndefined();
  expect(c.dispatchTimeoutMaxMs).toBeUndefined();
});

test("dispatch liveness + reporting knobs default per spec (stall 5m, grace 75s, digest 10m, recovery 24h)", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.dispatchStallMs).toBe(300_000);
  expect(c.dispatchGraceMs).toBe(75_000);
  expect(c.dispatchProgressMs).toBe(600_000);
  expect(c.dispatchRecoverWindowMs).toBe(86_400_000);
});

test("watchdog thresholds default per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.stuckAfterMs).toBe(600_000);
  expect(c.longTurnAlertMs).toBe(1_200_000);
  expect(c.alertRepeatMs).toBe(900_000);
});

test("API retry policy defaults (ladder 30s/2m/8m, jitter 0.2, cooldown 60s)", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.apiRetryLadderMs).toEqual([30_000, 120_000, 480_000]);
  expect(c.apiRetryJitterFrac).toBe(0.2);
  expect(c.apiCooldownMs).toBe(60_000);
});

test("config.json overrides the API retry policy (ladder length = retry count)", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ apiRetryLadderMs: [1000, 2000], apiRetryJitterFrac: 0, apiCooldownMs: 5000 }));
  const c = loadConfig(d);
  expect(c.apiRetryLadderMs).toEqual([1000, 2000]);
  expect(c.apiRetryJitterFrac).toBe(0);
  expect(c.apiCooldownMs).toBe(5000);
});

test("retention + list knobs default per spec and read config.json", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.routeKeep).toBe(20_000);
  expect(c.eventsKeep).toBe(50_000);
  expect(c.decisionsKeep).toBe(5_000);
  expect(c.codebaseMemoryListTimeoutMs).toBe(15_000);
  expect(c.inboxListDefault).toBe(100);
  expect(c.webFeedWindow).toBe(500);
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ routeKeep: 5, eventsKeep: 7, codebaseMemoryListTimeoutMs: 9, inboxListDefault: 11, webFeedWindow: 13 }));
  const o = loadConfig(d);
  expect(o.routeKeep).toBe(5);
  expect(o.eventsKeep).toBe(7);
  expect(o.codebaseMemoryListTimeoutMs).toBe(9);
  expect(o.inboxListDefault).toBe(11);
  expect(o.webFeedWindow).toBe(13);
});

test("decisionsChatId is undefined by default, reads config.json, and env wins", () => {
  withEnv("DECISIONS_CHAT_ID", undefined, () => {
    expect(loadConfig("/nonexistent-dir").decisionsChatId).toBeUndefined();
    const d = dir();
    writeFileSync(join(d, "config.json"), JSON.stringify({ decisionsChatId: -100123 }));
    expect(loadConfig(d).decisionsChatId).toBe(-100123);
  });
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ decisionsChatId: -100123 }));
  withEnv("DECISIONS_CHAT_ID", "-100999", () => {
    expect(loadConfig(d).decisionsChatId).toBe(-100999); // env over file
  });
});

test("contextPolicy defaults per spec", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.contextPolicy).toEqual({
    sweetSpotPct: 0.4,
    checkpointPct: 0.6,
    emergencyPct: 0.9,
    handoffNoteMaxChars: 20_000,
    handoffOrientationMaxSteps: 70,
    maxTurns: 200,
    maxAgeMs: 604_800_000,
    handoffTimeoutMs: 180_000,
    staleResumePct: 0.35,
    cacheTtlFallbackMs: 3_600_000,
    cacheTtlMinObservations: 5,
    cacheObsWindow: 50,
  });
});

test("messageRoutesCacheCap + contextPolicy.cacheObsWindow default and read config.json", () => {
  const c = loadConfig("/nonexistent-dir");
  expect(c.messageRoutesCacheCap).toBe(2_000);
  expect(c.contextPolicy.cacheObsWindow).toBe(50);
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ messageRoutesCacheCap: 42, contextPolicy: { cacheObsWindow: 8 } }));
  const o = loadConfig(d);
  expect(o.messageRoutesCacheCap).toBe(42);
  expect(o.contextPolicy.cacheObsWindow).toBe(8);
  expect(o.contextPolicy.sweetSpotPct).toBe(0.4); // unset contextPolicy fields keep defaults
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

test("optional MCP add-on bin is OFF by default (no hardcoded personal paths)", () => {
  withEnv("CODEBASE_MEMORY_BIN", undefined, () => {
    expect(loadConfig("/nonexistent-dir").codebaseMemoryBin).toBe("");
  });
  withEnv("CODEBASE_MEMORY_BIN", "/usr/bin/codebase-memory-mcp", () => {
    expect(loadConfig("/nonexistent-dir").codebaseMemoryBin).toBe("/usr/bin/codebase-memory-mcp");
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
  // other path (all code-writing paths included) stays empty and so takes `models.default`
  // (ADR-0005) — a path names a model only to DIFFER from the pinned default.
  expect(cfg.workers).toEqual({
    company: { effort: "low" }, project: {}, dispatch: {}, loop: {},
    judge: {}, ingress: { effort: "low" }, handoff: {}, secretary: {},
  });
  expect(cfg.workerEnv).toEqual({});
});

test("models: the default is PINNED to a real id — never an inherited SDK default, never a bare alias", () => {
  const m = loadConfig(dir()).models;
  // The defect this fixes: no model key anywhere meant every worker took whatever the
  // subscription happened to default to, with no config change and no record (ADR-0005).
  expect(m.default).toBe("claude-opus-5-5[1m]");
  expect(m.aliases).toEqual({
    opus: "claude-opus-5-5[1m]",
    sonnet: "claude-sonnet-5-5",
    haiku: "claude-haiku-4-5",
    fable: "claude-fable-5-1",
  });
  // A bare alias is release-dependent, so it must never BE the pinned value.
  expect(Object.values(m.aliases)).not.toContain("opus");
  expect(m.default.startsWith("claude-")).toBe(true);
});

test("models: config.json overrides the pinned default and merges a single alias", () => {
  const d = dir();
  writeFileSync(
    join(d, "config.json"),
    JSON.stringify({ models: { default: "claude-sonnet-5-5", aliases: { opus: "claude-opus-5" } } }),
  );
  const m = loadConfig(d).models;
  expect(m.default).toBe("claude-sonnet-5-5");
  expect(m.aliases.opus).toBe("claude-opus-5");          // file override wins for that tier
  expect(m.aliases.sonnet).toBe("claude-sonnet-5-5");    // untouched tiers keep the pinned default
});

test("models: NEO_WORKER_MODEL env beats config.json (env > file > defaults)", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ models: { default: "claude-sonnet-5-5" } }));
  withEnv("NEO_WORKER_MODEL", "claude-fable-5-1", () => {
    expect(loadConfig(d).models.default).toBe("claude-fable-5-1");
  });
  expect(loadConfig(d).models.default).toBe("claude-sonnet-5-5"); // env unset → file again
});

test("memory: QUALITY INVARIANT — scopes defaults to [] (total no-op) plus Hermes-measured fallbacks", () => {
  expect(loadConfig(dir()).memory).toEqual({
    scopes: [],
    snapshotMaxPct: 0.004,
    userMaxPct: 0.0025,
    dreamMaxMutations: 3,
    dreamMaxAdds: 1,
    dreamMaxNetChars: 250,
    dreamLookbackDays: 14,
  });
});

test("memory: config.json can opt a scope in and override the ratio caps", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ memory: { scopes: ["company"], snapshotMaxPct: 0.01 } }));
  const cfg = loadConfig(d);
  expect(cfg.memory.scopes).toEqual(["company"]);
  expect(cfg.memory.snapshotMaxPct).toBe(0.01);
  expect(cfg.memory.userMaxPct).toBe(0.0025); // unset field keeps the default
});

test("models: alias KEYS from config.json are normalised, so capitalisation cannot silently miss", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ models: { aliases: { Opus: "claude-opus-5" } } }));
  expect(loadConfig(d).models.aliases.opus).toBe("claude-opus-5");
});

test("updates: defaults — daily, auto-apply on for every category, breaking updates held (ADR-0009)", () => {
  const u = loadConfig(dir()).updates;
  expect(u.enabled).toBe(true);
  expect(u.everyMs).toBe(24 * 60 * 60 * 1000);
  expect(u.autoApply).toEqual({ sdk: true, plugins: true, mcp: true });
  expect(u.holdBreaking).toBe(true);
  expect(u.baseBranch).toBe("master");
  expect(u.npmGlobals["playwright-mcp"]).toBe("@playwright/mcp");
  expect(u.codebaseMemory.repo).toBe("DeusData/codebase-memory-mcp");
});

test("updates: config.json merges per key — one autoApply category off keeps the others", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ updates: { everyMs: 1000, autoApply: { mcp: false } } }));
  const u = loadConfig(d).updates;
  expect(u.everyMs).toBe(1000);
  expect(u.autoApply).toEqual({ sdk: true, plugins: true, mcp: false });
  expect(u.holdBreaking).toBe(true);
});

test("trustNewProjects defaults to true (operator choice, 2026-10-02)", () => {
  expect(loadConfig(dir()).trustNewProjects).toBe(true);
});

test("config.json can turn trustNewProjects off", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ trustNewProjects: false }));
  expect(loadConfig(d).trustNewProjects).toBe(false);
});

test("error containment knobs: defaults, and config.json merges per key (ADR-0010)", () => {
  const c = loadConfig(dir());
  expect(c.faults).toEqual({ dedupeMs: 15 * 60_000, maxAlertsPerHour: 6, companyHandoff: true, maxHandoffsPerHour: 3 });
  expect(c.health).toEqual({ everyMs: 60_000, lagWarnMs: 2_000, rssWarnMb: 2_048 });
  expect(c.sqliteBusyTimeoutMs).toBe(5_000);
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ faults: { companyHandoff: false }, health: { everyMs: 0 }, sqliteBusyTimeoutMs: 100 }));
  const o = loadConfig(d);
  expect(o.faults).toEqual({ dedupeMs: 15 * 60_000, maxAlertsPerHour: 6, companyHandoff: false, maxHandoffsPerHour: 3 });
  expect(o.health.everyMs).toBe(0);
  expect(o.health.lagWarnMs).toBe(2_000);
  expect(o.sqliteBusyTimeoutMs).toBe(100);
});

// ADR-0021: the sweet-spot band comes from transcript data (31,585 Opus turns), not a guess.
const withCfg = (json: unknown) => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify(json));
  return loadConfig(d);
};

test("the context band defaults to sweet spot 0.40, checkpoint 0.60, emergency 0.90", () => {
  const cp = loadConfig(dir()).contextPolicy;
  expect([cp.sweetSpotPct, cp.checkpointPct, cp.emergencyPct]).toEqual([0.4, 0.6, 0.9]);
  expect([cp.handoffNoteMaxChars, cp.handoffOrientationMaxSteps]).toEqual([20_000, 70]);
});

test("a legacy contextPolicy.handoffPct is honoured as sweetSpotPct; sweetSpotPct wins when both are set", () => {
  expect(withCfg({ contextPolicy: { handoffPct: 0.5 } }).contextPolicy.sweetSpotPct).toBe(0.5);
  expect(withCfg({ contextPolicy: { handoffPct: 0.5, sweetSpotPct: 0.3 } }).contextPolicy.sweetSpotPct).toBe(0.3);
});
