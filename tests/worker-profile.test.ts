import { test, expect } from "bun:test";
import { profileDeps } from "../src/engine/worker-profile";

const cfg = {
  providers: { ownWork: "subscription" as const, customerWork: "gemini" as const },
  workers: {
    company: { effort: "low" as const }, project: {}, dispatch: {},
    loop: { model: "sonnet", skills: [] as string[] },
    judge: { model: "haiku", effort: "low" as const },
    ingress: { effort: "low" as const }, handoff: { model: "haiku", effort: "low" as const },
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
