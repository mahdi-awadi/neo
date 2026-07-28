import { test, expect } from "bun:test";
import { runConfig } from "../src/engine/session-runner";

test("runConfig forwards disallowedTools when present", () => {
  expect(runConfig({ disallowedTools: ["Write", "Edit", "Bash"] })).toMatchObject({
    disallowedTools: ["Write", "Edit", "Bash"],
  });
});

test("runConfig omits disallowedTools when absent", () => {
  expect(runConfig({})).not.toHaveProperty("disallowedTools");
});

test("runConfig forwards agents when present (opt-in lead-orchestrated team run)", () => {
  const agents = {
    backend: { description: "backend", prompt: "own the API" },
    frontend: { description: "frontend", prompt: "own the UI" },
  };
  expect(runConfig({ agents })).toMatchObject({ agents });
});

test("runConfig omits agents when absent (default single worker — behaviour unchanged)", () => {
  expect(runConfig({})).not.toHaveProperty("agents");
});

test("runConfig omits Claude-only launch fields on Codex runs", () => {
  const agents = {
    backend: { description: "backend", prompt: "own the API" },
  };
  const c = runConfig({
    provider: "codex",
    resume: "codex-prev",
    effort: "high",
    mcpServers: { neo: {} },
    disallowedTools: ["Write"],
    model: "gpt-5.4",
    skills: [],
    maxTurns: 12,
    agents,
    env: {
      ANTHROPIC_API_KEY: "anthropic",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70",
      CLAUDE_CODE_SUBAGENT_MODEL: "opus",
      CODEX_API_KEY: "codex",
      MAX_MCP_OUTPUT_TOKENS: "12000",
      NEO_TEST_FLAG: "1",
    },
  });

  expect(c.resume).toBe("codex-prev");
  expect(c.effort).toBe("high");
  expect(c.model).toBe("gpt-5.4");
  expect(c).not.toHaveProperty("mcpServers");
  expect(c).not.toHaveProperty("disallowedTools");
  expect(c).not.toHaveProperty("skills");
  expect(c).not.toHaveProperty("maxTurns");
  expect(c).not.toHaveProperty("agents");
  const env = c.env as Record<string, string | undefined>;
  expect(env.CODEX_API_KEY).toBe("codex");
  expect(env.NEO_TEST_FLAG).toBe("1");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
  expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  expect(env.MAX_MCP_OUTPUT_TOKENS).toBeUndefined();
});
