import { test, expect } from "bun:test";
import { profileDeps } from "../src/engine/worker-profile";

const cfg = {
  providers: { ownWork: "subscription" as const, customerWork: "gemini" as const },
  workers: {
    company: { effort: "low" as const }, project: {}, dispatch: {},
    loop: { model: "sonnet", skills: [] as string[] },
    judge: { model: "haiku", effort: "low" as const },
    ingress: { effort: "low" as const }, handoff: { model: "haiku", effort: "low" as const }, secretary: {},
  },
  workerEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" },
};

test("profileDeps folds the path profile + workerEnv into RunDeps", () => {
  const d = profileDeps(cfg, "loop");
  expect(d.provider).toBe("subscription");
  expect(d.model).toBe("sonnet");
  expect(d.skills).toEqual([]);
  expect(d.env).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" });
});

test("call-site base wins over the profile and keeps unrelated fields", () => {
  const d = profileDeps(cfg, "judge", { effort: "medium", disallowedTools: ["Write"] });
  expect(d.effort).toBe("medium");        // base beats profile
  expect(d.model).toBe("haiku");          // profile fills the gap
  expect(d.disallowedTools).toEqual(["Write"]);
});

test("empty profile + empty env adds nothing (inherit = today's behavior)", () => {
  expect(profileDeps({ workers: cfg.workers, workerEnv: {} }, "dispatch")).toEqual({});
});

test("profileDeps threads the configured own-work SDK provider into every launch path", () => {
  const d = profileDeps(
    { ...cfg, providers: { ownWork: "codex" as const, customerWork: "gemini" as const } },
    "project",
  );
  expect(d.provider).toBe("codex");
});

// A config that pins models (ADR-0005). `cfg` above deliberately has no `models` block, so the
// tests above keep asserting the pre-pin behaviour.
const pinned = {
  ...cfg,
  models: {
    default: "claude-opus-5-5[1m]",
    aliases: {
      opus: "claude-opus-5-5[1m]",
      sonnet: "claude-sonnet-5-5",
      haiku: "claude-haiku-4-5",
      fable: "claude-fable-5-1",
    },
  },
};

test("profileDeps: a path with no model of its own gets the PINNED default, not nothing", () => {
  // The defect: `dispatch: {}` meant RunDeps.model stayed undefined and the worker silently took
  // whatever the subscription defaulted to. Absence must now mean the pinned default.
  expect(profileDeps(pinned, "dispatch").model).toBe("claude-opus-5-5[1m]");
  expect(profileDeps(pinned, "project").model).toBe("claude-opus-5-5[1m]");
  expect(profileDeps(pinned, "secretary").model).toBe("claude-opus-5-5[1m]");
});

test("profileDeps: a tier alias in a profile expands to the real pinned 5.5 model id", () => {
  expect(profileDeps(pinned, "loop").model).toBe("claude-sonnet-5-5");   // profile says "sonnet"
  expect(profileDeps(pinned, "judge").model).toBe("claude-haiku-4-5");   // profile says "haiku"
});

test("profileDeps: a blank or whitespace profile model falls back to the pinned default", () => {
  const blank = { ...pinned, workers: { ...pinned.workers, dispatch: { model: "   " } } };
  expect(profileDeps(blank, "dispatch").model).toBe("claude-opus-5-5[1m]");
});

test("profileDeps: an id the alias map does not know passes through untouched", () => {
  // A wrong id must fail loudly at the SDK (classifyApiError → model_not_found), not be silently
  // replaced by the default — that would mask a typo and clobber provider-native ids.
  const exotic = { ...pinned, workers: { ...pinned.workers, dispatch: { model: "claude-opus-4-8" } } };
  expect(profileDeps(exotic, "dispatch").model).toBe("claude-opus-4-8");
});

test("profileDeps: a call-site model still wins over both the profile and the pinned default", () => {
  expect(profileDeps(pinned, "loop", { model: "claude-fable-5-1" }).model).toBe("claude-fable-5-1");
  expect(profileDeps(pinned, "loop", { model: "fable" }).model).toBe("claude-fable-5-1"); // alias too
});

test("profileDeps: Codex gets NO Claude pin — the Codex adapter keeps owning its own model", () => {
  // models.* names Claude ids; injecting one into a Codex run would only be dropped downstream as
  // a foreign model, re-creating the invisible-default bug one layer down.
  const d = profileDeps({ ...pinned, providers: { ownWork: "codex" as const, customerWork: "gemini" as const } }, "dispatch");
  expect(d.provider).toBe("codex");
  expect(d.model).toBeUndefined();
});

test("profileDeps applies the SDK table: Codex keeps model/effort but drops Claude-only profile env", () => {
  const d = profileDeps(
    {
      ...cfg,
      providers: { ownWork: "codex" as const, customerWork: "gemini" as const },
      workers: {
        ...cfg.workers,
        loop: { model: "sonnet", effort: "high" as const, skills: [] as string[], maxTurns: 4 },
      },
      workerEnv: {
        ANTHROPIC_API_KEY: "anthropic",
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70",
        CLAUDE_CODE_SUBAGENT_MODEL: "opus",
        CODEX_API_KEY: "codex",
        MAX_MCP_OUTPUT_TOKENS: "12000",
        NEO_TEST_FLAG: "1",
      },
    },
    "loop",
    { env: { CLAUDE_CODE_EXTRA: "drop", OPENAI_API_KEY: "openai" } },
  );

  expect(d.provider).toBe("codex");
  expect(d.model).toBe("sonnet");
  expect(d.effort).toBe("high");
  expect(d.skills).toBeUndefined();
  expect(d.maxTurns).toBeUndefined();
  expect(d.env).toEqual({
    CODEX_API_KEY: "codex",
    NEO_TEST_FLAG: "1",
    OPENAI_API_KEY: "openai",
  });
});
