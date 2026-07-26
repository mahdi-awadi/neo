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
