import { test, expect } from "bun:test";
import { runConfig } from "../src/engine/session-runner";
import { resolveModelSelection, CLAUDE_TIER_MODELS } from "../src/engine/model-resolver";

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

// --- Model resolution at the SDK boundary (ADR-0005) -------------------------------------------

test("resolveModelSelection: a pinned Claude id reaches the Claude SDK untouched", () => {
  for (const model of ["claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-fable-5-1"]) {
    const r = resolveModelSelection("subscription", { model });
    expect(r.model).toBe(model);
    expect(r.changed).toBe(false);
  }
});

test("resolveModelSelection: a bare tier alias never reaches the SDK — the table expands it", () => {
  // Second net below profileDeps: a caller that sets RunDeps.model by hand still cannot send a
  // release-dependent alias. The SDK's own validator says to name the model instead.
  expect(resolveModelSelection("subscription", { model: "opus" }).model).toBe(CLAUDE_TIER_MODELS.opus);
  expect(resolveModelSelection("subscription", { model: "sonnet" }).model).toBe(CLAUDE_TIER_MODELS.sonnet);
  expect(resolveModelSelection("subscription", { model: "haiku" }).model).toBe(CLAUDE_TIER_MODELS.haiku);
  expect(resolveModelSelection("subscription", { model: "fable" }).model).toBe(CLAUDE_TIER_MODELS.fable);
  expect(resolveModelSelection("subscription", { model: "opus" }).changed).toBe(true);
});

test("resolveModelSelection: Codex maps a PINNED 5.5 id to reasoning effort and drops the model", () => {
  const opus = resolveModelSelection("codex", { model: "claude-opus-5-5[1m]" });
  expect(opus.model).toBeUndefined();
  expect(opus.effort).toBe("high");

  const sonnet = resolveModelSelection("codex", { model: "claude-sonnet-5-5" });
  expect(sonnet.model).toBeUndefined();
  expect(sonnet.effort).toBe("medium");
});

test("resolveModelSelection: Codex maps the fable tier to an effort instead of dropping it bare", () => {
  // Before ADR-0005 `fable` matched no Codex rule: the bare alias passed straight through as a
  // nonsense Codex model, and `claude-fable-5-1` fell into the ^claude- catch-all with NO effort —
  // so the Codex default effort applied invisibly. Both must now map.
  for (const model of ["fable", "claude-fable-5-1"]) {
    const r = resolveModelSelection("codex", { model });
    expect(r.model).toBeUndefined();
    expect(r.effort).toBe("medium");
  }
});

test("resolveModelSelection: a caller's own effort always beats the tier-derived one", () => {
  const r = resolveModelSelection("codex", { model: "claude-fable-5-1", effort: "max" });
  expect(r.effort).toBe("max");
});

test("resolveModelSelection: a provider-native Codex id is never clobbered by a Claude tier", () => {
  expect(resolveModelSelection("codex", { model: "gpt-5.4" }).model).toBe("gpt-5.4");
});

test("resolveModelSelection: the [1m] tier spelling expands too, carrying the context tag over", () => {
  // `opus[1m]` is an alias the SDK accepts and the operator's own settings use. Left unexpanded it
  // is still a bare, release-dependent alias reaching the SDK.
  expect(resolveModelSelection("subscription", { model: "opus[1m]" }).model).toBe("claude-opus-5-5[1m]");
  expect(resolveModelSelection("subscription", { model: "sonnet[1m]" }).model).toBe("claude-sonnet-5-5[1m]");
  expect(resolveModelSelection("subscription", { model: "fable[1m]" }).model).toBe("claude-fable-5-1[1m]");
});

test("resolveModelSelection: Codex never receives a Claude name as a literal model", () => {
  // `best` and `opusplan` are MODE aliases — they depend on the release AND the settings, so no one
  // id expresses them and Neo does not expand them on Claude. On Codex they must still not pass
  // through as a model name: "best" is not an OpenAI model.
  for (const model of ["best", "opusplan", "claude-mythos-5", "claude-opus-5-5[1m]"]) {
    const r = resolveModelSelection("codex", { model });
    expect(r.model).toBeUndefined();
    expect(r.effort).toBeDefined(); // an explicit effort, never a silent provider default
  }
});
